import { readDerived } from "@/lib/video/production/api/media-handlers";

type Context = { params: Promise<{ id: string; name: string }> };

// A derived file (proxy, poster, peaks), with Range support for media elements.
export async function GET(request: Request, { params }: Context) {
  const { id, name } = await params;
  return readDerived(request, id, name);
}

export async function HEAD(request: Request, { params }: Context) {
  const { id, name } = await params;
  return readDerived(request, id, name);
}
