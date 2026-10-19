import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type SessionEntry,
} from "@code-yeongyu/senpi";
import { computeEffectiveKeepRecentTokens } from "../src/policy";
import { prepareSource, type PrepareSettings } from "../src/prepare";

// Reference implementations are imported in tests only (never from src/).
const SENPI_ROOT = "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi";
const compactionRef = await import(
  pathToFileURL(`${SENPI_ROOT}/dist/core/compaction/compaction.js`).href
);
const sessionManagerRef = await import(
  pathToFileURL(`${SENPI_ROOT}/dist/core/session-manager.js`).href
);

interface ReferencePreparation {
  firstKeptEntryId: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
}

const prepareCompaction = compactionRef.prepareCompaction as (
  entries: SessionEntry[],
  settings: unknown,
  forceProgress?: boolean,
  allowSummaryOnly?: boolean,
) => ReferencePreparation | undefined;
const getSessionContextEntryId = sessionManagerRef.getSessionContextEntryId as (
  message: unknown,
) => string | undefined;

const TIMESTAMP = new Date(0).toISOString();
let entryCounter = 0;

/** A synthetic linear session branch with a valid parent chain. */
class Branch {
  readonly entries: SessionEntry[] = [];

  private push<T extends SessionEntry>(body: Record<string, unknown>): T {
    const parentId = this.entries.length > 0 ? this.entries[this.entries.length - 1].id : null;
    const entry = {
      id: `e${++entryCounter}`,
      parentId,
      timestamp: TIMESTAMP,
      ...body,
    } as unknown as T;
    this.entries.push(entry);
    return entry;
  }

  user(text: string): SessionEntry {
    return this.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
    });
  }

  assistant(text: string): SessionEntry {
    return this.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: 0,
      },
    });
  }

  assistantToolCall(text: string, callId: string): SessionEntry {
    return this.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "toolCall", id: callId, name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
        timestamp: 0,
      },
    });
  }

  toolResult(text: string, callId: string): SessionEntry {
    return this.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
      },
    });
  }

  customMessage(customType: string, text: string): SessionEntry {
    return this.push({
      type: "custom_message",
      customType,
      content: [{ type: "text", text }],
      display: false,
    });
  }

  contextEdit(targetId: string, replacement: null | { content: unknown }): SessionEntry {
    return this.push({ type: "context_edit", targetId, replacement });
  }

  branchSummary(summary: string, fromId: string): SessionEntry {
    return this.push({ type: "branch_summary", fromId, summary });
  }

  compaction(summary: string, firstKeptEntryId: string): SessionEntry {
    return this.push({ type: "compaction", summary, firstKeptEntryId, tokensBefore: 1 });
  }
}

interface CaseOptions {
  contextWindow?: number;
  thresholdRatio?: number;
  keepRecentTokens: number;
}

function messageIds(messages: readonly unknown[]): Array<string | undefined> {
  return messages.map((message) => getSessionContextEntryId(message));
}

function expectParity(branch: Branch, options: CaseOptions) {
  const contextWindow = options.contextWindow ?? 200_000;
  const thresholdRatio = options.thresholdRatio ?? 0.7;
  const keepRecentEff = computeEffectiveKeepRecentTokens(
    options.keepRecentTokens,
    contextWindow,
    thresholdRatio,
  );
  const settings: PrepareSettings = {
    keepRecentTokens: options.keepRecentTokens,
    reserveTokens: 16_384,
  };

  const prepared = prepareSource({
    branchEntries: branch.entries,
    contextWindow,
    thresholdRatio,
    settings,
  });
  const reference = prepareCompaction(branch.entries, {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: keepRecentEff,
  });

  expect(prepared).not.toBeNull();
  expect(reference).toBeDefined();
  const ours = prepared!;
  const theirs = reference!;
  const referenceMessages = [...theirs.messagesToSummarize, ...theirs.turnPrefixMessages];
  const ids = messageIds(referenceMessages);

  expect(ours.keepRecentEff).toBe(keepRecentEff);
  expect(ours.firstKeptEntryId).toBe(theirs.firstKeptEntryId);
  expect(ours.previousSummary).toBe(theirs.previousSummary);
  expect(ours.isSplitTurn).toBe(theirs.isSplitTurn);
  expect(ours.spanMessages as unknown[]).toEqual(referenceMessages);
  expect(messageIds(ours.spanMessages)).toEqual(ids);
  expect(ours.firstSpanEntryId).toBe(ids[0]!);
  expect(ours.lastSpanEntryId).toBe(ids[ids.length - 1]!);
  expect(ours.tokensBefore).toBeGreaterThan(0);

  return { ours, theirs, keepRecentEff, ids };
}

