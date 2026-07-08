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

  it("send(): a hard rejection still clears sending and reloads (never gets stuck, report §1.2-class guarantee)", async () => {
    mockedCommandStreaming.mockRejectedValue(new Error("runtime unavailable"));

    const { result } = renderHook(() => useChannel("chan-1", "co-1"));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    mockedQuery.mockClear();
    mockQueries([member]);

    // send() itself doesn't catch — sendToMembers/commandStreaming's rejection
    // propagates, so the caller (Composer's onSend) sees it; what matters here
    // is the finally-guaranteed cleanup, not swallowing the error.
    await expect(
      act(async () => {
        await result.current.send("hey team");
      }),
    ).rejects.toThrow("runtime unavailable");

    expect(result.current.sending).toBe(false);
    expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "chan-1" }, null);
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
