import { NextResponse } from "next/server";
import { actorFrom, handle } from "@/lib/mock/http";
import { view } from "@/lib/mock/store";

/** First read marks the request as viewed (audit + webhook). */
export async function GET(req: Request, ctx: RouteContext<"/api/mock/v1/public/signature-requests/[token]">) {
  return handle(async () => {
    const { token } = await ctx.params;
    return NextResponse.json(await view(token, actorFrom(req)));
  });
}
