import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinSummarySizes,
  notesSummaryTokens,
  parseSessionText,
  rewriteSummaryTokens,
  scanForCopiedText,
  simulatePolicy,
  spanTokensFor,
  type ReplayRequest,
} from "../qa/replay";

const TIMESTAMP = "2026-10-01T00:00:00.000Z";

function request(
  ts: number,
  promptTokens: number,
  appendedTokens: number,
  overrides: Partial<ReplayRequest> = {},
): ReplayRequest {
  return {
    ts,
    promptTokens,
    appendedTokens,
    cacheRead: 0,
    outputTokens: 100,
    provider: "test",
    modelId: "test-model",
    stopReason: "stop",
    ...overrides,
  };
}

const requests: ReplayRequest[] = [
  request(1_000_000, 50_000, 0),
  request(1_060_000, 60_000, 10_000),
  request(1_120_000, 40_000, 14_000),
  request(1_180_000, 56_000, 20_000),
];

const recordedSummaryTokens = [5_000, 6_000, 7_000];

function simulate(policy: "stock" | "early-rewrite" | "early-notes") {
  return simulatePolicy(requests, {
    policy,
    contextWindowFor: () => 100_000,
    coldAt: (index) => index === 2,
    recordedSummaryTokens,
  });
}

describe("replay size model", () => {
  test("notes are 0.08 x span tokens", () => {
    expect(notesSummaryTokens(100_000)).toBe(8_000);
    expect(notesSummaryTokens(12_500)).toBe(1_000);
    expect(notesSummaryTokens(0)).toBe(0);
  });

  test("rewrite uses the median recorded summary size", () => {
    expect(rewriteSummaryTokens([5_000, 6_000, 7_000], 100_000)).toBe(6_000);
    expect(rewriteSummaryTokens([5_000, 7_000], 100_000)).toBe(6_000);
    expect(rewriteSummaryTokens([], 100_000)).toBe(10_000);
  });

  test("a rewrite never exceeds the summarized span", () => {
    expect(rewriteSummaryTokens([20_000], 3_000)).toBe(3_000);
  });

  test("the cut keeps the effective keep-recent tail", () => {
    expect(spanTokensFor(60_000, 20_000)).toBe(40_000);
    expect(spanTokensFor(15_000, 20_000)).toBe(0);
  });
});

describe("replay policy rows", () => {
  test("stock compacts at the threshold and follows the yield-adjusted threshold", () => {
    const row = simulate("stock");
    expect(row.applies).toEqual({ cold: 0, boundary: 0, threshold: 2 });
    expect(row.appliesTotal).toBe(2);
    expect(row.thresholdCrossings).toBe(2);
    expect(row.jobsStarted).toBe(0);
    expect(row.coldMisses).toBe(1);
    expect(row.coldMissTokens).toBe(40_000);
    expect(row.prefillTokenPrefix).toBe(92_000);
    expect(row.prefillBlockLevel).toBe(52_000);
    expect(row.applyRereadTokenPrefix).toBe(52_000);
    expect(row.applyRereadBlockLevel).toBe(12_000);
    expect(row.summaryEndTokens).toBe(6_000);
    expect(row.summaryWriteTokens).toBe(12_000);
    expect(row.finalContextTokens).toBe(26_000);
  });

  test("early rewrite applies at threshold, cold and boundary routes", () => {
    const row = simulate("early-rewrite");
    expect(row.applies).toEqual({ cold: 1, boundary: 1, threshold: 1 });
    expect(row.appliesTotal).toBe(3);
    expect(row.thresholdCrossings).toBe(1);
    expect(row.jobsStarted).toBe(3);
    expect(row.prefillTokenPrefix).toBe(78_000);
    expect(row.prefillBlockLevel).toBe(18_000);
    expect(row.summaryEndTokens).toBe(6_000);
    expect(row.summaryWriteTokens).toBe(18_000);
    expect(row.notesBlocks).toBe(0);
    expect(row.consolidations).toBe(0);
    expect(row.finalContextTokens).toBe(26_000);
  });

  test("early notes grow the summary by 0.08 x span per appended block", () => {
    const row = simulate("early-notes");
    expect(row.applies).toEqual({ cold: 1, boundary: 1, threshold: 1 });
    expect(row.appliesTotal).toBe(3);
    expect(row.thresholdCrossings).toBe(1);
    expect(row.jobsStarted).toBe(3);
    expect(row.prefillTokenPrefix).toBe(83_408);
    expect(row.prefillBlockLevel).toBe(9_808);
    expect(row.summaryEndTokens).toBe(9_808);
    expect(row.summaryMaxTokens).toBe(9_808);
    expect(row.summaryWriteTokens).toBe(9_808);
    expect(row.notesAppends).toBe(2);
    expect(row.notesBlocks).toBe(2);
    expect(row.consolidations).toBe(0);
    expect(row.finalContextTokens).toBe(29_808);
  });
});

describe("replay parsing", () => {
  test("a valid session keeps recorded usage and compaction sizes", () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "synthetic-session",
      timestamp: TIMESTAMP,
      cwd: "/tmp",
    });
    const message = JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: TIMESTAMP,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(400) }],
        stopReason: "stop",
        usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const compaction = JSON.stringify({
      type: "compaction",
      id: "c1",
      parentId: "m1",
      timestamp: TIMESTAMP,
      summary: "y".repeat(2_000),
      firstKeptEntryId: "m1",
      tokensBefore: 20_000,
      details: { schema: "senpi.compaction.summary.v1" },
    });
    const parsed = parseSessionText([header, message, compaction].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.session.requests.length).toBe(1);
    expect(parsed.session.requests[0].promptTokens).toBe(1_000);
    expect(parsed.session.compactions.length).toBe(1);
    expect(parsed.session.compactions[0].summaryTokens).toBe(500);
    expect(parsed.session.compactions[0].schema).toBe("senpi.compaction.summary.v1");
  });

  test("only builtin-generated summaries feed the rewrite size model", () => {
    expect(
      builtinSummarySizes([
        { ts: 1, tokensBefore: 10, summaryTokens: 500, schema: "senpi.compaction.summary.v1" },
        { ts: 2, tokensBefore: 10, summaryTokens: 16, schema: "senpi.compaction.openai-remote.v1" },
        { ts: 3, tokensBefore: 10, summaryTokens: 16, schema: "unknown" },
      ]),
    ).toEqual([500]);
  });

  test("a truncated file is skipped with a named reason", () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "truncated-session",
      timestamp: TIMESTAMP,
      cwd: "/tmp",
    });
    const parsed = parseSessionText(`${header}\n{"type":"message"`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unparseable-jsonl-line-2");
  });

  test("a header without usage is skipped with a named reason", () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "empty-session",
      timestamp: TIMESTAMP,
      cwd: "/tmp",
    });
    const parsed = parseSessionText(header);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("no-recorded-usage");
  });
});

describe("copied-text scan", () => {
  test("finds a 40-character run of copied text and clears a numbers-only report", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-scan-test-"));
    try {
      const marker = "copied message text that must never reach the report";
      const copy = join(dir, "copy.jsonl");
      writeFileSync(copy, `{"type":"message","text":"${marker}"}\n`, "utf8");

      const hit = scanForCopiedText([`| ${marker} |`], [copy]);
      expect(hit.matches).toBeGreaterThan(0);

      const clean = scanForCopiedText(
        ["| session | policy | prefill |\n| --- | --- | --- |\n| abc | stock | 12345 |"],
        [copy],
      );
      expect(clean.matches).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
