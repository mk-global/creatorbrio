import { retryDerived } from "@/lib/video/production/api/media-handlers";

type Context = { params: Promise<{ id: string }> };

/** A person retries a failed derived-files job. */
export async function POST(request: Request, { params }: Context) {
  return retryDerived(request, (await params).id);
}
