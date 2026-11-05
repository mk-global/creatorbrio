import { getMedia } from "@/lib/video/production/api/media-handlers";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return getMedia(request, (await params).id);
}
