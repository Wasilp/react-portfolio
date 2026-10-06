import "server-only";

import { headers } from "next/headers";
import { ApiError, type DeclinePayload, SignatureRequest, type SignPayload } from "./types";

/**
 * Server-side client for the signature backend. Runs only on the Next server, so the
 * backend URL and API key are never exposed to the browser.
 *
 * Every call also forwards the signing link (X-Signature-Link) so the backend can check that
 * the portal acts on behalf of someone holding a link it issued for this request.
 */

export class SignatureApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function config() {
  const baseUrl = process.env.SIGNATURE_API_URL;
  if (!baseUrl) throw new Error("SIGNATURE_API_URL is not set");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey: process.env.SIGNATURE_API_KEY ?? "" };
}

/** Who is acting, for the backend's audit trail. */
async function auditHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
  return { "X-Signer-Ip": ip, "X-Signer-User-Agent": h.get("user-agent") ?? "" };
}

async function request(rid: string, path: string, link: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}/v1/signature-requests/${encodeURIComponent(rid)}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "X-Signature-Link": link,
      ...(await auditHeaders()),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = ApiError.safeParse(await res.json().catch(() => null));
    throw new SignatureApiError(
      res.status,
      body.success ? body.data.error.code : "unknown",
      body.success ? body.data.error.message : `Signature API responded ${res.status}`,
    );
  }
  return res;
}

const json = { "Content-Type": "application/json" };

/** Records the view (first call moves pending → viewed) and returns the live state. */
export async function view(rid: string, link: string): Promise<SignatureRequest> {
  const res = await request(rid, "/view", link, { method: "POST" });
  return SignatureRequest.parse(await res.json());
}

export async function sign(rid: string, link: string, payload: SignPayload): Promise<SignatureRequest> {
  const res = await request(rid, "/sign", link, { method: "POST", headers: json, body: JSON.stringify(payload) });
  return SignatureRequest.parse(await res.json());
}

export async function decline(rid: string, link: string, payload: DeclinePayload): Promise<SignatureRequest> {
  const res = await request(rid, "/decline", link, { method: "POST", headers: json, body: JSON.stringify(payload) });
  return SignatureRequest.parse(await res.json());
}

export async function getSignedDocument(rid: string, link: string): Promise<Response> {
  return request(rid, "/signed-document", link, { headers: { Accept: "application/pdf" } });
}
