/**
 * Offline replay comparison for the early-compaction mod (todo 15).
 *
 * Copies the largest root sessions (no `parentSession`) modified in the last
 * 14 days into one temporary directory outside the repository, replays the
 * recorded usage/timestamps under three policies, and writes a numbers-only
 * report. The temporary copies are always deleted; no message text, prompt or
 * session id reaches the reports.
 *
 * Policy decisions come from `src/policy.ts`; the cut keeps the effective
 * keep-recent tail exactly as `src/prepare.ts` computes it, recomputed at
 * every simulated compaction. The size model is:
 *   notes   = 0.08 * span tokens (the appended block)
 *   rewrite = median of the summary token counts recorded in the same session
 *             (fallback 0.10 * span when the session has no compaction)
 *
 * Two prefill models are reported:
 *   - token-prefix: a changed prefix invalidates everything after the cut.
 *   - block-level (INFERRED, Anthropic): unchanged message blocks after the
 *     changed summary block stay reusable; only the written summary block is
 *     re-read. This is an inference, not a live measurement.
 *
 * Local-model eviction (Strata/Ollama/opencodex) is inferred from request
 * timestamps interleaved across every recent session that used the same local
 * endpoint (baseUrl host 127.0.0.1/localhost, grouped by origin).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  closeSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "@code-yeongyu/senpi";
import {
  DEFAULTS,
  benefitOk,
  computeEffectiveKeepRecentTokens,
  computeEffectiveThreshold,
  nextJobKind,
  shouldStartJob,
  type LastYield,
  type PolicyConfig,
} from "../src/policy";
import { summaryTokens } from "../src/constants";

// ---------------------------------------------------------------------------
// Constants and public types
// ---------------------------------------------------------------------------

export const REPLAY_SCHEMA = "piomo.early-compaction.replay.v1";
export const REPLAY_WINDOW_DAYS = 14;
export const REPLAY_SESSION_LIMIT = 5;
export const DEFAULT_CONTEXT_WINDOW = 262_144;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const BUILTIN_SUMMARY_SCHEMA = "senpi.compaction.summary.v1";
export const NOTES_SPAN_RATIO = 0.08;
export const REWRITE_FALLBACK_SPAN_RATIO = 0.1;
export const ANTHROPIC_CACHE_TTL_MS = 300_000;
export const SCAN_WINDOW_CHARS = 40;

export type ReplayPolicy = "stock" | "early-rewrite" | "early-notes";
export const REPLAY_POLICIES: readonly ReplayPolicy[] = [
  "stock",
  "early-rewrite",
  "early-notes",
];

export interface ReplayRequest {
  /** Completion timestamp of the assistant turn, epoch ms. */
  ts: number;
  /** Tokens appended since the previous assistant usage (includes its output). */
  appendedTokens: number;
  /** Prompt tokens: input + cacheRead + cacheWrite. */
  promptTokens: number;
  cacheRead: number;
  outputTokens: number;
  provider: string;
  modelId: string;
  stopReason: string | null;
}

export interface ReplayCompaction {
  ts: number;
  tokensBefore: number;
  summaryTokens: number;
  schema: string;
}

export interface ParsedSession {
  id: string;
  hash: string;
  requests: ReplayRequest[];
  compactions: ReplayCompaction[];
}

export type ParseResult =
  | { ok: true; session: ParsedSession }
  | { ok: false; reason: string };

export interface AppliesByRoute {
  cold: number;
  boundary: number;
  threshold: number;
}

export interface PolicyRow {
  policy: ReplayPolicy;
  applies: AppliesByRoute;
  appliesTotal: number;
  thresholdCrossings: number;
  jobsStarted: number;
  coldMisses: number;
  coldMissTokens: number;
  applyRereadTokenPrefix: number;
  applyRereadBlockLevel: number;
  prefillTokenPrefix: number;
  prefillBlockLevel: number;
  summaryStartTokens: number;
  summaryEndTokens: number;
  summaryMaxTokens: number;
  summaryWriteTokens: number;
  notesAppends: number;
  notesBlocks: number;
  consolidations: number;
  finalContextTokens: number;
}

export interface SessionReplay {
  hash: string;
  requestCount: number;
  recordedCompactions: number;
  recordedBuiltinSummaries: number;
  recordedSummaryMedianTokens: number;
  policies: PolicyRow[];
}

export interface SkippedSession {
  hash: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Size model
// ---------------------------------------------------------------------------

/** The rewrite size model uses summaries the builtin generated itself. */
export function builtinSummarySizes(compactions: readonly ReplayCompaction[]): number[] {
  return compactions
    .filter((entry) => entry.schema === BUILTIN_SUMMARY_SCHEMA)
    .map((entry) => entry.summaryTokens);
}

/** notes = 0.08 x span tokens. */
export function notesSummaryTokens(spanTokens: number): number {
  if (!Number.isFinite(spanTokens) || spanTokens <= 0) return 0;
  return Math.round(NOTES_SPAN_RATIO * spanTokens);
}

export function median(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).slice().sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[middle];
  return Math.round((finite[middle - 1] + finite[middle]) / 2);
}

