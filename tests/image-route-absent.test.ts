import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The Design Agent may call any route under src/app/api with curl, so image
// generation stays server-side only: no app route reaches the image client
// (#35). The client in src/lib/image-service.ts is kept for later
// server-side use.
const apiDir = path.join(__dirname, "..", "src", "app", "api");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [full] : [];
  });
}

describe("agent-facing image generation is retired", () => {
  it("has no image generation route", () => {
    expect(existsSync(path.join(apiDir, "images"))).toBe(false);
  });

  it("has no API module that reaches the image client", () => {
    const files = sourceFiles(apiDir);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      /image-service|generateImage|parseImageRequest/.test(readFileSync(file, "utf8"))
    );
    expect(offenders.map((f) => path.relative(apiDir, f))).toEqual([]);
  });
});
