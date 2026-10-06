import { DocumentError, fetchDocument } from "@/lib/document";
import { decodeLink } from "@/lib/link-token";

/**
 * Serves the document named in the (decrypted) link, after checking its origin and SHA-256.
 * The browser never sees the storage URL.
 */
export async function GET(_req: Request, ctx: RouteContext<"/sign/[token]/document">) {
  const { token } = await ctx.params;
  const link = decodeLink(token);
  if (!link.ok) return new Response("Lien invalide ou expiré.", { status: link.reason === "expired" ? 410 : 404 });
  try {
    const bytes = await fetchDocument(link.payload.document);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${link.payload.document.filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof DocumentError) {
      console.error(e.message, { rid: link.payload.rid });
      return new Response("Document indisponible.", { status: 502 });
    }
    throw e;
  }
}
