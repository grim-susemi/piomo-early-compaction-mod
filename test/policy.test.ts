import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

import {
  NOTES_HEADER_RE,
  NOTES_SECTION_TITLES,
  summaryTokens,
} from "../src/constants";
import {
  DEFAULTS,
  PolicyConfigError,
  applyDecision,
  baseThresholdRatioForWindow,
  benefitOk,
  computeEffectiveKeepRecentTokens,
  computeEffectiveThreshold,
  isApplyPermissionOpen,
  isBreakerOpen,
  nextCooldownMs,
  nextJobKind,
  resolvePolicyConfig,
  shouldStartJob,
  startJitterMs,
  type ApplyDecisionInput,
  type LastYield,
  type StartJobInput,
} from "../src/policy";

const REFERENCE_POLICY_URL = pathToFileURL(
  "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/policy.js",
).href;

interface ReferencePolicy {
  baseThresholdRatioForWindow(contextWindow: number): number;
  computeEffectiveThreshold(contextWindow: number, lastYield?: LastYield | null): number;
  computeEffectiveKeepRecentTokens(
    setting: number,
    contextWindow: number,
    thresholdRatio: number,
    margin?: number,
  ): number;
}

async function referencePolicy(): Promise<ReferencePolicy> {
  return (await import(REFERENCE_POLICY_URL)) as ReferencePolicy;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  const header =
    "Notes added 2026-10-19T03:19:00.000Z for entries 01a15588-aaaa..01a15599-bbbb. Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.";

  test("notes header matches exactly one line, inside a summary", () => {
    expect(NOTES_HEADER_RE.test(header)).toBe(true);
    expect(NOTES_HEADER_RE.test(header.replace("T03:19:00.000Z", "T03:19:00Z"))).toBe(true);
    expect(NOTES_HEADER_RE.test(`earlier summary\n\n---\n${header}\nNew user requests\n...`)).toBe(true);
  });

  test("notes header rejects a missing rule, a prefix, and a broken timestamp", () => {
    expect(
      NOTES_HEADER_RE.test(
        header.replace(
          " Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.",
          "",
        ),
      ),
    ).toBe(false);
    expect(NOTES_HEADER_RE.test(`prefix ${header}`)).toBe(false);
    expect(NOTES_HEADER_RE.test(header.replace("Z for entries", " for entries"))).toBe(false);
    expect(NOTES_HEADER_RE.test(header.replace("Remaining Tasks", "Remaining tasks"))).toBe(false);
  });

  test("section titles are the five shared with todo 7", () => {
    expect([...NOTES_SECTION_TITLES]).toEqual([
      "New user requests",
      "New constraints",
      "Work done",
      "Current state and files",
      "Current next steps",
    ]);
  });

  test("summaryTokens is the chars/4 estimate of a compaction summary message", () => {
    expect(summaryTokens("")).toBe(0);
    expect(summaryTokens("abcd")).toBe(1);
    expect(summaryTokens("abcde")).toBe(2);
    expect(summaryTokens("a".repeat(40_000))).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Builtin threshold port
// ---------------------------------------------------------------------------

const EQUIVALENCE_WINDOWS = [0, 16_000, 32_000, 64_000, 128_000, 262_144, 512_000, 600_000, 1_000_000];

const EQUIVALENCE_YIELDS: Array<LastYield | undefined> = [
  undefined,
  { savedTokens: 9_000, tokensBefore: 10_000 }, // high yield: > 0.5
  { savedTokens: 100, tokensBefore: 10_000 }, // low yield: < 0.1
  { savedTokens: 0, tokensBefore: 10_000 }, // zero saved
];

describe("builtin threshold port", () => {
  test("window bands match the reference", async () => {
    const reference = await referencePolicy();
    expect(EQUIVALENCE_WINDOWS.map(baseThresholdRatioForWindow)).toEqual(
      EQUIVALENCE_WINDOWS.map((window) => reference.baseThresholdRatioForWindow(window)),
    );
    expect(EQUIVALENCE_WINDOWS.map(baseThresholdRatioForWindow)).toEqual([
      0.5, 0.45, 0.5, 0.55, 0.6, 0.7, 0.7, 0.8, 0.8,
    ]);
  });

  test("computeEffectiveThreshold deep-equals the reference for every window and yield", async () => {
    const reference = await referencePolicy();
    const actual: number[] = [];
    const expected: number[] = [];
    for (const window of EQUIVALENCE_WINDOWS) {
      for (const lastYield of EQUIVALENCE_YIELDS) {
        actual.push(computeEffectiveThreshold(window, lastYield));
        expected.push(reference.computeEffectiveThreshold(window, lastYield));
      }
    }
    expect(actual).toEqual(expected);
  });

  test("computeEffectiveKeepRecentTokens deep-equals the reference", async () => {
    const reference = await referencePolicy();
    const settings = [0, 1_024, 10_000, 20_000, 50_000];
    const ratios = [0, 0.4, 0.6, 0.8];
    const margins = [0.05, 0.1];
    const actual: number[] = [];
    const expected: number[] = [];
    for (const window of EQUIVALENCE_WINDOWS) {
      for (const setting of settings) {
        for (const ratio of ratios) {
          for (const margin of margins) {
            actual.push(computeEffectiveKeepRecentTokens(setting, window, ratio, margin));
            expected.push(reference.computeEffectiveKeepRecentTokens(setting, window, ratio, margin));
          }
        }
      }
    }
    expect(actual).toEqual(expected);
  });

  test("600K windows scale a 20K keepRecent to 30K", () => {
    expect(computeEffectiveKeepRecentTokens(20_000, 600_000, 0.6)).toBe(30_000);
    expect(computeEffectiveKeepRecentTokens(20_000, 400_000, 0.6)).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("policy config", () => {
  test("DEFAULTS carries the plan's numbers", () => {
    expect(DEFAULTS.startRatio).toBe(0.4);
    expect(DEFAULTS.growthMinTokens).toBe(4_096);
    expect(DEFAULTS.growthWindowRatio).toBe(0.05);
    expect(DEFAULTS.maxStartsPerHour).toBe(6);
    expect(DEFAULTS.maxStartsPerDay).toBe(40);
    expect(DEFAULTS.startJitterMaxMs).toBe(30_000);
    expect(DEFAULTS.breakerFailureThreshold).toBe(3);
    expect(DEFAULTS.breakerOpenMs).toBe(1_800_000);
    expect([...DEFAULTS.cooldownStepsMs]).toEqual([60_000, 120_000, 300_000]);
    expect(DEFAULTS.benefitMinTokens).toBe(8_192);
    expect(DEFAULTS.benefitRatio).toBe(0.1);
    expect(DEFAULTS.staleWindowRatio).toBe(0.1);
    expect(DEFAULTS.boundaryGrowthMinTokens).toBe(16_384);
    expect(DEFAULTS.boundaryGrowthRatio).toBe(0.1);
    expect(DEFAULTS.draftHoldMs).toBe(30_000);
    expect(DEFAULTS.thresholdRoute).toBe(true);
    expect(DEFAULTS.consolidateSummaryTokens).toBe(8_192);
    expect(DEFAULTS.consolidateNotesBlocks).toBe(4);
  });

  test("overrides merge over DEFAULTS without mutating them", () => {
    const config = resolvePolicyConfig({ startRatio: 0.5, thresholdRoute: false });
    expect(config.startRatio).toBe(0.5);
    expect(config.thresholdRoute).toBe(false);
    expect(config.benefitMinTokens).toBe(DEFAULTS.benefitMinTokens);
    expect(DEFAULTS.startRatio).toBe(0.4);
    expect(DEFAULTS.thresholdRoute).toBe(true);
  });

  test("undefined/null policy is a full copy of DEFAULTS", () => {
    expect(resolvePolicyConfig(undefined)).toEqual(DEFAULTS);
    expect(resolvePolicyConfig(null)).toEqual(DEFAULTS);
    expect(resolvePolicyConfig({})).toEqual(DEFAULTS);
  });

  test("unknown keys are rejected with a named error that names the key", () => {
    expect(() => resolvePolicyConfig({ nope: 1 })).toThrow(PolicyConfigError);
    try {
      resolvePolicyConfig({ nope: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyConfigError);
      expect((error as PolicyConfigError).name).toBe("PolicyConfigError");
      expect((error as PolicyConfigError).key).toBe("nope");
    }
  });

  test("wrong types are rejected with a named error (policy.startRatio: string)", () => {
    expect(() => resolvePolicyConfig({ startRatio: "x" })).toThrow(PolicyConfigError);
    try {
      resolvePolicyConfig({ startRatio: "x" });
    } catch (error) {
      expect((error as PolicyConfigError).key).toBe("startRatio");
      expect((error as Error).message).toContain("startRatio");
    }
    expect(() => resolvePolicyConfig({ thresholdRoute: "yes" })).toThrow(PolicyConfigError);
    expect(() => resolvePolicyConfig({ cooldownStepsMs: [] })).toThrow(PolicyConfigError);
    expect(() => resolvePolicyConfig({ benefitMinTokens: Number.NaN })).toThrow(PolicyConfigError);
    expect(() => resolvePolicyConfig([] as unknown)).toThrow(PolicyConfigError);
  });
});

// ---------------------------------------------------------------------------
// Start rule
// ---------------------------------------------------------------------------

function startInput(overrides: Partial<StartJobInput> = {}): StartJobInput {
  return {
    contextTokens: 40_000,
    contextWindow: 100_000,
    growthSincePreparedTokens: 5_000,
    now: 10_000_000,
    sessionStartTimes: [],
    cooldownUntil: null,
    consecutiveFailures: 0,
    lastFailureAt: null,
    random: () => 0,
    ...overrides,
  };
}

describe("shouldStartJob", () => {
  test("starts exactly at U = 0.40W or above, not one token below", () => {
    expect(shouldStartJob(startInput({ contextTokens: 39_999 }))).toEqual({
      start: false,
      reason: "below-start-ratio",
    });
    expect(shouldStartJob(startInput({ contextTokens: 40_000 })).start).toBe(true);
    expect(shouldStartJob(startInput({ contextTokens: 40_001 })).start).toBe(true);
  });

  test("growth floor is max(4096, 0.05W)", () => {
    // 0.05 * 100000 = 5000 dominates 4096: 4999 blocks, 5000 and 5001 start.
    expect(shouldStartJob(startInput({ growthSincePreparedTokens: 4_999 })).start).toBe(false);
    expect(shouldStartJob(startInput({ growthSincePreparedTokens: 5_000 })).start).toBe(true);
    expect(shouldStartJob(startInput({ growthSincePreparedTokens: 5_001 })).start).toBe(true);

    // At W = 50000 the fixed 4096 floor dominates 2500: 4095 blocks, 4096 and 4097 start.
    expect(
      shouldStartJob(
        startInput({ contextWindow: 50_000, contextTokens: 20_000, growthSincePreparedTokens: 4_095 }),
      ).start,
    ).toBe(false);
    expect(
      shouldStartJob(
        startInput({ contextWindow: 50_000, contextTokens: 20_000, growthSincePreparedTokens: 4_096 }),
      ).start,
    ).toBe(true);
    expect(
      shouldStartJob(
        startInput({ contextWindow: 50_000, contextTokens: 20_000, growthSincePreparedTokens: 4_097 }),
      ).start,
    ).toBe(true);
  });

  test("has no upper bound: a start is allowed at and above T", () => {
    expect(shouldStartJob(startInput({ contextTokens: 60_000 })).start).toBe(true);
    expect(shouldStartJob(startInput({ contextTokens: 100_000 })).start).toBe(true);
  });

  test("cooldown blocks strictly before cooldownUntil", () => {
    const now = 10_000_000;
    expect(shouldStartJob(startInput({ now, cooldownUntil: now + 1 })).start).toBe(false);
    expect(shouldStartJob(startInput({ now, cooldownUntil: now })).start).toBe(true);
  });

  test("hourly spend cap: 5 prior starts allow, 6 block", () => {
    const now = 10_000_000;
    const starts = (count: number) => Array.from({ length: count }, (_, index) => now - (index + 1) * 1_000);
    expect(shouldStartJob(startInput({ now, sessionStartTimes: starts(5) })).start).toBe(true);
    expect(shouldStartJob(startInput({ now, sessionStartTimes: starts(6) }))).toEqual({
      start: false,
      reason: "hourly-cap",
    });
  });

  test("daily spend cap: 39 prior starts allow, 40 block", () => {
    const now = 10_000_000;
    const starts = (count: number) =>
      Array.from({ length: count }, (_, index) => now - (index + 1) * 2_000_000);
    expect(shouldStartJob(startInput({ now, sessionStartTimes: starts(39) })).start).toBe(true);
    expect(shouldStartJob(startInput({ now, sessionStartTimes: starts(40) }))).toEqual({
      start: false,
      reason: "daily-cap",
    });
  });

  test("breaker opens at 3 consecutive failures and closes after 30 minutes", () => {
    const now = 10_000_000;
    expect(shouldStartJob(startInput({ now, consecutiveFailures: 2, lastFailureAt: now - 1_000 })).start).toBe(
      true,
    );
    expect(shouldStartJob(startInput({ now, consecutiveFailures: 3, lastFailureAt: now - 1_000 }))).toEqual({
      start: false,
      reason: "breaker-open",
    });
    expect(
      shouldStartJob(startInput({ now, consecutiveFailures: 3, lastFailureAt: now - (1_800_000 - 1) })).start,
    ).toBe(false);
    expect(
      shouldStartJob(startInput({ now, consecutiveFailures: 3, lastFailureAt: now - 1_800_000 })).start,
    ).toBe(true);
    // Missing clock fails closed.
    expect(shouldStartJob(startInput({ now, consecutiveFailures: 3, lastFailureAt: null })).start).toBe(false);
  });

  test("isBreakerOpen mirrors the breaker rule directly", () => {
    expect(isBreakerOpen(2, 0, 100_000)).toBe(false);
    expect(isBreakerOpen(3, 0, 100_000)).toBe(true);
    expect(isBreakerOpen(3, 0, 1_800_000)).toBe(false);
  });

  test("jitter is 0..30 s and injectable", () => {
    expect(startJitterMs(() => 0)).toBe(0);
    expect(startJitterMs(() => 0.5)).toBe(15_000);
    expect(startJitterMs(() => 1)).toBe(30_000);
    expect(startJitterMs(() => Number.NaN)).toBe(0);
    expect(shouldStartJob(startInput({ random: () => 0.25 })).jitterMs).toBe(7_500);
  });

  test("config override changes the start ratio", () => {
    const config = resolvePolicyConfig({ startRatio: 0.5 });
    expect(shouldStartJob(startInput({ contextTokens: 49_999, config })).start).toBe(false);
    expect(shouldStartJob(startInput({ contextTokens: 50_000, config })).start).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Benefit and cooldown
// ---------------------------------------------------------------------------

describe("benefitOk and cooldown", () => {
  test("benefit floor is max(8192, 0.10U)", () => {
    // 0.10 * 100000 = 10000 dominates 8192.
    expect(benefitOk(100_000, 90_000)).toBe(true);
    expect(benefitOk(100_000, 90_001)).toBe(false);
    // At U = 50000 the fixed 8192 floor dominates 5000.
    expect(benefitOk(50_000, 41_808)).toBe(true);
    expect(benefitOk(50_000, 41_809)).toBe(false);
  });

  test("cooldown sequence is 60/120/300/300", () => {
    expect(nextCooldownMs(0)).toBe(0);
    expect(nextCooldownMs(1)).toBe(60_000);
    expect(nextCooldownMs(2)).toBe(120_000);
    expect(nextCooldownMs(3)).toBe(300_000);
    expect(nextCooldownMs(4)).toBe(300_000);
    expect(nextCooldownMs(99)).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Apply decision
// ---------------------------------------------------------------------------

function applyInput(overrides: Partial<ApplyDecisionInput> = {}): ApplyDecisionInput {
  return {
    contextTokens: 50_000,
    contextWindow: 100_000,
    jobReady: true,
    tokensAppendedAfterCut: 20_000,
    effectiveKeepRecentTokens: 20_000,
    anchorValid: true,
    fingerprintValid: true,
    estimatedTokensAfter: 40_000,
    idle: true,
    hasPendingMessages: false,
    compacting: false,
    site: "agent_settled",
    now: 1_000_000,
    permission: {},
    todoRestorePending: false,
    cache: "warm",
    runEnd: { aborted: false, willRetry: false },
    lastAssistantStopReason: "stop",
    growthSinceAppliedTokens: 16_384,
    ...overrides,
  };
}

describe("applyDecision common conditions", () => {
  test("threshold boundary: U >= T, one token on each side", () => {
    const base = { growthSinceAppliedTokens: 0, runEnd: null };
    expect(applyDecision(applyInput({ ...base, contextTokens: 59_999 }))).toBe("none");
    expect(applyDecision(applyInput({ ...base, contextTokens: 60_000 }))).toBe("threshold");
    expect(applyDecision(applyInput({ ...base, contextTokens: 60_001 }))).toBe("threshold");
  });

  test("lastYield moves T exactly like the builtin", () => {
    const highYield: LastYield = { savedTokens: 9_000, tokensBefore: 10_000 };
    expect(applyDecision(applyInput({ contextTokens: 55_000, lastYield: highYield }))).toBe("threshold");
    expect(
      applyDecision(
        applyInput({ contextTokens: 54_999, lastYield: highYield, growthSinceAppliedTokens: 0, runEnd: null }),
      ),
    ).toBe("none");
  });

  test("thresholdRoute can be disabled", () => {
    const config = resolvePolicyConfig({ thresholdRoute: false });
    expect(
      applyDecision(applyInput({ contextTokens: 60_000, growthSinceAppliedTokens: 0, runEnd: null, config })),
    ).toBe("none");
  });

  test("cold route needs a cold cache", () => {
    expect(applyDecision(applyInput({ cache: "cold", growthSinceAppliedTokens: 0, runEnd: null }))).toBe("cold");
    expect(applyDecision(applyInput({ cache: "unknown", growthSinceAppliedTokens: 0, runEnd: null }))).toBe(
      "none",
    );
  });

  test("boundary needs a normal run end and max(16384, 0.10W) growth", () => {
    expect(applyDecision(applyInput({ growthSinceAppliedTokens: 16_384 }))).toBe("boundary");
    expect(applyDecision(applyInput({ growthSinceAppliedTokens: 16_383 }))).toBe("none");
    expect(applyDecision(applyInput({ runEnd: { aborted: true, willRetry: false } }))).toBe("none");
    expect(applyDecision(applyInput({ runEnd: { aborted: false, willRetry: true } }))).toBe("none");
    expect(applyDecision(applyInput({ lastAssistantStopReason: "length" }))).toBe("none");
    expect(applyDecision(applyInput({ lastAssistantStopReason: "error" }))).toBe("none");
  });

  test("cold wins over boundary (but threshold wins over cold)", () => {
    expect(applyDecision(applyInput({ cache: "cold" }))).toBe("cold");
    expect(applyDecision(applyInput({ cache: "cold", contextTokens: 60_000 }))).toBe("threshold");
  });

  test("READY staleness is max(keepRecentEff, 0.10W)", () => {
    expect(applyDecision(applyInput({ tokensAppendedAfterCut: 19_999 }))).toBe("boundary");
    expect(applyDecision(applyInput({ tokensAppendedAfterCut: 20_000 }))).toBe("boundary");
    expect(applyDecision(applyInput({ tokensAppendedAfterCut: 20_001 }))).toBe("none");
    // 0.10W dominates a smaller keepRecent.
    expect(
      applyDecision(applyInput({ effectiveKeepRecentTokens: 1_000, tokensAppendedAfterCut: 9_999 })),
    ).toBe("boundary");
    expect(
      applyDecision(applyInput({ effectiveKeepRecentTokens: 1_000, tokensAppendedAfterCut: 10_000 })),
    ).toBe("boundary");
    expect(
      applyDecision(applyInput({ effectiveKeepRecentTokens: 1_000, tokensAppendedAfterCut: 10_001 })),
    ).toBe("none");
  });

  test("benefit floor is enforced", () => {
    expect(applyDecision(applyInput({ estimatedTokensAfter: 41_808 }))).toBe("boundary");
    expect(applyDecision(applyInput({ estimatedTokensAfter: 41_809 }))).toBe("none");
  });

  test("job, anchor, fingerprint, idle, pending and compacting gate the apply", () => {
    expect(applyDecision(applyInput({ jobReady: false }))).toBe("none");
    expect(applyDecision(applyInput({ anchorValid: false }))).toBe("none");
    expect(applyDecision(applyInput({ fingerprintValid: false }))).toBe("none");
    expect(applyDecision(applyInput({ idle: false }))).toBe("none");
    expect(applyDecision(applyInput({ hasPendingMessages: true }))).toBe("none");
    expect(applyDecision(applyInput({ compacting: true }))).toBe("none");
    expect(applyDecision(applyInput({ contextTokens: null }))).toBe("none");
    expect(applyDecision(applyInput({ contextWindow: 0 }))).toBe("none");
  });
});

describe("apply permission", () => {
  test("a prompt closes applies until the next agent_settled", () => {
    const now = 1_000_000;
    expect(
      applyDecision(applyInput({ now, permission: { lastPromptAt: now - 1_000 } })),
    ).toBe("none");
    expect(
      applyDecision(
        applyInput({ now, site: "timer", permission: { lastPromptAt: now - 1_000 } }),
      ),
    ).toBe("none");
    expect(
      applyDecision(
        applyInput({ now, cache: "cold", permission: { lastPromptAt: now - 1_000 } }),
      ),
    ).toBe("none");
    expect(
      applyDecision(
        applyInput({
          now,
          permission: { lastPromptAt: now - 1_000, lastAgentSettledAt: now - 500 },
        }),
      ),
    ).toBe("boundary");
  });

  test("timer applies are held until 30 s after the last draft", () => {
    const now = 1_000_000;
    expect(
      applyDecision(applyInput({ now, site: "timer", permission: { lastDraftAt: now - 29_999 } })),
    ).toBe("none");
    expect(
      applyDecision(applyInput({ now, site: "timer", permission: { lastDraftAt: now - 30_000 } })),
    ).toBe("boundary");
    // The draft hold does not apply to agent_settled.
    expect(
      applyDecision(applyInput({ now, site: "agent_settled", permission: { lastDraftAt: now - 1 } })),
    ).toBe("boundary");
  });

  test("todo-restore blocks timer applies only", () => {
    expect(applyDecision(applyInput({ site: "timer", todoRestorePending: true }))).toBe("none");
    expect(applyDecision(applyInput({ site: "agent_settled", todoRestorePending: true }))).toBe("boundary");
  });

  test("the input seam admits threshold and cold; closed permission only makes threshold the exception", () => {
    const now = 1_000_000;
    const closed = { lastPromptAt: now };
    const base = { now, site: "input" as const, growthSinceAppliedTokens: 0, runEnd: null };

    // Open permission, cold cache: the input handler applies cold like settled/timer.
    expect(applyDecision(applyInput({ ...base, cache: "cold", permission: {} }))).toBe("cold");
    // Closed permission, cold cache: the exception is threshold-only, so none.
    expect(applyDecision(applyInput({ ...base, cache: "cold", permission: closed }))).toBe("none");

    // Closed permission at/above T: threshold is the one admitted route.
    expect(
      applyDecision(applyInput({ ...base, cache: "warm", contextTokens: 60_000, permission: closed })),
    ).toBe("threshold");
    expect(
      applyDecision(applyInput({ ...base, cache: "warm", contextTokens: 59_999, permission: closed })),
    ).toBe("none");

    // The submitted prompt counts toward T at the input seam.
    expect(
      applyDecision(
        applyInput({ ...base, cache: "warm", contextTokens: 59_999, promptTokens: 1, permission: closed }),
      ),
    ).toBe("threshold");
    expect(
      applyDecision(
        applyInput({ ...base, cache: "warm", contextTokens: 59_998, promptTokens: 1, permission: closed }),
      ),
    ).toBe("none");

    // Open permission, warm cache, below T: boundary needs a settled run, so none.
    expect(applyDecision(applyInput({ ...base, cache: "warm", permission: {} }))).toBe("none");
  });

  test("isApplyPermissionOpen exposes the same rules", () => {
    const now = 1_000_000;
    expect(isApplyPermissionOpen({ lastPromptAt: now - 1 }, "agent_settled", now)).toBe(false);
    expect(
      isApplyPermissionOpen(
        { lastPromptAt: now - 1, lastAgentSettledAt: now },
        "agent_settled",
        now,
      ),
    ).toBe(true);
    expect(isApplyPermissionOpen({ lastDraftAt: now - 29_999 }, "timer", now)).toBe(false);
    expect(isApplyPermissionOpen({ lastDraftAt: now - 30_000 }, "timer", now)).toBe(true);
    expect(
      isApplyPermissionOpen({ lastPromptAt: now - 1 }, "input", now, { thresholdException: true }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Next job kind
// ---------------------------------------------------------------------------

describe("nextJobKind", () => {
  test("all four outcomes", () => {
    expect(
      nextJobKind({ hasCompactionEntry: false, mode: "notes", summaryTokens: 0, notesBlocks: 0 }),
    ).toBe("rewrite-first");
    expect(
      nextJobKind({ hasCompactionEntry: false, mode: "rewrite", summaryTokens: 99_999, notesBlocks: 99 }),
    ).toBe("rewrite-first");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 8_191, notesBlocks: 3 }),
    ).toBe("notes");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 8_192, notesBlocks: 3 }),
    ).toBe("rewrite-consolidate");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 0, notesBlocks: 4 }),
    ).toBe("rewrite-consolidate");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "rewrite", summaryTokens: 0, notesBlocks: 0 }),
    ).toBe("rewrite");
  });

  test("config override changes the consolidation floors", () => {
    const config = resolvePolicyConfig({ consolidateSummaryTokens: 100, consolidateNotesBlocks: 2 });
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 99, notesBlocks: 1, config }),
    ).toBe("notes");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 100, notesBlocks: 1, config }),
    ).toBe("rewrite-consolidate");
    expect(
      nextJobKind({ hasCompactionEntry: true, mode: "notes", summaryTokens: 0, notesBlocks: 2, config }),
    ).toBe("rewrite-consolidate");
  });
});
