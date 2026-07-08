/**
 * All employees transitively managed by `rootId` (i.e. its full reporting subtree),
 * walked via BFS over `manager_employee_id`. A same-immediate-report check alone
 * (`e.manager_employee_id !== rootId`) only blocks a 1-hop cycle — A managing C who
 * already reports (via B) to A is a 2-hop cycle that check lets straight through
 * (report §4.1). Extracted from EmployeeSettingsPanel.tsx into its own testable,
 * dependency-free module (report §8).
 */
export function descendantIds(
  rootId: string,
  employees: { id: string; manager_employee_id: string | null }[],
): Set<string> {
  const byManager = new Map<string, string[]>();
  for (const e of employees) {
    if (!e.manager_employee_id) continue;
    const list = byManager.get(e.manager_employee_id);
    if (list) list.push(e.id);
    else byManager.set(e.manager_employee_id, [e.id]);
  }
  const seen = new Set<string>();
  const queue = [...(byManager.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byManager.get(id) ?? []));
  }
  return seen;
}
