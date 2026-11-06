import { readRenderFile } from "@/lib/video/production/api/render-handlers";

type Context = { params: Promise<{ id: string; renderId: string; name: string }> };

// A succeeded render's video, manifest or caption sidecar, as a download; Range for the video.
export async function GET(request: Request, { params }: Context) {
  const { id, renderId, name } = await params;
  return readRenderFile(request, id, renderId, name);
}

export async function HEAD(request: Request, { params }: Context) {
  const { id, renderId, name } = await params;
  return readRenderFile(request, id, renderId, name);
}
