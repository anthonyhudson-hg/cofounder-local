import * as readline from "node:readline";
import type { RuntimeInbound, RuntimeOutbound } from "@shared/protocol";
import { createRuntimeContext } from "./context";
import { dispatch, PROTOCOL_VERSION, validateInbound } from "./dispatch";
import { ensureBootstrap } from "../domains/companies/service";
import "../domains/register";

/** Best-effort id extraction from an otherwise-unvalidated parsed payload, so a
 *  malformed-but-id-bearing message still gets a correlatable result instead of
 *  falling back to "unknown" unnecessarily (report §3.3). */
function extractId(value: unknown): string {
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return "unknown";
}

/**
 * The agent runtime entry point. Owns SQLite, boots migrations, and serves the
 * newline-delimited JSON protocol over stdin/stdout. The Rust host pipes client
 * Commands/Queries in and broadcasts Events/Results out. This is the sole
 * backend process — the earlier client-orchestrated sidecar was fully retired.
 */

function write(out: RuntimeOutbound): void {
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function main(): Promise<void> {
  const ctx = createRuntimeContext();
  const m = ctx.migration;
  process.stderr.write(
    `[runtime] db=${ctx.dbPath} schema=v${m.schemaVersion} ` +
      `applied=[${m.applied.join(",")}] baselined=[${m.baselined.join(",")}]\n`,
  );

  // Broadcast every committed domain event to the client.
  ctx.bus.subscribe((event) => write(event));

  await ensureBootstrap(ctx);

  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      write({ kind: "result", id: "unknown", ok: false, error: { message: `bad JSON: ${String(err)}` } });
      return;
    }

    if (!validateInbound(parsed)) {
      // Previously this cast straight to RuntimeInbound with no check; a malformed
      // message with a missing/non-string `id` would make JSON.stringify silently
      // omit the `id` key from the result envelope below, so the client could never
      // correlate the response and just hung forever. Extract whatever id we can so
      // at least id-bearing malformed messages still get a correlatable error back
      // (report §1.4/§3.3).
      write({
        kind: "result",
        id: extractId(parsed),
        ok: false,
        error: { message: `malformed inbound message: ${trimmed.slice(0, 200)}` },
      });
      return;
    }
    const inbound: RuntimeInbound = parsed;

    const sink = {
      delta(channel: string, data: unknown) {
        write({ kind: "delta", id: inbound.id, channel, data });
      },
    };

    try {
      const data = await dispatch(ctx, inbound, sink);
      write({ kind: "result", id: inbound.id, ok: true, data });
    } catch (err) {
      write({
        kind: "result",
        id: inbound.id,
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  rl.on("close", () => {
    ctx.db.destroy().finally(() => process.exit(0));
  });

  write({ kind: "ready", protocolVersion: PROTOCOL_VERSION });
}

main().catch((err) => {
  process.stderr.write(`[runtime] fatal: ${String(err)}\n`);
  process.exit(1);
});
