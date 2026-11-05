import { restoreLabel } from "@/lib/video/production/api/handlers";

type Context = { params: Promise<{ id: string; name: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id, name } = await params;
  return restoreLabel(request, id, name);
}
