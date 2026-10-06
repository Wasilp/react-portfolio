import "server-only";

import { NextResponse } from "next/server";
import { MockError, type Actor } from "./store";

export function mockEnabled(): boolean {
  return process.env.MOCK_API === "true";
}

export function disabled() {
  return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

export function actorFrom(req: Request): Actor {
  return {
    ip: req.headers.get("x-signer-ip") ?? "",
    user_agent: req.headers.get("x-signer-user-agent") ?? "",
  };
}

/** Run a mock handler, mapping MockError to the API's error envelope. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  if (!mockEnabled()) return disabled();
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MockError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    throw e;
  }
}

export function pdfResponse(bytes: Uint8Array, filename: string, disposition: "inline" | "attachment") {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}