describe("prepareSource", () => {
  test("keeps a trailing tool result with the preceding tool call", () => {
    const branch = new Branch();
    branch.user("u".repeat(800));
    branch.assistant("a".repeat(800));
    branch.user("u".repeat(800));
    branch.assistant("a".repeat(800));
    branch.user("u".repeat(800));
    branch.assistant("a".repeat(800));
    branch.user("u".repeat(800));
    const toolCall = branch.assistantToolCall("call".repeat(200), "call-1");
    branch.toolResult("r".repeat(8_000), "call-1");

    const { ours, theirs } = expectParity(branch, { keepRecentTokens: 2_000 });
    expect(ours.firstKeptEntryId).toBe(toolCall.id);
    expect(theirs.isSplitTurn).toBe(true);
  });

  test("flattens a split turn into one span", () => {
    const branch = new Branch();
    for (let i = 0; i < 4; i++) {
      branch.user(`history-u-${i}-${"u".repeat(800)}`);
      branch.assistant(`history-a-${i}-${"a".repeat(800)}`);
    }
    branch.user("u".repeat(400));
    branch.assistantToolCall("c".repeat(4_000), "call-2");
    branch.toolResult("r".repeat(4_000), "call-2");
    const kept = branch.assistant("a".repeat(4_000));

    const { ours, theirs } = expectParity(branch, { keepRecentTokens: 2_000 });
    expect(ours.isSplitTurn).toBe(true);
    expect(theirs.isSplitTurn).toBe(true);
    expect(ours.firstKeptEntryId).toBe(kept.id);
  });

  test("reuses the previous summary and starts after its kept boundary", () => {
    const branch = new Branch();
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    const retained = branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    branch.compaction("Previous summary kept verbatim.", retained.id);
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));

    const { ours, theirs } = expectParity(branch, { keepRecentTokens: 2_000 });
    expect(ours.previousSummary).toBe("Previous summary kept verbatim.");
    expect(theirs.previousSummary).toBe("Previous summary kept verbatim.");
  });

  test("includes a branch summary in the span", () => {
    const branch = new Branch();
    branch.user("u".repeat(2_000));
    const prior = branch.assistant("a".repeat(2_000));
    const summaryEntry = branch.branchSummary("s".repeat(2_000), prior.id);
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));

    const { ours, ids } = expectParity(branch, { keepRecentTokens: 2_000 });
    expect(ids).toContain(summaryEntry.id);
    expect(ours.isSplitTurn).toBe(false);
  });

  test("skips context-excluded custom messages and keeps their identity as the cut", () => {
    const branch = new Branch();
    const first = branch.user("u".repeat(2_000));
    const omitted = branch.customMessage("fixture.omitted", "o".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    branch.contextEdit(omitted.id, null);
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));
    branch.user("u".repeat(2_000));
    branch.assistant("a".repeat(2_000));

    const { ours, ids } = expectParity(branch, { keepRecentTokens: 5_200 });
    expect(ours.firstKeptEntryId).toBe(omitted.id);
    expect(ids).toEqual([first.id]);
  });

  test("returns null for an empty span", () => {
    const branch = new Branch();
    branch.user("short");
    branch.assistant("short");

    const prepared = prepareSource({
      branchEntries: branch.entries,
      contextWindow: 200_000,
      thresholdRatio: 0.7,
      settings: { keepRecentTokens: 2_000, reserveTokens: 16_384 },
    });
    const reference = prepareCompaction(branch.entries, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: computeEffectiveKeepRecentTokens(2_000, 200_000, 0.7),
    });

    expect(prepared).toBeNull();
    expect(reference).toBeUndefined();
  });

  test("scales keepRecent above the raw setting at a 600K window", () => {
    const branch = new Branch();
    for (let i = 0; i < 17; i++) {
      branch.user(`u-${i}-${"u".repeat(4_000)}`);
      branch.assistant(`a-${i}-${"a".repeat(4_000)}`);
    }

    const { keepRecentEff } = expectParity(branch, {
      contextWindow: 600_000,
      thresholdRatio: 0.7,
      keepRecentTokens: 20_000,
    });
    expect(keepRecentEff).toBe(30_000);
    expect(keepRecentEff).toBeGreaterThan(20_000);
  });
});
