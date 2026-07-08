import twemoji from "@twemoji/api";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeReactionIntent, EMOJI_CATEGORIES, QUICK_REACTIONS } from "./emoji";

describe("describeReactionIntent", () => {
  it("describes a known reaction's intent", () => {
    expect(describeReactionIntent("👍")).toMatch(/approval/i);
    expect(describeReactionIntent("❌")).toMatch(/rejected/i);
  });

  it("falls back to a generic description for an unmapped emoji", () => {
    expect(describeReactionIntent("🦄")).toMatch(/no specific agreed meaning/i);
  });
});

describe("bundled Twemoji assets", () => {
  // Every emoji offered in the UI needs its SVG bundled under public/emoji,
  // or <Emoji> silently falls back to the native OS glyph — quietly
  // defeating the whole point of using Twemoji. This guards against adding
  // a new reaction emoji without also adding its asset.
  const allEmoji = [...QUICK_REACTIONS, ...EMOJI_CATEGORIES.flatMap((c) => c.emojis)];

  it.each(Array.from(new Set(allEmoji)))("has a bundled SVG for %s", (emoji) => {
    const codepoint = twemoji.convert.toCodePoint(emoji);
    const path = join(import.meta.dirname, "..", "..", "public", "emoji", `${codepoint}.svg`);
    expect(existsSync(path)).toBe(true);
  });
});
