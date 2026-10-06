import { z } from "zod";

/**
 * Contract between this portal and the backend that owns signature requests.
 * See docs/API.md: the backend (Laravel) must implement exactly these shapes.
 */

export const signatureStatuses = [
  "pending",
  "viewed",
  "signed",
  "declined",
  "expired",
  "canceled",
] as const;

export const SignatureStatus = z.enum(signatureStatuses);
export type SignatureStatus = z.infer<typeof SignatureStatus>;

/** Live state of a request. Static data (title, signer, document) comes from the link itself. */
export const SignatureRequest = z.object({
  id: z.string(),
  status: SignatureStatus,
  signed_at: z.string().nullable().optional(),
  declined_at: z.string().nullable().optional(),
  decline_reason: z.string().nullable().optional(),
});
export type SignatureRequest = z.infer<typeof SignatureRequest>;

export const SIGNATURE_PNG_PREFIX = "data:image/png;base64,";
/** ~500 KB of base64: a drawn signature is typically 10–60 KB. */
export const SIGNATURE_PNG_MAX_LENGTH = 700_000;

export const SignPayload = z.object({
  signer_name: z.string().trim().min(2).max(120),
  signature_png: z
    .string()
    .startsWith(SIGNATURE_PNG_PREFIX)
    .max(SIGNATURE_PNG_MAX_LENGTH),
  consent: z.literal(true),
  /** Hash of the document the signer was shown; backend rejects with 409 if it changed. */
  document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SignPayload = z.infer<typeof SignPayload>;

export const DeclinePayload = z.object({
  reason: z.string().trim().max(1000).nullable(),
});
export type DeclinePayload = z.infer<typeof DeclinePayload>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** Statuses on which the signer can still act. */
export function isActionable(status: SignatureStatus): boolean {
  return status === "pending" || status === "viewed";
}
