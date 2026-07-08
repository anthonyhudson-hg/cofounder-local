import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { getProvider, drainTurn } from "../../providers";

export interface OnboardingAnswers {
  companyName: string;
  description: string;
  stage: string;
  industry: string;
  customer: string;
  priorities: string[];
  teamContext: string;
}

export interface SuggestedRole {
  jobTitle: string;
  department: string;
  mission: string;
  why: string;
}

export interface OnboardingSuggestion {
  profile: string;
  systemPrompt: string;
  roles: SuggestedRole[];
  channels: string[];
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  const brace = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return brace >= 0 && end > brace ? text.slice(brace, end + 1) : text;
}

/** Deterministic fallback used when the model call fails or returns junk. */
function fallbackSuggestion(a: OnboardingAnswers): OnboardingSuggestion {
  const profile = [
    `${a.companyName || "The company"} — ${a.description || "an early-stage company"}.`,
    a.stage ? `Stage: ${a.stage}.` : "",
    a.industry ? `Industry: ${a.industry}.` : "",
    a.customer ? `Customer: ${a.customer}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const systemPrompt =
    `You are an AI employee at ${a.companyName || "this company"}, ${a.description || "an early-stage company"}. ` +
    `Be direct, concise, and proactive. Use good judgment about what genuinely needs the founder's attention versus what you should just handle. ` +
    (a.priorities.length ? `The company's current priorities are: ${a.priorities.join(", ")}. Bias your work toward moving these forward.` : "");

  // Realistic, minimal role suggestions keyed on the stage / priorities — the CoS already exists.
  const roles: SuggestedRole[] = [];
  const pri = a.priorities.map((p) => p.toLowerCase()).join(" ");
  const early = /idea|pre-?seed|seed/i.test(a.stage) || a.stage === "";
  if (/product|ship|build|engineer|mvp/.test(pri) || early) {
    roles.push({ jobTitle: "Full-Stack Engineer", department: "Engineering", mission: "Ship the core product quickly and reliably.", why: "You need to build and iterate on the product." });
  }
  if (/customer|sales|gtm|growth|market|revenue|launch/.test(pri)) {
    roles.push({ jobTitle: "Growth Lead", department: "Marketing", mission: "Find repeatable ways to reach and convert the target customer.", why: "You need early traction and a go-to-market motion." });
  }
  if (/fundrais|invest|finance|runway/.test(pri)) {
    roles.push({ jobTitle: "Finance & Fundraising Analyst", department: "Finance", mission: "Keep the model tight and fundraising materials ready.", why: "You're focused on runway/fundraising." });
  }
  // Keep it lean: at most 2 additional hires for early stage.
  const trimmed = early ? roles.slice(0, 2) : roles.slice(0, 3);

  const channels = ["general"]; // general already exists; suggest a couple more
  if (trimmed.some((r) => r.department === "Engineering")) channels.push("product");
  if (trimmed.some((r) => r.department === "Marketing")) channels.push("gtm");
  return { profile, systemPrompt, roles: trimmed, channels: channels.filter((c) => c !== "general") };
}

/**
 * Generates a company profile, an auto-composed company system prompt, and a
 * REALISTIC minimal set of initial hires + channels from the founder's answers.
 * Uses the Claude provider; falls back to a deterministic heuristic if the model
 * is unavailable or returns unparseable output.
 */
export async function generateOnboarding(
  _ctx: RuntimeContext,
  answers: OnboardingAnswers,
): Promise<OnboardingSuggestion> {
  const system = [
    "You are helping a solo founder set up an AI-employee workspace. Given their company details, return ONLY a JSON object:",
    `{"profile": string, "systemPrompt": string, "roles": [{"jobTitle": string, "department": string, "mission": string, "why": string}], "channels": [string]}`,
    "- profile: 1-3 sentence factual description of the company (what it does, stage, customer).",
    "- systemPrompt: company-wide operating ground rules for ALL AI employees (2-4 sentences), incorporating the company's context and priorities. Written in second person ('You are an AI employee at ...').",
    "- roles: the SMALLEST set of initial hires that add REAL value at this exact stage. A Chief of Staff already exists — do NOT include it. For an idea/pre-seed/seed solo founder this is usually 1-3 roles, sometimes 0. Do not pad. Each role: jobTitle, department, one-line mission, and a short 'why now'.",
    "- channels: 0-3 additional team channels beyond #general that are genuinely useful now (e.g. product, gtm). Lowercase, no #.",
    "Be realistic and lean. More employees is not better — only suggest a hire when the work clearly needs a dedicated owner right now.",
  ].join("\n");

  const prompt = JSON.stringify(answers, null, 2);

  try {
    let raw = "";
    await drainTurn(
      getProvider("claude").runTurn({ model: "claude-sonnet-5", effort: "medium", systemPrompt: system, prompt }),
      (t) => (raw += t),
    );
    const parsed = JSON.parse(extractJson(raw)) as Partial<OnboardingSuggestion>;
    const roles = Array.isArray(parsed.roles)
      ? parsed.roles
          .filter((r) => r && r.jobTitle && !/chief of staff/i.test(r.jobTitle))
          .map((r) => ({ jobTitle: String(r.jobTitle), department: String(r.department ?? "Other"), mission: String(r.mission ?? ""), why: String(r.why ?? "") }))
      : [];
    return {
      profile: String(parsed.profile ?? "").trim() || fallbackSuggestion(answers).profile,
      systemPrompt: String(parsed.systemPrompt ?? "").trim() || fallbackSuggestion(answers).systemPrompt,
      roles: roles.slice(0, 5),
      channels: Array.isArray(parsed.channels) ? parsed.channels.map((c) => String(c).replace(/^#/, "").trim()).filter(Boolean).slice(0, 3) : [],
    };
  } catch {
    return fallbackSuggestion(answers);
  }
}

export interface ApplyOnboardingInput {
  companyId: string;
  companyName: string;
  profile: string;
  systemPrompt: string;
  roles: SuggestedRole[];
  channels: string[];
}

/** Persists the finalized onboarding: company profile/prompt/name, hires, channels; marks onboarded. */
export async function applyOnboarding(ctx: RuntimeContext, input: ApplyOnboardingInput): Promise<{ ok: true }> {
  await mutate(ctx, async (trx, emit) => {
    await trx
      .updateTable("companies")
      .set({ name: input.companyName || "My Company", profile: input.profile, system_prompt: input.systemPrompt, onboarded: 1 })
      .where("id", "=", input.companyId)
      .execute();

    for (const role of input.roles) {
      const conversationId = randomUUID();
      const employeeId = randomUUID();
      await trx.insertInto("conversations").values({ id: conversationId, company_id: input.companyId, kind: "dm", name: role.jobTitle }).execute();
      await trx
        .insertInto("employees")
        .values({ id: employeeId, company_id: input.companyId, conversation_id: conversationId, job_title: role.jobTitle, department: role.department, mission: role.mission })
        .execute();
      // ensure the department exists
      await trx
        .insertInto("departments")
        .values({ id: randomUUID(), company_id: input.companyId, name: role.department, position: 0 })
        .onConflict((oc) => oc.columns(["company_id", "name"]).doNothing())
        .execute();
    }

    for (const name of input.channels) {
      const clean = name.replace(/^#/, "").trim();
      if (!clean || clean === "general") continue;
      await trx.insertInto("conversations").values({ id: randomUUID(), company_id: input.companyId, kind: "channel", name: clean }).execute();
    }

    await emit({ companyId: input.companyId, type: "company.onboarded", subjectId: input.companyId, actor: { kind: "user" }, payload: { roles: input.roles.length, channels: input.channels.length } });
  });
  return { ok: true };
}
