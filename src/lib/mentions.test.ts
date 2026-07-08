import { describe, expect, it } from "vitest";
import { findMentions, scopedMentionTargets } from "./mentions";

describe("findMentions", () => {
  const targets = [
    { type: "employee" as const, conversationId: "ben", label: "Ben Dover" },
    { type: "employee" as const, conversationId: "mike", label: "Mike Oxlong" },
    { type: "channel" as const, conversationId: "general", label: "general" },
  ];

  it("matches an @employee mention", () => {
    const matches = findMentions("hey @Ben Dover can you take a look?", targets);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ type: "employee", start: 4, end: 14 });
  });

  it("matches a #channel mention", () => {
    const matches = findMentions("post this in #general please", targets);
    expect(matches).toHaveLength(1);
    expect(matches[0].target.conversationId).toBe("general");
  });

  it("does not match a mention that isn't in the target list", () => {
    const matches = findMentions("cc @Someone Else", targets);
    expect(matches).toHaveLength(0);
  });

  it("does not match when a word character immediately follows the name", () => {
    const matches = findMentions("@Ben Doverific", targets);
    expect(matches).toHaveLength(0);
  });

  it("prefers the longest matching label to avoid partial overlaps", () => {
    const overlapping = [
      { type: "employee" as const, conversationId: "ben", label: "Ben" },
      { type: "employee" as const, conversationId: "ben-dover", label: "Ben Dover" },
    ];
    const matches = findMentions("@Ben Dover is here", overlapping);
    expect(matches).toHaveLength(1);
    expect(matches[0].target.conversationId).toBe("ben-dover");
  });

  it("returns non-overlapping matches sorted by position", () => {
    const matches = findMentions("@Mike Oxlong and @Ben Dover and #general", targets);
    expect(matches.map((m) => m.target.conversationId)).toEqual(["mike", "ben", "general"]);
  });
});

describe("scopedMentionTargets", () => {
  it("only includes the given participant employees and channels", () => {
    const result = scopedMentionTargets({
      participantEmployees: [{ conversation_id: "ben-dover", name: "Ben Dover" }],
      accessibleChannels: [{ id: "general", name: "general" }],
    });

    expect(result).toEqual([
      { type: "employee", conversationId: "ben-dover", label: "Ben Dover" },
      { type: "channel", conversationId: "general", label: "general" },
    ]);
  });

  it("excludes employees who are not participants — the DM isolation guarantee", () => {
    const result = scopedMentionTargets({
      participantEmployees: [{ conversation_id: "ben-dover", name: "Ben Dover" }],
      accessibleChannels: [],
    });

    expect(result.some((t) => t.label === "Mike Oxlong")).toBe(false);
  });

  it("returns an empty list when there are no participants or channels", () => {
    expect(scopedMentionTargets({ participantEmployees: [], accessibleChannels: [] })).toEqual([]);
  });
});
