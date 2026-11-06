import { cancelRender } from "@/lib/video/production/api/render-handlers";

type Context = { params: Promise<{ id: string; renderId: string }> };

/** A person cancels a queued or running render. */
export async function POST(request: Request, { params }: Context) {
  const { id, renderId } = await params;
  return cancelRender(request, id, renderId);
}
