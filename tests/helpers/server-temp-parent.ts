/**
 * The test seam for the contained Design Agent's temporary parent (#241),
 * spelled out rather than imported from the app, so the setup file that uses
 * it never loads app modules before a test file's mocks apply.
 * tests/agent-workspace.test.ts checks both against the app's own.
 */
export const OVERRIDE_KEY = Symbol.for("creatorbrio.server-temp-root");

/** The real per-user parent, as `systemServerTempRoot` names it. */
export const realParent = (platform: NodeJS.Platform, uid: number) => `${platform === "darwin" ? "/private/tmp" : "/tmp"}/cb${uid.toString(36)}`;

/** A server process's own folder in the parent, as `serverTempDirName` names it. */
export const serverFolderName = (pid: number) => `.s${pid.toString(36)}`;

/** The longest the real parent can be on a platform, in bytes: the one for the longest 32-bit user id (22 on macOS, 14 on Linux). */
export const longestRealParentBytes = (platform: NodeJS.Platform) => Buffer.byteLength(realParent(platform, 0xffffffff));

/**
 * The name of a test file's own parent, directly under `base` (the real path
 * of `/tmp`): `t`, the process id in base 36, a `-` and as many of the
 * `random` characters as keep the whole path within the longest real parent,
 * so a run's folder in it fits the CLI's path limit for every user id the real
 * parent fits (a longer test parent made `createRunTempDir` throw in tests for
 * macOS user ids from about ten million). The `-` ends the process id, so one
 * id's name is never another's prefix (the ids 46656 and 1679616 are `1000`
 * and `10000` in base 36), and it is a character the real name, `cb` and base
 * 36, never has, so a test parent is never a real one.
 */
export function testParentName(base: string, platform: NodeJS.Platform, pid: number, random: string): string {
  const stem = `t${pid.toString(36)}-`;
  const room = longestRealParentBytes(platform) - Buffer.byteLength(base) - 1 - Buffer.byteLength(stem);
  return stem + random.slice(0, Math.max(0, room));
}