/**
 * rewrite = the builtin summary sizes measured in the same session (median of
 * the recorded compaction summary token counts); fallback 0.10 x span.
 */
export function rewriteSummaryTokens(
  recordedSummaryTokens: readonly number[],
  spanTokens: number,
): number {
  if (spanTokens <= 0) return 0;
  const measured = median(recordedSummaryTokens);
  const raw = measured > 0 ? measured : Math.round(REWRITE_FALLBACK_SPAN_RATIO * spanTokens);
  return Math.max(0, Math.min(raw, Math.max(0, Math.round(spanTokens))));
}

/** The token-level cut used by the replay: keep the last `keepRecentEff` tokens. */
export function spanTokensFor(contextTokens: number, keepRecentEff: number): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0;
  return Math.max(0, Math.round(contextTokens - Math.max(0, keepRecentEff)));
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  try {
    return estimateTokens(message as never);
  } catch {
    return 0;
  }
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  try {
    return Math.ceil((JSON.stringify(content) ?? "").length / 4);
  } catch {
    return 0;
  }
}

function usageParts(message: Record<string, unknown>): {
  prompt: number;
  cacheRead: number;
  output: number;
} {
  const usage = (message.usage ?? {}) as Record<string, unknown>;
  const input = numberField(usage.input);
  const cacheRead = numberField(usage.cacheRead);
  const cacheWrite = numberField(usage.cacheWrite);
  const output = numberField(usage.output);
  const total = numberField(usage.totalTokens);
  const prompt = total > 0 ? Math.max(0, total - output) : input + cacheRead + cacheWrite;
  return { prompt, cacheRead, output };
}

/**
 * Parse one session file. Any malformed line skips the whole file with a named
 * reason (a truncated final line is the common case); the caller continues.
 * The reason carries only a line number, never file content.
 */
export function parseSessionText(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  let header: Record<string, unknown> | undefined;
  let lineNumber = 0;

  let currentProvider = "";
  let currentModelId = "";
  const requests: ReplayRequest[] = [];
  const compactions: ReplayCompaction[] = [];
  let pendingTokens = 0;

  for (const raw of lines) {
    lineNumber += 1;
    if (raw.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: `unparseable-jsonl-line-${lineNumber}` };
      }
      entry = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `unparseable-jsonl-line-${lineNumber}` };
    }

    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string") {
        return { ok: false, reason: "missing-session-header" };
      }
      header = entry;
      continue;
    }

    const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const ts = Number.isFinite(entryTs) ? entryTs : 0;

    if (entry.type === "model_change") {
      currentProvider = typeof entry.provider === "string" ? entry.provider : currentProvider;
      currentModelId = typeof entry.modelId === "string" ? entry.modelId : currentModelId;
      pendingTokens = 0;
      continue;
    }

    if (entry.type === "compaction") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      const details =
        entry.details && typeof entry.details === "object"
          ? (entry.details as Record<string, unknown>)
          : {};
      compactions.push({
        ts,
        tokensBefore: numberField(entry.tokensBefore),
        summaryTokens: summaryTokens(summary),
        schema: typeof details.schema === "string" ? details.schema : "unknown",
      });
      // The recorded summary is not an append; the simulation owns its own summary.
      continue;
    }

    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "assistant") {
        const parts = usageParts(message);
        const stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
        const validUsage =
          stopReason !== "aborted" &&
          stopReason !== "error" &&
          parts.prompt + parts.output > 0;
        if (validUsage) {
          requests.push({
            ts,
            appendedTokens: pendingTokens,
            promptTokens: parts.prompt,
            cacheRead: parts.cacheRead,
            outputTokens: parts.output,
            provider: currentProvider,
            modelId: currentModelId,
            stopReason,
          });
          pendingTokens = parts.output > 0 ? parts.output : estimateMessageTokens(message);
        } else {
          pendingTokens += estimateMessageTokens(message);
        }
      } else {
        pendingTokens += estimateMessageTokens(message);
      }
      continue;
    }

    if (entry.type === "custom_message") {
      pendingTokens += estimateContentTokens(entry.content);
      continue;
    }

    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      pendingTokens += Math.ceil(entry.summary.length / 4);
      continue;
    }
  }

  if (!header) return { ok: false, reason: "missing-session-header" };
  if (requests.length === 0) return { ok: false, reason: "no-recorded-usage" };

  const id = header.id as string;
  return {
    ok: true,
    session: {
      id,
      hash: hashId(id),
      requests,
      compactions,
    },
  };
}

// ---------------------------------------------------------------------------
// Model metadata (context windows and local endpoints)
// ---------------------------------------------------------------------------

