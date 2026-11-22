/**
 * What the server does at start (#241): only with the contained Design Agent
 * profile does it install the shutdown hook and sweep leftover folders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installShutdownHook = vi.fn();
const sweepLeftoverFolders = vi.fn(async () => ({ purged: Promise.resolve() }));
vi.mock("@/lib/agent-processes", () => ({ installShutdownHook }));
vi.mock("@/lib/agent-workspace", () => ({ sweepLeftoverFolders }));

const { register } = await import("@/instrumentation");

const saved = { runtime: process.env.NEXT_RUNTIME, profile: process.env.CREATORBRIO_DESIGN_AGENT_PROFILE };

beforeEach(() => {
  installShutdownHook.mockClear();
  sweepLeftoverFolders.mockClear();
  process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  for (const [key, value] of [
    ["NEXT_RUNTIME", saved.runtime],
    ["CREATORBRIO_DESIGN_AGENT_PROFILE", saved.profile],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the server start", () => {
  it("neither sweeps nor installs the shutdown hook with the legacy profile, explicit or by default, or an unknown one", async () => {
    for (const profile of [undefined, "", "legacy", "something-else"]) {
      if (profile === undefined) delete process.env.CREATORBRIO_DESIGN_AGENT_PROFILE;
      else process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = profile;
      await register();
    }
    expect(installShutdownHook).not.toHaveBeenCalled();
    expect(sweepLeftoverFolders).not.toHaveBeenCalled();
  });

  it("does nothing outside the Node.js runtime", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(installShutdownHook).not.toHaveBeenCalled();
    expect(sweepLeftoverFolders).not.toHaveBeenCalled();
  });

  it("installs the hook and sweeps with the contained profile", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    await register();
    expect(installShutdownHook).toHaveBeenCalledTimes(1);
    expect(sweepLeftoverFolders).toHaveBeenCalledTimes(1);
  });
});
