// Callback signatures and API key checks for the ATC24Academy integration.
import crypto from "node:crypto";
import { sha256 } from "../crypto";

/** X-Sweatbox-Signature for a callback: "sha256=" + hex HMAC-SHA256(secret, "<timestamp>.<raw body>"). */
export function signCallback(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Hex SHA-256 of an API key: the form ACADEMY_API_KEY_HASH stores. */
export const hashApiKey = (key: string): string => sha256(key);

/** Does `key` hash to one of `hashes`? Constant time in the key (only fixed-length hashes are compared). */
export function apiKeyMatches(key: string, hashes: readonly string[]): boolean {
  const got = Buffer.from(hashApiKey(key), "hex");
  let ok = false;
  for (const h of hashes) {
    const want = Buffer.from(h, "hex");
    if (want.length === got.length && crypto.timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}
