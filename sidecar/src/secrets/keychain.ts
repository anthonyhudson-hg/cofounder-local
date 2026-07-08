import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveDbPath } from "../db/index";

const SERVICE = "com.cofounder.local";
const ACCOUNT = "master-key";

let cachedKey: Buffer | null = null;

/**
 * Returns the 32-byte master key that encrypts all secrets at rest, creating it
 * on first use. Primary store is the OS keychain (@napi-rs/keyring); if the
 * platform keychain is unavailable it falls back to a 0600 key file beside the
 * DB so dev/headless still works. The key never leaves the device. Resolved once
 * and cached in-process — every seal/open used to re-hit the OS keychain (report §2.1).
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = resolveMasterKey();
  return cachedKey;
}

function resolveMasterKey(): Buffer {
  try {
    // Lazy require so a missing/failed native binding degrades to the file store.
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    const entry = new Entry(SERVICE, ACCOUNT);
    let b64: string | null = null;
    try {
      b64 = entry.getPassword();
    } catch {
      b64 = null;
    }
    if (!b64) {
      b64 = withKeyCreationLock(() => {
        // Re-check inside the lock: another process may have created it first.
        const existing = tryGetPassword(entry);
        if (existing) return existing;
        const fresh = randomBytes(32).toString("base64");
        entry.setPassword(fresh);
        return fresh;
      });
    }
    return Buffer.from(b64, "base64");
  } catch (err) {
    // A genuine keychain failure (permission prompt denied, locked credential store,
    // missing native binding) silently downgraded secret storage with zero diagnostic
    // trail before this — at minimum log why (report §2.1).
    process.stderr.write(
      `[keychain] OS keychain unavailable, falling back to key file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return getMasterKeyFromFile();
  }
}

function tryGetPassword(entry: { getPassword(): string | null }): string | null {
  try {
    return entry.getPassword();
  } catch {
    return null;
  }
}

function keyFilePath(): string {
  // Was `os.tmpdir()` by default — an OS-cleanable directory (Disk Cleanup, temp-file
  // cleaners, container restarts). If that file were ever wiped, every row in `secrets`
  // (GitHub PAT, provider API keys) becomes permanently undecryptable. Default to the
  // same stable, already-resolved app-config directory the DB itself lives in (report §2.1).
  const dir = process.env.COFOUNDER_KEY_DIR || path.dirname(resolveDbPath());
  return path.join(dir, ".cofounder-master.key");
}

function lockFilePath(): string {
  return `${keyFilePath()}.lock`;
}

/**
 * Serializes first-time master-key creation across processes via an O_EXCL lock file,
 * so two sidecar processes racing on a fresh profile can't clobber each other's
 * generated key and permanently orphan anything sealed with the loser's key (report §2.1).
 */
function withKeyCreationLock<T>(fn: () => T): T {
  const lockPath = lockFilePath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | null = null;
  const deadline = Date.now() + 5000;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // Stale lock from a crashed process — take it over rather than hanging forever.
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      blockingSleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getMasterKeyFromFile(): Buffer {
  const file = keyFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  return withKeyCreationLock(() => {
    if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    const key = randomBytes(32);
    fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    return key;
  });
}
