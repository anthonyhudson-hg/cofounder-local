import { describe, expect, it } from "vitest";
import { ReactionNotice } from "../types";
import { formatReactionNotices } from "./reactionNotices";

describe("formatReactionNotices", () => {
  it("returns an empty string when there are no notices", () => {
    expect(formatReactionNotices([])).toBe("");
  });

  it("formats one notice per line with sender, emoji, intent, and preview", () => {
    const notices: ReactionNotice[] = [
      { emoji: "👍", fromName: "Ada Lovelace", onMessagePreview: "Shipped the report", intent: "approval" },
      { emoji: "👀", fromName: "Ben Dover", onMessagePreview: "Draft plan attached", intent: "noted" },
    ];

    const formatted = formatReactionNotices(notices);
    expect(formatted).toContain("[Reactions since your last turn]");
    expect(formatted).toContain('Ada Lovelace reacted 👍 (approval) to your message: "Shipped the report"');
    expect(formatted).toContain('Ben Dover reacted 👀 (noted) to your message: "Draft plan attached"');
    expect(formatted.split("\n")).toHaveLength(3);
  });
});
