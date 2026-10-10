// Small crypto helpers. SESSION_SIGNING_SECRET signs the OAuth state and encrypts stored Discord
// tokens (AES-256-GCM); session cookies are random tokens stored only as SHA-256 hashes.
import crypto from "node:crypto";

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

export class Secrets {
  private encKey: Buffer;
  private macKey: Buffer;

  constructor(secret: string) {
    this.encKey = crypto.createHash("sha256").update(`sweatbox:enc:${secret}`).digest();
    this.macKey = crypto.createHash("sha256").update(`sweatbox:mac:${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
  }

  /** null when the value was tampered with or encrypted with another secret. */
  decrypt(enc: string | null | undefined): string | null {
    if (!enc) return null;
    try {
      const buf = Buffer.from(enc, "base64url");
      const d = crypto.createDecipheriv("aes-256-gcm", this.encKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  sign(payload: string): string {
    const mac = crypto.createHmac("sha256", this.macKey).update(payload).digest("base64url");
    return `${Buffer.from(payload).toString("base64url")}.${mac}`;
  }

  /** The payload, or null when the signature is wrong. */
  verify(signed: string): string | null {
    const [b64, mac] = signed.split(".");
    if (!b64 || !mac) return null;
    const payload = Buffer.from(b64, "base64url").toString("utf8");
    const expect = crypto.createHmac("sha256", this.macKey).update(payload).digest();
    const got = Buffer.from(mac, "base64url");
    return got.length === expect.length && crypto.timingSafeEqual(got, expect) ? payload : null;
  }
}
