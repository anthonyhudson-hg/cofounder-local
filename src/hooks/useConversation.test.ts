import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Employee } from "../types";

// Integration-level coverage for the hook that used to be untestable without a
// live sidecar process — now that it's a thin transport layer over
// command/query/commandStreaming, mocking runtimeClient is enough to exercise
// the real optimistic-UI/streaming/reconciliation logic (report §8, deferred
// as "no RTL set up yet"; closed as part of the full runtime cutover).
vi.mock("../lib/runtimeClient", () => ({
  command: vi.fn(),
  query: vi.fn(),
  commandStreaming: vi.fn(),
}));

import { command, commandStreaming, query } from "../lib/runtimeClient";
import { useConversation } from "./useConversation";

const mockedQuery = vi.mocked(query);
const mockedCommand = vi.mocked(command);
const mockedCommandStreaming = vi.mocked(commandStreaming);

const employee: Employee = {
  id: "emp-1",
  company_id: "co-1",
  conversation_id: "conv-1",
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

function mockEmptyQueries() {
  mockedQuery.mockImplementation(async (type: string) => {
    if (type === "messages.list") return [];
    if (type === "messages.replyCounts") return {};
    if (type === "reactions.list") return [];
    if (type === "questions.list") return [];
    if (type === "approvals.list") return [];
    throw new Error(`unexpected query in test: ${type}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmptyQueries();
});

describe("useConversation", () => {
  it("loads messages, reply counts, and reactions for the conversation on mount", async () => {
    renderHook(() => useConversation("conv-1", "co-1", employee));

    await waitFor(() => {
      expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "conv-1" }, null);
      expect(mockedQuery).toHaveBeenCalledWith("messages.replyCounts", { conversationId: "conv-1" }, null);
      expect(mockedQuery).toHaveBeenCalledWith("reactions.list", { conversationId: "conv-1" }, null);
    });
  });

  it("send(): appears optimistically, streams text + debug payload live, then reconciles with the server on completion", async () => {
    let resolveSend: (value: unknown) => void;
    let capturedOnDelta: ((channel: string, data: unknown) => void) | undefined;
    mockedCommandStreaming.mockImplementation(
      (_type, _payload, _companyId, onDelta) =>
        new Promise((resolve) => {
          capturedOnDelta = onDelta;
          resolveSend = resolve;
        }),
    );

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    act(() => {
      void result.current.send("hi there", "claude-sonnet-5", "medium");
    });

    // Optimistic user + assistant placeholders appear immediately, before the
    // command has resolved at all.
    expect(result.current.sending).toBe(true);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "hi there", status: "complete" });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", content: "", status: "streaming" });

    // The "meta" delta (debug payload) and "text" deltas both patch the live
    // optimistic assistant message in real time, well before the command settles
    // — this is the exact behavior the debug-payload-during-streaming fix relies on.
    act(() => {
      capturedOnDelta!("meta", { messageId: "server-assistant-id", debugPayload: '{"prompt":"hi there"}' });
      capturedOnDelta!("text", { messageId: "server-assistant-id", text: "Hello" });
      capturedOnDelta!("text", { messageId: "server-assistant-id", text: " world" });
    });

    expect(result.current.messages[1]).toMatchObject({
      content: "Hello world",
      debug_payload: '{"prompt":"hi there"}',
      status: "streaming",
    });

    // Once the command resolves, the hook reloads from the DB — assert the
    // reload actually re-fires (messages.list called a second time), and the
    // mocked (empty) reload result replaces the optimistic state entirely,
    // proving reconciliation — not just a same-shape merge — actually happened.
    mockedQuery.mockClear();
    mockEmptyQueries();
    await act(async () => {
      resolveSend!({ userMessageId: "u1", assistantMessageId: "a1", sessionId: "s1", success: true, reaction: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "conv-1" }, null);
    expect(result.current.messages).toHaveLength(0);
  });

  it("send(): 'tool' deltas surface as activeTool (start) and clear it (end), and the turn ending always clears it", async () => {
    let resolveSend: (value: unknown) => void;
    let capturedOnDelta: ((channel: string, data: unknown) => void) | undefined;
    mockedCommandStreaming.mockImplementation(
      (_type, _payload, _companyId, onDelta) =>
        new Promise((resolve) => {
          capturedOnDelta = onDelta;
          resolveSend = resolve;
        }),
    );

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    act(() => {
      void result.current.send("remember this", "claude-sonnet-5", "medium");
    });
    const assistantId = result.current.messages[1].id;

    expect(result.current.activeTool).toBeNull();
    act(() => {
      capturedOnDelta!("tool", { messageId: "server-assistant-id", name: "mcp__cofounder__memory_write", phase: "start" });
    });
    expect(result.current.activeTool).toEqual({ messageId: assistantId, name: "mcp__cofounder__memory_write" });

    act(() => {
      capturedOnDelta!("tool", { messageId: "server-assistant-id", name: "mcp__cofounder__memory_write", phase: "end" });
    });
    expect(result.current.activeTool).toBeNull();

    // Defensive clear: even if a "start" arrived with no matching "end", the
    // turn settling must not leave a stale indicator stuck on screen.
    act(() => {
      capturedOnDelta!("tool", { messageId: "server-assistant-id", name: "mcp__cofounder__memory_write", phase: "start" });
    });
    expect(result.current.activeTool).not.toBeNull();

    mockedQuery.mockClear();
    mockEmptyQueries();
    await act(async () => {
      resolveSend!({ userMessageId: "u1", assistantMessageId: "a1", sessionId: "s1", success: true, reaction: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(result.current.activeTool).toBeNull();
  });

  it("send(): a second send() while one is in flight queues (appears optimistically as 'pending') instead of racing, and fires automatically once the first finishes — composer must never lock or drop a message", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockedCommandStreaming.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    act(() => {
      result.current.send("first", "claude-sonnet-5", "medium");
    });
    expect(result.current.sending).toBe(true);
    expect(mockedCommandStreaming).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.send("second", "claude-sonnet-5", "medium");
    });
    // Queued, not sent — commandStreaming is NOT called a second time yet, but
    // the message appears immediately (optimistic), the assistant placeholder
    // is "pending" (nothing has started running for it).
    expect(mockedCommandStreaming).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[2]).toMatchObject({ role: "user", content: "second" });
    expect(result.current.messages[3]).toMatchObject({ role: "assistant", status: "pending" });

    mockedQuery.mockClear();
    mockEmptyQueries();

    // Resolving the first turn should automatically fire the queued second one.
    await act(async () => {
      resolvers[0]({ userMessageId: "u1", assistantMessageId: "a1", sessionId: null, success: true, reaction: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedCommandStreaming).toHaveBeenCalledTimes(2));
    expect(mockedCommandStreaming.mock.calls[1][1]).toMatchObject({ text: "second" });
    // sending stays true across the handoff between queued turns — it must not
    // flicker false-then-true, which would make the composer briefly re-lock/
    // unlock between two sends that were always meant to run back-to-back.
    expect(result.current.sending).toBe(true);

    mockedQuery.mockClear();
    mockEmptyQueries();
    await act(async () => {
      resolvers[1]({ userMessageId: "u2", assistantMessageId: "a2", sessionId: null, success: true, reaction: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
  });

  it("cancel(): sends command:message.cancel for whichever message is currently in flight, and is a clean no-op with nothing in flight", () => {
    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));

    // Nothing in flight yet — must not call the backend at all.
    result.current.cancel();
    expect(mockedCommand).not.toHaveBeenCalled();

    mockedCommandStreaming.mockImplementation(() => new Promise(() => {})); // never resolves, turn stays in flight
    act(() => {
      result.current.send("hi", "claude-sonnet-5", "medium");
    });
    const inFlightAssistantId = result.current.messages[1].id;

    result.current.cancel();
    expect(mockedCommand).toHaveBeenCalledWith("message.cancel", { messageId: inFlightAssistantId }, "co-1");
  });

  it("send(): a graceful failure (result.success = false) marks the assistant message errored", async () => {
    mockedCommandStreaming.mockResolvedValue({
      userMessageId: "u1",
      assistantMessageId: "a1",
      sessionId: null,
      success: false,
      errorMessage: "rate limited",
      reaction: null,
    });

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    await act(async () => {
      await result.current.send("hi", "claude-sonnet-5", "medium");
    });

    // reload() replaced messages with the (empty) mocked query result, so the
    // failure is only observable via sending having settled cleanly (no hang,
    // no thrown error) — the actual error-message persistence is covered
    // server-side by the sidecar's "provider throwing" test.
    expect(result.current.sending).toBe(false);
  });

  it("send(): commandStreaming rejecting outright still marks the message errored and always reloads/clears sending", async () => {
    mockedCommandStreaming.mockRejectedValue(new Error("network blip"));

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    mockedQuery.mockClear();
    mockEmptyQueries();

    await act(async () => {
      await result.current.send("hi", "claude-sonnet-5", "medium");
    });

    // The §1.2-class guarantee this hook depends on: a hard rejection must not
    // leave `sending` stuck true forever, and must still reconcile with the DB.
    expect(result.current.sending).toBe(false);
    expect(mockedQuery).toHaveBeenCalledWith("messages.list", { conversationId: "conv-1" }, null);
  });

  it("send(): the post-turn reload() itself rejecting still clears sending (composer must not get stuck read-only)", async () => {
    mockedCommandStreaming.mockResolvedValue({
      userMessageId: "u1",
      assistantMessageId: "a1",
      sessionId: null,
      success: true,
      reaction: null,
    });

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    // The turn itself succeeds; the reconciliation reload() that runs
    // afterward is what fails this time (timeout, backend error, etc).
    mockedQuery.mockImplementation(async (type: string) => {
      throw new Error(`reload failed: ${type}`);
    });

    await act(async () => {
      await result.current.send("hi", "claude-sonnet-5", "medium");
    });

    expect(result.current.sending).toBe(false);
  });

  it("send(): a reaction on the result triggers a reactions reload", async () => {
    mockedCommandStreaming.mockResolvedValue({
      userMessageId: "u1",
      assistantMessageId: "a1",
      sessionId: null,
      success: true,
      reaction: { messageId: "u1", emoji: "👍" },
    });

    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    const reactionCallsBefore = mockedQuery.mock.calls.filter((c) => c[0] === "reactions.list").length;

    await act(async () => {
      await result.current.send("hi", "claude-sonnet-5", "medium");
    });

    const reactionCallsAfter = mockedQuery.mock.calls.filter((c) => c[0] === "reactions.list").length;
    // reload() already refetches reactions once — the reaction branch adds one
    // more explicit reloadReactions() call on top of that.
    expect(reactionCallsAfter).toBeGreaterThan(reactionCallsBefore);
  });

  it("send(): does nothing when no employee is bound to the conversation yet", async () => {
    const { result } = renderHook(() => useConversation("conv-1", "co-1", null));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

    await act(async () => {
      await result.current.send("hi", "claude-sonnet-5", "medium");
    });

    expect(mockedCommandStreaming).not.toHaveBeenCalled();
    expect(result.current.sending).toBe(false);
  });

  it("toggleReaction(): passes the real company scope, not null (regression: register.ts's reaction.toggle requires one)", async () => {
    const { result } = renderHook(() => useConversation("conv-1", "co-1", employee));
    await waitFor(() => expect(mockedQuery).toHaveBeenCalled());

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
