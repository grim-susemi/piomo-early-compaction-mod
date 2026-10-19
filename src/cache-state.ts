/**
 * Cold-cache detection for the early-compaction mod.
 *
 * The mod may apply a prepared summary without extra cost only when the
 * provider's prompt cache has already expired (or the local slot was taken by
 * another conversation). This module owns that answer and returns exactly one
 * of `cold | warm | unknown`; `unknown` means "do not use the cold route".
 *
 * Two very different cache mechanisms are covered:
 *
 * - Anthropic-style providers have a known TTL. The last provider response time
 *   is the cache's latest write/reuse time; the TTL comes from the request's
 *   `cache_control` breakpoints (3600 s when a `ttl: "1h"` breakpoint exists,
 *   300 s otherwise) and a 30 s grace period is added before calling it cold.
 *   The builtin cache-keepalive extension refreshes the cache with a ping on
 *   `pi.events` (`CACHE_WARM_PING_EVENT`), and the goal feature schedules
 *   cache-warm continuations (`GOAL_CACHE_WARMUP_ENTRY_TYPE`); both count as a
 *   response time. When keep-alive is enabled but no ping has ever been
 *   observed, an otherwise-cold answer is downgraded to `unknown`, because a
 *   ping we cannot see may have refreshed the cache.
 *
 * - Local models (llama.cpp-style, host `127.0.0.1` or `localhost`) expose no
 *   TTL. Their `/slots` endpoint is the only signal: a baseline is taken at
 *   `agent_settled`, and a later probe calls the slot evicted when the matching
 *   slot is no longer processing and its `n_prompt_tokens` differs from that
 *   baseline. Probes are read-only `GET <origin>/slots`, time out after
 *   1500 ms, and are throttled to one per 30 s. A failed or timed-out probe is
 *   `unknown`. This module never sends a generation or completion request to a
 *   local server.
 *
 * Everything here is injectable (`now`, `fetch`) so the timing and probing
 * rules can be tested without a real clock or provider.
 */

export type CacheState = "cold" | "warm" | "unknown";

/**
 * Event name emitted by the builtin cache-keepalive extension after a
 * successful warm ping (`pi.events.emit(CACHE_WARM_PING_EVENT, ...)`).
 * Kept as a literal because extensions may not import senpi internals.
 */
export const CACHE_WARM_PING_EVENT = "cache_warm_ping";

/**
 * Session-entry type the goal feature uses for its cache-warm schedule. An
 * entry of this type means a continuation was scheduled inside the cache TTL,
 * so it is treated as a warm refresh.
 */
export const GOAL_CACHE_WARMUP_ENTRY_TYPE = "goal-cache-warmup";

/** Anthropic's ordinary prompt-cache TTL. */
export const ANTHROPIC_CACHE_TTL_SECONDS = 300;
/** Anthropic's long-retention prompt-cache TTL (`cache_control.ttl: "1h"`). */
export const ANTHROPIC_LONG_CACHE_TTL_SECONDS = 3600;
/** Extra slack past the TTL before a cache is called cold. */
export const CACHE_EXPIRY_GRACE_MS = 30_000;
/** Maximum time a local `/slots` request may take. */
export const LOCAL_PROBE_TIMEOUT_MS = 1500;
/** Minimum spacing between two local `/slots` probes after the baseline. */
export const LOCAL_PROBE_INTERVAL_MS = 30_000;

/** The model fields this module needs; structurally satisfied by senpi's `Model`. */
export interface CacheModelLike {
  readonly api?: string;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly cacheRetention?: "none" | "short" | "long";
}

/** The part of `BeforeProviderRequestEvent` this module reads. */
export interface CacheRequestLike {
  readonly payload?: unknown;
  readonly model?: CacheModelLike;
}

/** Per-call overrides for `state`. */
export interface CacheStateQuery {
  /**
   * Whether the builtin prompt-cache keep-alive is enabled for the session.
   * Defaults to the value set with `setKeepAliveEnabled`.
   */
  readonly keepAliveEnabled?: boolean;
}

