import type { RuntimeContext } from "../../runtime/context";
import { getProvider, drainTurn, type AgentProvider } from "../../providers";
import { preferredProvider, UTILITY_MODEL } from "../../providers/availability";
import { extractJson } from "../../runtime/parseJson";

/**
 * One fully-fleshed candidate persona for a role. Deliberately name/gender-neutral
 * and written in the second person (like `persona_examples/**`) so the frontend can
 * pair it with any silly name + photo without the prose contradicting them.
 */
export interface PersonaCandidate {
  /** Short display label for the card, e.g. "Methodical & data-driven". */
  personalityLabel: string;
  /** One-line pitch shown under the name on the card. */
  summary: string;
  mission: string;
  /** The system-prompt body: personality, working style, voice, judgment. */
  preamble: string;
  responsibilities: string[];
  additionalDetails: string;
  // Agent-profile fields (the "Personality & autonomy" panel).
  personality: string;
  communicationStyle: string;
  expertise: string[];
}

export interface GenerateCandidatesInput {
  companyId: string;
  jobTitle: string;
  department: string;
  count?: number;
}

function normalizeCandidate(raw: Partial<PersonaCandidate>): PersonaCandidate {
  return {
    personalityLabel: String(raw.personalityLabel ?? "").trim() || "Balanced generalist",
    summary: String(raw.summary ?? "").trim(),
    mission: String(raw.mission ?? "").trim(),
    preamble: String(raw.preamble ?? "").trim(),
    responsibilities: Array.isArray(raw.responsibilities)
      ? raw.responsibilities.map((r) => String(r).trim()).filter(Boolean).slice(0, 8)
      : [],
    additionalDetails: String(raw.additionalDetails ?? "").trim(),
    personality: String(raw.personality ?? "").trim(),
    communicationStyle: String(raw.communicationStyle ?? "").trim(),
    expertise: Array.isArray(raw.expertise)
      ? raw.expertise.map((e) => String(e).trim()).filter(Boolean).slice(0, 8)
      : [],
  };
}

/**
 * Deterministic fallback used when the model is unavailable or returns junk, so the
 * hiring UI always has `count` distinct, usable candidates. Three stock archetypes
 * differentiated by working style, specialized to the given job title/department.
 */
export function fallbackCandidates(jobTitle: string, department: string, count: number): PersonaCandidate[] {
  const title = jobTitle.trim() || "Team Member";
  const dept = department.trim() || "the team";
  const archetypes: Array<{
    label: string;
    style: string;
    extra: string;
    personality: string;
    communicationStyle: string;
  }> = [
    {
      label: "Methodical & data-driven",
      style:
        "You are rigorous and evidence-led. You slow down to get the facts straight, quantify trade-offs, and prefer a well-reasoned recommendation over a fast guess. You flag assumptions explicitly and say when you're uncertain.",
      extra: "Bias toward structured analysis and clear written reasoning. Surface risks early rather than late.",
      personality: "Analytical, calm, and precise. Values getting it right over getting it fast, and is candid about uncertainty.",
      communicationStyle: "Structured and thorough — leads with the recommendation, then the reasoning and the data behind it.",
    },
    {
      label: "Bold & decisive",
      style:
        "You are action-oriented and opinionated. You make the call with the information available, state your recommendation plainly, and optimize for momentum. You right-size your confidence to how reversible a decision is.",
      extra: "Bias toward shipping and iterating. Escalate only the genuinely one-way-door decisions.",
      personality: "Direct, confident, and momentum-driven. Comfortable making the call and owning it.",
      communicationStyle: "Short and punchy — a clear recommendation up front, minimal hedging, bullets over prose.",
    },
    {
      label: "Collaborative & consensus-building",
      style:
        "You are people-first and communicative. You bring stakeholders along, translate between functions, and make sure decisions stick because the people affected understood the why. You default to over-communicating.",
      extra: "Bias toward alignment and clear handoffs. Name who else needs to be in the loop.",
      personality: "Warm, diplomatic, and context-aware. Reads the room and keeps everyone aligned.",
      communicationStyle: "Friendly and explanatory — asks clarifying questions first, then lays out the why so decisions stick.",
    },
  ];
  return archetypes.slice(0, count).map((a) => ({
    personalityLabel: a.label,
    summary: `A ${a.label.toLowerCase()} ${title.toLowerCase()}.`,
    mission: `Own the ${title} function in ${dept} and make it excellent — proactively, with good judgment about what needs the founder's attention.`,
    preamble: `You are the ${title} in the ${dept} department. ${a.style} Be direct and concise, and use good judgment about what genuinely needs the founder's attention versus what you should just handle.`,
    responsibilities: [
      `Own the core ${title} work end to end`,
      `Keep the founder informed on what matters and decide the rest yourself`,
      `Partner with the rest of ${dept} and adjacent functions`,
      `Flag risks and blockers early, with a recommended path`,
    ],
    additionalDetails: a.extra,
    personality: a.personality,
    communicationStyle: a.communicationStyle,
    expertise: [title, dept].filter((s) => s && s !== "the team"),
  }));
}

