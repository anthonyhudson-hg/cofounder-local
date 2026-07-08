import { randomUUID } from "node:crypto";
import { mutate } from "../../runtime/unitOfWork";
import { registerTool } from "../registry";
import type { Tool, ToolContext } from "../types";

export const MEMORY_KINDS = ["working", "long", "episodic", "semantic"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

interface WriteInput {
  key: string;
  value: string;
  kind?: MemoryKind;
}
interface ReadInput {
  key?: string;
  kind?: MemoryKind;
  limit?: number;
}

// No hard limit previously — a long-lived agent's accumulated memory could return an
// ever-growing, unbounded result (and token cost) from a single call (report §3.8).
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;

function validateWriteInput(input: unknown): void {
  if (!input || typeof input !== "object") throw new Error("memory.write: input must be an object");
  const { key, value, kind } = input as Partial<WriteInput>;
  if (typeof key !== "string" || !key.trim()) throw new Error("memory.write: 'key' must be a non-empty string");
  if (typeof value !== "string") throw new Error("memory.write: 'value' must be a string");
  if (kind !== undefined && !MEMORY_KINDS.includes(kind)) {
    throw new Error(`memory.write: 'kind' must be one of ${MEMORY_KINDS.join(", ")}`);
  }
}

function validateReadInput(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input !== "object") throw new Error("memory.read: input must be an object");
  const { key, kind, limit } = input as Partial<ReadInput>;
  if (key !== undefined && typeof key !== "string") throw new Error("memory.read: 'key' must be a string");
  if (kind !== undefined && !MEMORY_KINDS.includes(kind)) {
    throw new Error(`memory.read: 'kind' must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
    throw new Error("memory.read: 'limit' must be a positive number");
  }
}

const memoryWrite: Tool<WriteInput, { ok: true }> = {
  name: "memory.write",
  scope: "tool:memory",
  effect: "write-internal",
  description: "Persist a durable memory entry (key/value) scoped to this agent.",
  validateInput: validateWriteInput,
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
  description: "Read this agent's memory entries, optionally filtered by key/kind, newest first (default limit 200).",
  validateInput: validateReadInput,
  async run(tc: ToolContext, input: ReadInput) {
    let q = tc.ctx.db
      .selectFrom("agent_memory")
      .where("company_id", "=", tc.companyId)
      .where("employee_id", "=", tc.employeeId)
      .select(["mem_key", "value", "kind"]);
    if (input.key) q = q.where("mem_key", "=", input.key);
    if (input.kind) q = q.where("kind", "=", input.kind);
    const limit = Math.min(input.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const rows = await q.orderBy("updated_at", "desc").limit(limit).execute();
    return { entries: rows.map((r) => ({ key: r.mem_key, value: r.value, kind: r.kind })) };
  },
};

export function registerMemoryTools(): void {
  registerTool(memoryWrite);
  registerTool(memoryRead);
}
