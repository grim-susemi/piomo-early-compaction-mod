/**
 * Early-compaction job state machine.
 *
 * One session owns at most one job:
 *
 *   EMPTY -> GENERATING -> READY -> APPLYING -> EMPTY
 *
 * Generation never blocks an event handler: `turn_end`/`agent_settled` launch
 * it with `void`. Apply sites call `applyCompaction` with the warm anchor and
 * the revision read synchronously at the call, never with a signal (AS:6127).
 *
 * Every continuation and timer callback carries the generation token it was
 * created under and is fenced by `retired`; a throw inside one is reduced to a
 * metrics event so a reload cannot take the process down.
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "@code-yeongyu/senpi";
import type {
  CompactionResult,
  CompactionSettings,
  SessionEntry,
} from "@code-yeongyu/senpi";
import {
  anchorMatches,
  createWarmAnchorSnapshot,
  fingerprint,
  type WarmAnchorSnapshot,
} from "./anchor";
import {
  GOAL_CACHE_WARMUP_ENTRY_TYPE,
  type CacheModelLike,
  type CacheRequestLike,
} from "./cache-state";
import { summaryTokens } from "./constants";
import {
  countNotesBlocks,
  generateCompaction,
  isLocalBaseUrl,
  type EarlyCompactionDetails,
  type GenerateContext,
  type GenerateOutcome,
} from "./generate";
import type { GateResult } from "./gate";
import type {
  DiscardReason,
  MetricsEventName,
  MetricsFieldsFor,
  MetricsWriter,
  OverrideState,
} from "./metrics";
import {
  applyDecision,
  computeEffectiveThreshold,
  nextCooldownMs,
  nextJobKind,
  shouldStartJob,
  type ApplyRoute,
  type ApplySite,
  type CacheState,
  type CompactionMode,
  type JobKind,
  type LastYield,
  type PolicyConfig,
  type RunEndState,
} from "./policy";
import {
  prepareSource,
  type PrepareSourceInput,
  type PreparedSource,
} from "./prepare";
import type { SurfaceFailureReason, VisibleSurface } from "./surface";

/** The four observable phases; APPLYING is entered synchronously. */
export type JobPhase = "EMPTY" | "GENERATING" | "READY" | "APPLYING";

/** The parts of the per-session configuration the job machine reads. */
export interface JobConfig {
  mode: CompactionMode;
  policy: PolicyConfig;
}

/** Metrics surface accepted by the job machine (a `MetricsWriter` fits). */
export type JobMetricsWriter = Pick<MetricsWriter, "write" | "close">;

/** Timer handle; Node's handle carries `unref`, test fakes need not. */
export interface JobTimerHandle {
  unref?: () => void;
}

export interface JobTimers {
  setInterval(callback: () => void, ms: number): JobTimerHandle;
  clearInterval(handle: JobTimerHandle): void;
  setTimeout(callback: () => void, ms: number): JobTimerHandle;
  clearTimeout(handle: JobTimerHandle): void;
}

const SYSTEM_TIMERS: JobTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms) as unknown as JobTimerHandle;
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  },
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms) as unknown as JobTimerHandle;
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

/** The live cache tracker methods used here; `CacheStateTracker` fits. */
export interface JobCache {
  state(model: CacheModelLike | undefined, query?: { keepAliveEnabled?: boolean }): CacheState;
  baselineLocal(model: CacheModelLike): Promise<CacheState>;
  probeLocal(model: CacheModelLike): Promise<CacheState>;
  observeRequest(request: CacheRequestLike): void;
  observeResponse(): void;
  observeMessageEnd(message: unknown): boolean;
  observeWarmPing(): void;
  observeGoalCacheWarmEntry(entry: unknown): boolean;
  reset(): void;
  setKeepAliveEnabled(enabled: boolean): void;
}

export type PrepareFn = (input: PrepareSourceInput) => PreparedSource | null;
export type GenerateFn = (input: Parameters<typeof generateCompaction>[0]) => Promise<GenerateOutcome>;

/** The resolved settings always carry both token budgets. */
export interface JobCompactionSettings extends CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

