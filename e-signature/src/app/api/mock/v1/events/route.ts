import { NextResponse } from "next/server";
import { handle } from "@/lib/mock/http";
import { events } from "@/lib/mock/store";

/** Debug: the webhooks the mock backend would have sent, newest first. */
export async function GET() {
  return handle(() => NextResponse.json({ data: events() }));
}
