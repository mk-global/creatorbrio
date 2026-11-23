/**
 * What the status route tells a person when the contained Design Agent cannot
 * run because Claude Code is not installed (#246): two steps, both required.
 * Planning (the Visual Director) uses their own Claude Code sign-in, so they
 * still sign in once in a terminal, and the Design Agent uses a separate token
 * made from their Claude account, saved in its token file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN_FILE_ENV } from "@/lib/agent-sign-in";

vi.mock("@/lib/claude-path", () => ({
  isClaudeAvailable: () => false,
  getClaudePath: () => "",
}));

const { GET: statusRoute } = await import("@/app/api/status/route");

afterEach(() => {
  delete process.env.CREATORBRIO_DESIGN_AGENT_PROFILE;
  delete process.env[AGENT_TOKEN_FILE_ENV];
});

describe("the app status without Claude Code, under the contained profile (#246)", () => {
  it("asks for both steps: signing in once in a terminal for planning, and the Design Agent's token file", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    const body = await (await statusRoute()).json();
    expect(body.claude).toEqual({ available: false });
    // No image-service token exists in the run's synthetic home, so a token in the person's own home is never read (#246).
    expect(body.imageGeneration).toEqual({ configured: false });
    expect(body.designAgent).toMatchObject({ profile: "contained", available: false, reason: "Claude Code was not found." });
    const { guidance } = body.designAgent as { guidance: string };
    // Step one: Claude Code installed and signed in, which planning uses.
    expect(guidance).toMatch(/Install Claude Code, sign in once in a terminal \(planning uses that sign-in\), then restart CreatorBrio/);
    // Step two: the Design Agent's separate token, made from the person's account, counted against their usage, its file checked and not its validity.
    expect(guidance).toMatch(/separate token made from your Claude account, which counts against its usage/);
    expect(guidance).toMatch(/checks the token file, not that the token is still valid/);
    expect(guidance).toMatch(/claude setup-token.*~\/\.creatorbrio\/design-agent-token.*chmod 600.*CREATORBRIO_DESIGN_AGENT_TOKEN_FILE/);
    expect(guidance).not.toMatch(/does not use your own Claude Code sign-in/);
  });

  it("names a configured token file by its setting, not its path", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    process.env[AGENT_TOKEN_FILE_ENV] = "/srv/synthetic-secrets/design-agent-token";
    const body = await (await statusRoute()).json();
    expect(body.designAgent.guidance).toMatch(/the file CREATORBRIO_DESIGN_AGENT_TOKEN_FILE names/);
    expect(JSON.stringify(body)).not.toContain("synthetic-secrets");
  });

  it("is unchanged for the legacy profile", async () => {
    const body = await (await statusRoute()).json();
    expect(body.designAgent).toEqual({ profile: "legacy" });
  });
});