export interface ModelMeta {
  windowFor(provider: string, modelId: string): number;
  endpointFor(provider: string): string | null;
  isAnthropic(provider: string, modelId: string): boolean;
}

function isLocalHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadModelMeta(agentDir: string): ModelMeta {
  const byProviderModel = new Map<string, number>();
  const byModel = new Map<string, number>();
  const endpoints = new Map<string, string>();
  const anthropicProviders = new Set<string>();

  const modelsPath = join(agentDir, "models.json");
  if (existsSync(modelsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
        providers?: Record<string, Record<string, unknown>>;
      };
      for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
        if (!config || typeof config !== "object") continue;
        const api = typeof config.api === "string" ? config.api : "";
        if (api === "anthropic-messages" || /anthropic/i.test(provider)) {
          anthropicProviders.add(provider);
        }
        const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
        if (baseUrl.length > 0) {
          try {
            const url = new URL(baseUrl);
            if (isLocalHost(url.hostname)) endpoints.set(provider, url.origin);
          } catch {
            // A malformed baseUrl is not a local endpoint.
          }
        }
        const models = Array.isArray(config.models) ? config.models : [];
        for (const model of models) {
          if (!model || typeof model !== "object") continue;
          const record = model as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          const window = numberField(record.contextWindow);
          if (id && window > 0) {
            byProviderModel.set(`${provider}/${id}`, window);
            if (!byModel.has(id)) byModel.set(id, window);
          }
        }
        const overrides =
          config.modelOverrides && typeof config.modelOverrides === "object"
            ? (config.modelOverrides as Record<string, unknown>)
            : {};
        for (const [id, override] of Object.entries(overrides)) {
          if (!override || typeof override !== "object") continue;
          const window = numberField((override as Record<string, unknown>).contextWindow);
          if (window > 0) {
            byProviderModel.set(`${provider}/${id}`, window);
            if (!byModel.has(id)) byModel.set(id, window);
          }
        }
      }
    } catch {
      // A missing/invalid models.json only means the default window and no
      // local-eviction inference; the replay still runs.
    }
  }

  return {
    windowFor(provider: string, modelId: string): number {
      return (
        byProviderModel.get(`${provider}/${modelId}`) ??
        byModel.get(modelId) ??
        DEFAULT_CONTEXT_WINDOW
      );
    },
    endpointFor(provider: string): string | null {
      return endpoints.get(provider) ?? null;
    },
    isAnthropic(provider: string, modelId: string): boolean {
      return anthropicProviders.has(provider) || /^claude/i.test(modelId);
    },
  };
}

// ---------------------------------------------------------------------------
// Strata/Ollama eviction inference
// ---------------------------------------------------------------------------

export type EndpointIndex = Map<string, Map<string, number[]>>;

async function forEachJsonLine(
  path: string,
  onLine: (line: string) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) onLine(line);
  } finally {
    reader.close();
    stream.close();
  }
}

/**
 * Collect assistant request timestamps for every recent session that used a
 * local endpoint. Keyed endpoint -> session hash -> sorted timestamps.
 */
export async function scanLocalRequestTimes(
  sessionsDir: string,
  cutoffMs: number,
  meta: ModelMeta,
): Promise<EndpointIndex> {
  const index: EndpointIndex = new Map();
  const files = collectSessionFiles(sessionsDir);

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) continue;

    let sessionHash = hashId(basename(file));
    let provider = "";
    let modelId = "";
    const perSession: Map<string, number[]> = new Map();

    try {
      await forEachJsonLine(file, (line) => {
        if (line.trim().length === 0) return;
        if (line.includes('"type":"session"')) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === "session" && typeof entry.id === "string") {
              sessionHash = hashId(entry.id);
            }
          } catch {
            // Keep the filename hash.
          }
          return;
        }
        if (line.includes('"model_change"')) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === "model_change") {
              if (typeof entry.provider === "string") provider = entry.provider;
              if (typeof entry.modelId === "string") modelId = entry.modelId;
            }
          } catch {
            // Ignore a malformed metadata line in the eviction scan.
          }
          return;
        }
        if (!line.includes('"role":"assistant"')) return;
        const endpoint = meta.endpointFor(provider);
        if (!endpoint) return;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type !== "message" || typeof entry.message !== "object") return;
          const message = entry.message as Record<string, unknown>;
          if (message.role !== "assistant") return;
          const parts = usageParts(message);
          if (parts.prompt + parts.output <= 0) return;
          const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
          if (!Number.isFinite(ts)) return;
          let times = perSession.get(endpoint);
          if (!times) {
            times = [];
            perSession.set(endpoint, times);
          }
          times.push(ts);
        } catch {
          // A truncated line contributes no timestamp.
        }
      });
    } catch {
      continue;
    }

    for (const [endpoint, times] of perSession) {
      times.sort((a, b) => a - b);
      let sessions = index.get(endpoint);
      if (!sessions) {
        sessions = new Map();
        index.set(endpoint, sessions);
      }
      sessions.set(sessionHash, times);
    }
  }

  return index;
}

