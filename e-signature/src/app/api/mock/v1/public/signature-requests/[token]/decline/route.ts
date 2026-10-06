import { NextResponse } from "next/server";
import { actorFrom, handle } from "@/lib/mock/http";
import { decline, MockError } from "@/lib/mock/store";
import { DeclinePayload } from "@/lib/signature-api/types";

export async function POST(req: Request, ctx: RouteContext<"/api/mock/v1/public/signature-requests/[token]/decline">) {
  return handle(async () => {
    const { token } = await ctx.params;
    const parsed = DeclinePayload.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new MockError(422, "validation_failed", parsed.error.message);
    return NextResponse.json(await decline(token, parsed.data.reason, actorFrom(req)));
  });
}
