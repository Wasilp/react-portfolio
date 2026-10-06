import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { SignatureRequest, SignatureStatus } from "@/lib/signature-api/types";
import { renderSamplePdf, renderSignedPdf } from "./pdf";

/**
 * In-memory stand-in for the real backend (Laravel). Reference behaviour for the API contract
 * in docs/API.md. Data lives on globalThis and is lost on restart.
 */

export type MockEvent = {
  id: string;
  type: `signature_request.${"created" | "viewed" | "signed" | "declined" | "expired"}`;
  created_at: string;
  data: { signature_request_id: string; external_ref: string | null; status: SignatureStatus };
  delivery: "logged" | "delivered" | "failed";
};

type Audit = { at: string; type: string; ip: string; user_agent: string };

type StoredRequest = Omit<SignatureRequest, "document"> & {
  token_hash: string;
  external_ref: string | null;
  document: SignatureRequest["document"] & { bytes: Uint8Array };
  signed_document: Uint8Array | null;
  signature_png: string | null;
  audit: Audit[];
};

type Store = { requests: Map<string, StoredRequest>; byTokenHash: Map<string, string>; events: MockEvent[] };

const g = globalThis as unknown as { __esignMockStore?: Store };
const store: Store = (g.__esignMockStore ??= {
  requests: new Map(),
  byTokenHash: new Map(),
  events: [],
});

export class MockError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const now = () => new Date().toISOString();

export type Actor = { ip: string; user_agent: string };

export async function createRequest(input: {
  title: string;
  message?: string | null;
  issuer_name: string;
  signer_name: string;
  signer_email: string;
  external_ref?: string | null;
  expires_in_days?: number;
  pdf?: Uint8Array | null;
  filename?: string | null;
}) {
  // The token is the only secret in the link: random, opaque, stored hashed only.
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const bytes = input.pdf ?? (await renderSamplePdf(input.title, input.signer_name, input.issuer_name));
  const req: StoredRequest = {
    id,
    status: "pending",
    title: input.title,
    message: input.message ?? null,
    issuer: { name: input.issuer_name, logo_url: null },
    signer: { name: input.signer_name, email: input.signer_email },
    document: {
      filename: input.filename ?? "document.pdf",
      sha256: sha256(bytes),
      size: bytes.byteLength,
      bytes,
    },
    expires_at: new Date(Date.now() + (input.expires_in_days ?? 14) * 86_400_000).toISOString(),
    signed_at: null,
    declined_at: null,
    decline_reason: null,
    token_hash: sha256(token),
    external_ref: input.external_ref ?? null,
    signed_document: null,
    signature_png: null,
    audit: [{ at: now(), type: "created", ip: "", user_agent: "" }],
  };
  store.requests.set(id, req);
  store.byTokenHash.set(req.token_hash, id);
  await emit("signature_request.created", req);
  return { id, token };
}

function findByToken(token: string): StoredRequest {
  const id = store.byTokenHash.get(sha256(token));
  const req = id ? store.requests.get(id) : undefined;
  if (!req) throw new MockError(404, "not_found", "Lien de signature invalide.");
  return req;
}

async function expireIfNeeded(req: StoredRequest) {
  if ((req.status === "pending" || req.status === "viewed") && Date.parse(req.expires_at) < Date.now()) {
    req.status = "expired";
    await emit("signature_request.expired", req);
  }
}

export function toPublic(req: StoredRequest): SignatureRequest {
  const { document, ...rest } = req;
  return {
    id: rest.id,
    status: rest.status,
    title: rest.title,
    message: rest.message,
    issuer: rest.issuer,
    signer: rest.signer,
    document: { filename: document.filename, sha256: document.sha256, size: document.size },
    expires_at: rest.expires_at,
    signed_at: rest.signed_at,
    declined_at: rest.declined_at,
    decline_reason: rest.decline_reason,
  };
}

function assertActionable(req: StoredRequest) {
  if (req.status === "expired") throw new MockError(410, "expired", "Ce lien a expiré.");
  if (req.status !== "pending" && req.status !== "viewed") {
    throw new MockError(409, "already_" + req.status, "Cette demande n'est plus modifiable.");
  }
}

export async function view(token: string, actor: Actor) {
  const req = findByToken(token);
  await expireIfNeeded(req);
  if (req.status === "pending") {
    req.status = "viewed";
    req.audit.push({ at: now(), type: "viewed", ...actor });
    await emit("signature_request.viewed", req);
  }
  return toPublic(req);
}

export function document(token: string) {
  return findByToken(token).document;
}

export function signedDocument(token: string) {
  const req = findByToken(token);
  if (!req.signed_document) throw new MockError(404, "not_signed", "Document pas encore signé.");
  return { bytes: req.signed_document, filename: req.document.filename.replace(/\.pdf$/i, "") + "-signe.pdf" };
}

export async function sign(
  token: string,
  input: { signer_name: string; signature_png: string; document_sha256: string },
  actor: Actor,
) {
  const req = findByToken(token);
  await expireIfNeeded(req);
  assertActionable(req);
  if (input.document_sha256 !== req.document.sha256) {
    throw new MockError(409, "document_changed", "Le document a été modifié depuis son affichage.");
  }
  // Single-threaded event loop: the status check above and this write cannot interleave.
  // The real backend must use a row lock (SELECT ... FOR UPDATE) for the same guarantee.
  req.status = "signed";
  req.signed_at = now();
  req.signature_png = input.signature_png;
  req.audit.push({ at: req.signed_at, type: "consent_given", ...actor });
  req.audit.push({ at: req.signed_at, type: "signed", ...actor });
  req.signed_document = await renderSignedPdf({
    original: req.document.bytes,
    originalSha256: req.document.sha256,
    requestId: req.id,
    title: req.title,
    signerName: input.signer_name,
    signerEmail: req.signer.email,
    signaturePng: input.signature_png,
    audit: req.audit,
  });
  await emit("signature_request.signed", req);
  return toPublic(req);
}

export async function decline(token: string, reason: string | null, actor: Actor) {
  const req = findByToken(token);
  await expireIfNeeded(req);
  assertActionable(req);
  req.status = "declined";
  req.declined_at = now();
  req.decline_reason = reason || null;
  req.audit.push({ at: req.declined_at, type: "declined", ...actor });
  await emit("signature_request.declined", req);
  return toPublic(req);
}

export function events(): MockEvent[] {
  return [...store.events].reverse();
}

/**
 * Mocked outgoing webhook. Always logged; POSTed with an HMAC signature when
 * MOCK_WEBHOOK_URL is set (same format the real backend should use, see docs/API.md).
 */
async function emit(type: MockEvent["type"], req: StoredRequest) {
  const event: MockEvent = {
    id: randomUUID(),
    type,
    created_at: now(),
    data: { signature_request_id: req.id, external_ref: req.external_ref, status: req.status },
    delivery: "logged",
  };
  store.events.push(event);
  console.info(`[mock webhook] ${type}`, event.data);

  const url = process.env.MOCK_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({ id: event.id, type: event.type, created_at: event.created_at, data: event.data });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", process.env.MOCK_WEBHOOK_SECRET ?? "dev-secret")
    .update(`${t}.${body}`)
    .digest("hex");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Esign-Signature": `t=${t},v1=${sig}`, "X-Esign-Event-Id": event.id },
      body,
      signal: AbortSignal.timeout(5000),
    });
    event.delivery = res.ok ? "delivered" : "failed";
  } catch {
    event.delivery = "failed";
  }
}
