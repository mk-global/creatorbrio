/**
 * The Next.js development indicator stays off (#177). People run CreatorBrio
 * with `npm run dev`, and the indicator sat over the app shell: the sidebar
 * footer and the editor rail's Settings button. No corner is free at every
 * width, so it is hidden rather than moved; Next.js still reports compile and
 * runtime errors without it.
 */
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("the Next.js development indicator", () => {
  it("is turned off", () => {
    expect(nextConfig.devIndicators).toBe(false);
  });
});
