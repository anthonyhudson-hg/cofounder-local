import * as readline from "node:readline";
import type { RuntimeInbound, RuntimeOutbound } from "@shared/protocol";
import { createRuntimeContext } from "./context";
import { dispatch, PROTOCOL_VERSION } from "./dispatch";
import { ensureBootstrap } from "../domains/companies/service";
import "../domains/register";

/**
 * The agent runtime entry point (refactor #2). Owns SQLite, boots migrations,
 * and serves the newline-delimited JSON protocol over stdin/stdout. The Rust
 * host pipes client Commands/Queries in and broadcasts Events/Results out.
 *
 * NOTE: during the strangler transition this runs ALONGSIDE the legacy
 * `index.ts` handlers; domains move over one at a time until this is the only
 * entry point.
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

    let inbound: RuntimeInbound;
    try {
      inbound = JSON.parse(trimmed) as RuntimeInbound;
    } catch (err) {
      write({ kind: "result", id: "unknown", ok: false, error: { message: `bad JSON: ${String(err)}` } });
      return;
    }

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
