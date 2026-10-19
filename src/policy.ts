/**
 * Pure decision policy for early compaction.
 *
 * No I/O, no timers, no senpi imports: every function is a deterministic
 * function of its input (the only nondeterminism is the injectable jitter
 * source). W = context window, U = current context tokens, T = the builtin
 * threshold.
 *
 * The threshold/keep-recent math is a line-for-line port of
 * `@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/policy.js` so
 * T equals stock for every window size and after high- or low-yield
 * compactions. Those constants are fixed ports, not policy knobs.
 */

// ---------------------------------------------------------------------------
// Ported builtin threshold math (BC/policy.js)
// ---------------------------------------------------------------------------

export const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;
export const MAX_ADAPTIVE_THRESHOLD_RATIO = 0.85;
export const HIGH_YIELD_SAVING_RATIO = 0.5;
export const LOW_YIELD_SAVING_RATIO = 0.1;
export const YIELD_ADJUSTMENT_RATIO = 0.05;
export const MIN_EFFECTIVE_KEEP_RECENT_TOKENS = 1024;
export const KEEP_RECENT_WINDOW_FRACTION = 0.05;
export const MAX_SCALED_KEEP_RECENT_TOKENS = 60_000;
export const KEEP_RECENT_SCALE_WINDOW_THRESHOLD = 409_600;
export const KEEP_RECENT_SCALE_MIN_SETTING = 10_000;

/** The yield of the previous compaction, as the builtin records it. */
export interface LastYield {
  savedTokens: number;
  tokensBefore: number;
}

function clampThresholdRatio(ratio: number): number {
  return Math.min(MAX_ADAPTIVE_THRESHOLD_RATIO, Math.max(MIN_ADAPTIVE_THRESHOLD_RATIO, ratio));
}

function adjustThresholdRatio(ratio: number, savedTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) {
    return ratio;
  }
  const savedRatio = savedTokens / contextWindow;
  if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
    return clampThresholdRatio(ratio - YIELD_ADJUSTMENT_RATIO);
  }
  if (savedRatio < LOW_YIELD_SAVING_RATIO) {
    return Math.min(baseThresholdRatioForWindow(contextWindow), clampThresholdRatio(ratio + YIELD_ADJUSTMENT_RATIO));
  }
  return ratio;
}

function adjustEffectiveThresholdRatio(
  ratio: number,
  savedTokens: number,
  tokensBefore: number,
  contextWindow: number,
): number {
  if (tokensBefore <= 0) {
    return ratio;
  }
  const savedRatio = savedTokens / tokensBefore;
  if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
    return ratio - YIELD_ADJUSTMENT_RATIO;
  }
  if (savedRatio < LOW_YIELD_SAVING_RATIO) {
    return Math.min(baseThresholdRatioForWindow(contextWindow), ratio + YIELD_ADJUSTMENT_RATIO);
  }
  return ratio;
}

/** Base ratio by window band: 0.45/0.50/0.55/0.60/0.70/0.80. */
export function baseThresholdRatioForWindow(contextWindow: number): number {
  if (!(contextWindow > 0)) {
    return 0.5;
  }
  if (contextWindow <= 16_000) {
    return 0.45;
  }
  if (contextWindow <= 32_000) {
    return 0.5;
  }
  if (contextWindow <= 64_000) {
    return 0.55;
  }
  if (contextWindow <= 128_000) {
    return 0.6;
  }
  if (contextWindow <= 512_000) {
    return 0.7;
  }
  return 0.8;
}

export function computeAdaptiveThresholdRatio(contextWindow: number, priorCompactionSavedTokens?: number): number {
  const ratio = baseThresholdRatioForWindow(contextWindow);
  if (priorCompactionSavedTokens === undefined) {
    return ratio;
  }
  return adjustThresholdRatio(ratio, priorCompactionSavedTokens, contextWindow);
}

/**
 * T / W. `undefined` (or null) yield returns the base ratio; a high-yield
 * compaction lowers it by 0.05 and a low-yield one raises it by 0.05 (never
 * above the window base), clamped to [0.4, 0.85].
 */
