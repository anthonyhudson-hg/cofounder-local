import { mutate } from "../runtime/unitOfWork";
import { requestApproval } from "../domains/approvals/service";
import { evaluateCapability } from "./capability";
import type { Tool, ToolContext } from "./types";

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(): Tool[] {
  return [...registry.values()];
}

export type InvokeResult =
  | { status: "ok"; output: unknown }
  | { status: "approval"; approvalId: string };

/**
 * Invokes a tool THROUGH the capability gate (refactor #4). Emits tool.invoked
 * and tool.completed for observability/audit. If the action exceeds the agent's
 * standing grant, a human approval is requested and the call returns
 * {status:'approval'} instead of executing — the tool runs later on approval.
 */
export async function invokeTool(tc: ToolContext, name: string, input: unknown): Promise<InvokeResult> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);

  const decision = await evaluateCapability(tc.ctx, tc.employeeId, tool.scope, tool.effect);
  if (decision === "deny") {
    throw new Error(`capability denied: ${tc.employeeId} may not use ${tool.scope} (${name})`);
  }

  await mutate(tc.ctx, async (_trx, emit) => {
    await emit({
      companyId: tc.companyId,
      type: "tool.invoked",
      subjectId: name,
      actor: { kind: "employee", employeeId: tc.employeeId },
      payload: { tool: name, effect: tool.effect, input },
      correlationId: tc.correlationId ?? null,
    });
  });

  if (decision === "approval") {
    const approvalId = await requestApproval(tc.ctx, {
      companyId: tc.companyId,
      employeeId: tc.employeeId,
      action: name,
      detail: input,
      correlationId: tc.correlationId ?? null,
    });
    return { status: "approval", approvalId };
  }

  const output = await tool.run(tc, input);

  await mutate(tc.ctx, async (_trx, emit) => {
    await emit({
      companyId: tc.companyId,
      type: "tool.completed",
      subjectId: name,
      actor: { kind: "employee", employeeId: tc.employeeId },
      payload: { tool: name, ok: true },
      correlationId: tc.correlationId ?? null,
    });
  });

  return { status: "ok", output };
}

/** Runs a tool bypassing the gate — used after a human approves the action. */
export async function runToolApproved(tc: ToolContext, name: string, input: unknown): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const output = await tool.run(tc, input);
  await mutate(tc.ctx, async (_trx, emit) => {
    await emit({
      companyId: tc.companyId,
      type: "tool.completed",
      subjectId: name,
      actor: { kind: "employee", employeeId: tc.employeeId },
      payload: { tool: name, ok: true, viaApproval: true },
      correlationId: tc.correlationId ?? null,
    });
  });
  return output;
}
