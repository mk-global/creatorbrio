import { describe, expect, it } from "vitest";
import { interruptedNoticeText } from "@/components/editor/InterruptedExportNotice";

/**
 * The export menu's notice after a design that did not finish (#187): it
 * counts the planned slides when the plan is known, and never calls a slide
 * missing that exists.
 */
describe("the interrupted export notice", () => {
  it("says every planned slide is saved when all of them are", () => {
    const text = interruptedNoticeText(10, 10);
    expect(text).toBe(
      "All 10 planned slides are saved, but the design agent stopped before it finished working on them. Select Continue in the chat to let it finish, or use the slides as they are."
    );
    expect(text).not.toMatch(/missing|incomplete/);
    // A Reel cover has exactly one slide.
    expect(interruptedNoticeText(1, 1)).toBe(
      "The planned slide is saved, but the design agent stopped before it finished working on it. Select Continue in the chat to let it finish, or use the slide as it is."
    );
  });

  it("counts the saved and the missing slides when some are missing", () => {
    expect(interruptedNoticeText(4, 8)).toBe(
      "4 of 8 planned slides are saved. Select Continue in the chat to make only the 4 missing slides, or use the slides as they are."
    );
    expect(interruptedNoticeText(7, 8)).toContain("make only the 1 missing slide,");
  });

  it("does not offer slides that do not exist", () => {
    expect(interruptedNoticeText(0, 5)).toBe("None of the 5 planned slides were saved. Select Continue in the chat to make them.");
    expect(interruptedNoticeText(0, 1)).toBe("The planned slide was not saved. Select Continue in the chat to make it.");
    expect(interruptedNoticeText(0, null)).toBe("No slides were saved. Select Continue in the chat to make them.");
  });

  it("claims nothing about missing slides when the plan is unknown", () => {
    expect(interruptedNoticeText(3, null)).toBe(
      "The 3 slides are saved, but the carousel may be incomplete. Select Continue in the chat to finish it, or use the slides as they are."
    );
    expect(interruptedNoticeText(1, null)).toMatch(/^The slide is saved/);
    expect(interruptedNoticeText(3, null)).not.toMatch(/missing/);
  });
});
