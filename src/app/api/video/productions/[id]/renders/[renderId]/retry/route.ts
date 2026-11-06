import { retryRender } from "@/lib/video/production/api/render-handlers";

type Context = { params: Promise<{ id: string; renderId: string }> };

/** A person retries a failed or cancelled render. */
export async function POST(request: Request, { params }: Context) {
  const { id, renderId } = await params;
  return retryRender(request, id, renderId);
}
