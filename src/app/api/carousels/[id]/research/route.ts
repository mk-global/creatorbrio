import { NextResponse } from "next/server";
import { dataErrorResponse } from "@/lib/api-errors";
import { readResearch, startResearch, type ResearchResponse } from "@/lib/research/run";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ id: string }> };

function respond(result: ResearchResponse, okStatus = 200): NextResponse {
  return result.ok
    ? NextResponse.json({ research: result.research }, { status: okStatus, headers: NO_STORE })
    : NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
}

/**
 * The carousel's research (#252): `{ research }`, null when it has none. A
 * run the server no longer holds is reported as interrupted. The research
 * screen polls it while a run is in progress.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    return respond(await readResearch(id));
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}

/**
 * Starts research: `{ topic, links? }`, at most three links. Answers 202 with
 * the running record; 409 while research already runs for the carousel.
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
    return respond(await startResearch(id, body), 202);
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}
