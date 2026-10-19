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
  type ReplayBranch,
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
    expect(row.cutFallbacks).toBe(2);
    expect(row.cutUnavailable).toBe(0);
    expect(row.thresholdCrossings).toBe(2);
    expect(row.jobsStarted).toBe(0);
    expect(row.coldMisses).toBe(2);
    expect(row.coldMissTokens).toBe(90_000);
    expect(row.prefillTokenPrefix).toBe(142_000);
    expect(row.prefillBlockLevel).toBe(102_000);
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
    expect(row.cutFallbacks).toBe(3);
    expect(row.thresholdCrossings).toBe(1);
    expect(row.jobsStarted).toBe(3);
    // Index 0 pays 50,000; the applies at 1 and 3 pay 26,000 each; the cold
    // apply at index 2 pays its own 40,000 prompt plus the 26,000 re-read.
    expect(row.prefillTokenPrefix).toBe(168_000);
    expect(row.prefillBlockLevel).toBe(108_000);
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
    expect(row.cutFallbacks).toBe(3);
    expect(row.thresholdCrossings).toBe(1);
    expect(row.jobsStarted).toBe(3);
    // Same 40,000 cold prompt at index 2 as the rewrite row; the appended
    // notes blocks still add 1,600 and 2,208 tokens.
    expect(row.prefillTokenPrefix).toBe(173_408);
    expect(row.prefillBlockLevel).toBe(99_808);
    expect(row.summaryEndTokens).toBe(9_808);
    expect(row.summaryMaxTokens).toBe(9_808);
    expect(row.summaryWriteTokens).toBe(9_808);
    expect(row.notesAppends).toBe(2);
    expect(row.notesBlocks).toBe(2);
    expect(row.consolidations).toBe(0);
    expect(row.finalContextTokens).toBe(29_808);
  });

  test("a toolUse turn is not a task boundary", () => {
    const toolUseRequests = [request(1_000_000, 20_000, 0, { stopReason: "toolUse" }), request(1_060_000, 40_000, 20_000, { stopReason: "toolUse" })];
    const row = simulatePolicy(toolUseRequests, {
      policy: "early-rewrite",
      contextWindowFor: () => 100_000,
      coldAt: () => false,
      recordedSummaryTokens: [5_000],
    });
    expect(row.applies.boundary).toBe(0);
    expect(row.appliesTotal).toBe(0);
    // The same row with a normal stop is a boundary apply, so the assertion
    // above cannot pass for an unrelated reason.
    const stopRequests = [request(1_000_000, 20_000, 0), request(1_060_000, 40_000, 20_000)];
    const stopRow = simulatePolicy(stopRequests, {
      policy: "early-rewrite",
      contextWindowFor: () => 100_000,
      coldAt: () => false,
      recordedSummaryTokens: [5_000],
    });
    expect(stopRow.applies.boundary).toBe(1);
  });

  test("the initial cold request is counted in both prefill models", () => {
    const twoRequests = [request(1_000_000, 20_000, 0), request(1_060_000, 40_000, 20_000)];
    const early = simulatePolicy(twoRequests, {
      policy: "early-rewrite",
      contextWindowFor: () => 100_000,
      coldAt: () => false,
      recordedSummaryTokens: [5_000],
    });
    expect(early.applies.boundary).toBe(1);
    expect(early.prefillTokenPrefix).toBe(45_000);
    expect(early.prefillBlockLevel).toBe(25_000);

    const stock = simulatePolicy(twoRequests, {
      policy: "stock",
      contextWindowFor: () => 100_000,
      coldAt: () => false,
      recordedSummaryTokens: [5_000],
    });
    expect(stock.appliesTotal).toBe(0);
    expect(stock.prefillTokenPrefix).toBe(40_000);
    expect(stock.prefillBlockLevel).toBe(40_000);
  });

  const compactionAtZero: ReplayBranch = {
    edits: [],
    entries: [
      {
        index: 0,
        id: "c0",
        parentId: null,
        timestamp: 0,
        type: "compaction",
        tokens: 0,
        summaryTokens: 5_000,
        firstKeptEntryId: "m1",
      },
      { index: 1, id: "m1", parentId: "c0", timestamp: 0, type: "message", role: "user", tokens: 1_000 },
      {
        index: 2,
        id: "m2",
        parentId: "m1",
        timestamp: 0,
        type: "message",
        role: "assistant",
        stopReason: "stop",
        tokens: 1_000,
      },
    ],
  };

  const compactionAtOne: ReplayBranch = {
    edits: [],
    entries: [
      {
        index: 0,
        id: "a0",
        parentId: null,
        timestamp: 0,
        type: "message",
        role: "assistant",
        stopReason: "stop",
        tokens: 20_000,
      },
      {
        index: 1,
        id: "c1",
        parentId: "a0",
        timestamp: 0,
        type: "compaction",
        tokens: 0,
        summaryTokens: 5_000,
        firstKeptEntryId: "a0",
      },
    ],
  };

  interface PrefillCase {
    name: string;
    requests: ReplayRequest[];
    coldAt: (index: number) => boolean;
    branch?: ReplayBranch;
    expected: {
      prefillTokenPrefix: number;
      prefillBlockLevel: number;
      coldMisses: number;
      coldMissTokens: number;
      thresholdApplies?: number;
    };
  }

  // Every expectation below is hand-computed for a 100,000-token window:
  // T = 60,000 (base ratio 0.6), effective keep-recent = 20,000, and a
  // recorded summary of 5,000 tokens. A threshold apply on context C removes
  // C - 20,000 and leaves 20,000 + 5,000 = 25,000 tokens.
  const prefillCases: PrefillCase[] = [
    {
      name: "no apply",
      requests: [request(1_000_000, 30_000, 0), request(1_060_000, 35_000, 5_000)],
      coldAt: () => false,
      expected: { prefillTokenPrefix: 35_000, prefillBlockLevel: 35_000, coldMisses: 1, coldMissTokens: 30_000, thresholdApplies: 0 },
    },
    {
      name: "apply at index 0",
      requests: [request(1_000_000, 80_000, 0)],
      coldAt: () => false,
      expected: { prefillTokenPrefix: 80_000, prefillBlockLevel: 80_000, coldMisses: 1, coldMissTokens: 80_000, thresholdApplies: 1 },
    },
    {
      name: "apply at index 0, post-apply context on the next request",
      requests: [request(1_000_000, 80_000, 0), request(1_060_000, 35_000, 10_000)],
      coldAt: () => false,
      expected: { prefillTokenPrefix: 115_000, prefillBlockLevel: 95_000, coldMisses: 1, coldMissTokens: 80_000, thresholdApplies: 1 },
    },
    {
      name: "apply at index 1",
      requests: [request(1_000_000, 30_000, 0), request(1_060_000, 65_000, 35_000)],
      coldAt: () => false,
      expected: { prefillTokenPrefix: 55_000, prefillBlockLevel: 35_000, coldMisses: 1, coldMissTokens: 30_000, thresholdApplies: 1 },
    },
    {
      name: "cold request that also applies at index 1",
      requests: [request(1_000_000, 30_000, 0), request(1_060_000, 65_000, 35_000)],
      coldAt: (index) => index === 1,
      expected: { prefillTokenPrefix: 120_000, prefillBlockLevel: 100_000, coldMisses: 2, coldMissTokens: 95_000, thresholdApplies: 1 },
    },
    {
      name: "recorded builtin compaction at index 0",
      requests: [request(1_000_000, 50_000, 0, { entryIndex: 2 })],
      coldAt: () => false,
      branch: compactionAtZero,
      expected: { prefillTokenPrefix: 50_000, prefillBlockLevel: 50_000, coldMisses: 1, coldMissTokens: 50_000 },
    },
    {
      name: "recorded compaction resync on a cold request",
      requests: [
        request(1_000_000, 30_000, 0, { entryIndex: 0 }),
        request(1_060_000, 40_000, 0, { entryIndex: 1 }),
      ],
      coldAt: (index) => index === 1,
      branch: compactionAtOne,
      expected: { prefillTokenPrefix: 70_000, prefillBlockLevel: 70_000, coldMisses: 2, coldMissTokens: 70_000 },
    },
    {
      name: "cold flag at index 0",
      requests: [request(1_000_000, 30_000, 0), request(1_060_000, 35_000, 5_000)],
      coldAt: (index) => index === 0,
      expected: { prefillTokenPrefix: 35_000, prefillBlockLevel: 35_000, coldMisses: 1, coldMissTokens: 30_000, thresholdApplies: 0 },
    },
    {
      name: "toolUse stopReason at index 0",
      requests: [request(1_000_000, 80_000, 0, { stopReason: "toolUse" })],
      coldAt: () => false,
      expected: { prefillTokenPrefix: 80_000, prefillBlockLevel: 80_000, coldMisses: 1, coldMissTokens: 80_000, thresholdApplies: 0 },
    },
  ];

  for (const policy of ["stock", "early-rewrite", "early-notes"] as const) {
    for (const scenario of prefillCases) {
      test(`${policy}: ${scenario.name}`, () => {
        const row = simulatePolicy(scenario.requests, {
          policy,
          contextWindowFor: () => 100_000,
          coldAt: scenario.coldAt,
          recordedSummaryTokens: [5_000],
          branch: scenario.branch,
        });
        expect(row.prefillTokenPrefix).toBe(scenario.expected.prefillTokenPrefix);
        expect(row.prefillBlockLevel).toBe(scenario.expected.prefillBlockLevel);
        expect(row.coldMisses).toBe(scenario.expected.coldMisses);
        expect(row.coldMissTokens).toBe(scenario.expected.coldMissTokens);
        if (scenario.expected.thresholdApplies !== undefined) {
          expect(row.applies.threshold).toBe(scenario.expected.thresholdApplies);
          expect(row.appliesTotal).toBe(scenario.expected.thresholdApplies);
        }
      });
    }
  }

  test("a recorded compaction resync updates the summary maximum", () => {
    const row = simulatePolicy(
      [
        request(1_000_000, 30_000, 0, { entryIndex: 0 }),
        request(1_060_000, 40_000, 0, { entryIndex: 1 }),
      ],
      {
        policy: "early-rewrite",
        contextWindowFor: () => 100_000,
        coldAt: () => false,
        recordedSummaryTokens: [5_000],
        branch: compactionAtOne,
      },
    );
    expect(row.summaryEndTokens).toBe(5_000);
    expect(row.summaryMaxTokens).toBe(5_000);
  });

  test("the structural cut wins over scalar keep-recent subtraction", () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "structural-cut-session",
      timestamp: TIMESTAMP,
      cwd: "/tmp",
    });
    const entry = (id: string, parentId: string | null, role: string, text: string, usage?: object): string =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: TIMESTAMP,
        message: {
          role,
          content: [{ type: "text", text }],
          ...(role === "assistant"
            ? { stopReason: "stop", usage, provider: "test", model: "test-model" }
            : {}),
        },
      });
    const text = [
      header,
      entry("e1", null, "user", "ab ".repeat(40_000)),
      entry("e2", "e1", "assistant", "ab ".repeat(40_000), { input: 90_000, output: 100 }),
      entry("e3", "e2", "user", "ab ".repeat(40_000)),
      entry("e4", "e3", "assistant", "ab ".repeat(13_333), { input: 30_000, output: 100 }),
    ].join("\n");

    const parsed = parseSessionText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.session.requests.map((value) => value.entryIndex)).toEqual([1, 3]);
    expect(parsed.session.branch.entries.length).toBe(4);

    const options = {
      contextWindowFor: () => 200_000,
      coldAt: () => false,
      recordedSummaryTokens: [],
    } as const;
    const structural = simulatePolicy(parsed.session.requests, {
      ...options,
      policy: "early-rewrite",
      branch: parsed.session.branch,
    });
    const scalar = simulatePolicy(parsed.session.requests, { ...options, policy: "early-rewrite" });

    // Kept tail: e3+e4 (40k tokens), so the structural span is e1+e2 = 60k,
    // not the scalar 120100 - 20000 = 100100.
    expect(structural.cutFallbacks).toBe(0);
    expect(structural.cutUnavailable).toBe(0);
    expect(structural.applies.boundary).toBe(1);
    expect(structural.summaryWriteTokens).toBe(6_000);
    expect(structural.finalContextTokens).toBe(66_100);
    expect(scalar.cutFallbacks).toBe(1);
    expect(scalar.summaryWriteTokens).toBe(10_010);
    expect(structural.summaryWriteTokens).not.toBe(scalar.summaryWriteTokens);
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
