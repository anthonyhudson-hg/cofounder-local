import { Employee } from "../types";

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

export function composeSystemPrompt(
  companyProfile: string,
  companySystemPrompt: string,
  identityBlock: string,
  employee: Pick<Employee, "mission" | "preamble" | "additional_details">,
  responsibilities: string[],
): string {
  const parts: string[] = [];
  if (companyProfile.trim()) parts.push(`Company: ${companyProfile.trim()}`);
  if (companySystemPrompt.trim()) parts.push(companySystemPrompt.trim());
  if (identityBlock.trim()) parts.push(identityBlock.trim());
  if (employee.mission.trim()) parts.push(`Mission: ${employee.mission.trim()}`);
  if (employee.preamble.trim()) parts.push(employee.preamble.trim());
  if (responsibilities.length) {
    parts.push(`Core responsibilities:\n${responsibilities.map((r) => `- ${r}`).join("\n")}`);
  }
  if (employee.additional_details.trim()) parts.push(employee.additional_details.trim());
  parts.push(FORMATTING_GUIDANCE);
  return parts.join("\n\n");
}
