import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/mock/http";
import { createRequest, MockError } from "@/lib/mock/store";

/**
 * Mock of the *issuer* side (normally called by the Laravel app, not by this portal).
 * Accepts multipart (with an optional `document` PDF) or JSON. Returns the encrypted signing URL.
 */
const Input = z.object({
  title: z.string().min(1).default("Devis D-2026-0012"),
  message: z.string().nullish(),
  issuer_name: z.string().min(1).default("SolarPro SRL"),
  signer_name: z.string().min(1).default("Jean Dupont"),
  signer_email: z.string().email().default("jean.dupont@example.com"),
  external_ref: z.string().nullish(),
  expires_in_days: z.coerce.number().int().min(-1).max(365).default(14),
});

export async function POST(req: Request) {
  return handle(async () => {
    let raw: Record<string, unknown> = {};
    let pdf: Uint8Array | null = null;
    let filename: string | null = null;
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("document");
      form.delete("document");
      raw = Object.fromEntries([...form.entries()].filter(([, v]) => v !== ""));
      if (file instanceof File && file.size > 0) {
        if (file.type !== "application/pdf") throw new MockError(422, "invalid_document", "Le document doit être un PDF.");
        pdf = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
    } else {
      raw = await req.json().catch(() => ({}));
    }
    const parsed = Input.safeParse(raw);
    if (!parsed.success) throw new MockError(422, "validation_failed", parsed.error.message);

    const origin = process.env.PORTAL_URL ?? new URL(req.url).origin;
    return NextResponse.json(await createRequest({ ...parsed.data, pdf, filename, origin }), { status: 201 });
  });
}
