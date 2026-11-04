import { submitChanges } from "@/lib/video/production/api/handlers";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  return submitChanges(request, (await params).id);
}
