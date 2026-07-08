import { describe, expect, it } from "vitest";
import { buildIdentityBlock, composeSystemPrompt, resolveManagerName } from "./promptBuilder";

describe("resolveManagerName", () => {
  it("resolves to the founder's name when there is no manager employee", () => {
    expect(resolveManagerName(null, {}, "Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("falls back to 'the founder' when there is no manager and no founder name set", () => {
    expect(resolveManagerName(null, {}, "")).toBe("the founder");
  });

  it("resolves to the named manager employee when one is set", () => {
    const employeesById = { "emp-1": { name: "Ben Dover" } };
    expect(resolveManagerName("emp-1", employeesById, "Ada Lovelace")).toBe("Ben Dover");
  });

  it("falls back to the founder if the manager id doesn't resolve to a known employee", () => {
    expect(resolveManagerName("missing-id", {}, "Ada Lovelace")).toBe("Ada Lovelace");
  });
});

describe("buildIdentityBlock", () => {
  it("describes the employee's role, department, and manager", () => {
    const block = buildIdentityBlock("Jenny Talia", { job_title: "Chief of Staff", department: "Executive" }, "Ada Lovelace");
    expect(block).toBe("You are Jenny Talia, Chief of Staff in the Executive department. You report to Ada Lovelace.");
  });
});

describe("composeSystemPrompt", () => {
  it("joins only the non-empty sections in order", () => {
    const prompt = composeSystemPrompt(
      "Acme Inc, a startup",
      "",
      "You are Jenny Talia, Chief of Staff.",
      { mission: "Keep the founder focused", preamble: "", additional_details: "" },
      ["Triage inbound requests", "Own the calendar"],
    );

    expect(prompt).toContain("Company: Acme Inc, a startup");
    expect(prompt).toContain("You are Jenny Talia, Chief of Staff.");
    expect(prompt).toContain("Mission: Keep the founder focused");
    expect(prompt).toContain("- Triage inbound requests");
    expect(prompt).toContain("- Own the calendar");
    // The formatting guidance is always appended so agents get consistent output.
    expect(prompt).toMatch(/lightweight Markdown/);
  });

  it("omits empty sections, leaving only the fixed formatting guidance", () => {
    const prompt = composeSystemPrompt("", "", "", { mission: "", preamble: "", additional_details: "" }, []);
    expect(prompt).not.toContain("Company:");
    expect(prompt).not.toContain("Mission:");
    expect(prompt.split("\n\n")).toHaveLength(1);
  });

  it("injects personality/communication style/expertise/autonomy when an agent profile is passed", () => {
    const prompt = composeSystemPrompt(
      "",
      "",
      "You are Ada, Engineer.",
      { mission: "", preamble: "", additional_details: "" },
      [],
      { personality: "Enthusiastic and curious.", communicationStyle: "Casual, lots of emoji.", expertise: ["rust", "distributed systems"], autonomyLevel: "autonomous" },
    );
    expect(prompt).toContain("Personality: Enthusiastic and curious.");
    expect(prompt).toContain("Communication style: Casual, lots of emoji.");
    expect(prompt).toContain("Areas of expertise: rust, distributed systems");
    expect(prompt).toContain("Autonomy level: autonomous.");
  });

  it("stays byte-for-byte free of the profile sections when no agent profile is passed (every pre-existing caller)", () => {
    const prompt = composeSystemPrompt("", "", "identity", { mission: "", preamble: "", additional_details: "" }, []);
    expect(prompt).not.toContain("Personality:");
    expect(prompt).not.toContain("Communication style:");
    expect(prompt).not.toContain("Areas of expertise:");
    expect(prompt).not.toContain("Autonomy level:");
    expect(prompt).not.toContain("undefined");
  });
});
