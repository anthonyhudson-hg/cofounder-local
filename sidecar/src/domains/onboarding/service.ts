import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { getProvider, drainTurn } from "../../providers";
import { preferredProvider, UTILITY_MODEL } from "../../providers/availability";
import { nextPositionAfter } from "../../runtime/position";
import { extractJson } from "../../runtime/parseJson";
import { insertFullEmployee } from "../employees/service";

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
 * Uses whichever provider is configured (see preferredProvider); falls back to a
 * deterministic heuristic if the model is unavailable or returns unparseable output.
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
    const provider = preferredProvider();
    await drainTurn(
      getProvider(provider).runTurn({ model: UTILITY_MODEL[provider], effort: "medium", systemPrompt: system, prompt }),
      (chunk) => {
        if (chunk.kind === "text") raw += chunk.text;
      },
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

/**
 * A role the founder actually chose to hire during onboarding — i.e. a picked
 * candidate. Unlike `SuggestedRole` (the suggestion), this carries the full persona
 * so onboarding produces employees identical to the Hire flow.
 */
export interface HiredCandidateRole {
  jobTitle: string;
  department: string;
  name: string;
  avatar: string | null;
  mission: string;
  preamble: string;
  additionalDetails: string;
  responsibilities: string[];
  personality: string;
  communicationStyle: string;
  expertise: string[];
}

export interface ApplyOnboardingInput {
  companyId: string;
  companyName: string;
  profile: string;
  systemPrompt: string;
  roles: HiredCandidateRole[];
  channels: string[];
}

/**
 * Persists the finalized onboarding: company profile/prompt/name, hires, channels; marks onboarded.
 * Returns the DM conversation ids of the newly-created employees so the client can surface them
 * immediately — freshly-created employees have no messages, and the sidebar's DM list hides
 * message-less DMs, so without this the whole hired cohort would be invisible after onboarding.
 */
export async function applyOnboarding(
  ctx: RuntimeContext,
  input: ApplyOnboardingInput,
): Promise<{ ok: true; conversationIds: string[] }> {
  const newConversationIds: string[] = [];
  await mutate(ctx, async (trx, emit) => {
    const updated = await trx
      .updateTable("companies")
      .set({ name: input.companyName || "My Company", profile: input.profile, system_prompt: input.systemPrompt, onboarded: 1 })
      .where("id", "=", input.companyId)
      .executeTakeFirst();
    if (!updated.numUpdatedRows) throw new Error(`company ${input.companyId} not found`);

    // Every NEW department previously got the literal position 0 — colliding with the
    // "Executive" department already seeded at position 0 by company creation — instead
    // of a distinct, increasing position like createDepartment computes elsewhere
    // (report §4.3).
    const maxPos = await trx
      .selectFrom("departments")
      .where("company_id", "=", input.companyId)
      .select(trx.fn.max("position").as("m"))
      .executeTakeFirst();
    let nextPosition = nextPositionAfter(maxPos?.m);
    const assignedDepartmentPositions = new Set<string>();

    const newEmployeeIds: string[] = [];
    for (const role of input.roles) {
      // Same insert path as the Hire flow — a fully-populated employee (name, avatar,
      // persona, responsibilities), not a bare stub.
      const { conversationId, employeeId } = await insertFullEmployee(trx, {
        companyId: input.companyId,
        name: role.name || role.jobTitle,
        jobTitle: role.jobTitle,
        department: role.department,
        avatar: role.avatar ?? null,
        mission: role.mission,
        preamble: role.preamble,
        additionalDetails: role.additionalDetails,
        responsibilities: role.responsibilities,
        personality: role.personality,
        communicationStyle: role.communicationStyle,
        expertise: role.expertise,
      });
      newEmployeeIds.push(employeeId);
      newConversationIds.push(conversationId);

      // ensure the department exists
      if (!assignedDepartmentPositions.has(role.department)) {
        assignedDepartmentPositions.add(role.department);
        await trx
          .insertInto("departments")
          .values({ id: randomUUID(), company_id: input.companyId, name: role.department, position: nextPosition })
          .onConflict((oc) => oc.columns(["company_id", "name"]).doNothing())
          .execute();
        nextPosition += 1;
      }
    }

    const newChannelIds: string[] = [];
    for (const name of input.channels) {
      const clean = name.replace(/^#/, "").trim();
      if (!clean || clean === "general") continue;
      const channelId = randomUUID();
      await trx.insertInto("conversations").values({ id: channelId, company_id: input.companyId, kind: "channel", name: clean }).execute();
      newChannelIds.push(channelId);
    }

    // The suggestion step deliberately correlates suggested channels with the roles
    // being hired (e.g. an Engineering role suggests a "product" channel), but the
    // channel-creation loop above never added any of the new hires to them — an empty
    // channel undercuts the stated onboarding goal. Add every newly-hired employee to
    // every newly-created channel (report §4.4).
    for (const channelId of newChannelIds) {
      for (const employeeId of newEmployeeIds) {
        await trx.insertInto("channel_memberships").values({ id: randomUUID(), conversation_id: channelId, employee_id: employeeId }).execute();
      }
    }

    await emit({ companyId: input.companyId, type: "company.onboarded", subjectId: input.companyId, actor: { kind: "user" }, payload: { roles: input.roles.length, channels: input.channels.length } });
  });
  return { ok: true, conversationIds: newConversationIds };
}
