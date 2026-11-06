import { listRenders, requestRender } from "@/lib/video/production/api/render-handlers";

type Context = { params: Promise<{ id: string }> };

// A production's render jobs (#144). Only GET and POST are exported, so
// Next.js answers every other method with 405.
export async function GET(request: Request, { params }: Context) {
  return listRenders(request, (await params).id);
}

export async function POST(request: Request, { params }: Context) {
  return requestRender(request, (await params).id);
}
