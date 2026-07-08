import { describe, expect, it, vi } from "vitest";
import { ReactionNotice } from "../types";

// consumeReactionNotices (the function that actually talks to the runtime) had zero
// test coverage before this — only its pure formatting half was tested (report §8).
vi.mock("./runtimeClient", () => ({ command: vi.fn() }));

import { command } from "./runtimeClient";
import { consumeReactionNotices, formatReactionNotices } from "./reactionNotices";

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

describe("consumeReactionNotices", () => {
  it("maps runtime notices into ReactionNotice shape: falls back fromName, truncates preview at 120 chars", async () => {
    vi.mocked(command).mockResolvedValueOnce({
      notices: [
        { emoji: "👍", fromName: null, messageContent: "x".repeat(200) },
        { emoji: "🎉", fromName: "Ada Lovelace", messageContent: "short message" },
      ],
    });

    const result = await consumeReactionNotices("emp-1", "Founder");

    expect(command).toHaveBeenCalledWith(
      "reactionNotices.consume",
      { employeeId: "emp-1", userFullName: "Founder" },
      null,
    );
    expect(result).toHaveLength(2);
    expect(result[0].fromName).toBe("Someone");
    expect(result[0].onMessagePreview).toHaveLength(120);
    expect(result[1].fromName).toBe("Ada Lovelace");
    expect(result[1].onMessagePreview).toBe("short message");
  });

  it("returns an empty array when there are no unseen reactions", async () => {
    vi.mocked(command).mockResolvedValueOnce({ notices: [] });
    const result = await consumeReactionNotices("emp-1", "Founder");
    expect(result).toEqual([]);
  });
});
