import { AgentProfile, Employee } from "../types";

export function resolveManagerName(
  managerEmployeeId: string | null,
  employeesById: Record<string, { name: string }>,
  userFullName: string,
): string {
  if (!managerEmployeeId) return userFullName || "the founder";
  return employeesById[managerEmployeeId]?.name ?? (userFullName || "the founder");
}

export function buildIdentityBlock(
  displayName: string,
  employee: Pick<Employee, "job_title" | "department">,
  managerName: string,
): string {
  return `You are ${displayName}, ${employee.job_title} in the ${employee.department} department. You report to ${managerName}.`;
}

const FORMATTING_GUIDANCE =
  "Format your responses using lightweight Markdown where it genuinely helps readability — **bold** for key terms, bullet or numbered lists when enumerating multiple items, `code spans` for literal values, filenames, or commands, and short headings only for longer structured writeups (like a digest or report). Don't overformat simple conversational replies — a short answer doesn't need headers or bullets.";

// Server-side fork lives in sidecar/src/runtime/promptBuilder.ts — keep both in
// sync by hand (see CLAUDE.md). Kept here purely for EmployeeSettingsPanel's
// live "injected before this employee's prompt" preview.
const AUTONOMY_GUIDANCE: Record<AgentProfile["autonomyLevel"], string> = {
  suggest:
    "Autonomy level: suggest. Propose actions and explain your reasoning, but avoid taking consequential actions (anything that changes state) without first describing your plan and getting explicit confirmation.",
  "act-with-approval":
    "Autonomy level: act with approval. Use your available tools to get work done directly. Actions beyond what you're currently granted will be held for a human to approve before they take effect — don't hesitate to attempt them.",
  autonomous:
    "Autonomy level: autonomous. Act independently to get work done using your available tools, without pausing to ask permission for actions you're already authorized to take.",
};

export function composeSystemPrompt(
  companyProfile: string,
  companySystemPrompt: string,
  identityBlock: string,
  employee: Pick<Employee, "mission" | "preamble" | "additional_details">,
  responsibilities: string[],
  agentProfile?: AgentProfile,
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
