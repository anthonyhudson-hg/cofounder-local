import { describe, expect, it } from "vitest";
import { modelLabel, modelProvider } from "./types";

describe("modelLabel", () => {
  it("returns the human-readable label for a known model id", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("falls back to the raw id for an unknown model", () => {
    expect(modelLabel("some-future-model")).toBe("some-future-model");
  });

  it("returns an empty string for a null model", () => {
    expect(modelLabel(null)).toBe("");
  });
});

describe("modelProvider", () => {
  it("identifies the provider for a known model id", () => {
    expect(modelProvider("claude-sonnet-5")).toBe("claude");
  });

  it("defaults to claude for an unknown model id", () => {
    expect(modelProvider("some-future-model")).toBe("claude");
    expect(modelProvider(null)).toBe("claude");
  });
});
