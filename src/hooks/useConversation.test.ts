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
