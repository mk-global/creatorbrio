import { createProduction, listProductions } from "@/lib/video/production/api/handlers";

// Video Studio productions (WS1 #120). Only GET and POST are exported, so
// Next.js answers every other method with 405.
export const GET = (request: Request) => listProductions(request);
export const POST = (request: Request) => createProduction(request);
