import { NextResponse } from "next/server";
import { cancelResearch } from "@/lib/research/run";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Stops the carousel's running research (#252); 409 when none is running. The run records itself as stopped. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!cancelResearch(id)) {
    return NextResponse.json({ error: "No research is running for this project." }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ stopping: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
