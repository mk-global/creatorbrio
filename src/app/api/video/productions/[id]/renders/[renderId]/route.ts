import { getRender } from "@/lib/video/production/api/render-handlers";

type Context = { params: Promise<{ id: string; renderId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id, renderId } = await params;
  return getRender(request, id, renderId);
}
