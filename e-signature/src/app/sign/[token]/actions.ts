"use server";

import { redirect } from "next/navigation";
import { decodeLink } from "@/lib/link-token";
import { decline, sign, SignatureApiError } from "@/lib/signature-api/client";
import { DeclinePayload, SignPayload } from "@/lib/signature-api/types";

export type ActionState = { error: string | null };

/**
 * The link is the signer's only credential: it is decrypted and checked again here (never
 * trusted from the page), and the backend enforces status, expiry and the document hash.
 */

function messageFor(e: unknown): string {
  if (e instanceof SignatureApiError) {
    if (e.status === 409 && e.code === "document_changed") {
      return "Le document a été modifié entre-temps. Rechargez la page pour voir la dernière version.";
    }
    if (e.status === 409 || e.status === 410 || e.status === 404 || e.status === 403) return e.message;
    if (e.status === 422) return "Certaines informations sont invalides. Vérifiez le formulaire.";
  }
  console.error(e);
  return "Une erreur est survenue. Réessayez dans un instant.";
}

function readLink(token: string) {
  const link = decodeLink(token);
  if (link.ok) return { payload: link.payload, error: null };
  return { payload: null, error: link.reason === "expired" ? "Ce lien a expiré." : "Lien de signature invalide." };
}

export async function signAction(token: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const { payload, error } = readLink(token);
  if (!payload) return { error };

  const parsed = SignPayload.safeParse({
    signer_name: form.get("signer_name"),
    signature_png: form.get("signature_png"),
    consent: form.get("consent") === "on",
    // The hash comes from the authenticated link, not from the form.
    document_sha256: payload.document.sha256,
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => i.path[0]));
    if (fields.has("consent")) return { error: "Vous devez accepter le document pour le signer." };
    if (fields.has("signature_png")) return { error: "Veuillez dessiner votre signature." };
    if (fields.has("signer_name")) return { error: "Veuillez indiquer votre nom complet." };
    return { error: "Formulaire invalide." };
  }
  try {
    await sign(payload.rid, token, parsed.data);
  } catch (e) {
    return { error: messageFor(e) };
  }
  redirect(`/sign/${token}`);
}

export async function declineAction(token: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const { payload, error } = readLink(token);
  if (!payload) return { error };

  const parsed = DeclinePayload.safeParse({ reason: (form.get("reason") as string | null) || null });
  if (!parsed.success) return { error: "Le motif est trop long (1000 caractères max)." };
  try {
    await decline(payload.rid, token, parsed.data);
  } catch (e) {
    return { error: messageFor(e) };
  }
  redirect(`/sign/${token}`);
}
