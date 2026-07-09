import { describe, expect, it } from "vitest";
import { notificationReplyCommand } from "./notificationRoute";

describe("notificationReplyCommand", () => {
  it("routes a 1:1 DM reply through the DM turn", () => {
    expect(notificationReplyCommand("dm")).toBe("message.send");
  });

  it("routes a channel reply through the channel turn", () => {
    expect(notificationReplyCommand("channel")).toBe("message.sendChannel");
  });

  it("routes a group DM reply through the channel turn (not the single-employee DM path)", () => {
    expect(notificationReplyCommand("group")).toBe("message.sendChannel");
  });
});
