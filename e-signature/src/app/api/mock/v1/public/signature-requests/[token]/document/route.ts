import { handle, pdfResponse } from "@/lib/mock/http";
import { document } from "@/lib/mock/store";

export async function GET(_req: Request, ctx: RouteContext<"/api/mock/v1/public/signature-requests/[token]/document">) {
  return handle(async () => {
    const { token } = await ctx.params;
    const doc = document(token);
    return pdfResponse(doc.bytes, doc.filename, "inline");
  });
}
