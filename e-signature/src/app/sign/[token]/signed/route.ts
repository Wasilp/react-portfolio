import { notFound } from "next/navigation";
import { getSignedDocument, SignatureApiError } from "@/lib/signature-api/client";
import { passthroughPdf } from "@/lib/pdf-response";
import { isWellFormedToken } from "@/lib/token";

export async function GET(_req: Request, ctx: RouteContext<"/sign/[token]/signed">) {
  const { token } = await ctx.params;
  if (!isWellFormedToken(token)) notFound();
  try {
    return passthroughPdf(await getSignedDocument(token), "attachment");
  } catch (e) {
    if (e instanceof SignatureApiError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
