import { NextResponse } from "next/server";
import { actorFrom, assertApiKey, handle, linkFrom } from "@/lib/mock/http";
import { decline, MockError } from "@/lib/mock/store";
import { DeclinePayload } from "@/lib/signature-api/types";

export async function POST(req: Request, ctx: RouteContext<"/api/mock/v1/signature-requests/[rid]/decline">) {
  return handle(async () => {
    assertApiKey(req);
    const { rid } = await ctx.params;
    const parsed = DeclinePayload.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new MockError(422, "validation_failed", parsed.error.message);
    return NextResponse.json(await decline(rid, linkFrom(req), parsed.data.reason, actorFrom(req)));
  });
}
