import { handle, pdfResponse } from "@/lib/mock/http";
import { documentById } from "@/lib/mock/store";

/** Stands in for the storage URL embedded in the link (in production: a pre-signed S3 URL). */
export async function GET(_req: Request, ctx: RouteContext<"/api/mock/v1/documents/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const doc = documentById(id);
    return pdfResponse(doc.bytes, doc.filename, "inline");
  });
}