export interface CacheStateOptions {
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Fetch implementation. Defaults to `globalThis.fetch`; only `/slots` is requested. */
  readonly fetch?: FetchLike;
  /** Initial keep-alive state; can be updated with `setKeepAliveEnabled`. */
  readonly keepAliveEnabled?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ProviderKind = "anthropic" | "local" | "other";

interface LocalSlot {
  readonly id: string | number;
  readonly isProcessing: boolean;
  readonly nPromptTokens: number;
}

interface LocalBaseline {
  readonly id: string | number;
  readonly nPromptTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function originOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

function modelKind(model: CacheModelLike | undefined): ProviderKind {
  if (model === undefined) return "other";
  // A local endpoint wins over the API shape: its cache is owned by the slot,
  // not by the Anthropic prompt-cache contract.
  if (isLocalBaseUrl(model.baseUrl)) return "local";
  if (model.api === "anthropic-messages" || model.provider === "anthropic") {
    return "anthropic";
  }
  return "other";
}

/**
 * True when the payload contains any `cache_control` breakpoint with
 * `ttl: "1h"`. The payload is plain JSON-shaped data; cycles are guarded
 * anyway so a hostile/decorated payload cannot hang the handler.
 */
function hasOneHourCacheControl(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const item of current) stack.push(item);
      continue;
    }
    if (!isRecord(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const cacheControl = current.cache_control;
    if (isRecord(cacheControl) && cacheControl.ttl === "1h") return true;
    for (const item of Object.values(current)) stack.push(item);
  }
  return false;
}

function parseSlots(body: unknown): LocalSlot[] | undefined {
  const raw = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.slots)
      ? body.slots
      : undefined;
  if (raw === undefined) return undefined;
  const slots: LocalSlot[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = item.id;
    const isProcessing = item.is_processing;
    const nPromptTokens = item.n_prompt_tokens;
    if (
      (typeof id !== "string" && !isFiniteNumber(id)) ||
      typeof isProcessing !== "boolean" ||
      !isFiniteNumber(nPromptTokens)
    ) {
      continue;
    }
    slots.push({ id, isProcessing, nPromptTokens });
  }
  return slots;
}

/** The slot that just handled this session: the one with the largest prompt. */
function selectBaselineSlot(slots: readonly LocalSlot[]): LocalSlot | undefined {
  let best: LocalSlot | undefined;
  for (const slot of slots) {
    if (best === undefined || slot.nPromptTokens > best.nPromptTokens) best = slot;
  }
  return best;
}

/**
 * Prefer the baseline slot's id. Some llama.cpp builds expose unstable ids, so
 * a single-slot server falls back to that one slot; with several slots and no
 * id match the owner is unknown.
 */
function selectProbeSlot(
  slots: readonly LocalSlot[],
  baseline: LocalBaseline,
): LocalSlot | undefined {
  const byId = slots.find((slot) => String(slot.id) === String(baseline.id));
  if (byId !== undefined) return byId;
  return slots.length === 1 ? slots[0] : undefined;
}

export class CacheStateTracker {
  readonly #now: () => number;
  readonly #fetch: FetchLike;

  #keepAliveEnabled: boolean;
  #keepAlivePingObserved = false;

  #lastResponseAtMs: number | undefined;
  #anthropicTtlSeconds = ANTHROPIC_CACHE_TTL_SECONDS;

  #localBaseline: LocalBaseline | undefined;
  #localState: CacheState = "unknown";
  #lastLocalProbeAtMs: number | undefined;

  constructor(options: CacheStateOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#keepAliveEnabled = options.keepAliveEnabled ?? false;
  }

  /** Remember whether the builtin prompt-cache keep-alive is enabled. */
  setKeepAliveEnabled(enabled: boolean): void {
    this.#keepAliveEnabled = enabled;
  }

  get keepAliveEnabled(): boolean {
    return this.#keepAliveEnabled;
  }

  /**
   * Called from `before_provider_request` (which must not return a value).
   * Reads the cache TTL decision; it does not itself prove the cache is warm.
   */
  observeRequest(request: CacheRequestLike): void {
    if (modelKind(request.model) !== "anthropic") return;
    this.#anthropicTtlSeconds = hasOneHourCacheControl(request.payload)
      ? ANTHROPIC_LONG_CACHE_TTL_SECONDS
      : ANTHROPIC_CACHE_TTL_SECONDS;
  }

  /** Called from `after_provider_response`: the cache was just written/reused. */
  observeResponse(): void {
    this.#lastResponseAtMs = this.#now();
  }

  /**
   * Called from `message_end`. An assistant message carrying usage is the other
   * reliable proof that a provider response completed.
   *
   * @returns whether the message counted as a response.
   */
  observeMessageEnd(message: unknown): boolean {
    if (!isRecord(message)) return false;
    if (message.role !== "assistant") return false;
    if (!isRecord(message.usage)) return false;
    this.observeResponse();
    return true;
  }

  /**
   * Called for `CACHE_WARM_PING_EVENT` on `pi.events`: the builtin refreshed the
   * cache, so the TTL restarts now. Also marks that keep-alive pings are
   * observable, which lets a later expiry be called `cold` instead of `unknown`.
   *
   * A ping is only observable if the wiring subscribes to the event; call this
   * method from that subscription.
   */
  observeWarmPing(): void {
    this.#keepAlivePingObserved = true;
    this.observeResponse();
  }

