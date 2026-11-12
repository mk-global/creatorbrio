import { NextResponse } from "next/server";
import { isClaudeAvailable } from "@/lib/claude-path";
import { imageGenerationConfigured } from "@/lib/image-service";

/**
 * What Settings and Home tell a person about this computer (#175): whether
 * Claude Code can be found, and whether image generation is set up. Read-only,
 * no network call, and nothing in it is a path, a URL or a secret. Whether the
 * image service is running is only known when a design asks it for an image,
 * so it is not claimed here.
 */
export async function GET() {
  return NextResponse.json({
    claude: { available: isClaudeAvailable() },
    imageGeneration: { configured: await imageGenerationConfigured() },
  });
}
