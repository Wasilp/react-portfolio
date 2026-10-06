import { decodeLink } from "@/lib/link-token";
import { passthroughPdf } from "@/lib/pdf-response";
import { getSignedDocument, SignatureApiError } from "@/lib/signature-api/client";

/** The signed PDF stays downloadable after the link's expiry, as long as the link is authentic. */
export async function GET(_req: Request, ctx: RouteContext<"/sign/[token]/signed">) {
  const { token } = await ctx.params;
  const link = decodeLink(token);
  if (!link.ok && link.reason === "invalid") return new Response("Lien invalide.", { status: 404 });
  try {
    return passthroughPdf(await getSignedDocument(link.payload.rid, token), "attachment");
  } catch (e) {
    if (e instanceof SignatureApiError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
