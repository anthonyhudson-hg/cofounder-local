import { mutate } from "../runtime/unitOfWork";
import { requestApproval } from "../domains/approvals/service";
import { evaluateCapability } from "./capability";
import { effectRank, type Effect, type Tool, type ToolContext } from "./types";

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

export interface CapabilityScope {
  scope: string;
  /** Highest effect any registered tool in this scope needs — the ceiling that's actually meaningful to grant. */
  maxEffect: Effect;
  /** Names of the tools sharing this scope, for a UI hint (e.g. "memory.read, memory.write"). */
  tools: string[];
}

/**
 * Distinct grantable scopes across every registered tool, for a Permissions
 * UI that shouldn't have to hardcode scope names — new tools/connectors
 * automatically show up here the moment they're registered.
 */
export function listScopes(): CapabilityScope[] {
  const byScope = new Map<string, CapabilityScope>();
  for (const tool of registry.values()) {
    const existing = byScope.get(tool.scope);
    if (!existing) {
      byScope.set(tool.scope, { scope: tool.scope, maxEffect: tool.effect, tools: [tool.name] });
      continue;
    }
    existing.tools.push(tool.name);
    if (effectRank(tool.effect) > effectRank(existing.maxEffect)) existing.maxEffect = tool.effect;
  }
  return [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}

export type InvokeResult =
  | { status: "ok"; output: unknown }
  | { status: "approval"; approvalId: string };

/**
 * Invokes a tool THROUGH the capability gate (refactor #4). Emits tool.invoked,
 * tool.denied, tool.completed, and tool.failed for observability/audit. If the
 * action exceeds the agent's standing grant, a human approval is requested and the
 * call returns {status:'approval'} instead of executing — the tool runs later on
 * approval.
 */
export async function invokeTool(tc: ToolContext, name: string, input: unknown): Promise<InvokeResult> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  tool.validateInput?.(input);

  const decision = await evaluateCapability(tc.ctx, tc.employeeId, tool.scope, tool.effect);
  if (decision === "deny") {
    // Denied attempts (arguably the most security-relevant case) used to leave zero
    // audit trace — emit before throwing (report §3.4).
    await mutate(tc.ctx, async (_trx, emit) => {
      await emit({
        companyId: tc.companyId,
        type: "tool.denied",
        subjectId: name,
        actor: { kind: "employee", employeeId: tc.employeeId },
        payload: { tool: name, effect: tool.effect },
        correlationId: tc.correlationId ?? null,
      });
    });
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
    const extra = tool.describeForApproval ? await tool.describeForApproval(tc, input) : {};
    const detail =
      input && typeof input === "object" && !Array.isArray(input) ? { ...(input as object), ...extra } : input;
    const approvalId = await requestApproval(tc.ctx, {
      companyId: tc.companyId,
      employeeId: tc.employeeId,
      action: name,
      detail,
      correlationId: tc.correlationId ?? null,
    });
    return { status: "approval", approvalId };
  }

  const output = await runAndRecord(tc, tool, name, input, false);
  return { status: "ok", output };
}

/** Runs a tool bypassing the gate — used after a human approves the action. */
export async function runToolApproved(tc: ToolContext, name: string, input: unknown): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return runAndRecord(tc, tool, name, input, true);
}

/**
 * Runs `tool.run()` and records tool.completed/tool.failed. Previously a throw from
 * `tool.run()` propagated uncaught: `tool.invoked` was already durably committed, there
 * was no `tool.failed` event, and `tool.completed` never fired — a permanent
 * "invoked but never resolved" gap in the event log indistinguishable from "still
 * running" (report §3.4).
 */
async function runAndRecord(
  tc: ToolContext,
  tool: Tool,
  name: string,
  input: unknown,
  viaApproval: boolean,
): Promise<unknown> {
  let output: unknown;
  try {
    output = await tool.run(tc, input);
  } catch (err) {
    await mutate(tc.ctx, async (_trx, emit) => {
      await emit({
        companyId: tc.companyId,
        type: "tool.failed",
        subjectId: name,
        actor: { kind: "employee", employeeId: tc.employeeId },
        payload: { tool: name, viaApproval, error: err instanceof Error ? err.message : String(err) },
        correlationId: tc.correlationId ?? null,
      });
    });
    throw err;
  }

  await mutate(tc.ctx, async (_trx, emit) => {
    await emit({
      companyId: tc.companyId,
      type: "tool.completed",
      subjectId: name,
      actor: { kind: "employee", employeeId: tc.employeeId },
      payload: { tool: name, ok: true, viaApproval },
      correlationId: tc.correlationId ?? null,
    });
  });

  return output;
}