/** The live `ExtensionContext` surface the job handlers read. */
export interface JobContext extends GenerateContext {
  readonly agentDir: string;
  readonly hasUI: boolean;
  readonly mode: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
  readonly sessionManager: {
    getBranch(): readonly SessionEntry[];
    getSessionId(): string;
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  isCompacting?(): boolean;
  getMessageRevision(): number;
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
  getCompactionSettings(): JobCompactionSettings;
  getSystemPrompt?(): string;
  onUserActivity?(listener: (kind: "draft" | "prompt") => void): () => void;
  getPromptCacheKeepAliveSettings?(): { enabled: boolean };
  applyCompaction(
    result: CompactionResult<EarlyCompactionDetails>,
    options: {
      reason: "extension";
      expectedRevision: number;
      expectedWarmAnchor: WarmAnchorSnapshot;
    },
  ): Promise<{ applied: boolean; reason: "ok" | "stale" | "rejected" }>;
}

/** The parts of a `session_compact` event this module reads. */
export interface CompactionEntryLike {
  id: string;
  summary: string;
  tokensBefore: number;
  details?: unknown;
}

export interface SessionCompactLike {
  accepted: boolean;
  reason: string;
  requestId: string;
  compactionEntry?: CompactionEntryLike;
}

export interface AgentEndLike {
  messages?: readonly unknown[];
  aborted?: boolean;
  willRetry?: boolean;
}

export interface InputLike {
  text: string;
  source: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface MessageEndLike {
  message: unknown;
}

export interface BeforeProviderRequestLike {
  payload?: unknown;
  model?: CacheModelLike;
}

export interface JobSnapshot {
  phase: JobPhase;
  jobId: string | undefined;
  jobKind: JobKind | undefined;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  lastPreparedTokens: number | null;
  lastAppliedTokens: number | null;
  lastYield: LastYield | undefined;
  thresholdCrossed: boolean;
}

export interface JobControllerOptions {
  gate: GateResult;
  config: JobConfig;
  metrics: JobMetricsWriter | null;
  surface: VisibleSurface;
  cache: JobCache;
  initialOverrideState?: OverrideState | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
  timers?: JobTimers | undefined;
  prepare?: PrepareFn | undefined;
  generate?: GenerateFn | undefined;
  idleIntervalMs?: number | undefined;
}

interface JobRecord {
  id: string;
  kind: JobKind;
  startedAt: number;
  source: PreparedSource;
  anchor: WarmAnchorSnapshot;
  fingerprint: string;
  branchTailId: string;
  controller: AbortController;
  result?: CompactionResult<EarlyCompactionDetails>;
}

interface PendingStart {
  token: number;
  handle: JobTimerHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Job kinds that rewrite an existing summary instead of appending notes. */
function rewritesPreviousSummary(kind: JobKind): boolean {
  return kind === "rewrite-consolidate" || kind === "rewrite";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The same measure `applyDecision` expects for a not-yet-appended prompt. */
export function estimatePromptTokens(text: string): number {
  return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
}

function lastAssistantStopReason(messages: readonly unknown[] | undefined): string | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asRecord(messages[index]);
    if (message?.role !== "assistant") continue;
    return typeof message.stopReason === "string" ? message.stopReason : null;
  }
  return null;
}

function structuralYield(entry: CompactionEntryLike | undefined):
  | { savedTokens: number; savingsRatio: number }
  | undefined {
  const details = asRecord(entry?.details);
  const yieldValue = asRecord(details?.structuralYield);
  const savedTokens = finiteNumber(yieldValue?.savedTokens);
  const savingsRatio = finiteNumber(yieldValue?.savingsRatio);
  if (savedTokens === undefined || savingsRatio === undefined) return undefined;
  return { savedTokens, savingsRatio };
}

function earlyJobId(entry: CompactionEntryLike | undefined): string | undefined {
  const details = asRecord(entry?.details);
  const early = asRecord(details?.earlyCompaction);
  return typeof early?.jobId === "string" ? early.jobId : undefined;
}

function estimatedAfterCompaction(entry: CompactionEntryLike): number {
  const yieldValue = structuralYield(entry);
  if (yieldValue !== undefined) {
    return Math.max(0, entry.tokensBefore - yieldValue.savedTokens);
  }
  // No structural yield (manual/core routes): the summary is the only part we
  // can name without re-projecting the branch. Conservative for growth checks.
  return Math.max(0, summaryTokens(entry.summary));
}

function readAssistantUsage(message: unknown):
  | { input: number; cacheRead: number; cacheWrite: number }
  | undefined {
  const record = asRecord(message);
  if (record?.role !== "assistant") return undefined;
  const usage = asRecord(record.usage);
  if (!usage) return undefined;
  const input = finiteNonNegative(usage.input);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, cacheRead, cacheWrite };
}

function isCurrentTodoEntry(entry: SessionEntry): boolean {
  if (entry.type !== "custom") return false;
  return (
    entry.customType.startsWith("todowrite") ||
    entry.customType === "senpi.todo-state" ||
    entry.customType === "todo-list"
  );
}

function todosInCustomEntry(entry: SessionEntry): unknown[] {
  if (entry.type !== "custom") return [];
  const data = asRecord((entry as { data?: unknown }).data);
  if (!data) return [];
  if (Array.isArray(data.todos)) return data.todos;
  if (Array.isArray(data.phases)) {
    const tasks: unknown[] = [];
    for (const phase of data.phases) {
      const phaseRecord = asRecord(phase);
      if (Array.isArray(phaseRecord?.tasks)) tasks.push(...phaseRecord.tasks);
    }
    return tasks;
  }
  return [];
}

/**
 * The builtin restores a todo snapshot with a turn when the current todo list
 * is empty; a timer apply must not steal that turn (todo-bridge.js:129-149).
 */
function todoRestorePending(branch: readonly SessionEntry[]): boolean {
  let snapshotExists = false;
  let currentTodos: unknown[] | undefined;

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom") continue;
    if (entry.customType === "compaction.todo-snapshot") {
      const data = asRecord((entry as { data?: unknown }).data);
      if (
        data?.schema === "senpi.compaction.todo-snapshot.v1" &&
        Array.isArray(data.todos) &&
        data.todos.length > 0
      ) {
        snapshotExists = true;
      }
      continue;
    }
    if (currentTodos === undefined && isCurrentTodoEntry(entry)) {
      currentTodos = todosInCustomEntry(entry);
    }
  }

  return snapshotExists && (currentTodos ?? []).length === 0;
}

function discardToJobEndReason(
  reason: DiscardReason,
): "builtin-compact" | "fingerprint-mismatch" | "stale" | "aborted" | "failed" {
  switch (reason) {
    case "builtin-compact":
    case "session-before-compact":
      return "builtin-compact";
    case "context-edit":
    case "fingerprint-mismatch":
      return "fingerprint-mismatch";
    case "session-tree":
    case "model-select":
    case "stale":
    case "job-superseded":
      return "stale";
    case "session-shutdown":
    case "user-activity":
      return "aborted";
    default:
      return "failed";
  }
}

