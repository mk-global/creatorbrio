import { decideRun } from "@/lib/video/production/api/handlers";

type Context = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id, runId } = await params;
  return decideRun(request, id, runId);
}
