/**
 * Runtime-side prompt composition — ported verbatim from the client
 * src/lib/promptBuilder.ts so behavior is identical after the turn loop moves
 * into the runtime. Kept dependency-free.
 */

export function buildIdentityBlock(
  displayName: string,
  employee: { job_title: string; department: string },
  managerName: string,
): string {
  return `You are ${displayName}, ${employee.job_title} in the ${employee.department} department. You report to ${managerName}.`;
}

const FORMATTING_GUIDANCE =
  "Format your responses using lightweight Markdown where it genuinely helps readability — **bold** for key terms, bullet or numbered lists when enumerating multiple items, `code spans` for literal values, filenames, or commands, and short headings only for longer structured writeups (like a digest or report). Don't overformat simple conversational replies — a short answer doesn't need headers or bullets.";

export type AutonomyLevel = "suggest" | "act-with-approval" | "autonomous";

/**
 * What each autonomy level actually means to the model, in plain language.
 * This is prompt-level guidance only — it shapes how the agent *chooses* to
 * behave, it is not itself a security boundary. The real backstop for
 * "suggest" lives in tools/capability.ts's evaluateCapability(), which
 * downgrades an otherwise-allowed action to a human approval regardless of
 * what the model decides to do.
 */
const AUTONOMY_GUIDANCE: Record<AutonomyLevel, string> = {
  suggest:
    "Autonomy level: suggest. Propose actions and explain your reasoning, but avoid taking consequential actions (anything that changes state) without first describing your plan and getting explicit confirmation.",
  "act-with-approval":
    "Autonomy level: act with approval. Use your available tools to get work done directly. Actions beyond what you're currently granted will be held for a human to approve before they take effect — don't hesitate to attempt them.",
  autonomous:
    "Autonomy level: autonomous. Act independently to get work done using your available tools, without pausing to ask permission for actions you're already authorized to take.",
};

export interface AgentProfileForPrompt {
  personality: string;
  communicationStyle: string;
  expertise: string[];
  autonomyLevel: AutonomyLevel;
}

export function composeSystemPrompt(
  companyProfile: string,
  companySystemPrompt: string,
  identityBlock: string,
  employee: { mission: string; preamble: string; additional_details: string },
  responsibilities: string[],
  agentProfile?: AgentProfileForPrompt,
): string {
  const parts: string[] = [];
  if (companyProfile.trim()) parts.push(`Company: ${companyProfile.trim()}`);
  if (companySystemPrompt.trim()) parts.push(companySystemPrompt.trim());
  if (identityBlock.trim()) parts.push(identityBlock.trim());
  if (agentProfile?.personality.trim()) parts.push(`Personality: ${agentProfile.personality.trim()}`);
  if (agentProfile?.communicationStyle.trim()) parts.push(`Communication style: ${agentProfile.communicationStyle.trim()}`);
  if (agentProfile?.expertise.length) parts.push(`Areas of expertise: ${agentProfile.expertise.join(", ")}`);
  if (employee.mission.trim()) parts.push(`Mission: ${employee.mission.trim()}`);
  if (employee.preamble.trim()) parts.push(employee.preamble.trim());
  if (responsibilities.length) {
    parts.push(`Core responsibilities:\n${responsibilities.map((r) => `- ${r}`).join("\n")}`);
  }
  if (employee.additional_details.trim()) parts.push(employee.additional_details.trim());
  if (agentProfile) parts.push(AUTONOMY_GUIDANCE[agentProfile.autonomyLevel]);
  parts.push(FORMATTING_GUIDANCE);
  return parts.join("\n\n");
}