  /**
   * Called for a session entry written by the goal feature's cache-warm
   * schedule. Accepts a full custom entry or an entry-like object.
   *
   * @returns whether the entry counted as a response.
   */
  observeGoalCacheWarmEntry(entry: unknown): boolean {
    if (!isRecord(entry)) return false;
    if (entry.customType !== GOAL_CACHE_WARMUP_ENTRY_TYPE) return false;
    this.observeResponse();
    return true;
  }

  /**
   * The current answer. For Anthropic-style models this is synchronous and uses
   * the observed response time plus the request's TTL. For local models it
   * returns the latest `/slots` result, so callers must run `baselineLocal` at
   * `agent_settled` and `probeLocal` from the input handler and idle timer.
   */
  state(
    model: CacheModelLike | undefined,
    query: CacheStateQuery = {},
  ): CacheState {
    const kind = modelKind(model);
    if (kind === "local") return this.#localState;
    if (kind !== "anthropic") return "unknown";

    // No cache at all: every request re-reads the prompt.
    if (model?.cacheRetention === "none") return "cold";

    const lastResponseAtMs = this.#lastResponseAtMs;
    if (lastResponseAtMs === undefined) return "unknown";

    const ttlMs = this.#anthropicTtlSeconds * 1000;
    const elapsedMs = this.#now() - lastResponseAtMs;
    if (elapsedMs < ttlMs + CACHE_EXPIRY_GRACE_MS) return "warm";

    const keepAliveEnabled = query.keepAliveEnabled ?? this.#keepAliveEnabled;
    if (keepAliveEnabled && !this.#keepAlivePingObserved) return "unknown";
    return "cold";
  }

  /**
   * Take the `/slots` baseline at `agent_settled`. This is not throttled by the
   * probe interval: it runs at most once per settled turn and records the
   * prompt size the next probe compares against.
   */
  async baselineLocal(model: CacheModelLike): Promise<CacheState> {
    if (modelKind(model) !== "local") return "unknown";
    const slots = await this.#fetchSlots(model);
    if (slots === undefined) {
      this.#localBaseline = undefined;
      this.#localState = "unknown";
      return "unknown";
    }
    const selected = selectBaselineSlot(slots);
    if (selected === undefined) {
      this.#localBaseline = undefined;
      this.#localState = "unknown";
      return "unknown";
    }
    this.#localBaseline = {
      id: selected.id,
      nPromptTokens: selected.nPromptTokens,
    };
    this.#localState = "warm";
    return "warm";
  }

  /**
   * Probe `/slots` from the input handler or the idle timer. At most one
   * network probe per 30 s; inside the window the cached result is returned
   * unchanged. A failed, malformed, or timed-out probe is `unknown`.
   */
  async probeLocal(model: CacheModelLike): Promise<CacheState> {
    if (modelKind(model) !== "local") return "unknown";

    const now = this.#now();
    if (
      this.#lastLocalProbeAtMs !== undefined &&
      now - this.#lastLocalProbeAtMs < LOCAL_PROBE_INTERVAL_MS
    ) {
      return this.#localState;
    }
    this.#lastLocalProbeAtMs = now;

    const baseline = this.#localBaseline;
    if (baseline === undefined) {
      this.#localState = "unknown";
      return "unknown";
    }

    const slots = await this.#fetchSlots(model);
    if (slots === undefined) {
      this.#localState = "unknown";
      return "unknown";
    }
    const slot = selectProbeSlot(slots, baseline);
    if (slot === undefined) {
      this.#localState = "unknown";
      return "unknown";
    }

    // INFERRED: another conversation reused the slot when it is no longer
    // processing and the prompt token count moved away from our baseline.
    this.#localState =
      !slot.isProcessing && slot.nPromptTokens !== baseline.nPromptTokens
        ? "cold"
        : "warm";
    return this.#localState;
  }

  /** Forget session timing/baselines (for example on a model change). */
  reset(): void {
    this.#lastResponseAtMs = undefined;
    this.#anthropicTtlSeconds = ANTHROPIC_CACHE_TTL_SECONDS;
    this.#keepAlivePingObserved = false;
    this.#localBaseline = undefined;
    this.#localState = "unknown";
    this.#lastLocalProbeAtMs = undefined;
  }

  async #fetchSlots(model: CacheModelLike): Promise<LocalSlot[] | undefined> {
    const origin = originOf(model.baseUrl);
    if (origin === undefined) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${origin}/slots`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return parseSlots(await response.json());
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convenience factory for callers that prefer not to use `new`. */
export function createCacheStateTracker(
  options: CacheStateOptions = {},
): CacheStateTracker {
  return new CacheStateTracker(options);
}
