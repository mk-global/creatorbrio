import { describe, expect, it } from "vitest";
import { platformAvailability, versionAvailability } from "@/lib/design-agent-availability";

const host = (platform: NodeJS.Platform, programs: string[] = [], kernelRelease: string | null = null) => ({
  platform,
  kernelRelease,
  has: (program: string) => programs.includes(program),
});

describe("where the contained Design Agent may run", () => {
  it("runs on macOS", () => {
    expect(platformAvailability(host("darwin"))).toEqual({ ok: true });
  });

  it("runs on Linux only with bubblewrap and socat", () => {
    expect(platformAvailability(host("linux", ["bwrap", "socat"], "6.8.0-45-generic"))).toEqual({ ok: true });
    expect(platformAvailability(host("linux", ["socat"], "6.8.0"))).toMatchObject({ ok: false, reason: expect.stringMatching(/needs bubblewrap, which is not installed/) });
    expect(platformAvailability(host("linux", [], "6.8.0"))).toMatchObject({ ok: false, reason: expect.stringMatching(/bubblewrap and socat, which are not installed/) });
  });

  it("is not available on WSL2 or Windows, which have not been qualified", () => {
    expect(platformAvailability(host("linux", ["bwrap", "socat"], "5.15.153.1-microsoft-standard-WSL2"))).toMatchObject({ ok: false, reason: expect.stringMatching(/WSL2/) });
    expect(platformAvailability(host("win32"))).toMatchObject({ ok: false, reason: expect.stringMatching(/Windows/) });
    expect(platformAvailability(host("freebsd"))).toMatchObject({ ok: false });
  });
});

describe("which Claude Code versions it accepts", () => {
  it("accepts the qualified version without a warning", () => {
    expect(versionAvailability("2.1.328")).toEqual({ available: true, cliVersion: "2.1.328", versionWarning: null });
  });

  it("runs another version from the first with the sandbox setting, with a warning", () => {
    expect(versionAvailability("2.1.330")).toMatchObject({ available: true, versionWarning: expect.stringMatching(/2\.1\.330 has not been tested.*2\.1\.328 has/) });
    expect(versionAvailability("2.1.219")).toMatchObject({ available: true });
  });

  it("refuses an older version, and one whose version could not be read", () => {
    expect(versionAvailability("2.1.218")).toMatchObject({ available: false, reason: expect.stringMatching(/older than 2\.1\.219/) });
    expect(versionAvailability(null)).toMatchObject({ available: false });
    expect(versionAvailability("2.1.328-beta")).toMatchObject({ available: false });
  });
});

describe("the doctor command", () => {
  it("checks the contained profile's own versions", async () => {
    const { readFile } = await import("node:fs/promises");
    const { CONTAINED_PROFILE } = await import("@/lib/design-agent-profile");
    const doctor = await readFile("scripts/doctor.mjs", "utf8");
    expect(doctor).toContain(`const QUALIFIED_CLI_VERSION = "${CONTAINED_PROFILE.qualifiedCliVersion}";`);
    expect(doctor).toContain(`const MINIMUM_CLI_VERSION = "${CONTAINED_PROFILE.minimumCliVersion}";`);
  });
});
