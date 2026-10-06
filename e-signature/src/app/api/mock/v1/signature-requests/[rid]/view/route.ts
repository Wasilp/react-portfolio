import { NextResponse } from "next/server";
import { actorFrom, assertApiKey, handle, linkFrom } from "@/lib/mock/http";
import { view } from "@/lib/mock/store";

/** First call moves pending → viewed (audit + webhook). Returns the live state. */
export async function POST(req: Request, ctx: RouteContext<"/api/mock/v1/signature-requests/[rid]/view">) {
  return handle(async () => {
    assertApiKey(req);
    const { rid } = await ctx.params;
    return NextResponse.json(await view(rid, linkFrom(req), actorFrom(req)));
  });
}