export function computeEffectiveThreshold(
  contextWindow: number,
  lastYield?: LastYield | null,
): number {
  let ratio = computeAdaptiveThresholdRatio(contextWindow);
  if (lastYield) {
    ratio = adjustEffectiveThresholdRatio(ratio, lastYield.savedTokens, lastYield.tokensBefore, contextWindow);
  }
  return clampThresholdRatio(ratio);
}

/**
 * The builtin's effective keepRecent. Scaling only applies to windows above
 * 409,600 tokens with a setting of at least 10,000, so a 600K window keeps 30K
 * rather than the raw 20K. The margin default matches the reference.
 */
export function computeEffectiveKeepRecentTokens(
  setting: number,
  contextWindow: number,
  thresholdRatio: number,
  margin = 0.05,
): number {
  const scaled =
    contextWindow > KEEP_RECENT_SCALE_WINDOW_THRESHOLD && setting >= KEEP_RECENT_SCALE_MIN_SETTING
      ? Math.max(
          setting,
          Math.min(Math.floor(KEEP_RECENT_WINDOW_FRACTION * contextWindow), MAX_SCALED_KEEP_RECENT_TOKENS),
        )
      : setting;
  const capped = Math.floor(contextWindow * (1 - thresholdRatio - margin));
  return Math.min(scaled, Math.max(MIN_EFFECTIVE_KEEP_RECENT_TOKENS, capped));
}

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

export interface PolicyConfig {
  /** Start a job at U >= startRatio * W. */
  startRatio: number;
  /** Growth floor in tokens, combined with growthWindowRatio via max(). */
  growthMinTokens: number;
  /** Growth floor as a fraction of W, combined with growthMinTokens via max(). */
  growthWindowRatio: number;
  maxStartsPerHour: number;
  maxStartsPerDay: number;
  /** Jitter is a uniform 0..startJitterMaxMs delay before a start. */
  startJitterMaxMs: number;
  /** Consecutive failures (rate-limit errors count) that open the breaker. */
  breakerFailureThreshold: number;
  breakerOpenMs: number;
  /** Cooldown per consecutive failure, capped at the last entry (60/120/300 s). */
  cooldownStepsMs: readonly number[];
  benefitMinTokens: number;
  benefitRatio: number;
  /** Staleness allowance is max(keepRecentEff, staleWindowRatio * W). */
  staleWindowRatio: number;
  boundaryGrowthMinTokens: number;
  boundaryGrowthRatio: number;
  /** Idle-timer applies are held this long after the last "draft" activity. */
  draftHoldMs: number;
  /** The threshold route, default true. */
  thresholdRoute: boolean;
  /** Notes-append consolidates at summary tokens >= this. */
  consolidateSummaryTokens: number;
  /** Notes-append consolidates at this many notes blocks. */
  consolidateNotesBlocks: number;
}

export const DEFAULTS: PolicyConfig = Object.freeze({
  startRatio: 0.4,
  growthMinTokens: 4096,
  growthWindowRatio: 0.05,
  maxStartsPerHour: 6,
  maxStartsPerDay: 40,
  startJitterMaxMs: 30_000,
  breakerFailureThreshold: 3,
  breakerOpenMs: 30 * 60_000,
  cooldownStepsMs: Object.freeze([60_000, 120_000, 300_000]) as readonly number[],
  benefitMinTokens: 8192,
  benefitRatio: 0.1,
  staleWindowRatio: 0.1,
  boundaryGrowthMinTokens: 16_384,
  boundaryGrowthRatio: 0.1,
  draftHoldMs: 30_000,
  thresholdRoute: true,
  consolidateSummaryTokens: 8192,
  consolidateNotesBlocks: 4,
});

/** Named error for an unknown key or an invalid value in `policy`. */
export class PolicyConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "PolicyConfigError";
    this.key = key;
  }
}

function copyDefaults(): PolicyConfig {
  return { ...DEFAULTS, cooldownStepsMs: [...DEFAULTS.cooldownStepsMs] };
}

/**
 * Merge the user's `policy` object over `DEFAULTS`. Unknown keys and values of
 * the wrong type/range are rejected with a `PolicyConfigError` naming the key;
 * config is a system boundary, so it is validated here rather than trusting it.
 */
