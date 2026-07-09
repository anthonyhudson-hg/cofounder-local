import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Employee } from "../types";

// Mirrors useConversation.test.ts — the channel-send orchestration itself now
// lives entirely server-side (sendChannelMessage), so this hook is thin enough
// that mocking runtimeClient is sufficient to exercise it for real (report §8).
vi.mock("../lib/runtimeClient", () => ({
  command: vi.fn(),
  query: vi.fn(),
  commandStreaming: vi.fn(),
}));

import { command, commandStreaming, query } from "../lib/runtimeClient";
import { useChannel } from "./useChannel";

const mockedQuery = vi.mocked(query);
const mockedCommand = vi.mocked(command);
const mockedCommandStreaming = vi.mocked(commandStreaming);

const member: Employee = {
  id: "emp-1",
  company_id: "co-1",
  conversation_id: "dm-1",
  job_title: "Engineer",
  department: "Eng",
  manager_employee_id: null,
  mission: "",
  preamble: "",
  additional_details: "",
  default_model: "claude-sonnet-5",
  default_effort: "medium",
  avatar: null,
  created_at: "2024-01-01T00:00:00Z",
};

function mockQueries(members: Employee[]) {
  mockedQuery.mockImplementation(async (type: string) => {
    if (type === "messages.list") return [];
    if (type === "messages.replyCounts") return {};
    if (type === "reactions.list") return [];
    if (type === "channel.members") return members;
    if (type === "questions.list") return [];
    throw new Error(`unexpected query in test: ${type}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueries([member]);
});

describe("useChannel", () => {
  it("loads members alongside messages/reactions on mount", async () => {
    const { result } = renderHook(() => useChannel("chan-1", "co-1"));

    await waitFor(() => {
      expect(mockedQuery).toHaveBeenCalledWith("channel.members", { conversationId: "chan-1" }, null);
      expect(result.current.members).toEqual([member]);
    });
  });

  it("send(): appears optimistically, calls message.sendChannel with the real company scope, and reconciles via reload once the whole turn settles", async () => {
    let resolveSend: (value: unknown) => void;
    mockedCommandStreaming.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    act(() => {
      void result.current.send("hey team");
    });

    // Optimistic top-level user message appears immediately.
    expect(result.current.sending).toBe(true);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "hey team", status: "complete" });

    expect(mockedCommandStreaming).toHaveBeenCalledWith(
      "message.sendChannel",
      { conversationId: "chan-1", text: "hey team", replyTo: null },
      "co-1",
      expect.any(Function),
    );

    mockedQuery.mockClear();
    mockQueries([member]);
    await act(async () => {
      resolveSend!({ userMessageId: "u1", responders: [] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    // reload() re-fetched from the DB — channel responses only ever appear this
    // way (no live streaming for channel replies, before or after the cutover).
    expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "chan-1" }, null);
  });

  it("send(): channelText/channelTool/channelDone deltas drive a live per-employee ephemeral placeholder, keyed by employeeId (not a message id, since none exists until the responder decides to post)", async () => {
    let capturedOnDelta: ((channel: string, data: unknown) => void) | undefined;
    let resolveSend: (value: unknown) => void;
    mockedCommandStreaming.mockImplementation(
      (_type, _payload, _companyId, onDelta) =>
        new Promise((resolve) => {
          capturedOnDelta = onDelta;
          resolveSend = resolve;
        }),
    );

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    act(() => {
      result.current.send("hey team");
    });

    act(() => {
      capturedOnDelta!("channelText", { employeeId: "emp-1", text: "Sure, " });
      capturedOnDelta!("channelTool", { employeeId: "emp-1", name: "memory_write", phase: "start" });
    });

    const ephemeral = result.current.messages.find((m) => m.author_employee_id === "emp-1" && m.role === "assistant");
    expect(ephemeral).toMatchObject({ content: "Sure, ", status: "streaming" });
    expect(result.current.activeTools).toEqual({ "emp-1": "memory_write" });

    act(() => {
      capturedOnDelta!("channelText", { employeeId: "emp-1", text: "on it." });
      capturedOnDelta!("channelTool", { employeeId: "emp-1", name: "memory_write", phase: "end" });
    });
    expect(result.current.messages.find((m) => m.author_employee_id === "emp-1")).toMatchObject({ content: "Sure, on it." });
    expect(result.current.activeTools).toEqual({});

    mockedQuery.mockClear();
    mockQueries([member]);
    act(() => {
      capturedOnDelta!("channelDone", { employeeId: "emp-1" });
    });
    // The ephemeral placeholder disappears immediately on channelDone — it
    // doesn't wait for the whole batch (other, possibly slower responders)
    // to finish before this one's real message can appear via reload().
    expect(result.current.messages.some((m) => m.id.startsWith("ephemeral-"))).toBe(false);
    await waitFor(() => expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "chan-1" }, null));

    await act(async () => {
      resolveSend!({ userMessageId: "u1", responders: [{ employeeId: "emp-1", respond: true, posted: true }] });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.sending).toBe(false));
  });

  it("send(): a second send() while one is in flight queues instead of racing (same as a DM) — the queued send fires once the first settles", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockedCommandStreaming.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    act(() => {
      result.current.send("first");
    });
    expect(result.current.sending).toBe(true);
    expect(mockedCommandStreaming).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.send("second");
    });
    // Queued, not sent — the user message still appears immediately (optimistic).
    expect(mockedCommandStreaming).toHaveBeenCalledTimes(1);
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(2);

    mockedQuery.mockClear();
    mockQueries([member]);
    await act(async () => {
      resolvers[0]({ userMessageId: "u1", responders: [] });
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedCommandStreaming).toHaveBeenCalledTimes(2));
    expect(mockedCommandStreaming.mock.calls[1][1]).toMatchObject({ text: "second" });
    expect(result.current.sending).toBe(true);

    mockedQuery.mockClear();
    mockQueries([member]);
    await act(async () => {
      resolvers[1]({ userMessageId: "u2", responders: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.sending).toBe(false));
  });

  it("send(): a hard rejection is swallowed (not an unhandled rejection now that send() is fire-and-forget for queueing) but still clears sending and reloads (report §1.2-class guarantee)", async () => {
    mockedCommandStreaming.mockRejectedValue(new Error("runtime unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    mockedQuery.mockClear();
    mockQueries([member]);

    act(() => {
      result.current.send("hey team");
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "chan-1" }, null);
    expect(consoleError).toHaveBeenCalledWith("channel send failed:", expect.objectContaining({ message: "runtime unavailable" }));
    consoleError.mockRestore();
  });

  it("send(): the post-turn reload() itself rejecting still clears sending (composer must not get stuck read-only)", async () => {
    mockedCommandStreaming.mockResolvedValue({ userMessageId: "u1", responders: [] });

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    // The turn itself succeeds; the reconciliation reload() that runs
    // afterward is what fails this time (timeout, backend error, etc). Unlike
    // the hard-rejection case above, this must NOT propagate — reload()'s own
    // failure is swallowed so it can never suppress the sending-flag reset.
    mockedQuery.mockImplementation(async (type: string) => {
      throw new Error(`reload failed: ${type}`);
    });

    await act(async () => {
      await result.current.send("hey team");
    });

    expect(result.current.sending).toBe(false);
  });

  it("send(): does nothing when the channel has no members", async () => {
    mockQueries([]);
    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalledWith("channel.members", { conversationId: "chan-1" }, null));

    await act(async () => {
      await result.current.send("hello?");
    });

    expect(mockedCommandStreaming).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
  });

  it("toggleReaction(): passes the real company scope, not null (regression: register.ts's reaction.toggle requires one)", async () => {
    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    await act(async () => {
      await result.current.toggleReaction("msg-1", "🎉");
    });

    expect(mockedCommand).toHaveBeenCalledWith(
      "reaction.toggle",
      { messageId: "msg-1", emoji: "🎉", reactor: "user" },
      "co-1",
    );
  });
});