export class JobController {
  readonly #gate: GateResult;
  readonly #active: boolean;
  readonly #config: JobConfig;
  readonly #metrics: JobMetricsWriter | null;
  readonly #surface: VisibleSurface;
  readonly #cache: JobCache;
  readonly #initialOverrideState: OverrideState | undefined;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timers: JobTimers;
  readonly #prepare: PrepareFn;
  readonly #generate: GenerateFn;
  readonly #idleIntervalMs: number;

  #ctx: JobContext | undefined;
  #started = false;
  #retired = false;
  #token = 0;
  #phase: JobPhase = "EMPTY";
  #job: JobRecord | undefined;
  #pendingStart: PendingStart | undefined;
  #idleTimer: JobTimerHandle | undefined;
  #unsubscribeActivity: (() => void) | undefined;
  #lastYieldValue: LastYield | undefined;
  #thresholdCrossed = false;
  #nextUsagePending = false;
  #lastPromptAt: number | null = null;
  #lastDraftAt: number | null = null;
  #lastAgentSettledAt: number | null = null;
  #runEnd: RunEndState | null = null;
  #lastAssistantStopReason: string | null = null;
  #lastPreparedTokens: number | null = null;
  #lastAppliedTokens: number | null = null;
  #startTimes: number[] = [];
  #consecutiveFailures = 0;
  #lastFailureAt: number | null = null;
  #cooldownUntil: number | null = null;
  #applyingJobId: string | undefined;
  #keepAliveEnabled = false;
  #lastCacheWarmEntryId: string | null = null;
  #jobSeq = 0;
  /**
   * Estimated tokens of the previous summary whose rewrite ran out of output
   * budget. While the previous summary is at least this large, a rewrite would
   * be cut again, so the next job appends notes instead. A smaller summary
   * (for example after a builtin compaction) allows rewrites again.
   */
  #rewriteHoldoffTokens: number | null = null;

  constructor(options: JobControllerOptions) {
    this.#gate = options.gate;
    this.#active = options.gate.state === "active";
    this.#config = options.config;
    this.#metrics = options.metrics;
    this.#surface = options.surface;
    this.#cache = options.cache;
    this.#initialOverrideState = options.initialOverrideState;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
    this.#prepare = options.prepare ?? prepareSource;
    this.#generate = options.generate ?? generateCompaction;
    this.#idleIntervalMs = options.idleIntervalMs ?? 30_000;
  }

  snapshot(): JobSnapshot {
    return {
      phase: this.#phase,
      jobId: this.#job?.id,
      jobKind: this.#job?.kind,
      consecutiveFailures: this.#consecutiveFailures,
      cooldownUntil: this.#cooldownUntil,
      lastPreparedTokens: this.#lastPreparedTokens,
      lastAppliedTokens: this.#lastAppliedTokens,
      lastYield: this.#lastYieldValue === undefined ? undefined : { ...this.#lastYieldValue },
      thresholdCrossed: this.#thresholdCrossed,
    };
  }

  sessionStart(ctx: JobContext): void {
    this.#ctx = ctx;
    if (this.#retired || this.#started) return;
    this.#started = true;

    this.#emit("gate", {
      state: this.#gate.state,
      reason: this.#gate.state === "active" ? "ok" : this.#gate.reason,
    });
    if (this.#initialOverrideState !== undefined) {
      this.#emit("override", { state: this.#initialOverrideState });
    }

