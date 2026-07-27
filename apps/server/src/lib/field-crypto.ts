import crypto from "node:crypto";

/**
 * Reusable authenticated field-level encryption (AES-256-GCM).
 *
 * This is the general-purpose sibling of the tenant-secret wrap in
 * `lib/tenant.ts` — use it to encrypt individual sensitive column values
 * (push-subscription keys, attachment filenames, any non-searched PII) so
 * a leaked DB dump or a rogue-DBA read yields ciphertext, not plaintext.
 *
 * It does NOT protect searchable columns: because the server holds the
 * key, anything it can decrypt for a query it can also leak — and you
 * can't trigram-search ciphertext. Encrypt only columns you never query
 * by content. (For at-rest coverage WITHOUT losing search, use
 * storage-layer TDE — see docs/security/OPS_HARDENING.md.)
 *
 * Format:  `fenc1:<iv_b64url>:<ct_b64url>:<tag_b64url>`
 *   - AES-256-GCM, 32-byte key, fresh random 96-bit nonce per call, GCM
 *     16-byte auth tag. The version prefix lets us rotate scheme/params.
 *
 * The core `*WithKey` fns take an explicit 32-byte key so they're pure +
 * unit-testable. `encryptField`/`decryptField` pull the key from
 * `FIELD_ENCRYPTION_KEY` (base64, decoding to exactly 32 bytes). Keep it
 * DISTINCT from JWT_SECRET_ENCRYPTION_KEY (key separation by purpose).
 * When wiring this to real columns, add FIELD_ENCRYPTION_KEY to env.ts.
 */

const PREFIX = "fenc1";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the GCM standard

/** True if a stored value is a field-crypto ciphertext (vs legacy plaintext). */
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`field-crypto: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

export function decryptWithKey(blob: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`field-crypto: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("field-crypto: malformed ciphertext");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const ct = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error("field-crypto: malformed ciphertext");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag); // any tamper (ct/iv/tag) fails final()
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Load + validate the 32-byte field-encryption key from the environment. */
function fieldKey(): Buffer {
  const b64 = process.env["FIELD_ENCRYPTION_KEY"];
  if (!b64) {
    throw new Error(
      "field-crypto: FIELD_ENCRYPTION_KEY is not set (base64 32-byte key; generate with `openssl rand -base64 32`)",
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("field-crypto: FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** Encrypt a column value using the env-configured key. */
export function encryptField(plaintext: string): string {
  return encryptWithKey(plaintext, fieldKey());
}

/**
 * Decrypt a column value. Legacy/plaintext values (no `fenc1:` prefix)
 * are returned as-is so a gradual backfill migration reads cleanly.
 */
export function decryptField(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  return decryptWithKey(stored, fieldKey());
}

/** Whether field encryption is configured (FIELD_ENCRYPTION_KEY present). */
export function isFieldCryptoEnabled(): boolean {
  return Boolean(process.env["FIELD_ENCRYPTION_KEY"]);
}

/**
 * Encrypt when a key is configured, else return plaintext unchanged. Lets a
 * deployment opt into field encryption WITHOUT a data migration: existing
 * plaintext rows keep working (`decryptField` passes them through), and new
 * writes become ciphertext once the key is set. Backfill of old rows is
 * optional and can run lazily.
 */
export function encryptFieldIfEnabled(plaintext: string): string {
  return isFieldCryptoEnabled() ? encryptField(plaintext) : plaintext;
}
