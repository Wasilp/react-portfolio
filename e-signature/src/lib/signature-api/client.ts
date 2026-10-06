import "server-only";

import { headers } from "next/headers";
import {
  ApiError,
  type DeclinePayload,
  SignatureRequest,
  type SignPayload,
} from "./types";

/**
 * Server-side client for the signature backend. Runs only on the Next server, so the
 * backend URL and API key are never exposed to the browser.
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

/** Forward who is signing, for the backend's audit trail. */
async function auditHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
  return {
    "X-Signer-Ip": ip,
    "X-Signer-User-Agent": h.get("user-agent") ?? "",
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}/v1/public/signature-requests/${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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

const enc = encodeURIComponent;

export async function getSignatureRequest(token: string): Promise<SignatureRequest> {
  const res = await request(enc(token));
  return SignatureRequest.parse(await res.json());
}

export async function getDocument(token: string): Promise<Response> {
  return request(`${enc(token)}/document`, { headers: { Accept: "application/pdf" } });
}

export async function getSignedDocument(token: string): Promise<Response> {
  return request(`${enc(token)}/signed-document`, { headers: { Accept: "application/pdf" } });
}

export async function sign(token: string, payload: SignPayload): Promise<SignatureRequest> {
  const res = await request(`${enc(token)}/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return SignatureRequest.parse(await res.json());
}

export async function decline(token: string, payload: DeclinePayload): Promise<SignatureRequest> {
  const res = await request(`${enc(token)}/decline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return SignatureRequest.parse(await res.json());
}
