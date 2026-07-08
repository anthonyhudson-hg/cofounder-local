import { describe, expect, it } from "vitest";
import { descendantIds } from "./orgChart";

// This is the core logic behind fixing report §4.1: the manager picker only used to
// exclude direct reports (a 1-hop check), so A managing C who already reports to A via
// B was a fully achievable 2-hop cycle. These tests exercise the BFS directly rather
// than requiring a full component render (report §8 — this was the exact code path a
// real bug was found in during this pass).
describe("descendantIds", () => {
  it("returns an empty set for an employee with no reports", () => {
    const employees = [{ id: "a", manager_employee_id: null }];
    expect(descendantIds("a", employees)).toEqual(new Set());
  });

  it("includes direct reports", () => {
    const employees = [
      { id: "a", manager_employee_id: null },
      { id: "b", manager_employee_id: "a" },
    ];
    expect(descendantIds("a", employees)).toEqual(new Set(["b"]));
  });

  it("includes transitive (multi-hop) reports — the exact case the old 1-hop check missed", () => {
    // A manages B, B manages C: from A's perspective, C is a transitive report.
    const employees = [
      { id: "a", manager_employee_id: null },
      { id: "b", manager_employee_id: "a" },
      { id: "c", manager_employee_id: "b" },
    ];
    const result = descendantIds("a", employees);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
  });

  it("does not include unrelated employees or the root itself", () => {
    const employees = [
      { id: "a", manager_employee_id: null },
      { id: "b", manager_employee_id: "a" },
      { id: "unrelated", manager_employee_id: null },
    ];
    const result = descendantIds("a", employees);
    expect(result.has("unrelated")).toBe(false);
    expect(result.has("a")).toBe(false);
  });

  it("terminates instead of looping forever if the data already contains a cycle", () => {
    // Defensive: if a cycle somehow already exists in stored data (e.g. from before
    // this fix shipped), the BFS must not infinite-loop. Walking the cycle correctly
    // reaches back to "a" itself (via c -> a), which is fine — the property under
    // test is termination, not exact membership.
    const employees = [
      { id: "a", manager_employee_id: "c" },
      { id: "b", manager_employee_id: "a" },
      { id: "c", manager_employee_id: "b" },
    ];
    const result = descendantIds("a", employees);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });
});
