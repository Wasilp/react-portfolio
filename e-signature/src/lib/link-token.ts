import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Signing links carry an encrypted, authenticated payload issued by the backend:
 *
 *   /sign/v1.<iv>.<ciphertext>.<tag>        (each part base64url)
 *
 * AES-256-GCM with a key shared with the backend (ESIGN_LINK_KEY, 32 bytes base64) and the
 * fixed AAD "esign.v1". GCM gives both confidentiality (the signer's email and the document URL
 * are not readable in the link) and integrity (any altered byte fails the tag check).
 * See docs/API.md §2 for the PHP side.
 */

const VERSION = "v1";
const AAD = Buffer.from("esign.v1");
const MAX_TOKEN_LENGTH = 4096;
const PART = /^[A-Za-z0-9_-]+$/;

export const LinkPayload = z.object({
  v: z.literal(1),
  /** Signature request id on the backend. */
  rid: z.string().min(1).max(100),
  /** Expiry, unix seconds. */
  exp: z.number().int(),
  iat: z.number().int().optional(),
  title: z.string().min(1).max(200),
  message: z.string().max(2000).nullish(),
  issuer: z.object({ name: z.string().min(1).max(200), logo_url: z.string().url().nullish() }),
  signer: z.object({ name: z.string().min(1).max(120), email: z.string().email() }),
  document: z.object({
    url: z.string().url(),
    filename: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export type LinkPayload = z.infer<typeof LinkPayload>;

export type DecodeResult =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired"; payload: LinkPayload };

function key(): Buffer {
  const raw = process.env.ESIGN_LINK_KEY;
  if (!raw) throw new Error("ESIGN_LINK_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("ESIGN_LINK_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function decodeLink(token: string, now = Date.now()): DecodeResult {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART.test(p))) {
    return { ok: false, reason: "invalid" };
  }
  const [iv, ciphertext, tag] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) return { ok: false, reason: "invalid" };

  let json: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if tampered
    json = JSON.parse(plain.toString("utf8"));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("ESIGN_LINK_KEY")) throw e;
    return { ok: false, reason: "invalid" };
  }

  const parsed = LinkPayload.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.exp * 1000 <= now) return { ok: false, reason: "expired", payload: parsed.data };
  return { ok: true, payload: parsed.data };
}

/** Used by the mock backend and tests; the real backend encodes in PHP (docs/API.md). */
export function encodeLink(payload: LinkPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/**
 * The portal fetches the document server-side from the URL in the link. Only origins listed in
 * DOCUMENT_ALLOWED_ORIGINS are fetched, so a forged-looking link can't make the server call
 * arbitrary hosts (SSRF), even though the GCM tag already makes forging impractical.
 */
export function isAllowedDocumentUrl(url: string): boolean {
  const allowed = (process.env.DOCUMENT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && allowed.includes(u.origin);
  } catch {
    return false;
  }
}
