/**
 * The test seam for the contained Design Agent's temporary parent (#241),
 * spelled out rather than imported from the app, so the setup file that uses
 * it never loads app modules before a test file's mocks apply.
 * tests/agent-workspace.test.ts checks both against the app's own.
 */
export const OVERRIDE_KEY = Symbol.for("creatorbrio.server-temp-root");

/** The real per-user parent, as `systemServerTempRoot` names it. */
export const realParent = (platform: NodeJS.Platform, uid: number) => `${platform === "darwin" ? "/private/tmp" : "/tmp"}/cb${uid.toString(36)}`;
