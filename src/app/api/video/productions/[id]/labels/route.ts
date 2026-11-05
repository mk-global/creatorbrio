import { addLabel } from "@/lib/video/production/api/handlers";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  return addLabel(request, (await params).id);
}
