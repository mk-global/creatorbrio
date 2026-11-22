/**
 * What the server does at start (#241, #246): only with the contained Design
 * Agent profile, and only once it owns the data folder and the agent folders,
 * does it install the shutdown hook and sweep leftover folders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installShutdownHook = vi.fn();
const sweepLeftoverFolders = vi.fn(async () => ({ purged: Promise.resolve() }));
const order: string[] = [];
let owns = true;
const claimContainedServer = vi.fn(async () => {
  order.push("claim");
  return { owned: owns };
});
vi.mock("@/lib/agent-processes", () => ({ installShutdownHook }));
vi.mock("@/lib/agent-workspace", () => ({ sweepLeftoverFolders }));
vi.mock("@/lib/contained-server", () => ({ claimContainedServer, containedServerClaimLog: () => ({ folder: "data", holder: 4242 }) }));

const { register } = await import("@/instrumentation");

const saved = { runtime: process.env.NEXT_RUNTIME, profile: process.env.CREATORBRIO_DESIGN_AGENT_PROFILE };

beforeEach(() => {
  installShutdownHook.mockClear();
  installShutdownHook.mockImplementation(() => void order.push("hook"));
  sweepLeftoverFolders.mockClear();
  claimContainedServer.mockClear();
  order.length = 0;
  owns = true;
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
    expect(claimContainedServer).not.toHaveBeenCalled();
  });

  it("does nothing outside the Node.js runtime", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(installShutdownHook).not.toHaveBeenCalled();
    expect(sweepLeftoverFolders).not.toHaveBeenCalled();
  });

  it("takes ownership of its folders first, then installs the hook and sweeps, with the contained profile", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    await register();
    expect(order).toEqual(["claim", "hook"]);
    expect(installShutdownHook).toHaveBeenCalledTimes(1);
    expect(sweepLeftoverFolders).toHaveBeenCalledTimes(1);
  });

  it("neither sweeps, stops leftover processes nor installs the hook when another contained server owns the folders (#246)", async () => {
    process.env.CREATORBRIO_DESIGN_AGENT_PROFILE = "contained";
    owns = false;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    expect(claimContainedServer).toHaveBeenCalledTimes(1);
    expect(installShutdownHook).not.toHaveBeenCalled();
    expect(sweepLeftoverFolders).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/does not own the contained Design Agent's folders/), { folder: "data", holder: 4242 });
    logged.mockRestore();
  });
});