    if (!this.#active) return;

    this.#readKeepAlive(ctx);
    this.#cache.setKeepAliveEnabled(this.#keepAliveEnabled);
    this.#seedCacheWarmCursor();
    this.#observeUsage();

    try {
      const unsubscribe = ctx.onUserActivity?.((kind) => this.#onUserActivity(kind));
      if (typeof unsubscribe === "function") this.#unsubscribeActivity = unsubscribe;
    } catch {
      this.#recordInternalError("user-activity-subscribe");
    }

    try {
      this.#idleTimer = this.#timers.setInterval(() => this.#onIdleTimer(), this.#idleIntervalMs);
    } catch {
      this.#recordInternalError("idle-timer");
    }
  }

  sessionShutdown(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#token += 1;

    this.#cancelPendingStart();
    if (this.#idleTimer !== undefined) {
      try {
        this.#timers.clearInterval(this.#idleTimer);
      } catch {
        // Timers are best-effort during teardown.
      }
      this.#idleTimer = undefined;
    }
    try {
      this.#unsubscribeActivity?.();
    } catch {
      // A host that already dropped the subscription must not fail shutdown.
    }
    this.#unsubscribeActivity = undefined;

    if (this.#job) {
      this.#discard("session-shutdown", { accountFailure: false });
    }

    try {
      this.#surface.stop();
    } catch {
      // UI teardown is best-effort.
    }
    try {
      this.#metrics?.close();
    } catch {
      // A closed writer is already the desired end state.
    }
  }

  turnEnd(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    try {
      this.#observeUsage();
      this.#observeNewCacheWarmEntries();
      this.#maybeStartJob();
    } catch {
      this.#recordInternalError("turn-end");
    }
  }

  agentEnd(ctx: JobContext, event: AgentEndLike): void {
    if (!this.#bind(ctx)) return;
    this.#runEnd = {
      aborted: event.aborted === true,
      willRetry: event.willRetry === true,
    };
    this.#lastAssistantStopReason = lastAssistantStopReason(event.messages);
    try {
      this.#observeNewCacheWarmEntries();
    } catch {
      this.#recordInternalError("agent-end");
    }
  }

  agentSettled(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    this.#lastAgentSettledAt = this.#now();
    try {
      this.#observeUsage();
      this.#observeNewCacheWarmEntries();
      this.#maybeStartJob();

      const model = this.#ctx?.model;
      if (isLocalBaseUrl(model?.baseUrl) && model) {
        const token = this.#token;
        void this.#cache
          .baselineLocal(model)
          .then(() => {
            if (!this.#isLive(token)) return;
            this.#launchApply("agent_settled");
          })
          .catch(() => this.#recordInternalError("local-baseline"));
      } else {
        this.#launchApply("agent_settled");
      }
    } catch {
      this.#recordInternalError("agent-settled");
    }
  }

  async handleInput(ctx: JobContext, event: InputLike): Promise<void> {
    if (!this.#bind(ctx)) return;
    if (event.streamingBehavior !== undefined) return;
    if (event.source !== "interactive") return;

    try {
      this.#observeUsage();
      this.#observeNewCacheWarmEntries();
      if (this.#phase !== "READY") return;

      const model = this.#ctx?.model;
      if (isLocalBaseUrl(model?.baseUrl) && model) {
        // Never delay the prompt on a /slots round trip; refresh for the next
        // decision and use the cached result now.
        void this.#cache.probeLocal(model).catch(() => undefined);
      }

      await this.#attemptApply("input", estimatePromptTokens(event.text));
    } catch {
      this.#recordInternalError("input");
    }
  }

  sessionBeforeCompact(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    this.#discard("session-before-compact");
  }

  sessionCompact(ctx: JobContext, event: SessionCompactLike): void {
    if (!this.#bind(ctx)) return;
    try {
      const accepted = event.accepted === true;
      const entry = accepted ? event.compactionEntry : undefined;
      const ownJobId = earlyJobId(entry);
      // A rejected apply has no compactionEntry, so its jobId is unavailable.
      // While this controller is APPLYING, a rejected session_compact is this
      // apply's own terminal event; the apply promise still owns its metric.
      const own =
        ownJobId !== undefined
          ? ownJobId === this.#job?.id || ownJobId === this.#applyingJobId
          : !accepted && this.#phase === "APPLYING" && this.#applyingJobId !== undefined;

      if (!own) {
        this.#emit("builtin_compact", {
          reason: event.reason,
          tokensBefore: entry?.tokensBefore ?? 0,
          requestId: event.requestId,
          compactionEntryId: entry?.id ?? "",
        });
        this.#discard("builtin-compact");
      }

      if (accepted && entry !== undefined) {
        this.#applyAcceptedCompaction(entry);
      }
    } catch {
      this.#recordInternalError("session-compact");
    }
  }

  sessionTree(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    this.#discard("session-tree");
    this.#cache.reset();
    this.#runEnd = null;
    this.#lastAssistantStopReason = null;
    this.#lastPreparedTokens = null;
    this.#lastAppliedTokens = null;
    this.#thresholdCrossed = false;
    this.#seedCacheWarmCursor();
  }

  modelSelect(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    try {
      this.#readKeepAlive(ctx);
      this.#cache.setKeepAliveEnabled(this.#keepAliveEnabled);
      this.#cache.reset();
    } catch {
      this.#recordInternalError("model-select-cache");
    }
    this.#thresholdCrossed = false;
    this.#discard("model-select");
  }

  messageEnd(ctx: JobContext, event: MessageEndLike): void {
    if (!this.#bind(ctx)) return;
    try {
      this.#cache.observeMessageEnd(event.message);
      if (!this.#nextUsagePending) return;
      const usage = readAssistantUsage(event.message);
      if (usage === undefined) return;
      this.#nextUsagePending = false;
      this.#emit("next_usage", {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        systemHash: this.#systemHash(),
      });
    } catch {
      this.#recordInternalError("message-end");
    }
  }

  afterProviderResponse(ctx: JobContext): void {
    if (!this.#bind(ctx)) return;
    try {
      this.#cache.observeResponse();
    } catch {
      this.#recordInternalError("after-provider-response");
    }
  }

  beforeProviderRequest(ctx: JobContext, event: BeforeProviderRequestLike): void {
    if (!this.#bind(ctx)) return;
    try {
      this.#cache.observeRequest({
        payload: event.payload,
        model: event.model ?? ctx.model,
      });
    } catch {
      this.#recordInternalError("before-provider-request");
    }
  }

  observeWarmPing(): void {
    if (this.#retired || !this.#active) return;
    try {
      this.#cache.observeWarmPing();
    } catch {
      this.#recordInternalError("warm-ping");
    }
  }

  // -------------------------------------------------------------------------
  // Job start
  // -------------------------------------------------------------------------

  #bind(ctx: JobContext): boolean {
    if (this.#retired || !this.#active) return false;
    this.#ctx = ctx;
    return true;
  }

  #readKeepAlive(ctx: JobContext): void {
    try {
      this.#keepAliveEnabled = ctx.getPromptCacheKeepAliveSettings?.().enabled === true;
    } catch {
      this.#keepAliveEnabled = false;
    }
  }

  #onUserActivity(kind: "draft" | "prompt"): void {
    if (this.#retired || !this.#active) return;
    const at = this.#now();
    if (kind === "prompt") {
      this.#lastPromptAt = at;
    } else {
      this.#lastDraftAt = at;
    }
  }

  #maybeStartJob(): void {
    if (!this.#active || this.#retired) return;
    if (this.#phase !== "EMPTY" || this.#pendingStart !== undefined) return;
    const ctx = this.#ctx;
    if (!ctx) return;

    try {
      if (ctx.isCompacting?.() === true) return;
    } catch {
      return;
    }

    const usage = this.#observeUsage();
    if (!usage || usage.tokens === null || usage.window <= 0) return;

    const now = this.#now();
    const decision = shouldStartJob({
      contextTokens: usage.tokens,
      contextWindow: usage.window,
      growthSincePreparedTokens: this.#growthSincePrepared(usage.tokens),
      now,
      sessionStartTimes: this.#startTimes,
      cooldownUntil: this.#cooldownUntil,
      consecutiveFailures: this.#consecutiveFailures,
      lastFailureAt: this.#lastFailureAt,
      random: this.#random,
      config: this.#config.policy,
    });
    if (!decision.start) return;

    const jitter = decision.jitterMs ?? 0;
    if (jitter <= 0) {
      this.#startJobNow();
      return;
    }

    const token = this.#token;
    const handle = this.#timers.setTimeout(() => {
      if (this.#pendingStart?.handle === handle) this.#pendingStart = undefined;
      if (!this.#isLive(token)) return;
      this.#startJobNow();
    }, jitter);
    this.#pendingStart = { token, handle };
  }

  #startJobNow(): void {
    if (!this.#active || this.#retired) return;
    if (this.#phase !== "EMPTY" || this.#pendingStart !== undefined) return;
    const ctx = this.#ctx;
    if (!ctx) return;

    try {
      if (ctx.isCompacting?.() === true) return;
      const usage = this.#observeUsage();
      if (!usage || usage.tokens === null || usage.window <= 0) return;

      // The start was admitted before jitter; re-check after it without adding
      // a second delay. Growth/spend can have moved while the timer waited.
      const decision = shouldStartJob({
        contextTokens: usage.tokens,
        contextWindow: usage.window,
        growthSincePreparedTokens: this.#growthSincePrepared(usage.tokens),
        now: this.#now(),
        sessionStartTimes: this.#startTimes,
        cooldownUntil: this.#cooldownUntil,
        consecutiveFailures: this.#consecutiveFailures,
        lastFailureAt: this.#lastFailureAt,
        random: () => 0,
        config: this.#config.policy,
      });
      if (!decision.start) return;

      const branch = ctx.sessionManager.getBranch();
      const settings = ctx.getCompactionSettings();
      const thresholdRatio = computeEffectiveThreshold(usage.window, this.#lastYieldValue);
      const source = this.#prepare({
        branchEntries: branch,
        contextWindow: usage.window,
        thresholdRatio,
        settings: {
          keepRecentTokens: settings.keepRecentTokens,
          reserveTokens: settings.reserveTokens,
        },
      });
      if (!source) return;

      const anchor = createWarmAnchorSnapshot(source.firstKeptEntryId, branch);
      if (!anchor) return;
      const cutIndex = branch.findIndex((entry) => entry.id === source.firstKeptEntryId);
      if (cutIndex < 0) return;

      const previousSummaryTokens = summaryTokens(source.previousSummary ?? "");
      const chosenKind = nextJobKind({
        hasCompactionEntry: source.previousSummary !== undefined,
        mode: this.#config.mode,
        summaryTokens: previousSummaryTokens,
        notesBlocks: countNotesBlocks(source.previousSummary),
        config: this.#config.policy,
      });
      const kind: JobKind =
        rewritesPreviousSummary(chosenKind) &&
        this.#rewriteHoldoffTokens !== null &&
        previousSummaryTokens >= this.#rewriteHoldoffTokens
          ? "notes"
          : chosenKind;

      const job: JobRecord = {
        id: `ec-${this.#now().toString(36)}-${++this.#jobSeq}`,
        kind,
        startedAt: this.#now(),
        source,
        anchor,
        fingerprint: fingerprint(source.previousSummary, branch.slice(0, cutIndex)),
        branchTailId: branch[branch.length - 1]?.id ?? "",
        controller: new AbortController(),
      };

      this.#job = job;
      this.#phase = "GENERATING";
      this.#lastPreparedTokens = source.tokensBefore;
      this.#startTimes.push(this.#now());
      this.#emit("job_start", {
        jobId: job.id,
        kind,
        U: usage.tokens,
        W: usage.window,
      });
      this.#safeSurface(() => this.#surface.setState({ phase: "generating" }));

      const token = this.#token;
      void this.#runGeneration(job, token).catch(() => {
        // A throw after the generator settled must not leave the controller
        // stuck in GENERATING with no one to clear it.
        if (this.#isLive(token) && this.#job === job) this.#discard("stale");
        this.#recordInternalError("generation");
      });
    } catch {
      this.#recordInternalError("job-start");
    }
  }

  #growthSincePrepared(usedTokens: number): number {
    if (this.#lastPreparedTokens === null) return usedTokens;
    return Math.max(0, usedTokens - this.#lastPreparedTokens);
  }

  async #runGeneration(job: JobRecord, token: number): Promise<void> {
    let outcome: GenerateOutcome;
    try {
      outcome = await this.#generate({
        ctx: this.#ctx as GenerateContext,
        kind: job.kind,
        source: job.source,
        jobId: job.id,
        signal: job.controller.signal,
      });
    } catch {
      outcome = { status: "failed", reason: "error" };
    }

    if (!this.#isLive(token) || this.#job !== job || this.#phase !== "GENERATING") {
      return;
    }

    const ms = Math.max(0, this.#now() - job.startedAt);

    if (outcome.status === "ok") {
      const mutation = this.#mutationReason(job);
      if (mutation !== undefined) {
        this.#discard(mutation);
        return;
      }
      job.result = outcome.result;
      this.#phase = "READY";
      const after = outcome.result.estimatedTokensAfter ?? outcome.result.tokensBefore;
      const saved = Math.max(0, outcome.result.tokensBefore - after);
      this.#safeSurface(() => this.#surface.setState({ phase: "ready", savedTokens: saved }));
      this.#emit("job_end", {
        jobId: job.id,
        outcome: "ready",
        reason: "ok",
        ms,
        inputTokens: outcome.result.usage?.input ?? 0,
        outputTokens: outcome.result.usage?.output ?? 0,
      });
      this.#observeUsage();
      return;
    }

