import * as readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { drainTurn, getProvider, Effort } from "./providers";

interface SendRequest {
  type: "send";
  id: string;
  conversationId: string;
  companyId?: string | null;
  provider?: string | null;
  model: string;
  effort: Effort;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string | null;
}

interface CountTokensRequest {
  type: "count_tokens";
  id: string;
  provider?: string | null;
  model: string;
  systemPrompt: string;
}

interface CheckRelevanceRequest {
  type: "check_relevance";
  id: string;
  employeeContext: string;
  channelName: string;
  triggerMessage: string;
}

interface ThreadRef {
  id: string;
  preview: string;
}

interface ReactionTarget {
  id: string;
  author: string;
  preview: string;
}

interface SendChannelRequest {
  type: "send_channel";
  id: string;
  companyId?: string | null;
  provider?: string | null;
  model: string;
  effort: Effort;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string | null;
  openThreads: ThreadRef[];
  reactionTargets: ReactionTarget[];
}

type IncomingRequest = SendRequest | CountTokensRequest | CheckRelevanceRequest | SendChannelRequest;

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function emitError(id: string, message: string): void {
  emit({ type: "error", id, message });
}

async function handleSend(req: SendRequest): Promise<void> {
  try {
    const result = await drainTurn(
      getProvider(req.provider).runTurn({
        model: req.model,
        effort: req.effort,
        systemPrompt: req.systemPrompt,
        prompt: req.prompt,
        resumeSessionId: req.resumeSessionId,
      }),
      (text) => emit({ type: "delta", id: req.id, text }),
    );

    emit({
      type: "done",
      id: req.id,
      sessionId: result.sessionId ?? req.resumeSessionId ?? null,
      success: result.success,
      usage: result.usage,
      totalCostUsd: result.totalCostUsd,
    });
  } catch (err) {
    emitError(req.id, err instanceof Error ? err.message : String(err));
  }
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function handleCountTokens(req: CountTokensRequest): Promise<void> {
  const text = req.systemPrompt ?? "";
  if (!text.trim()) {
    emit({ type: "token_count", id: req.id, tokens: 0, exact: true });
    return;
  }

  // Exact token counting is Anthropic-specific; other providers fall back to an
  // approximation (this figure is only a system-prompt size indicator).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (req.provider === "codex" || !apiKey) {
    emit({ type: "token_count", id: req.id, tokens: approxTokens(text), exact: false });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const result = await client.messages.countTokens({
      model: req.model,
      system: text,
      messages: [{ role: "user", content: " " }],
    });
    emit({ type: "token_count", id: req.id, tokens: result.input_tokens, exact: true });
  } catch {
    emit({ type: "token_count", id: req.id, tokens: approxTokens(text), exact: false });
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : text;
}

async function handleCheckRelevance(req: CheckRelevanceRequest): Promise<void> {
  try {
    const systemPrompt = [
      `You are deciding whether ONE employee should reply to a message in the #${req.channelName} channel.`,
      `Say YES (respond) if the message is relevant to this employee's role, asks for something they can help with, addresses them, or they can add genuine value. Say NO only if it is clearly outside their area or they would add nothing. For a plausibly-relevant employee, lean YES — in a channel, a helpful reply beats silence. (Direct @mentions are already handled and always reply.)`,
      `Employee:\n${req.employeeContext}`,
      `Respond with ONLY a JSON object, no other text: {"respond": true|false, "reason": "one short sentence"}`,
    ].join("\n\n");

    // Relevance gatekeeping is a cheap, internal Claude call regardless of which
    // provider the employee chats with.
    let raw = "";
    await drainTurn(
      getProvider("claude").runTurn({
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        systemPrompt,
        prompt: req.triggerMessage,
      }),
      (text) => {
        raw += text;
      },
    );

    try {
      const parsed = JSON.parse(extractJson(raw));
      emit({
        type: "relevance_result",
        id: req.id,
        respond: Boolean(parsed.respond),
        reason: String(parsed.reason ?? ""),
      });
    } catch {
      emit({
        type: "relevance_result",
        id: req.id,
        respond: false,
        reason: `Could not parse relevance decision; defaulting to skip. Raw: ${raw.slice(0, 200)}`,
      });
    }
  } catch (err) {
    emit({
      type: "relevance_result",
      id: req.id,
      respond: false,
      reason: `Relevance check errored, defaulting to skip: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

interface ChannelControl {
  respondsWithText: boolean;
  replyToMessageId: string | null;
  threadRootId: string | null;
  reactions: { messageId: string; emoji: string }[];
}

function parseChannelControl(fullText: string): { control: ChannelControl; text: string } {
  const fallback: ChannelControl = {
    respondsWithText: true,
    replyToMessageId: null,
    threadRootId: null,
    reactions: [],
  };

  const match = fullText.match(/```control\s*([\s\S]*?)\s*```/);
  if (!match) return { control: fallback, text: fullText.trim() };

  try {
    const parsed = JSON.parse(match[1]);
    const control: ChannelControl = {
      respondsWithText: parsed.respondsWithText ?? true,
      replyToMessageId: parsed.replyToMessageId ?? null,
      threadRootId: parsed.threadRootId ?? null,
      reactions: Array.isArray(parsed.reactions) ? parsed.reactions : [],
    };
    const text = fullText.slice((match.index ?? 0) + match[0].length).trim();
    return { control, text };
  } catch {
    return { control: fallback, text: fullText.trim() };
  }
}

function buildChannelSystemPrompt(req: SendChannelRequest): string {
  const threadsBlock = req.openThreads.length
    ? req.openThreads.map((t) => `- ${t.id}: ${t.preview}`).join("\n")
    : "(none open right now)";
  const targetsBlock = req.reactionTargets.length
    ? req.reactionTargets.map((t) => `- ${t.id} (${t.author}): ${t.preview}`).join("\n")
    : "(none)";

  return [
    req.systemPrompt,
    [
      "You are responding in a multi-person channel, not a 1:1 DM. Reply with EXACTLY one fenced control block first, then your message text (if any) after it:",
      "```control",
      '{"respondsWithText": true, "replyToMessageId": null, "threadRootId": null, "reactions": []}',
      "```",
      "Your message text goes here if respondsWithText is true.",
      "",
      "Rules:",
      '- Set "respondsWithText" to false if you have nothing valuable to add and do not want to post a message (you can still react via "reactions" even when this is false).',
      '- "replyToMessageId": the id of a specific message you are directly replying to, or null.',
      '- "threadRootId": the id of an existing thread to reply within (see Open threads below), or null to post as a new top-level message.',
      '- "reactions": a list of {"messageId": "...", "emoji": "..."} for reactions to add to specific recent messages, independent of whether you post text.',
      "",
      "Open threads:",
      threadsBlock,
      "",
      "Recent messages you can reply to or react to:",
      targetsBlock,
    ].join("\n"),
  ].join("\n\n---\n\n");
}

async function handleSendChannel(req: SendChannelRequest): Promise<void> {
  try {
    let fullText = "";
    const result = await drainTurn(
      getProvider(req.provider).runTurn({
        model: req.model,
        effort: req.effort,
        systemPrompt: buildChannelSystemPrompt(req),
        prompt: req.prompt,
        resumeSessionId: req.resumeSessionId,
      }),
      (text) => {
        fullText += text;
      },
    );

    const { control, text } = parseChannelControl(fullText);

    emit({
      type: "channel_result",
      id: req.id,
      respondsWithText: control.respondsWithText,
      text,
      replyToMessageId: control.replyToMessageId,
      threadRootId: control.threadRootId,
      reactions: control.reactions,
      sessionId: result.sessionId ?? req.resumeSessionId ?? null,
      success: result.success,
      usage: result.usage,
      totalCostUsd: result.totalCostUsd,
    });
  } catch (err) {
    emitError(req.id, err instanceof Error ? err.message : String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: IncomingRequest;
  try {
    req = JSON.parse(trimmed);
  } catch {
    emitError("unknown", `Invalid JSON on stdin: ${trimmed}`);
    return;
  }

  if (req.type === "send") {
    void handleSend(req);
  } else if (req.type === "count_tokens") {
    void handleCountTokens(req);
  } else if (req.type === "check_relevance") {
    void handleCheckRelevance(req);
  } else if (req.type === "send_channel") {
    void handleSendChannel(req);
  } else {
    emitError((req as { id?: string }).id ?? "unknown", `Unknown request type: ${(req as { type?: string }).type}`);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

emit({ type: "ready" });
