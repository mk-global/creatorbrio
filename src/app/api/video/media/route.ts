import { importMedia, listMedia } from "@/lib/video/production/api/media-handlers";

// The Video Studio media registry (#140). Only GET and POST are exported, so
// Next.js answers every other method with 405.
export const GET = (request: Request) => listMedia(request);
export const POST = (request: Request) => importMedia(request);
