import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

const SERVICE = "com.cofounder.local";
const ACCOUNT = "master-key";

/**
 * Returns the 32-byte master key that encrypts all secrets at rest, creating it
 * on first use. Primary store is the OS keychain (@napi-rs/keyring); if the
 * platform keychain is unavailable it falls back to a 0600 key file beside the
 * DB so dev/headless still works. The key never leaves the device.
 */
export function getMasterKey(): Buffer {
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
      b64 = randomBytes(32).toString("base64");
      entry.setPassword(b64);
    }
    return Buffer.from(b64, "base64");
  } catch {
    return getMasterKeyFromFile();
  }
}

function keyFilePath(): string {
  const dir = process.env.COFOUNDER_KEY_DIR || os.tmpdir();
  return path.join(dir, ".cofounder-master.key");
}

function getMasterKeyFromFile(): Buffer {
  const file = keyFilePath();
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  return key;
}
