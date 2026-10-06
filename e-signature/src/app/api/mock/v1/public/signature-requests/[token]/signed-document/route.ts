import { handle, pdfResponse } from "@/lib/mock/http";
import { signedDocument } from "@/lib/mock/store";

export async function GET(_req: Request, ctx: RouteContext<"/api/mock/v1/public/signature-requests/[token]/signed-document">) {
  return handle(async () => {
    const { token } = await ctx.params;
    const doc = signedDocument(token);
    return pdfResponse(doc.bytes, doc.filename, "attachment");
  });
}
