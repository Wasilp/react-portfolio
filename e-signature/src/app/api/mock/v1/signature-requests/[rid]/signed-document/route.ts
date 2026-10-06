import { assertApiKey, handle, linkFrom, pdfResponse } from "@/lib/mock/http";
import { signedDocument } from "@/lib/mock/store";

export async function GET(req: Request, ctx: RouteContext<"/api/mock/v1/signature-requests/[rid]/signed-document">) {
  return handle(async () => {
    assertApiKey(req);
    const { rid } = await ctx.params;
    const doc = signedDocument(rid, linkFrom(req));
    return pdfResponse(doc.bytes, doc.filename, "attachment");
  });
}
