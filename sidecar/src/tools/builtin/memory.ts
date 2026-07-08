import { randomUUID } from "node:crypto";
import { mutate } from "../../runtime/unitOfWork";
import { registerTool } from "../registry";
import type { Tool, ToolContext } from "../types";

type MemoryKind = "working" | "long" | "episodic" | "semantic";

interface WriteInput {
  key: string;
  value: string;
  kind?: MemoryKind;
}
interface ReadInput {
  key?: string;
  kind?: MemoryKind;
}

const memoryWrite: Tool<WriteInput, { ok: true }> = {
  name: "memory.write",
  scope: "tool:memory",
  effect: "write-internal",
  description: "Persist a durable memory entry (key/value) scoped to this agent.",
  async run(tc: ToolContext, input: WriteInput) {
    const kind = input.kind ?? "long";
    await mutate(tc.ctx, async (trx, emit) => {
      await trx
        .insertInto("agent_memory")
        .values({
          id: randomUUID(),
          company_id: tc.companyId,
          employee_id: tc.employeeId,
          kind,
          mem_key: input.key,
          value: input.value,
        })
        .onConflict((oc) =>
          oc
            .columns(["employee_id", "kind", "mem_key"])
            .doUpdateSet({ value: input.value, updated_at: new Date().toISOString() }),
        )
        .execute();
      await emit({
        companyId: tc.companyId,
        type: "memory.written",
        subjectId: tc.employeeId,
        actor: { kind: "employee", employeeId: tc.employeeId },
        payload: { key: input.key, kind },
        correlationId: tc.correlationId ?? null,
      });
    });
    return { ok: true };
  },
};

const memoryRead: Tool<ReadInput, { entries: { key: string; value: string; kind: string }[] }> = {
  name: "memory.read",
  scope: "tool:memory",
  effect: "read",
  description: "Read this agent's memory entries, optionally filtered by key/kind.",
  async run(tc: ToolContext, input: ReadInput) {
    let q = tc.ctx.db
      .selectFrom("agent_memory")
      .where("company_id", "=", tc.companyId)
      .where("employee_id", "=", tc.employeeId)
      .select(["mem_key", "value", "kind"]);
    if (input.key) q = q.where("mem_key", "=", input.key);
    if (input.kind) q = q.where("kind", "=", input.kind);
    const rows = await q.orderBy("updated_at", "desc").execute();
    return { entries: rows.map((r) => ({ key: r.mem_key, value: r.value, kind: r.kind })) };
  },
};

export function registerMemoryTools(): void {
  registerTool(memoryWrite);
  registerTool(memoryRead);
}
