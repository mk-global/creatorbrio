import { NextResponse } from "next/server";
import { isClaudeAvailable } from "@/lib/claude-path";
import { capabilityStatus, isAvailable } from "@/lib/creative-capabilities";
import { getClaudePath } from "@/lib/claude-path";
import { CONTAINED_PROFILE, designAgentProfileName } from "@/lib/design-agent-profile";
import { containedAvailability } from "@/lib/design-agent-availability";
import { agentTokenFile, tokenGuidance } from "@/lib/agent-sign-in";
import { configuredSearchProviders } from "@/lib/research/providers";
import { braveKeyConfigured } from "@/lib/research/search";

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
 *
 * `research.search` says whether a Brave Search key is set (#252), never the
 * key or anything derived from it, and which web search research tries first
 * (#256): "brave", "claude" (Claude's own web search, the default whenever
 * Claude Code is found) or null. Whether Claude's web search works on the
 * person's connection is only known when research tries it, so it is not
 * claimed here.
 */
export async function GET() {
  const capabilities = await capabilityStatus({ referenceCount: 0, intactAssetCount: 0 });
  return NextResponse.json({
    claude: { available: isClaudeAvailable() },
    imageGeneration: { configured: isAvailable(capabilities, "image-generation") },
    designAgent: await designAgentStatus(),
    research: {
      search: {
        configured: braveKeyConfigured(),
        provider: configuredSearchProviders({ claudeAvailable: isClaudeAvailable() })[0]?.name ?? null,
      },
    },
  });
}

async function designAgentStatus() {
  const profile = designAgentProfileName();
  if (!profile.ok) return { profile: "invalid" as const };
  if (profile.name === "legacy") return { profile: "legacy" as const };
  if (!isClaudeAvailable()) {
    // Two sign-ins are needed (#246): planning (the Visual Director) uses the person's own Claude Code sign-in, so signing in once in a
    // terminal is still required, and the Design Agent uses a token of its own, made from the person's Claude account.
    const located = agentTokenFile();
    return {
      profile: "contained" as const,
      available: false,
      reason: "Claude Code was not found.",
      guidance:
        "Install Claude Code, sign in once in a terminal (planning uses that sign-in), then restart CreatorBrio. " +
        "The Design Agent also signs in with a separate token made from your Claude account, which counts against its usage; CreatorBrio checks the token file, not that the token is still valid. " +
        tokenGuidance(located.ok ? located.configured : true),
    };
  }
  const availability = await containedAvailability(getClaudePath());
  return { profile: "contained" as const, qualifiedCliVersion: CONTAINED_PROFILE.qualifiedCliVersion, ...availability };
}
