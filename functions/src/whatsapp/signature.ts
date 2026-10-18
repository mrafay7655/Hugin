import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256(rawBody, appSecret).
 * Must be computed over the RAW request bytes, not re-serialized JSON. Constant-time compare.
 */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [scheme, hex] = header.split("=");
  if (scheme !== "sha256" || !hex || !/^[0-9a-f]+$/i.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Computes the header value. Used by tests and the local replay script. */
export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
