import { endSession, pairSession, sessionStatus } from "@/lib/video/production/api/session-handlers";

// Pairing a browser with the Video Studio (WS1 #122). Only these methods are
// exported, so Next.js answers any other with 405.
export const POST = (request: Request) => pairSession(request);
export const GET = (request: Request) => sessionStatus(request);
export const DELETE = (request: Request) => endSession(request);