export function resolvePolicyConfig(partial: unknown = {}): PolicyConfig {
  if (partial === undefined || partial === null) {
    return copyDefaults();
  }
  if (typeof partial !== "object" || Array.isArray(partial)) {
    throw new PolicyConfigError("<policy>", "policy must be a plain object");
  }

  const resolved = copyDefaults();
  const input = partial as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      throw new PolicyConfigError(key, `unknown policy key "${key}"`);
    }
    const fallback = (DEFAULTS as unknown as Record<string, unknown>)[key];
    const value = input[key];

    if (Array.isArray(fallback)) {
      const valid =
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
      if (!valid) {
        throw new PolicyConfigError(
          key,
          `invalid policy value for "${key}": expected a non-empty array of finite non-negative numbers`,
        );
      }
      (resolved as unknown as Record<string, unknown>)[key] = [...(value as number[])];
      continue;
    }

    if (typeof fallback === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new PolicyConfigError(
          key,
          `invalid policy value for "${key}": expected a finite non-negative number`,
        );
      }
      (resolved as unknown as Record<string, unknown>)[key] = value;
      continue;
    }

    if (typeof fallback === "boolean") {
      if (typeof value !== "boolean") {
        throw new PolicyConfigError(key, `invalid policy value for "${key}": expected a boolean`);
      }
      (resolved as unknown as Record<string, unknown>)[key] = value;
      continue;
    }

    throw new PolicyConfigError(key, `unhandled policy key "${key}"`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Start rule
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type StartBlockReason =
  | "usage-unknown"
  | "below-start-ratio"
  | "insufficient-growth"
  | "cooldown"
  | "hourly-cap"
  | "daily-cap"
  | "breaker-open";

export interface StartJobInput {
  /** U; null means no usage data, so no decision. */
  contextTokens: number | null;
  contextWindow: number;
  /** Growth since the last prepared source (U when none was ever prepared). */
  growthSincePreparedTokens: number;
  /** Epoch ms. */
  now: number;
  /** Epoch ms of prior job starts in this session. */
  sessionStartTimes?: readonly number[];
  /** Epoch ms; starts are blocked while now < cooldownUntil. */
  cooldownUntil?: number | null;
  /** Consecutive failed/discarded jobs; rate-limit errors count. */
  consecutiveFailures?: number;
  /** Epoch ms of the failure that opened the breaker. */
  lastFailureAt?: number | null;
  /** Injectable random source for tests. */
  random?: () => number;
  config?: PolicyConfig;
}

export interface StartJobDecision {
  start: boolean;
  reason?: StartBlockReason;
  /** 0..startJitterMaxMs, present only when start is true. */
  jitterMs?: number;
}

/** Uniform 0..max jitter; the source is injectable for deterministic tests. */
export function startJitterMs(random: () => number = Math.random, config: PolicyConfig = DEFAULTS): number {
  const raw = random();
  const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return Math.round(clamped * config.startJitterMaxMs);
}

/** Breaker is open after the threshold of consecutive failures, for breakerOpenMs. */
export function isBreakerOpen(
  consecutiveFailures: number,
  lastFailureAt: number | null | undefined,
  now: number,
  config: PolicyConfig = DEFAULTS,
): boolean {
  if (consecutiveFailures < config.breakerFailureThreshold) {
    return false;
  }
  // Fail closed when the failure clock is missing.
  if (lastFailureAt === null || lastFailureAt === undefined) {
    return true;
  }
  return now - lastFailureAt < config.breakerOpenMs;
}

/**
 * U >= 0.40W AND growth since the last prepared source >= max(4096, 0.05W) AND
 * not in cooldown AND spend caps AND breaker closed. There is deliberately no
 * upper bound: a start at or above T is allowed (todo 11 discards it if the
 * builtin compacts first).
 */
export function shouldStartJob(input: StartJobInput): StartJobDecision {
  const config = input.config ?? DEFAULTS;
  const window = input.contextWindow;
  const used = input.contextTokens;

  if (used === null || used === undefined || !Number.isFinite(used) || !Number.isFinite(window) || window <= 0) {
    return { start: false, reason: "usage-unknown" };
  }
  if (used < window * config.startRatio) {
    return { start: false, reason: "below-start-ratio" };
  }

  const growthFloor = Math.max(config.growthMinTokens, window * config.growthWindowRatio);
  if (input.growthSincePreparedTokens < growthFloor) {
    return { start: false, reason: "insufficient-growth" };
  }

  if (input.cooldownUntil !== null && input.cooldownUntil !== undefined && input.now < input.cooldownUntil) {
    return { start: false, reason: "cooldown" };
  }

  const starts = input.sessionStartTimes ?? [];
  const hourly = starts.filter((at) => at >= input.now - HOUR_MS && at <= input.now).length;
  if (hourly >= config.maxStartsPerHour) {
    return { start: false, reason: "hourly-cap" };
  }
  const daily = starts.filter((at) => at >= input.now - DAY_MS && at <= input.now).length;
  if (daily >= config.maxStartsPerDay) {
    return { start: false, reason: "daily-cap" };
  }

  if (isBreakerOpen(input.consecutiveFailures ?? 0, input.lastFailureAt, input.now, config)) {
    return { start: false, reason: "breaker-open" };
  }

  return { start: true, jitterMs: startJitterMs(input.random ?? Math.random, config) };
}

// ---------------------------------------------------------------------------
// Benefit and cooldown
// ---------------------------------------------------------------------------

/** U - estimatedTokensAfter >= max(8192, 0.10U). */
export function benefitOk(
  usedTokens: number,
  estimatedTokensAfter: number,
  config: PolicyConfig = DEFAULTS,
): boolean {
  return usedTokens - estimatedTokensAfter >= Math.max(config.benefitMinTokens, config.benefitRatio * usedTokens);
}

/** 60 s, 120 s, 300 s, then capped at 300 s. Zero failures means no cooldown. */
export function nextCooldownMs(
  consecutiveFailures: number,
  cooldownStepsMs: readonly number[] = DEFAULTS.cooldownStepsMs,
): number {
  if (consecutiveFailures <= 0 || cooldownStepsMs.length === 0) {
    return 0;
  }
  const index = Math.min(consecutiveFailures - 1, cooldownStepsMs.length - 1);
  return cooldownStepsMs[index];
}

// ---------------------------------------------------------------------------
// Apply decision
// ---------------------------------------------------------------------------

export type ApplySite = "agent_settled" | "timer" | "input";
export type ApplyRoute = "none" | "cold" | "boundary" | "threshold";
export type CacheState = "cold" | "warm" | "unknown";

export interface ApplyPermissionState {
  /** Epoch ms of the last onUserActivity("prompt"). */
  lastPromptAt?: number | null;
  /** Epoch ms of the last agent_settled (reopens permission). */
  lastAgentSettledAt?: number | null;
  /** Epoch ms of the last onUserActivity("draft"); holds timer applies 30 s. */
  lastDraftAt?: number | null;
}

export interface RunEndState {
  aborted?: boolean;
  willRetry?: boolean;
}

export interface ApplyDecisionInput {
  contextTokens: number | null;
  contextWindow: number;
  /**
   * Tokens of the prompt being submitted at the input seam. They are not in U
   * yet, so the input-seam threshold check uses U + promptTokens (default 0).
   */
  promptTokens?: number;
  lastYield?: LastYield | null;
  jobReady: boolean;
  /** Tokens appended after the prepared cut. */
  tokensAppendedAfterCut: number;
  /** Effective keepRecent for this window (todo 6). */
  effectiveKeepRecentTokens: number;
  anchorValid: boolean;
  fingerprintValid: boolean;
  estimatedTokensAfter: number;
  idle: boolean;
  hasPendingMessages: boolean;
  compacting: boolean;
  site: ApplySite;
  now: number;
  permission: ApplyPermissionState;
  todoRestorePending?: boolean;
  cache: CacheState;
  runEnd?: RunEndState | null;
  lastAssistantStopReason?: string | null;
  /** Growth since the last applied compaction, mod or builtin. */
  growthSinceAppliedTokens: number;
  config?: PolicyConfig;
}

/**
 * Apply permission is closed by a prompt until the next agent_settled. Timer
 * applies additionally wait until 30 s after the last draft. The input-seam
 * threshold apply is the one exception to the prompt rule.
 */
export function isApplyPermissionOpen(
  permission: ApplyPermissionState,
  site: ApplySite,
  now: number,
  options: { thresholdException?: boolean; config?: PolicyConfig } = {},
): boolean {
  const config = options.config ?? DEFAULTS;
  const lastPrompt = permission.lastPromptAt ?? null;
  const lastSettled = permission.lastAgentSettledAt ?? null;
  if (lastPrompt !== null && (lastSettled === null || lastSettled < lastPrompt)) {
    if (!options.thresholdException) {
      return false;
    }
  }
  if (site === "timer") {
    const lastDraft = permission.lastDraftAt ?? null;
    if (lastDraft !== null && now - lastDraft < config.draftHoldMs) {
      return false;
    }
  }
  return true;
}

/**
 * Route precedence: threshold, then cold, then boundary. Threshold is first so
 * the safety route is never relabeled when the cache also happens to be cold.
 * The input seam admits the threshold and cold routes; boundary is only for an
 * agent_settled/timer apply. A closed prompt permission is bypassed only for
 * the input-seam threshold route.
 */
export function applyDecision(input: ApplyDecisionInput): ApplyRoute {
  const config = input.config ?? DEFAULTS;
  const window = input.contextWindow;
  const used = input.contextTokens;

  if (used === null || used === undefined || !Number.isFinite(used) || !Number.isFinite(window) || window <= 0) {
    return "none";
  }
  if (!input.jobReady) {
    return "none";
  }

  const staleAllowance = Math.max(input.effectiveKeepRecentTokens, config.staleWindowRatio * window);
  if (input.tokensAppendedAfterCut > staleAllowance) {
    return "none";
  }
  if (!input.anchorValid || !input.fingerprintValid) {
    return "none";
  }
  if (!benefitOk(used, input.estimatedTokensAfter, config)) {
    return "none";
  }
  if (!input.idle || input.hasPendingMessages || input.compacting) {
    return "none";
  }

  const thresholdUsage = input.site === "input" ? used + (input.promptTokens ?? 0) : used;
  const thresholdEligible =
    config.thresholdRoute &&
    thresholdUsage >= window * computeEffectiveThreshold(window, input.lastYield ?? undefined);
  const thresholdException = input.site === "input" && thresholdEligible;
  const permissionOpen = isApplyPermissionOpen(input.permission, input.site, input.now, {
    thresholdException,
    config,
  });
  if (!permissionOpen) {
    return "none";
  }

  // The builtin would start a turn to restore a todo snapshot; no timer apply.
  if (input.site === "timer" && input.todoRestorePending === true) {
    return "none";
  }

  if (thresholdEligible) {
    return "threshold";
  }
  if (input.site === "input") {
    // The input handler applies on threshold or cold; boundary needs a settled run.
    return input.cache === "cold" ? "cold" : "none";
  }

  if (input.cache === "cold") {
    return "cold";
  }

  const runEndedNormally =
    input.runEnd !== null &&
    input.runEnd !== undefined &&
    input.runEnd.aborted !== true &&
    input.runEnd.willRetry !== true &&
    input.lastAssistantStopReason === "stop";
  if (runEndedNormally) {
    const boundaryFloor = Math.max(config.boundaryGrowthMinTokens, config.boundaryGrowthRatio * window);
    if (input.growthSinceAppliedTokens >= boundaryFloor) {
      return "boundary";
    }
  }

  return "none";
}

// ---------------------------------------------------------------------------
// Next job kind
// ---------------------------------------------------------------------------

export type CompactionMode = "notes" | "rewrite";
export type JobKind = "rewrite-first" | "rewrite-consolidate" | "rewrite" | "notes";

export interface NextJobKindInput {
  /** True when the branch carries a compaction entry (previous summary exists). */
  hasCompactionEntry: boolean;
  mode: CompactionMode;
  summaryTokens: number;
  notesBlocks: number;
  config?: PolicyConfig;
}

/**
 * rewrite-first when there is no previous summary; in notes mode, consolidate
 * after 4 notes blocks or 8192 summary tokens; rewrite when the mode says so;
 * otherwise append notes.
 */
export function nextJobKind(input: NextJobKindInput): JobKind {
  const config = input.config ?? DEFAULTS;
  if (!input.hasCompactionEntry) {
    return "rewrite-first";
  }
  if (
    input.mode === "notes" &&
    (input.summaryTokens >= config.consolidateSummaryTokens || input.notesBlocks >= config.consolidateNotesBlocks)
  ) {
    return "rewrite-consolidate";
  }
  if (input.mode === "rewrite") {
    return "rewrite";
  }
  return "notes";
}