function hasTimeInOpenRange(times: readonly number[], low: number, high: number): boolean {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= low) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length && times[lo] < high;
}

/**
 * Cold flags for one session's requests. First request is cold; local
 * endpoints are cold when another session's request interleaved since this
 * session's previous request on the same endpoint; Anthropic providers are
 * cold when the recorded cacheRead is zero.
 */
export function inferColdFlags(
  session: ParsedSession,
  index: EndpointIndex,
  meta: ModelMeta,
): boolean[] {
  const flags: boolean[] = [];
  const lastByEndpoint = new Map<string, number>();
  const lastByProvider = new Map<string, number>();

  for (let i = 0; i < session.requests.length; i++) {
    const request = session.requests[i];
    if (i === 0) {
      flags.push(true);
      const endpoint = meta.endpointFor(request.provider);
      if (endpoint) lastByEndpoint.set(endpoint, request.ts);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    const endpoint = meta.endpointFor(request.provider);
    if (endpoint) {
      const previous = lastByEndpoint.get(endpoint);
      let cold = previous === undefined;
      if (previous !== undefined && request.ts > previous) {
        const sessions = index.get(endpoint);
        if (sessions) {
          for (const [otherHash, times] of sessions) {
            if (otherHash === session.hash) continue;
            if (hasTimeInOpenRange(times, previous, request.ts)) {
              cold = true;
              break;
            }
          }
        }
      }
      flags.push(cold);
      lastByEndpoint.set(endpoint, request.ts);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    if (meta.isAnthropic(request.provider, request.modelId)) {
      const previous = lastByProvider.get(request.provider);
      const expired = previous !== undefined && request.ts - previous > ANTHROPIC_CACHE_TTL_MS;
      const cold = (request.cacheRead === 0 && request.promptTokens >= 1024) || expired;
      flags.push(cold);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    flags.push(false);
    lastByProvider.set(request.provider, request.ts);
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimulateOptions {
  policy: ReplayPolicy;
  contextWindowFor: (provider: string, modelId: string) => number;
  coldAt: (index: number) => boolean;
  recordedSummaryTokens: readonly number[];
  keepRecentTokens?: number;
  config?: PolicyConfig;
}

function emptyRow(policy: ReplayPolicy): PolicyRow {
  return {
    policy,
    applies: { cold: 0, boundary: 0, threshold: 0 },
    appliesTotal: 0,
    thresholdCrossings: 0,
    jobsStarted: 0,
    coldMisses: 0,
    coldMissTokens: 0,
    applyRereadTokenPrefix: 0,
    applyRereadBlockLevel: 0,
    prefillTokenPrefix: 0,
    prefillBlockLevel: 0,
    summaryStartTokens: 0,
    summaryEndTokens: 0,
    summaryMaxTokens: 0,
    summaryWriteTokens: 0,
    notesAppends: 0,
    notesBlocks: 0,
    consolidations: 0,
    finalContextTokens: 0,
  };
}

export function simulatePolicy(
  requests: readonly ReplayRequest[],
  options: SimulateOptions,
): PolicyRow {
  const row = emptyRow(options.policy);
  const config = options.config ?? DEFAULTS;
  const keepRecentSetting = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  if (requests.length === 0) return row;

  let contextAfterRequest = requests[0].promptTokens;
  let summary = 0;
  let hasCompaction = false;
  let notesBlocks = 0;
  let lastYield: LastYield | undefined;
  let preparedBase = 0;
  let appliedBase = requests[0].promptTokens;
  let preparedAtU = 0;
  let jobReady = false;
  const startTimes: number[] = [];
  let aboveThreshold = false;

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const contextTokens =
      i === 0 ? request.promptTokens : contextAfterRequest + Math.max(0, request.appendedTokens);

    const window = options.contextWindowFor(request.provider, request.modelId);
    const thresholdRatio = computeEffectiveThreshold(window, lastYield);
    const threshold = window * thresholdRatio;
    const keepRecentEff = computeEffectiveKeepRecentTokens(
      keepRecentSetting,
      window,
      thresholdRatio,
    );

    if (contextTokens >= threshold && !aboveThreshold) {
      row.thresholdCrossings += 1;
      aboveThreshold = true;
    }

    const span = spanTokensFor(contextTokens, keepRecentEff);
    let route: "cold" | "boundary" | "threshold" | null = null;
    let applied = false;
    let applyAfter = contextTokens;
    let written = 0;

    if (i === 0) {
      // Before the first prompt only the builtin safety net can act.
      if (contextTokens >= threshold) {
        const candidate = rewriteSummaryTokens(options.recordedSummaryTokens, span);
        summary = candidate;
        hasCompaction = true;
        notesBlocks = 0;
        written = candidate;
        applyAfter = keepRecentEff + candidate;
        applied = true;
        route = "threshold";
      }
    } else if (options.policy === "stock") {
      if (contextTokens >= threshold) route = "threshold";
    } else {
      const staleAllowance = Math.max(keepRecentEff, config.staleWindowRatio * window);
      if (jobReady && contextTokens - preparedAtU > staleAllowance) jobReady = false;

      if (!jobReady) {
        const start = shouldStartJob({
          contextTokens,
          contextWindow: window,
          growthSincePreparedTokens: contextTokens - preparedBase,
          now: request.ts,
          sessionStartTimes: startTimes,
          random: () => 0,
          config,
        });
        if (start.start) {
          jobReady = true;
          preparedBase = contextTokens;
          preparedAtU = contextTokens;
          startTimes.push(request.ts + (start.jitterMs ?? 0));
          row.jobsStarted += 1;
        }
      }

      if (contextTokens >= threshold && !jobReady) {
        // The builtin safety net compacts even when no mod job is ready.
        route = "threshold";
      } else if (jobReady) {
        const mode = options.policy === "early-notes" ? "notes" : "rewrite";
        const kind = nextJobKind({
          hasCompactionEntry: hasCompaction,
          mode,
          summaryTokens: summary,
          notesBlocks,
          config,
        });
        const candidate =
          kind === "notes"
            ? summary + notesSummaryTokens(span)
            : rewriteSummaryTokens(options.recordedSummaryTokens, span);
        const after = keepRecentEff + candidate;
        if (benefitOk(contextTokens, after, config)) {
          if (contextTokens >= threshold) {
            route = "threshold";
          } else if (options.coldAt(i)) {
            route = "cold";
          } else {
            const boundaryFloor = Math.max(
              config.boundaryGrowthMinTokens,
              config.boundaryGrowthRatio * window,
            );
            if (contextTokens - appliedBase >= boundaryFloor) route = "boundary";
          }
          if (route !== null) {
            if (kind === "notes") {
              summary = candidate;
              notesBlocks += 1;
              row.notesAppends += 1;
              written = notesSummaryTokens(span);
            } else {
              summary = candidate;
              notesBlocks = 0;
              written = candidate;
              if (kind === "rewrite-consolidate") row.consolidations += 1;
            }
            hasCompaction = true;
            jobReady = false;
            applyAfter = after;
            applied = true;
          }
        }
      }
    }

    if (route === "threshold" && !applied) {
      // Stock and the early safety fallback both use a full rewrite.
      const candidate = rewriteSummaryTokens(options.recordedSummaryTokens, span);
      summary = candidate;
      hasCompaction = true;
      notesBlocks = 0;
      written = candidate;
      applyAfter = keepRecentEff + candidate;
      applied = true;
    }

    if (route !== null) {
      row.applies[route] += 1;
      row.appliesTotal += 1;
    }

    if (applied) {
      if (options.policy === "stock") {
        lastYield = {
          savedTokens: Math.max(0, contextTokens - applyAfter),
          tokensBefore: contextTokens,
        };
      }
      appliedBase = applyAfter;
      preparedBase = applyAfter;
      preparedAtU = applyAfter;
      row.summaryWriteTokens += written;
      row.summaryMaxTokens = Math.max(row.summaryMaxTokens, summary);
      row.applyRereadTokenPrefix += applyAfter;
      row.applyRereadBlockLevel += written;
      row.prefillTokenPrefix += applyAfter;
      row.prefillBlockLevel += written;
      contextAfterRequest = applyAfter;
      aboveThreshold = applyAfter >= threshold;
    } else {
      if (i > 0 && options.coldAt(i)) {
        row.coldMisses += 1;
        row.coldMissTokens += contextTokens;
        row.prefillTokenPrefix += contextTokens;
        row.prefillBlockLevel += contextTokens;
      } else if (i > 0) {
        const warm = Math.max(0, request.appendedTokens);
        row.prefillTokenPrefix += warm;
        row.prefillBlockLevel += warm;
      }
      contextAfterRequest = contextTokens;
      if (i === 0) appliedBase = contextTokens;
    }
  }

  row.summaryEndTokens = summary;
  row.notesBlocks = notesBlocks;
  row.finalContextTokens = contextAfterRequest;
  return row;
}

// ---------------------------------------------------------------------------
// Input selection
// ---------------------------------------------------------------------------

export interface RootSessionFile {
  path: string;
  size: number;
  mtimeMs: number;
  id: string;
  hash: string;
}

export function collectSessionFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function readFirstLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, read);
    const line = text.split(/\r?\n/, 1)[0];
    return line && line.trim().length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on read-only handles.
      }
    }
  }
}

