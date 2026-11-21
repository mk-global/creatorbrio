import { NextResponse } from "next/server";
import { isClaudeAvailable } from "@/lib/claude-path";
import { capabilityStatus, isAvailable } from "@/lib/creative-capabilities";
import { getClaudePath } from "@/lib/claude-path";
import { CONTAINED_PROFILE, designAgentProfileName } from "@/lib/design-agent-profile";
import { containedAvailability } from "@/lib/design-agent-availability";

/**
 * What Settings and Home tell a person about this computer (#175): whether
 * Claude Code can be found, and whether image generation is set up. Read-only,
 * no network call, and nothing in it is a path, a URL or a secret. Image
 * generation is read through the capability registry, the same answer the
 * planner gets, so no API module reaches the image client (#35). Whether the
 * image service is running is only known when a design asks it for an image,
 * so it is not claimed here.
 *
 * `designAgent` says which Design Agent profile runs (#227): for the contained
 * profile, whether it can run here, the CLI version and any version warning.
 */
export async function GET() {
  const capabilities = await capabilityStatus({ referenceCount: 0, intactAssetCount: 0 });
  return NextResponse.json({
    claude: { available: isClaudeAvailable() },
    imageGeneration: { configured: isAvailable(capabilities, "image-generation") },
    designAgent: await designAgentStatus(),
  });
}

async function designAgentStatus() {
  const profile = designAgentProfileName();
  if (!profile.ok) return { profile: "invalid" as const };
  if (profile.name === "legacy") return { profile: "legacy" as const };
  if (!isClaudeAvailable()) return { profile: "contained" as const, available: false, reason: "Claude Code was not found.", guidance: "Install Claude Code, sign in once in a terminal, then restart CreatorBrio." };
  const availability = await containedAvailability(getClaudePath());
  return { profile: "contained" as const, qualifiedCliVersion: CONTAINED_PROFILE.qualifiedCliVersion, ...availability };
}
