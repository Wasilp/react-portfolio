import { NextResponse } from "next/server";
import { actorFrom, handle } from "@/lib/mock/http";
import { MockError, sign } from "@/lib/mock/store";
import { SignPayload } from "@/lib/signature-api/types";

export async function POST(req: Request, ctx: RouteContext<"/api/mock/v1/public/signature-requests/[token]/sign">) {
  return handle(async () => {
    const { token } = await ctx.params;
    const parsed = SignPayload.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new MockError(422, "validation_failed", parsed.error.message);
    return NextResponse.json(await sign(token, parsed.data, actorFrom(req)));
  });
}
