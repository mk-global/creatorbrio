import { getProduction } from "@/lib/video/production/api/handlers";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return getProduction(request, (await params).id);
}
