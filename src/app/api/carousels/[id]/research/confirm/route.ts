import { NextResponse } from "next/server";
import { dataErrorResponse } from "@/lib/api-errors";
import { confirmResearch } from "@/lib/research/run";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ id: string }> };

/**
 * The person confirms a direction for the latest ready research (#252):
 * `{ revision, direction }`, where direction is the suggestion as shown or as
 * they edited it. 409 when the research changed since they opened it. A
 * workflow step, not a binding approval (FQ-11).
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await confirmResearch(id, body);
    return result.ok
      ? NextResponse.json({ research: result.research }, { headers: NO_STORE })
      : NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}