/**
 * Generates `count` (default 3) DISTINCT, fully-populated candidate personas for a
 * job title, using the founder's company context. Same provider pattern as
 * `generateOnboarding`; falls back to deterministic archetypes on any failure.
 */
export async function generateCandidates(
  ctx: RuntimeContext,
  input: GenerateCandidatesInput,
  // Test seam: inject a provider so the LLM path can be exercised without a live
  // model call (mirrors sendMessage's providerOverride). Defaults to the real one.
  providerOverride?: AgentProvider,
): Promise<PersonaCandidate[]> {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);
  const jobTitle = input.jobTitle.trim();
  const department = input.department.trim();

  const company = await ctx.db
    .selectFrom("companies")
    .where("id", "=", input.companyId)
    .select(["profile", "system_prompt"])
    .executeTakeFirst();

  const system = [
    `You are helping a founder hire an AI employee for the role of "${jobTitle}"${department ? ` in the ${department} department` : ""}.`,
    `Return ONLY a JSON array of exactly ${count} candidate personas. Each element:`,
    `{"personalityLabel": string, "summary": string, "mission": string, "preamble": string, "responsibilities": [string], "additionalDetails": string, "personality": string, "communicationStyle": string, "expertise": [string]}`,
    "- The candidates must be GENUINELY DIFFERENT from each other: distinct personality, working style, temperament, and approach to the job. Not three phrasings of the same person.",
    "- personalityLabel: a short 2-4 word tag for the card (e.g. 'Methodical & data-driven', 'Bold operator', 'Warm consensus-builder').",
    "- summary: one punchy line (<= 120 chars) capturing this candidate's flavor.",
    "- mission: 1-2 sentences on what this person is accountable for.",
    "- preamble: the system-prompt body (4-8 sentences) that gives the employee its personality, working style, voice, and judgment for THIS role. Write in the SECOND PERSON ('You are ...'). Do NOT invent or reference a personal name, gender, or pronouns for the employee — it will be assigned separately.",
    "- responsibilities: 4-8 concrete, role-specific core responsibilities (short imperative phrases).",
    "- additionalDetails: 1-3 sentences of extra operating guidance (how they collaborate, escalate, or communicate).",
    "- personality: 1-2 sentences on how this employee comes across (e.g. blunt and dry, warm and encouraging, methodical). Third person or adjectives, NOT second person.",
    "- communicationStyle: 1 sentence on how they communicate (e.g. short messages, bullet points over prose, asks clarifying questions first).",
    "- expertise: 3-6 short areas of expertise relevant to this role (single words or short phrases).",
    "Be specific to the role and the company. Make each candidate feel like a real, distinct hire.",
    company?.profile ? `\nCompany: ${company.profile}` : "",
    company?.system_prompt ? `Company operating principles: ${company.system_prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = JSON.stringify({ jobTitle, department }, null, 2);

  try {
    let raw = "";
    const provider = preferredProvider();
    const agent = providerOverride ?? getProvider(provider);
    await drainTurn(
      agent.runTurn({ model: UTILITY_MODEL[provider], effort: "medium", systemPrompt: system, prompt }),
      (chunk) => {
        if (chunk.kind === "text") raw += chunk.text;
      },
    );
    const parsed = JSON.parse(extractJson(raw)) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [];
    const candidates = arr
      .filter((c): c is Partial<PersonaCandidate> => !!c && typeof c === "object")
      .map(normalizeCandidate)
      .filter((c) => c.preamble && c.mission)
      .slice(0, count);
    // If the model under-delivered (too few usable candidates), top up deterministically
    // so the UI always shows a full set of `count`.
    if (candidates.length < count) {
      const filler = fallbackCandidates(jobTitle, department, count).slice(candidates.length);
      candidates.push(...filler.slice(0, count - candidates.length));
    }
    return candidates;
  } catch {
    return fallbackCandidates(jobTitle, department, count);
  }
}