export function findLargestRootSessions(
  sessionsDir: string,
  cutoffMs: number,
  limit = REPLAY_SESSION_LIMIT,
): RootSessionFile[] {
  const candidates: RootSessionFile[] = [];
  for (const path of collectSessionFiles(sessionsDir)) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) continue;
    const line = readFirstLine(path);
    if (!line) continue;
    try {
      const header = JSON.parse(line) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string") continue;
      if (header.parentSession !== undefined) continue;
      candidates.push({
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        id: header.id,
        hash: hashId(header.id),
      });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Report generation (numbers only)
// ---------------------------------------------------------------------------

export interface ReplayReport {
  schema: string;
  date: string;
  windowDays: number;
  sessionLimit: number;
  sessionsSelected: number;
  sessionsReplayed: number;
  sessionsSkipped: number;
  sizeModel: {
    notesSpanRatio: number;
    rewriteFallbackSpanRatio: number;
    rewriteMeasure: string;
  };
  cacheModels: string[];
  sessions: SessionReplay[];
  skipped: SkippedSession[];
  totals: PolicyRow[];
  checks: {
    rowsPerSessionPolicy: boolean;
    forbiddenTextScan: { windows: number; matches: number };
    tempCopyRemoved: boolean;
  };
}

export function totalRows(sessions: readonly SessionReplay[]): PolicyRow[] {
  return REPLAY_POLICIES.map((policy) => {
    const total = emptyRow(policy);
    for (const session of sessions) {
      const row = session.policies.find((entry) => entry.policy === policy);
      if (!row) continue;
      total.applies.cold += row.applies.cold;
      total.applies.boundary += row.applies.boundary;
      total.applies.threshold += row.applies.threshold;
      total.appliesTotal += row.appliesTotal;
      total.thresholdCrossings += row.thresholdCrossings;
      total.jobsStarted += row.jobsStarted;
      total.coldMisses += row.coldMisses;
      total.coldMissTokens += row.coldMissTokens;
      total.applyRereadTokenPrefix += row.applyRereadTokenPrefix;
      total.applyRereadBlockLevel += row.applyRereadBlockLevel;
      total.prefillTokenPrefix += row.prefillTokenPrefix;
      total.prefillBlockLevel += row.prefillBlockLevel;
      total.summaryStartTokens += row.summaryStartTokens;
      total.summaryEndTokens += row.summaryEndTokens;
      total.summaryMaxTokens = Math.max(total.summaryMaxTokens, row.summaryMaxTokens);
      total.summaryWriteTokens += row.summaryWriteTokens;
      total.notesAppends += row.notesAppends;
      total.notesBlocks += row.notesBlocks;
      total.consolidations += row.consolidations;
      total.finalContextTokens += row.finalContextTokens;
    }
    return total;
  });
}

function markdownRow(sessionHash: string, row: PolicyRow): string {
  const cells = [
    sessionHash,
    row.policy,
    row.applies.cold,
    row.applies.boundary,
    row.applies.threshold,
    row.appliesTotal,
    row.thresholdCrossings,
    row.jobsStarted,
    row.coldMisses,
    row.prefillTokenPrefix,
    row.prefillBlockLevel,
    row.applyRereadTokenPrefix,
    row.applyRereadBlockLevel,
    row.summaryStartTokens,
    row.summaryEndTokens,
    row.summaryMaxTokens,
    row.summaryWriteTokens,
    row.notesAppends,
    row.notesBlocks,
    row.consolidations,
    row.finalContextTokens,
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`# Replay comparison - ${report.date}`);
  lines.push("");
  lines.push(`- sessions selected: ${report.sessionsSelected}`);
  lines.push(`- sessions replayed: ${report.sessionsReplayed}`);
  lines.push(`- sessions skipped: ${report.sessionsSkipped}`);
  lines.push(`- window days: ${report.windowDays}`);
  lines.push(`- notes size model: ${report.sizeModel.notesSpanRatio} x span tokens`);
  lines.push(
    `- rewrite size model: ${report.sizeModel.rewriteMeasure} (fallback ${report.sizeModel.rewriteFallbackSpanRatio} x span)`,
  );
  lines.push(`- cache models: ${report.cacheModels.join(", ")}`);
  lines.push("");
  lines.push(
    "| session | policy | cold | boundary | threshold | applies | threshold crossings | jobs started | cold misses | prefill token-prefix | prefill block-level (INFERRED) | apply re-read token-prefix | apply re-read block-level | summary start | summary end | summary max | summary written | notes appends | notes blocks left | consolidations | final context |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const session of report.sessions) {
    for (const row of session.policies) lines.push(markdownRow(session.hash, row));
  }
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(
    "| policy | cold | boundary | threshold | applies | threshold crossings | jobs started | cold misses | prefill token-prefix | prefill block-level (INFERRED) | summary written | notes appends | notes blocks left | consolidations |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of report.totals) {
    lines.push(
      `| ${row.policy} | ${row.applies.cold} | ${row.applies.boundary} | ${row.applies.threshold} | ${row.appliesTotal} | ${row.thresholdCrossings} | ${row.jobsStarted} | ${row.coldMisses} | ${row.prefillTokenPrefix} | ${row.prefillBlockLevel} | ${row.summaryWriteTokens} | ${row.notesAppends} | ${row.notesBlocks} | ${row.consolidations} |`,
    );
  }
  lines.push("");
  lines.push("## Skipped");
  lines.push("");
  if (report.skipped.length === 0) {
    lines.push("- none");
  } else {
    for (const skipped of report.skipped) lines.push(`- ${skipped.hash}: ${skipped.reason}`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push(`- rows per session and policy: ${report.checks.rowsPerSessionPolicy}`);
  lines.push(
    `- 40-character copied-text scan: windows ${report.checks.forbiddenTextScan.windows}, matches ${report.checks.forbiddenTextScan.matches}`,
  );
  lines.push(`- temp copy removed: ${report.checks.tempCopyRemoved}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 40-character copied-text scan
// ---------------------------------------------------------------------------

const BASE = 131;
const WINDOW_POWER = (() => {
  let power = 1;
  for (let i = 0; i < SCAN_WINDOW_CHARS - 1; i++) power = Math.imul(power, BASE) >>> 0;
  return power;
})();

function windowHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < SCAN_WINDOW_CHARS; i++) {
    hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function collectReportWindows(reportTexts: readonly string[]): Map<number, string[]> {
  const windows = new Map<number, string[]>();
  for (const text of reportTexts) {
    for (let i = 0; i + SCAN_WINDOW_CHARS <= text.length; i++) {
      const window = text.slice(i, i + SCAN_WINDOW_CHARS);
      // Numeric-only windows cannot carry private message prose and would
      // produce false positives against recorded usage numbers.
      if (!/[A-Za-z]/.test(window)) continue;
      const hash = windowHash(window);
      const bucket = windows.get(hash);
      if (bucket) {
        if (!bucket.includes(window)) bucket.push(window);
      } else {
        windows.set(hash, [window]);
      }
    }
  }
  return windows;
}

/**
 * Exhaustive rolling-hash scan: every 40-character window of the report is
 * searched in the raw copied session bytes. Returns counts only; a matched
 * window is never printed.
 */
export function scanForCopiedText(
  reportTexts: readonly string[],
  copyPaths: readonly string[],
  chunkSize = 8 * 1024 * 1024,
): { windows: number; matches: number } {
  const windows = collectReportWindows(reportTexts);
  let windowCount = 0;
  for (const bucket of windows.values()) windowCount += bucket.length;
  if (windowCount === 0) return { windows: 0, matches: 0 };

  let matches = 0;
  for (const path of copyPaths) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(chunkSize);
      let carry = "";
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        const text = carry + buffer.toString("latin1", 0, read);
        if (text.length >= SCAN_WINDOW_CHARS) {
          let hash = 0;
          for (let i = 0; i < SCAN_WINDOW_CHARS; i++) {
            hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
          }
          for (let i = SCAN_WINDOW_CHARS; i <= text.length; i++) {
            const bucket = windows.get(hash);
            if (bucket) {
              const candidate = text.slice(i - SCAN_WINDOW_CHARS, i);
              if (bucket.includes(candidate)) {
                matches += 1;
                break;
              }
            }
            if (i < text.length) {
              hash = (hash - Math.imul(text.charCodeAt(i - SCAN_WINDOW_CHARS), WINDOW_POWER)) >>> 0;
              hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
            }
          }
        }
        carry = text.slice(Math.max(0, text.length - (SCAN_WINDOW_CHARS - 1)));
      }
    } catch {
      // A read failure leaves the check conservative (no match found).
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failures.
        }
      }
    }
  }

  return { windows: windowCount, matches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const AGENT_DIR = "C:/Users/USER/.omo-stable-500/home/.omo/agent";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const agentDir = process.env.PIOMO_REPLAY_AGENT_DIR ?? AGENT_DIR;
  const sessionsDir = process.env.PIOMO_REPLAY_SESSIONS_DIR ?? join(agentDir, "sessions");
  const reportsDir = join(REPO_ROOT, "reports");
  const date = new Date().toISOString().slice(0, 10);
  const cutoffMs = Date.now() - REPLAY_WINDOW_DAYS * 86_400_000;

  const selected = findLargestRootSessions(sessionsDir, cutoffMs, REPLAY_SESSION_LIMIT);
  print(`REPLAY_SESSIONS_SELECTED=${selected.length}`);
  if (selected.length === 0) {
    print("REPLAY_ERROR=no-root-sessions-modified-in-window");
    return 1;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "piomo-early-compaction-replay-"));
  const resolvedTemp = resolve(tempDir);
  if (resolvedTemp === REPO_ROOT || resolvedTemp.startsWith(`${REPO_ROOT}${sep}`)) {
    print("REPLAY_ERROR=temp-inside-repo");
    return 1;
  }
  print(`REPLAY_TEMP_DIR=${resolvedTemp}`);

  let tempRemoved = false;
  let report: ReplayReport | undefined;
  const skipped: SkippedSession[] = [];
  const sessions: SessionReplay[] = [];

  try {
    const copies: string[] = [];
    const meta = loadModelMeta(agentDir);
    for (let i = 0; i < selected.length; i++) {
      const copy = join(tempDir, `session-${String(i + 1).padStart(2, "0")}.jsonl`);
      copyFileSync(selected[i].path, copy);
      copies.push(copy);
    }

    const endpointIndex = await scanLocalRequestTimes(sessionsDir, cutoffMs, meta);

    for (let i = 0; i < copies.length; i++) {
      const source = selected[i];
      let text: string;
      try {
        text = readFileSync(copies[i], "utf8");
      } catch {
        skipped.push({ hash: source.hash, reason: "copy-read-failed" });
        continue;
      }
      const parsed = parseSessionText(text);
      text = "";
      if (!parsed.ok) {
        skipped.push({ hash: source.hash, reason: parsed.reason });
        continue;
      }

      const session = parsed.session;
      const coldFlags = inferColdFlags(session, endpointIndex, meta);
      const recordedSummaryTokens = builtinSummarySizes(session.compactions);
      const policies = REPLAY_POLICIES.map((policy) =>
        simulatePolicy(session.requests, {
          policy,
          contextWindowFor: (provider, modelId) => meta.windowFor(provider, modelId),
          coldAt: (index) => coldFlags[index] === true,
          recordedSummaryTokens,
        }),
      );

      sessions.push({
        hash: session.hash,
        requestCount: session.requests.length,
        recordedCompactions: session.compactions.length,
        recordedBuiltinSummaries: recordedSummaryTokens.length,
        recordedSummaryMedianTokens: median(recordedSummaryTokens),
        policies,
      });
    }

    print(`REPLAY_SESSIONS_REPLAYED=${sessions.length}`);
    print(`REPLAY_SESSIONS_SKIPPED=${skipped.length}`);

    const rowsPerSessionPolicy =
      sessions.length > 0 &&
      sessions.every(
        (session) =>
          session.policies.length === REPLAY_POLICIES.length &&
          REPLAY_POLICIES.every((policy) =>
            session.policies.some((row) => row.policy === policy),
          ),
      );

    const draft: ReplayReport = {
      schema: REPLAY_SCHEMA,
      date,
      windowDays: REPLAY_WINDOW_DAYS,
      sessionLimit: REPLAY_SESSION_LIMIT,
      sessionsSelected: selected.length,
      sessionsReplayed: sessions.length,
      sessionsSkipped: skipped.length,
      sizeModel: {
        notesSpanRatio: NOTES_SPAN_RATIO,
        rewriteFallbackSpanRatio: REWRITE_FALLBACK_SPAN_RATIO,
        rewriteMeasure: "median-builtin-recorded-summary-tokens",
      },
      cacheModels: ["token-prefix", "block-level (INFERRED, Anthropic)"],
      sessions,
      skipped,
      totals: totalRows(sessions),
      checks: {
        rowsPerSessionPolicy,
        forbiddenTextScan: { windows: 0, matches: 0 },
        tempCopyRemoved: false,
      },
    };

    const markdownDraft = renderMarkdown(draft);
    const jsonDraft = `${JSON.stringify(draft, null, 2)}\n`;
    const scan = scanForCopiedText([markdownDraft, jsonDraft], copies);
    draft.checks.forbiddenTextScan = scan;
    print(`REPLAY_SCAN_WINDOWS=${scan.windows}`);
    print(`REPLAY_SCAN_MATCHES=${scan.matches}`);

    if (!rowsPerSessionPolicy) {
      print("REPLAY_ERROR=missing-session-policy-row");
      return 1;
    }
    if (scan.matches > 0) {
      print("REPLAY_ERROR=copied-text-in-report");
      return 1;
    }
    report = draft;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The check below reports the failure.
    }
    tempRemoved = !existsSync(tempDir);
    print(`REPLAY_TEMP_DIR_REMOVED=${tempRemoved}`);
  }

  if (!report) return 1;
  if (!tempRemoved) {
    print("REPLAY_ERROR=temp-copy-not-removed");
    return 1;
  }

  report.checks.tempCopyRemoved = true;
  const markdown = renderMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `replay-${date}.md`);
  const jsonPath = join(reportsDir, `replay-${date}.json`);
  writeFileSync(mdPath, markdown, "utf8");
  writeFileSync(jsonPath, json, "utf8");

  print(`REPLAY_ROWS=${report.sessions.reduce((sum, session) => sum + session.policies.length, 0)}`);
  print(`REPLAY_REPORT_MD=${join("reports", `replay-${date}.md`)}`);
  print(`REPLAY_REPORT_JSON=${join("reports", `replay-${date}.json`)}`);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
