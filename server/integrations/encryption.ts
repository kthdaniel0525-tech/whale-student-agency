import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { IntegrationError } from "./errors";
export interface TokenEncryptionService {
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}
/** Node/OpenSSL AES-256-GCM; unique nonce and authenticated context bind each
 * ciphertext to its user, record and purpose. Old key IDs enable staged rotation. */
export class AesTokenEncryptionService implements TokenEncryptionService {
  private readonly keys = new Map<string, Buffer>();
  constructor(keys: Record<string, string>, private readonly activeKeyId: string) {
    for (const [id, encoded] of Object.entries(keys)) {
      const key = Buffer.from(encoded, "base64");
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || key.length !== 32 || key.toString("base64") !== encoded)
        throw new IntegrationError("CONFIGURATION");
      this.keys.set(id, key);
    }
    if (!this.keys.has(activeKeyId)) throw new IntegrationError("CONFIGURATION");
  }
  encrypt(plaintext: string, context: string): string {
    try {
      if (!plaintext || plaintext.length > 65536 || !context) throw new Error();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeKeyId)!, nonce);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", this.activeKeyId, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
    } catch { throw new IntegrationError("ENCRYPTION_FAILURE"); }
  }
  decrypt(ciphertext: string, context: string): string {
    try {
      const [version, keyId, iv, tag, data, extra] = ciphertext.split(".");
      if (version !== "v1" || extra !== undefined || !context || !this.keys.has(keyId) || !iv || !tag || !data || ciphertext.length > 100000) throw new Error();
      if (![iv, tag, data].every((value) => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value)) throw new Error();
      const nonce = Buffer.from(iv, "base64url"), authTag = Buffer.from(tag, "base64url");
      if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.keys.get(keyId)!, nonce);
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch { throw new IntegrationError("ENCRYPTION_FAILURE"); }
  }
}
export function getTokenEncryptionService(): TokenEncryptionService {
  try {
    const keys: unknown = JSON.parse(process.env.INTEGRATION_TOKEN_KEYS ?? "{}");
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || !Object.values(keys).every((value) => typeof value === "string")) throw new Error();
    return new AesTokenEncryptionService(keys as Record<string, string>, process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID ?? "v1");
  } catch { throw new IntegrationError("CONFIGURATION"); }
}
export const credentialContext = (userId: string, provider: string, id: string, purpose: string) =>
  JSON.stringify(["integration-v1", userId, provider, id, purpose]);
