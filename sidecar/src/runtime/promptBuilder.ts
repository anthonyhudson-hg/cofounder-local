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

export function composeSystemPrompt(
  companyProfile: string,
  companySystemPrompt: string,
  identityBlock: string,
  employee: { mission: string; preamble: string; additional_details: string },
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
