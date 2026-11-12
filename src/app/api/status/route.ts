import { NextResponse } from "next/server";
import { isClaudeAvailable } from "@/lib/claude-path";
import { capabilityStatus, isAvailable } from "@/lib/creative-capabilities";

/**
 * What Settings and Home tell a person about this computer (#175): whether
 * Claude Code can be found, and whether image generation is set up. Read-only,
 * no network call, and nothing in it is a path, a URL or a secret. Image
 * generation is read through the capability registry, the same answer the
 * planner gets, so no API module reaches the image client (#35). Whether the
 * image service is running is only known when a design asks it for an image,
 * so it is not claimed here.
 */
export async function GET() {
  const capabilities = await capabilityStatus({ referenceCount: 0, intactAssetCount: 0 });
  return NextResponse.json({
    claude: { available: isClaudeAvailable() },
    imageGeneration: { configured: isAvailable(capabilities, "image-generation") },
  });
}
