import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { RuntimeContext } from "../runtime/context";
import { mutate } from "../runtime/unitOfWork";
import { getMasterKey } from "./keychain";

const ALGO = "aes-256-gcm";

interface Sealed {
  ciphertext: string; // base64(encrypted || authTag)
  nonce: string; // base64(12-byte iv)
}

function seal(plaintext: string): Sealed {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]).toString("base64"), nonce: iv.toString("base64") };
}

function open(sealed: Sealed): string {
  const key = getMasterKey();
  const iv = Buffer.from(sealed.nonce, "base64");
  const blob = Buffer.from(sealed.ciphertext, "base64");
  const tag = blob.subarray(blob.length - 16);
  const enc = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * Stores a company-scoped secret encrypted at rest (refactor #9). Emits
 * secret.stored (name only — never the plaintext). Used for connector OAuth
 * tokens, PATs, provider API keys.
 */
export async function storeSecret(
  ctx: RuntimeContext,
  companyId: string,
  name: string,
  plaintext: string,
): Promise<void> {
  const sealed = seal(plaintext);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("secrets")
      .values({ id: randomUUID(), company_id: companyId, name, ciphertext: sealed.ciphertext, nonce: sealed.nonce })
      .onConflict((oc) =>
        oc
          .columns(["company_id", "name"])
          .doUpdateSet({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, updated_at: new Date().toISOString() }),
      )
      .execute();
    await emit({ companyId, type: "secret.stored", subjectId: name, actor: { kind: "user" }, payload: { name } });
  });
}

/** Decrypts and returns a company-scoped secret, or null if absent. */
export async function getSecret(ctx: RuntimeContext, companyId: string, name: string): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("secrets")
    .where("company_id", "=", companyId)
    .where("name", "=", name)
    .select(["ciphertext", "nonce"])
    .executeTakeFirst();
  if (!row) return null;
  return open({ ciphertext: row.ciphertext, nonce: row.nonce });
}
