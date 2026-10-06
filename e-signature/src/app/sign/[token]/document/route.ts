import { notFound } from "next/navigation";
import { getDocument, SignatureApiError } from "@/lib/signature-api/client";
import { passthroughPdf } from "@/lib/pdf-response";
import { isWellFormedToken } from "@/lib/token";

/** Streams the PDF from the backend so the browser never talks to the API directly. */
export async function GET(_req: Request, ctx: RouteContext<"/sign/[token]/document">) {
  const { token } = await ctx.params;
  if (!isWellFormedToken(token)) notFound();
  try {
    return passthroughPdf(await getDocument(token), "inline");
  } catch (e) {
    if (e instanceof SignatureApiError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
