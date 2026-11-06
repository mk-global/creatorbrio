import { getPreview } from "@/lib/video/production/api/preview-handlers";

type Context = { params: Promise<{ id: string }> };

// The compiled preview of a production's current revision (#150). Only GET is
// exported, so Next.js answers every other method with 405.
export async function GET(request: Request, { params }: Context) {
  return getPreview(request, (await params).id);
}
