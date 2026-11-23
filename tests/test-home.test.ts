/**
 * The test run's synthetic home (#246).
 *
 * `tests/global-setup.ts` points HOME and USERPROFILE at a folder made for the run, so that no test, and no
 * product code a test calls, reads a real token, sign-in or configuration file from the person's own home.
 * Two product files are the ones a test could reach by accident: the image service's token and the Design
 * Agent's default token file.
 */
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentTokenFile } from "@/lib/agent-sign-in";
import { agentWorkspaceRoot } from "@/lib/agent-workspace";
import { imageGenerationConfigured } from "@/lib/image-service";

const home = process.env.HOME ?? "";
const base = realpathSync(process.platform === "win32" ? os.tmpdir() : "/tmp");
const planted = path.join(home, ".config", "framewoven");
// Nothing is planted in, or removed from, a home that is not the run's own: a person's real one is never touched.
const synthetic = path.dirname(home) === base && /^cbh-[0-9a-f]{8}$/.test(path.basename(home));

beforeAll(() => {
  if (!synthetic) throw new Error("the test run's home is not the synthetic one made by tests/global-setup.ts, so nothing is planted in it");
});

afterEach(() => {
  if (synthetic) rmSync(planted, { recursive: true, force: true });
});

describe("the test run's synthetic home (#246)", () => {
  it("is one folder made for the run under the system's temporary folder, named by HOME, USERPROFILE and the system's own answer", () => {
    expect(path.dirname(home)).toBe(base);
    expect(path.basename(home)).toMatch(/^cbh-[0-9a-f]{8}$/);
    expect(process.env.USERPROFILE).toBe(home);
    expect(os.homedir()).toBe(home);
  });

  it("holds the Design Agent's default token file and agent folders, and nothing of the person's own", () => {
    expect(defaultAgentTokenFile().startsWith(`${home}${path.sep}`)).toBe(true);
    expect(agentWorkspaceRoot({}).startsWith(`${home}${path.sep}`)).toBe(true);
  });

  it("is where the image service's token path resolves: a token found there is the only one the product can find", async () => {
    // No token in the run's home: whatever the person's real home holds is out of reach.
    expect(await imageGenerationConfigured()).toBe(false);
    // The product's token path, under the run's home. Finding a planted synthetic token proves the path resolves there and nowhere else.
    mkdirSync(planted, { recursive: true, mode: 0o700 });
    const file = path.join(planted, "image-service.token");
    expect(file.startsWith(`${base}${path.sep}`)).toBe(true);
    writeFileSync(file, `${"0123456789abcdef".repeat(4)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(await imageGenerationConfigured()).toBe(true);
    rmSync(file);
    expect(await imageGenerationConfigured()).toBe(false);
  });
});