    if (outcome.status === "skipped") {
      this.#emit("job_end", {
        jobId: job.id,
        outcome: "skipped",
        reason: outcome.reason,
        ms,
        inputTokens: 0,
        outputTokens: 0,
      });
      this.#clearJob(job);
      if (outcome.reason === "model-unresolved") {
        this.#safeSurface(() => this.#surface.warnModelUnresolved());
      }
      return;
    }

    if (outcome.status === "aborted") {
      this.#emit("job_end", {
        jobId: job.id,
        outcome: "aborted",
        reason: "aborted",
        ms,
        inputTokens: 0,
        outputTokens: 0,
      });
      this.#clearJob(job, "aborted");
      this.#noteFailure();
      return;
    }

    const reason =
      outcome.reason === "auth"
        ? "auth"
        : outcome.reason === "truncated"
          ? "truncated"
          : "failed";
    this.#emit("job_end", {
      jobId: job.id,
      outcome: "failed",
      reason,
      ms,
      inputTokens: 0,
      outputTokens: 0,
    });
    if (
      reason === "truncated" &&
      rewritesPreviousSummary(job.kind) &&
      job.source.previousSummary !== undefined
    ) {
      this.#rewriteHoldoffTokens = summaryTokens(job.source.previousSummary);
      // The truncated rewrite is not counted as a failure: the same slot
      // retries once as a notes append, which has a much smaller output.
      if (this.#startNotesFallback(job, token)) return;
    }
    this.#clearJob(job, reason);
    this.#noteFailure();
  }

  /**
   * Replace a truncated rewrite with one notes append over the same source.
   * Returns false when usage is unreadable; the caller then records the
   * failure as usual.
   */
  #startNotesFallback(failed: JobRecord, token: number): boolean {
    const usage = this.#observeUsage();
    if (!usage || usage.tokens === null || usage.window <= 0) return false;

    const job: JobRecord = {
      id: `ec-${this.#now().toString(36)}-${++this.#jobSeq}`,
      kind: "notes",
      startedAt: this.#now(),
      source: failed.source,
      anchor: failed.anchor,
      fingerprint: failed.fingerprint,
      branchTailId: failed.branchTailId,
      controller: new AbortController(),
    };
    this.#job = job;
    this.#startTimes.push(this.#now());
    this.#emit("job_start", {
      jobId: job.id,
      kind: job.kind,
      U: usage.tokens,
      W: usage.window,
    });
    this.#safeSurface(() => this.#surface.setState({ phase: "retrying" }));

    void this.#runGeneration(job, token).catch(() => {
      if (this.#isLive(token) && this.#job === job) this.#discard("stale");
      this.#recordInternalError("generation");
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  #launchApply(site: ApplySite): void {
    const pending = this.#attemptApply(site, 0);
    if (pending !== undefined) {
      void pending.catch(() => this.#recordInternalError(`apply-${site}`));
    }
  }

  #attemptApply(site: ApplySite, tokensOfPrompt = 0): Promise<void> | undefined {
    if (!this.#active || this.#retired) return undefined;
    if (this.#phase !== "READY") return undefined;
    const job = this.#job;
    const ctx = this.#ctx;
    if (!job?.result || !ctx) return undefined;

    try {
      const branch = ctx.sessionManager.getBranch();
      const mutation = this.#mutationReason(job, branch);
      if (mutation !== undefined) {
        this.#discard(mutation);
        return undefined;
      }

      const usage = this.#observeUsage();
      if (!usage || usage.tokens === null || usage.window <= 0) return undefined;

      const appended = Math.max(0, usage.tokens - job.source.tokensBefore);
      const allowance = Math.max(
        job.source.keepRecentEff,
        this.#config.policy.staleWindowRatio * usage.window,
      );
      if (appended > allowance) {
        this.#discard("stale");
        return undefined;
      }

      let cacheState: CacheState = "unknown";
      try {
        cacheState = this.#cache.state(ctx.model, {
          keepAliveEnabled: this.#keepAliveEnabled,
        });
      } catch {
        cacheState = "unknown";
      }

      const route = applyDecision({
        contextTokens: usage.tokens,
        contextWindow: usage.window,
        promptTokens: site === "input" ? tokensOfPrompt : 0,
        lastYield: this.#lastYieldValue,
        jobReady: true,
        tokensAppendedAfterCut: appended,
        effectiveKeepRecentTokens: job.source.keepRecentEff,
        anchorValid: true,
        fingerprintValid: true,
        estimatedTokensAfter:
          job.result.estimatedTokensAfter ??
          Math.max(0, job.result.tokensBefore - summaryTokens(job.result.summary)),
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        compacting: ctx.isCompacting?.() === true,
        site,
        now: this.#now(),
        permission: {
          lastPromptAt: this.#lastPromptAt,
          lastAgentSettledAt: this.#lastAgentSettledAt,
          lastDraftAt: this.#lastDraftAt,
        },
        todoRestorePending: site === "timer" ? todoRestorePending(branch) : false,
        cache: cacheState,
        runEnd: this.#runEnd,
        lastAssistantStopReason: this.#lastAssistantStopReason,
        growthSinceAppliedTokens:
          this.#lastAppliedTokens === null
            ? usage.tokens
            : Math.max(0, usage.tokens - this.#lastAppliedTokens),
        config: this.#config.policy,
      });

      if (route === "none") return undefined;
      // The plan admits boundary applies only at agent_settled; the idle timer
      // is cold or threshold only.
      if (site === "timer" && route === "boundary") return undefined;

      return this.#performApply(job, route, site);
    } catch {
      this.#recordInternalError(`apply-${site}`);
      return undefined;
    }
  }

  async #performApply(
    job: JobRecord,
    route: Exclude<ApplyRoute, "none">,
    site: ApplySite,
  ): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx || !job.result) return;

    try {
      if (ctx.isCompacting?.() === true) {
        this.#discard("compacting");
        return;
      }
      // The decision above checked these; re-check at the apply boundary so a
      // prompt or run that started in between never lands under a summary.
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    } catch {
      this.#recordInternalError("apply-precondition");
      return;
    }

    let revision: number;
    try {
      // Synchronous read immediately before the call, as AS:6127 requires.
      revision = ctx.getMessageRevision();
    } catch {
      this.#recordInternalError("apply-revision");
      return;
    }

    this.#phase = "APPLYING";
    this.#applyingJobId = job.id;

    let pending: Promise<{ applied: boolean; reason: "ok" | "stale" | "rejected" }>;
    try {
      pending = ctx.applyCompaction(job.result, {
        reason: "extension",
        expectedWarmAnchor: job.anchor,
        expectedRevision: revision,
      });
    } catch {
      if (this.#applyingJobId === job.id) this.#applyingJobId = undefined;
      this.#emitApply(job, route, site, "rejected");
      this.#discard("apply-rejected");
      return;
    }

    let result: { applied: boolean; reason: "ok" | "stale" | "rejected" } | undefined;
    try {
      result = await pending;
    } catch {
      result = undefined;
    }

    if (this.#applyingJobId === job.id) this.#applyingJobId = undefined;
    if (this.#retired || this.#job !== job || this.#phase !== "APPLYING") return;

    if (result?.applied === true && result.reason === "ok") {
      this.#emitApply(job, route, site, "ok");
      const after = job.result.estimatedTokensAfter ?? job.result.tokensBefore;
      this.#safeSurface(() =>
        this.#surface.recordApply({
          route,
          tokensBefore: job.result?.tokensBefore ?? job.source.tokensBefore,
          estimatedTokensAfter: after,
        }),
      );
      this.#job = undefined;
      this.#phase = "EMPTY";
      this.#safeSurface(() => this.#surface.setState({ phase: "idle" }));
      this.#noteSuccess();
      this.#lastAppliedTokens = after;
      this.#lastPreparedTokens = after;
      this.#thresholdCrossed = false;
      this.#nextUsagePending = true;
      return;
    }

    if (result?.reason === "stale") {
      this.#emitApply(job, route, site, "stale");
      this.#discard("stale");
      return;
    }

    this.#emitApply(job, route, site, "rejected");
    this.#discard("apply-rejected");
  }

  #emitApply(
    job: JobRecord,
    route: Exclude<ApplyRoute, "none">,
    site: ApplySite,
    result: "ok" | "stale" | "rejected",
  ): void {
    const compaction = job.result;
    if (!compaction) return;
    this.#emit("apply", {
      jobId: job.id,
      route,
      site,
      result,
      tokensBefore: compaction.tokensBefore,
      estimatedTokensAfter:
        compaction.estimatedTokensAfter ??
        Math.max(0, compaction.tokensBefore - summaryTokens(compaction.summary)),
      summaryTokens: summaryTokens(compaction.summary),
      notesBlocks: countNotesBlocks(compaction.summary),
    });
  }

  // -------------------------------------------------------------------------
  // Discard / staleness
  // -------------------------------------------------------------------------

  #mutationReason(job: JobRecord, branch?: readonly SessionEntry[]): DiscardReason | undefined {
    const entries = branch ?? this.#ctx?.sessionManager.getBranch();
    if (!entries) return "stale";

    const tailIndex = entries.findIndex((entry) => entry.id === job.branchTailId);
    if (tailIndex < 0) return "stale";

    for (let index = tailIndex + 1; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type === "context_edit") return "context-edit";
      if (entry.type === "compaction") return "builtin-compact";
    }

    if (!anchorMatches(job.anchor, entries)) return "stale";

    const cutIndex = entries.findIndex((entry) => entry.id === job.source.firstKeptEntryId);
    if (cutIndex < 0) return "stale";
    const current = fingerprint(job.source.previousSummary, entries.slice(0, cutIndex));
    if (current !== job.fingerprint) return "fingerprint-mismatch";
    return undefined;
  }

  #discard(reason: DiscardReason, options: { accountFailure?: boolean } = {}): void {
    const job = this.#job;
    this.#cancelPendingStart();
    if (!job) {
      this.#surfaceIdle();
      return;
    }

    try {
      job.controller.abort();
    } catch {
      // Already aborted.
    }

    if (this.#phase === "GENERATING") {
      this.#emit("job_end", {
        jobId: job.id,
        outcome: "aborted",
        reason: discardToJobEndReason(reason),
        ms: Math.max(0, this.#now() - job.startedAt),
        inputTokens: 0,
        outputTokens: 0,
      });
    }

    this.#emit("discard", { jobId: job.id, reason });
    this.#job = undefined;
    this.#phase = "EMPTY";
    this.#surfaceIdle();

    if (options.accountFailure !== false) this.#noteFailure();
  }

  #clearJob(job: JobRecord, failure?: SurfaceFailureReason): void {
    if (this.#job !== job) return;
    this.#job = undefined;
    this.#phase = "EMPTY";
    if (failure === undefined) {
      this.#surfaceIdle();
    } else {
      this.#surfaceFailed(failure);
    }
  }

  #cancelPendingStart(): void {
    const pending = this.#pendingStart;
    if (!pending) return;
    this.#pendingStart = undefined;
    try {
      this.#timers.clearTimeout(pending.handle);
    } catch {
      // Best effort.
    }
  }

  #noteFailure(): void {
    this.#consecutiveFailures += 1;
    this.#lastFailureAt = this.#now();
    this.#cooldownUntil =
      this.#lastFailureAt + nextCooldownMs(this.#consecutiveFailures, this.#config.policy.cooldownStepsMs);
    if (this.#consecutiveFailures >= this.#config.policy.breakerFailureThreshold) {
      this.#safeSurface(() => this.#surface.warnBreakerOpened());
    }
  }

  #noteSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#lastFailureAt = null;
    this.#cooldownUntil = null;
  }

  // -------------------------------------------------------------------------
  // Usage, threshold and compaction bookkeeping
  // -------------------------------------------------------------------------

  #observeUsage(): { tokens: number | null; window: number } | undefined {
    const ctx = this.#ctx;
    if (!ctx) return undefined;
    try {
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const tokens = usage?.tokens ?? null;
      if (tokens !== null && window > 0) {
        const threshold = Math.round(
          window * computeEffectiveThreshold(window, this.#lastYieldValue),
        );
        if (tokens >= threshold) {
          if (!this.#thresholdCrossed) {
            this.#thresholdCrossed = true;
            this.#emit("threshold_cross", { U: tokens, T: threshold });
          }
        } else {
          this.#thresholdCrossed = false;
        }
      }
      return { tokens, window };
    } catch {
      this.#recordInternalError("usage");
      return undefined;
    }
  }

  #applyAcceptedCompaction(entry: CompactionEntryLike): void {
    this.#thresholdCrossed = false;
    this.#nextUsagePending = true;

    const yieldValue = structuralYield(entry);
    if (yieldValue !== undefined) {
      this.#lastYieldValue = {
        savedTokens: yieldValue.savedTokens,
        tokensBefore: entry.tokensBefore,
      };
    }

    const after = estimatedAfterCompaction(entry);
    this.#lastAppliedTokens = after;
    this.#lastPreparedTokens = after;
    this.#observeNewCacheWarmEntries();
  }

  #seedCacheWarmCursor(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    try {
      const branch = ctx.sessionManager.getBranch();
      this.#lastCacheWarmEntryId = null;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (
          entry.type === "custom" &&
          entry.customType === GOAL_CACHE_WARMUP_ENTRY_TYPE
        ) {
          this.#lastCacheWarmEntryId = entry.id;
          break;
        }
      }
    } catch {
      this.#lastCacheWarmEntryId = null;
    }
  }

  #observeNewCacheWarmEntries(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    let branch: readonly SessionEntry[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return;
    }

    let cursor = -1;
    if (this.#lastCacheWarmEntryId !== null) {
      cursor = branch.findIndex((entry) => entry.id === this.#lastCacheWarmEntryId);
      if (cursor < 0) {
        // The branch was rewritten; do not replay old warm entries as new.
        this.#seedCacheWarmCursor();
        return;
      }
    }

    for (let index = cursor + 1; index < branch.length; index++) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== GOAL_CACHE_WARMUP_ENTRY_TYPE) {
        continue;
      }
      try {
        this.#cache.observeGoalCacheWarmEntry(entry);
      } catch {
        // Cache evidence is optional.
      }
      this.#lastCacheWarmEntryId = entry.id;
    }
  }

  #systemHash(): string {
    let text = "";
    try {
      text = this.#ctx?.getSystemPrompt?.() ?? "";
    } catch {
      text = "";
    }
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  }

  // -------------------------------------------------------------------------
  // Idle timer and small helpers
  // -------------------------------------------------------------------------

  #onIdleTimer(): void {
    const token = this.#token;
    if (!this.#isLive(token)) return;
    if (this.#phase === "APPLYING") return;
    void this.#runIdleTimer(token).catch(() => this.#recordInternalError("timer"));
  }

  async #runIdleTimer(token: number): Promise<void> {
    if (!this.#isLive(token)) return;
    const ctx = this.#ctx;
    if (!ctx) return;
    try {
      if (!ctx.isIdle()) return;
      this.#observeUsage();
      this.#observeNewCacheWarmEntries();

      const model = ctx.model;
      if (isLocalBaseUrl(model?.baseUrl) && model) {
        await this.#cache.probeLocal(model);
        if (!this.#isLive(token)) return;
      }

      const pending = this.#attemptApply("timer", 0);
      if (pending !== undefined) await pending;
    } catch {
      this.#recordInternalError("timer");
    }
  }

  #isLive(token: number): boolean {
    return !this.#retired && token === this.#token;
  }

  #surfaceIdle(): void {
    if (!this.#active || this.#retired) return;
    this.#safeSurface(() => this.#surface.setState({ phase: "idle" }));
  }

  #surfaceFailed(reason: SurfaceFailureReason): void {
    if (!this.#active || this.#retired) return;
    this.#safeSurface(() => this.#surface.setState({ phase: "failed", reason }));
  }

  #safeSurface(action: () => void): void {
    try {
      action();
    } catch {
      // UI failures must not take down a session or a job.
    }
  }

  #emit<E extends MetricsEventName>(event: E, fields: MetricsFieldsFor<E>): void {
    if (!this.#metrics) return;
    try {
      this.#metrics.write(event, fields);
    } catch {
      // Metrics are diagnostics: a rejected line must never affect the job.
    }
  }

  #recordInternalError(label: string): void {
    if (this.#retired) return;
    this.#emit("job_end", {
      jobId: this.#job?.id ?? `internal-${label}`,
      outcome: "failed",
      reason: "failed",
      ms: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }
}
