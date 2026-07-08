import { describe, expect, it } from "vitest";
import { randomSillyName, shuffledSillyNames, SILLY_NAMES, sillyNamesByGender } from "./sillyNames";

describe("randomSillyName", () => {
  it("always returns a name from the roster", () => {
    for (let i = 0; i < 20; i++) {
      expect(SILLY_NAMES.map((n) => n.name)).toContain(randomSillyName());
    }
  });

  it("never returns the excluded name", () => {
    for (let i = 0; i < 20; i++) {
      expect(randomSillyName("Ben Dover")).not.toBe("Ben Dover");
    }
  });
});

describe("sillyNamesByGender", () => {
  it("only returns names tagged with the requested gender", () => {
    const female = sillyNamesByGender("female");
    const femaleSet = new Set(SILLY_NAMES.filter((n) => n.gender === "female").map((n) => n.name));
    expect(female.every((name) => femaleSet.has(name))).toBe(true);
    expect(female.length).toBe(femaleSet.size);
  });
});

describe("shuffledSillyNames", () => {
  it("returns every name exactly once", () => {
    const shuffled = shuffledSillyNames();
    expect(shuffled).toHaveLength(SILLY_NAMES.length);
    expect(new Set(shuffled.map((n) => n.name)).size).toBe(SILLY_NAMES.length);
  });

  it("does not mutate the original roster", () => {
    const before = SILLY_NAMES.map((n) => n.name);
    shuffledSillyNames();
    expect(SILLY_NAMES.map((n) => n.name)).toEqual(before);
  });
});
