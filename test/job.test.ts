import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@code-yeongyu/senpi";
import type { CacheRequestLike } from "../src/cache-state";
import {
  createEarlyCompactionExtension,
  type EarlyCompactionHandle,
  type ExtensionConfig,
} from "../src/extension";
import type { GenerateInput, GenerateOutcome } from "../src/generate";
import type { GateResult } from "../src/gate";
import {
  estimatePromptTokens,
  type JobCache,
  type JobContext,
  type JobMetricsWriter,
  type JobTimerHandle,
  type JobTimers,
} from "../src/job";
import type { MetricsEventName, MetricsFieldsFor } from "../src/metrics";
import type { ActivateResult, InstallOverrideResult } from "../src/override";
import { DEFAULTS, type CacheState, type PolicyConfig } from "../src/policy";
import type { PrepareSourceInput, PreparedSource } from "../src/prepare";
import { STATUS_KEY } from "../src/surface";

const TIMESTAMP = new Date(0).toISOString();
const SYSTEM_PROMPT = "system prompt";
const BASE_NOW = 1_000_000;

type ApplyOutcome = { applied: boolean; reason: "ok" | "stale" | "rejected" };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeUI {
  readonly status: Array<{ key: string; text: string | undefined }> = [];
  readonly notices: Array<{ message: string; type: string | undefined }> = [];

  setStatus(key: string, text: string | undefined): void {
    this.status.push({ key, text });
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notices.push({ message, type });
  }
}

class FakeMetrics implements JobMetricsWriter {
  readonly events: Array<{
    event: MetricsEventName;
    fields: Record<string, unknown>;
  }> = [];
  closed = false;

  write<E extends MetricsEventName>(event: E, fields: MetricsFieldsFor<E>): void {
    if (this.closed) throw new Error("metrics closed");
    this.events.push({
      event,
      fields: fields as unknown as Record<string, unknown>,
    });
  }

  close(): void {
    this.closed = true;
  }

  find(event: MetricsEventName): Array<{ event: MetricsEventName; fields: Record<string, unknown> }> {
    return this.events.filter((entry) => entry.event === event);
  }
}

interface FakeInterval {
  cb: () => void;
  ms: number;
  handle: JobTimerHandle;
  cleared: boolean;
}

interface FakeTimeout {
  cb: () => void;
  ms: number;
  handle: JobTimerHandle;
  cleared: boolean;
}

class FakeTimers implements JobTimers {
  readonly intervals: FakeInterval[] = [];
  readonly timeouts: FakeTimeout[] = [];

  #handle(): JobTimerHandle {
    return { unref: () => undefined };
  }

  setInterval(callback: () => void, ms: number): JobTimerHandle {
    const handle = this.#handle();
    this.intervals.push({ cb: callback, ms, handle, cleared: false });
    return handle;
  }

  clearInterval(handle: JobTimerHandle): void {
    const interval = this.intervals.find((entry) => entry.handle === handle);
    if (interval) interval.cleared = true;
  }

  setTimeout(callback: () => void, ms: number): JobTimerHandle {
    const handle = this.#handle();
    this.timeouts.push({ cb: callback, ms, handle, cleared: false });
    return handle;
  }

  clearTimeout(handle: JobTimerHandle): void {
    const timeout = this.timeouts.find((entry) => entry.handle === handle);
    if (timeout) timeout.cleared = true;
  }

  runIntervals(): void {
    for (const interval of [...this.intervals]) {
      if (!interval.cleared) interval.cb();
    }
  }

  runTimeouts(): void {
    for (const timeout of [...this.timeouts]) {
      if (timeout.cleared) continue;
      timeout.cleared = true;
      timeout.cb();
    }
  }
}

class FakeCache implements JobCache {
  stateValue: CacheState = "unknown";
  readonly calls: string[] = [];
  lastRequest: CacheRequestLike | undefined;

  state(): CacheState {
    this.calls.push("state");
    return this.stateValue;
  }

  async baselineLocal(): Promise<CacheState> {
    this.calls.push("baseline");
    return this.stateValue;
  }

  async probeLocal(): Promise<CacheState> {
    this.calls.push("probe");
    return this.stateValue;
  }

  observeRequest(request: CacheRequestLike): void {
    this.calls.push("request");
    this.lastRequest = request;
  }

  observeResponse(): void {
    this.calls.push("response");
  }

  observeMessageEnd(): boolean {
    this.calls.push("message");
    return true;
  }

  observeWarmPing(): void {
    this.calls.push("ping");
  }

  observeGoalCacheWarmEntry(): boolean {
    this.calls.push("goal");
    return true;
  }

  reset(): void {
    this.calls.push("reset");
  }

  setKeepAliveEnabled(): void {
    this.calls.push("keepalive");
  }
}

const MODEL = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.example.test/v1",
  cacheRetention: "short",
  contextWindow: 100_000,
  maxTokens: 8_192,
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

class FakeContext {
  usage: { tokens: number | null; contextWindow: number } = {
    tokens: 50_000,
    contextWindow: 100_000,
  };
  branch: SessionEntry[] = makeBranch();
  idle = true;
  pending = false;
  compacting = false;
  revision = 1;
  readonly settings = {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    speculativeEnabled: true,
    idleCompactionEnabled: true,
  };
  readonly model = MODEL;
  readonly modelRegistry = {
    find: () => undefined,
    getApiKeyAndHeaders: async () => ({ ok: false }),
    complete: async () => {
      throw new Error("the fake job test never calls the real generator");
    },
  };
  readonly sessionManager = {
    getBranch: () => {
      if (this.branchError) throw new Error("branch unavailable");
      return this.branch;
    },
    getSessionId: () => "session-1",
  };
  branchError = false;
  readonly agentDir = "C:/tmp/early-compaction-job-test";
  readonly hasUI = true;
  readonly mode = "tui";
  readonly ui = new FakeUI();
  readonly activityListeners: Array<(kind: "draft" | "prompt") => void> = [];
  activityUnsubscribed = false;

  readonly applyCalls: Array<{
    result: unknown;
    options: Record<string, unknown>;
  }> = [];
  applyOutcome: "ok" | "stale" | "rejected" = "ok";
  applyDeferred = false;
  #pendingApply: ((value: ApplyOutcome) => void) | undefined;

  isIdle(): boolean {
    return this.idle;
  }

  hasPendingMessages(): boolean {
    return this.pending;
  }

  isCompacting(): boolean {
    return this.compacting;
  }

  getMessageRevision(): number {
    return this.revision;
  }

  getContextUsage(): { tokens: number | null; contextWindow: number } {
    return this.usage;
  }

  getCompactionSettings(): typeof this.settings {
    return this.settings;
  }

  getCompactionModel(): undefined {
    return undefined;
  }

  getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  getPromptCacheKeepAliveSettings(): { enabled: boolean } {
    return { enabled: false };
  }

  onUserActivity(listener: (kind: "draft" | "prompt") => void): () => void {
    this.activityListeners.push(listener);
    return () => {
      this.activityUnsubscribed = true;
      const index = this.activityListeners.indexOf(listener);
      if (index >= 0) this.activityListeners.splice(index, 1);
    };
  }

  emitActivity(kind: "draft" | "prompt"): void {
    for (const listener of [...this.activityListeners]) listener(kind);
  }

  applyCompaction(result: unknown, options: unknown): Promise<ApplyOutcome> {
    this.applyCalls.push({ result, options: options as Record<string, unknown> });
    if (this.applyDeferred) {
      return new Promise<ApplyOutcome>((resolve) => {
        this.#pendingApply = resolve;
      });
    }
    return Promise.resolve(
      this.applyOutcome === "ok"
        ? { applied: true, reason: "ok" }
        : { applied: false, reason: this.applyOutcome },
    );
  }

  resolveApply(result: ApplyOutcome = { applied: true, reason: "ok" }): void {
    const resolve = this.#pendingApply;
    this.#pendingApply = undefined;
    resolve?.(result);
  }
}

class FakeBus {
  readonly handlers = new Map<string, Array<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    return () => {
      const current = this.handlers.get(channel) ?? [];
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
    };
  }

  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  readonly sessionKind = "interactive" as const;
  readonly handlers = new Map<string, Handler[]>();
  readonly onCalls: string[] = [];
  readonly commands: Array<{ name: string; options: unknown }> = [];
  readonly events = new FakeBus();

  constructor(private readonly lifecycle: string[]) {}

  on(event: string, handler: Handler): () => void {
    this.onCalls.push(event);
    this.lifecycle.push(`on:${event}`);
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) ?? [];
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
    };
  }

  registerCommand(name: string, options: unknown): void {
    this.commands.push({ name, options });
  }

  callHandler(event: string, payload: unknown, ctx: unknown): unknown {
    return this.handlers.get(event)?.[0]?.(payload, ctx);
  }

  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      result = await handler(payload, ctx);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  stopReason?: string,
): SessionEntry {
  return {
    id,
    parentId,
    timestamp: TIMESTAMP,
    type: "message",
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: 0,
      ...(stopReason === undefined ? {} : { stopReason }),
    },
  } as unknown as SessionEntry;
}

function makeBranch(): SessionEntry[] {
  return [
    message("u1", null, "user", "u".repeat(8_000)),
    message("a1", "u1", "assistant", "first answer"),
    message("u2", "a1", "user", "recent request"),
    message("a2", "u2", "assistant", "done", "stop"),
  ];
}

function preparedSource(tokensBefore = 50_000): PreparedSource {
  return {
    spanMessages: [
      {
        role: "user",
        content: [{ type: "text", text: "u".repeat(8_000) }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        timestamp: 0,
      },
    ] as unknown as PreparedSource["spanMessages"],
    firstKeptEntryId: "u2",
    tokensBefore,
    firstSpanEntryId: "u1",
    lastSpanEntryId: "a1",
    isSplitTurn: false,
    keepRecentEff: 1_024,
  };
}

function okOutcome(tokensBefore = 50_000, estimatedAfter = 20_000): GenerateOutcome {
  return {
    status: "ok",
    result: {
      summary: "SUMMARY",
      firstKeptEntryId: "u2",
      tokensBefore,
      estimatedTokensAfter: estimatedAfter,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      details: {
        schema: "senpi.compaction.summary.v1",
        origin: "piomo.early-compaction",
        earlyCompaction: {
          v: 1,
          kind: "notes",
          notesBlocks: 1,
          jobId: "generated",
        },
      },
    },
  };
}

function deferredGenerate(): {
  fn: (input: GenerateInput) => Promise<GenerateOutcome>;
  resolve: (outcome: GenerateOutcome) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (outcome: GenerateOutcome) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  return {
    fn: () =>
      new Promise<GenerateOutcome>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
    resolve: (outcome) => resolve(outcome),
    reject: (error) => reject(error),
  };
}

function makeConfig(
  mode: ExtensionConfig["mode"] = "notes",
  policy: Partial<PolicyConfig> = {},
): ExtensionConfig {
  return {
    mode,
    policy: { ...DEFAULTS, startJitterMaxMs: 0, ...policy },
    allowRpcInteractive: false,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  gate?: GateResult;
  activation?: ActivateResult;
  install?: InstallOverrideResult;
  config?: ExtensionConfig;
  policy?: Partial<PolicyConfig>;
  generate?: (input: GenerateInput) => Promise<GenerateOutcome>;
  prepare?: (input: PrepareSourceInput) => PreparedSource | null;
  createCache?: (now: () => number) => JobCache;
  random?: () => number;
}

interface Harness {
  pi: FakePi;
  ctx: FakeContext;
  metrics: FakeMetrics;
  timers: FakeTimers;
  cache: FakeCache;
  handle: EarlyCompactionHandle;
  lifecycle: string[];
  activateCalls: unknown[];
  deactivateCalls: unknown[];
  generateCalls: GenerateInput[];
  prepareCalls: PrepareSourceInput[];
  advance(ms: number): void;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const lifecycle: string[] = [];
  const pi = new FakePi(lifecycle);
  const ctx = new FakeContext();
  const metrics = new FakeMetrics();
  const timers = new FakeTimers();
  const cache = new FakeCache();
  const activateCalls: unknown[] = [];
  const deactivateCalls: unknown[] = [];
  const generateCalls: GenerateInput[] = [];
  const prepareCalls: PrepareSourceInput[] = [];
  let nowMs = BASE_NOW;
  const now = () => nowMs;
  const config = options.config ?? makeConfig("notes", options.policy ?? {});
  const generate = options.generate ?? (async () => okOutcome());
  const prepare = options.prepare ?? (() => preparedSource());
  const install = options.install ?? { state: "installed" as const };
  const activation = options.activation ?? { state: "active" as const };

  const handle = createEarlyCompactionExtension(pi as unknown as ExtensionAPI, {
    installOverride: () => {
      lifecycle.push("install");
      return install;
    },
    gate: () => options.gate ?? { state: "active" },
    activateOverride: (sessionManager) => {
      activateCalls.push(sessionManager);
      return activation;
    },
    deactivateOverride: (sessionManager) => {
      deactivateCalls.push(sessionManager);
    },
    createMetrics: () => metrics,
    createCache: options.createCache ?? (() => cache),
    config,
    now,
    random: options.random ?? (() => 0),
    timers,
    prepare: (input) => {
      prepareCalls.push(input);
      return prepare(input);
    },
    generate: (input) => {
      generateCalls.push(input);
      return generate(input);
    },
  });

  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

  return {
    pi,
    ctx,
    metrics,
    timers,
    cache,
    handle,
    lifecycle,
    activateCalls,
    deactivateCalls,
    generateCalls,
    prepareCalls,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function startReady(h: Harness, usage?: number): Promise<void> {
  if (usage !== undefined) h.ctx.usage.tokens = usage;
  const returned = h.pi.callHandler("turn_end", { type: "turn_end" }, h.ctx);
  expect(returned).toBeUndefined();
  await flush();
  expect(h.handle.getSession()?.phase).toBe("READY");
}

async function settle(h: Harness): Promise<void> {
  await h.pi.emit("agent_settled", { type: "agent_settled" }, h.ctx);
  await flush();
}

function lastDiscard(h: Harness): Record<string, unknown> | undefined {
  return h.metrics.find("discard").at(-1)?.fields;
}

function lastApply(h: Harness): Record<string, unknown> | undefined {
  return h.metrics.find("apply").at(-1)?.fields;
}

function footerTexts(h: Harness): (string | undefined)[] {
  return h.ctx.ui.status.filter((call) => call.key === STATUS_KEY).map((call) => call.text);
}

function generatedKinds(h: Harness): string[] {
  return h.generateCalls.map((call) => call.kind);
}

// ---------------------------------------------------------------------------
// Compile-time contract: the real ExtensionContext fits the handlers' type.
// ---------------------------------------------------------------------------

function acceptsJobContext(_ctx: JobContext): void {}
function acceptsRealExtensionContext(ctx: ExtensionContext): void {
  acceptsJobContext(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("load and session wiring", () => {
  test("installOverride runs before handlers; an active session opens the surface, metrics, timer and activity", async () => {
    const h = await makeHarness();

    expect(h.lifecycle[0]).toBe("install");
    expect(h.lifecycle.slice(1).every((entry) => entry.startsWith("on:"))).toBe(true);
    expect(h.lifecycle[1]).toBe("on:session_start");
    expect(h.metrics.find("gate").at(-1)?.fields).toEqual({
      state: "active",
      reason: "ok",
    });
    expect(h.metrics.find("override").at(-1)?.fields).toEqual({
      state: "installed",
    });
    expect(h.timers.intervals).toHaveLength(1);
    expect(h.timers.intervals[0].ms).toBe(30_000);
    expect(h.ctx.activityListeners).toHaveLength(1);
    expect(h.activateCalls).toHaveLength(1);
    expect(h.ctx.ui.status[0]).toEqual({
      key: "early-compaction",
      text: "EC 대기",
    });
    expect(h.pi.commands.map((command) => command.name)).toContain(
      "early-compaction",
    );
  });

  test("a silent dormant gate installs nothing, starts no timer and makes no UI call", async () => {
    const h = await makeHarness({ gate: { state: "dormant", reason: "mode" } });

    expect(h.activateCalls).toHaveLength(0);
    expect(h.timers.intervals).toHaveLength(0);
    expect(h.ctx.activityListeners).toHaveLength(0);
    expect(h.ctx.ui.status).toHaveLength(0);
    expect(h.ctx.ui.notices).toHaveLength(0);
    expect(h.metrics.find("gate").at(-1)?.fields).toEqual({
      state: "dormant",
      reason: "mode",
    });
  });

  test("a failed override self-test becomes dormant(capability) with one warning", async () => {
    const h = await makeHarness({
      activation: { state: "dormant", reason: "capability" },
    });

    expect(h.activateCalls).toHaveLength(1);
    expect(h.timers.intervals).toHaveLength(0);
    expect(h.metrics.find("gate").at(-1)?.fields).toEqual({
      state: "dormant",
      reason: "capability",
    });
    expect(h.metrics.find("override").at(-1)?.fields).toEqual({
      state: "self-test-failed",
    });
    expect(h.ctx.ui.status.at(-1)?.text).toBe("EC 꺼짐(capability)");
    expect(h.ctx.ui.notices).toHaveLength(1);
    expect(h.ctx.ui.notices[0].type).toBe("warning");
  });
});

describe("job state machine", () => {
  test("EMPTY -> GENERATING -> READY -> APPLYING -> EMPTY", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    h.ctx.applyDeferred = true;

    expect(h.handle.getSession()?.phase).toBe("EMPTY");
    const returned = h.pi.callHandler("turn_end", { type: "turn_end" }, h.ctx);
    expect(returned).toBeUndefined();
    expect(h.handle.getSession()?.phase).toBe("GENERATING");
    expect(h.generateCalls).toHaveLength(1);

    await flush();
    expect(h.handle.getSession()?.phase).toBe("READY");
    expect(h.ctx.ui.status.map((entry) => entry.text)).toContain("EC 준비중");
    expect(h.ctx.ui.status.at(-1)?.text).toBe("EC 준비됨 -30k");

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(1);
    expect(h.handle.getSession()?.phase).toBe("APPLYING");

    h.ctx.resolveApply({ applied: true, reason: "ok" });
    await flush();
    expect(h.handle.getSession()?.phase).toBe("EMPTY");
    expect(h.ctx.ui.status.at(-1)?.text).toBe("EC 대기");
    expect(h.ctx.ui.notices.at(-1)?.message).toContain("조기 요약 적용");
    expect(lastApply(h)?.result).toBe("ok");
    expect(lastApply(h)?.route).toBe("cold");
  });

  test("one job at a time; generation is never awaited by an event handler", async () => {
    const gen = deferredGenerate();
    const h = await makeHarness({ generate: gen.fn });

    const returned = h.pi.callHandler("turn_end", { type: "turn_end" }, h.ctx);
    expect(returned).toBeUndefined();
    expect(h.generateCalls).toHaveLength(1);
    expect(h.handle.getSession()?.phase).toBe("GENERATING");

    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.generateCalls).toHaveLength(1);

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("GENERATING");

    gen.resolve(okOutcome());
    await flush();
    expect(h.handle.getSession()?.phase).toBe("READY");

    h.cache.stateValue = "cold";
    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(1);
  });

  test("generation failure, skip and abort return to EMPTY with a job_end", async () => {
    const cases: Array<{
      outcome: GenerateOutcome;
      outcomeName: string;
      reason: string;
      failures: number;
      footer: string;
    }> = [
      {
        outcome: { status: "failed", reason: "auth" },
        outcomeName: "failed",
        reason: "auth",
        failures: 1,
        footer: "EC 실패(인증)",
      },
      {
        outcome: { status: "skipped", reason: "model-unresolved" },
        outcomeName: "skipped",
        reason: "model-unresolved",
        failures: 0,
        footer: "EC 대기",
      },
      {
        outcome: { status: "aborted" },
        outcomeName: "aborted",
        reason: "aborted",
        failures: 1,
        footer: "EC 실패(중단)",
      },
      {
        outcome: { status: "failed", reason: "empty" },
        outcomeName: "failed",
        reason: "failed",
        failures: 1,
        footer: "EC 실패(오류)",
      },
    ];

    for (const testCase of cases) {
      const h = await makeHarness({ generate: async () => testCase.outcome });
      await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
      await flush();

      expect(h.handle.getSession()?.phase).toBe("EMPTY");
      expect(h.handle.getSession()?.consecutiveFailures).toBe(testCase.failures);
      const jobEnd = h.metrics.find("job_end").at(-1);
      expect(jobEnd?.fields.outcome).toBe(testCase.outcomeName);
      expect(jobEnd?.fields.reason).toBe(testCase.reason);
      expect(footerTexts(h).at(-1)).toBe(testCase.footer);
      if (testCase.outcomeName === "skipped") {
        expect(
          h.ctx.ui.notices.some((notice) =>
            notice.message.includes("model registry"),
          ),
        ).toBe(true);
      }
    }
  });

  test("a truncated summary rewrite retries once as notes in the same slot, then holds rewrites off", async () => {
    let previousSummary = "PREVIOUS SUMMARY";
    const h = await makeHarness({
      policy: { consolidateSummaryTokens: 1 },
      prepare: () => ({ ...preparedSource(), previousSummary }),
      generate: async (input) =>
        input.kind === "rewrite-consolidate"
          ? { status: "failed", reason: "truncated" }
          : okOutcome(),
    });

    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    await flush();
    await flush();

    expect(generatedKinds(h)).toEqual(["rewrite-consolidate", "notes"]);
    expect(h.generateCalls[1].source).toBe(h.generateCalls[0].source);
    expect(h.handle.getSession()?.phase).toBe("READY");
    expect(h.handle.getSession()?.consecutiveFailures).toBe(0);
    expect(h.metrics.find("job_start").map((entry) => entry.fields.kind)).toEqual([
      "rewrite-consolidate",
      "notes",
    ]);
    expect(
      h.metrics.find("job_end").map((entry) => `${entry.fields.outcome}/${entry.fields.reason}`),
    ).toEqual(["failed/truncated", "ready/ok"]);
    expect(footerTexts(h).slice(-3)).toEqual([
      "EC 준비중",
      "EC 재시도중(잘림)",
      "EC 준비됨 -30k",
    ]);

    // Same-sized summary: the known-truncating rewrite is skipped.
    h.cache.stateValue = "cold";
    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(1);
    h.ctx.usage.tokens = 80_000;
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    await flush();
    expect(generatedKinds(h)).toEqual(["rewrite-consolidate", "notes", "notes"]);

    // A builtin compaction replaces the summary with a smaller one: rewrites may run again.
    await h.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", reason: "threshold" },
      h.ctx,
    );
    expect(h.handle.getSession()?.phase).toBe("EMPTY");
    h.advance(61_000);
    previousSummary = "S";
    h.ctx.usage.tokens = 95_000;
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    await flush();
    await flush();
    expect(generatedKinds(h)).toEqual([
      "rewrite-consolidate",
      "notes",
      "notes",
      "rewrite-consolidate",
      "notes",
    ]);
  });

  test("a failed notes fallback counts one failure; a first rewrite never falls back", async () => {
    const fallback = await makeHarness({
      policy: { consolidateSummaryTokens: 1 },
      prepare: () => ({ ...preparedSource(), previousSummary: "PREVIOUS SUMMARY" }),
      generate: async () => ({ status: "failed", reason: "truncated" }),
    });
    await fallback.pi.emit("turn_end", { type: "turn_end" }, fallback.ctx);
    await flush();
    await flush();

    expect(generatedKinds(fallback)).toEqual(["rewrite-consolidate", "notes"]);
    expect(fallback.handle.getSession()?.phase).toBe("EMPTY");
    expect(fallback.handle.getSession()?.consecutiveFailures).toBe(1);
    expect(footerTexts(fallback).at(-1)).toBe("EC 실패(잘림)");

    const first = await makeHarness({
      generate: async () => ({ status: "failed", reason: "truncated" }),
    });
    await first.pi.emit("turn_end", { type: "turn_end" }, first.ctx);
    await flush();
    await flush();

    expect(generatedKinds(first)).toEqual(["rewrite-first"]);
    expect(first.handle.getSession()?.consecutiveFailures).toBe(1);
    expect(footerTexts(first).at(-1)).toBe("EC 실패(잘림)");
  });

  test("start jitter delays the generation and the delayed start is re-checked", async () => {
    const h = await makeHarness({
      policy: { startJitterMaxMs: 1_000 },
      random: () => 0.5,
    });

    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.generateCalls).toHaveLength(0);
    expect(h.timers.timeouts).toHaveLength(1);
    expect(h.timers.timeouts[0].ms).toBe(500);

    h.timers.runTimeouts();
    expect(h.generateCalls).toHaveLength(1);
    await flush();
    expect(h.handle.getSession()?.phase).toBe("READY");
  });

  test("a throw in the generation continuation clears the job and records a discard", async () => {
    const gen = deferredGenerate();
    const h = await makeHarness({ generate: gen.fn });
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.handle.getSession()?.phase).toBe("GENERATING");

    h.ctx.branchError = true;
    gen.resolve(okOutcome());
    await flush();

    expect(h.handle.getSession()?.phase).toBe("EMPTY");
    expect(lastDiscard(h)?.reason).toBe("stale");
    expect(h.ctx.applyCalls).toHaveLength(0);
  });

  test("threshold_cross is recorded once per crossing", async () => {
    const h = await makeHarness();
    h.ctx.usage.tokens = 61_000;

    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.metrics.find("threshold_cross")).toHaveLength(1);

    h.ctx.usage.tokens = 59_000;
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    h.ctx.usage.tokens = 61_000;
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.metrics.find("threshold_cross")).toHaveLength(2);
  });
});

describe("apply", () => {
  test("apply options carry the warm anchor and expectedRevision and no signal", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    h.ctx.revision = 42;
    await startReady(h);
    await settle(h);

    expect(h.ctx.applyCalls).toHaveLength(1);
    const options = h.ctx.applyCalls[0].options;
    expect(options).toEqual({
      reason: "extension",
      expectedRevision: 42,
      expectedWarmAnchor: {
        firstKeptEntryId: "u2",
        prefixEntryIds: ["u1", "a1"],
        latestCompactionEntryId: null,
      },
    });
    expect(Object.keys(options).sort()).toEqual([
      "expectedRevision",
      "expectedWarmAnchor",
      "reason",
    ]);
    expect("signal" in options).toBe(false);
  });

  test("a stale or rejected apply discards and starts a cooldown", async () => {
    for (const outcome of ["stale", "rejected"] as const) {
      const h = await makeHarness();
      h.cache.stateValue = "cold";
      h.ctx.applyOutcome = outcome;
      await startReady(h);
      await settle(h);

      const snapshot = h.handle.getSession();
      expect(snapshot?.phase).toBe("EMPTY");
      expect(snapshot?.consecutiveFailures).toBe(1);
      expect(snapshot?.cooldownUntil).toBe(BASE_NOW + 60_000);
      expect(lastApply(h)?.result).toBe(outcome);
      expect(lastDiscard(h)?.reason).toBe(
        outcome === "stale" ? "stale" : "apply-rejected",
      );
    }
  });

  test("agent_settled applies the boundary route after a normal run", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "warm";
    await startReady(h);
    await h.pi.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
        aborted: false,
        willRetry: false,
      },
      h.ctx,
    );
    await settle(h);

    expect(h.ctx.applyCalls).toHaveLength(1);
    expect(lastApply(h)?.route).toBe("boundary");
    expect(lastApply(h)?.site).toBe("agent_settled");
  });

  test("an own rejected session_compact during APPLYING is not recorded as builtin", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    h.ctx.applyDeferred = true;
    await startReady(h);
    await settle(h);
    expect(h.handle.getSession()?.phase).toBe("APPLYING");

    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: false,
        reason: "extension",
        requestId: "r1",
      },
      h.ctx,
    );
    expect(h.metrics.find("builtin_compact")).toHaveLength(0);
    expect(h.metrics.find("discard")).toHaveLength(0);

    h.ctx.resolveApply({ applied: false, reason: "rejected" });
    await flush();
    expect(lastApply(h)?.result).toBe("rejected");
    expect(lastDiscard(h)?.reason).toBe("apply-rejected");
    expect(h.handle.getSession()?.phase).toBe("EMPTY");
  });

  test("an aborted run does not earn the boundary route", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "warm";
    await startReady(h);
    await h.pi.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
        aborted: true,
        willRetry: false,
      },
      h.ctx,
    );
    await settle(h);

    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("READY");
  });

  test("the idle timer applies cold/threshold only and respects the draft hold", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);

    h.ctx.emitActivity("draft");
    h.timers.runIntervals();
    await flush();
    expect(h.ctx.applyCalls).toHaveLength(0);

    h.advance(30_001);
    h.timers.runIntervals();
    await flush();
    expect(h.ctx.applyCalls).toHaveLength(1);
    expect(lastApply(h)?.route).toBe("cold");
    expect(lastApply(h)?.site).toBe("timer");
  });

  test("the idle timer does not apply a boundary route", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "warm";
    await startReady(h);
    await h.pi.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
        aborted: false,
        willRetry: false,
      },
      h.ctx,
    );

    h.timers.runIntervals();
    await flush();
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("READY");
  });

  test("compacting and pending messages block the apply", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);

    h.ctx.compacting = true;
    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("READY");

    h.ctx.compacting = false;
    h.ctx.pending = true;
    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("READY");
  });

  test("no apply while the session is not idle", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);
    h.ctx.idle = false;

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(h.handle.getSession()?.phase).toBe("READY");
  });

  test("the input seam uses the submitted prompt tokens for the threshold", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "unknown";
    await startReady(h, 59_000);

    h.ctx.emitActivity("prompt");
    await h.pi.emit(
      "input",
      {
        type: "input",
        inputId: "i1",
        text: "hi",
        source: "interactive",
      },
      h.ctx,
    );
    expect(h.ctx.applyCalls).toHaveLength(0);

    const longPrompt = "x".repeat(8_000);
    expect(estimatePromptTokens(longPrompt)).toBeGreaterThan(1_000);
    await h.pi.emit(
      "input",
      {
        type: "input",
        inputId: "i2",
        text: longPrompt,
        source: "interactive",
      },
      h.ctx,
    );

    expect(h.ctx.applyCalls).toHaveLength(1);
    expect(lastApply(h)?.route).toBe("threshold");
    expect(lastApply(h)?.site).toBe("input");
  });
});

describe("discard paths", () => {
  test("a foreign session_compact during GENERATING aborts and no apply follows", async () => {
    const gen = deferredGenerate();
    const h = await makeHarness({ generate: gen.fn });
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.handle.getSession()?.phase).toBe("GENERATING");
    const signal = h.generateCalls[0].signal;
    expect(signal).toBeDefined();

    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: true,
        reason: "threshold",
        requestId: "r1",
        compactionEntry: {
          id: "c1",
          summary: "S",
          tokensBefore: 40_000,
          details: {
            structuralYield: { savedTokens: 10_000, savingsRatio: 0.25 },
          },
        },
      },
      h.ctx,
    );

    expect(signal?.aborted).toBe(true);
    expect(h.handle.getSession()?.phase).toBe("EMPTY");
    expect(h.metrics.find("builtin_compact")).toHaveLength(1);
    expect(lastDiscard(h)?.reason).toBe("builtin-compact");

    gen.resolve(okOutcome());
    await flush();
    expect(h.ctx.applyCalls).toHaveLength(0);
  });

  test("session_before_compact, session_tree and model_select discard a READY job", async () => {
    const cases: Array<{ event: string; payload: unknown; reason: string }> = [
      {
        event: "session_before_compact",
        payload: { type: "session_before_compact", reason: "threshold" },
        reason: "session-before-compact",
      },
      {
        event: "session_tree",
        payload: { type: "session_tree", newLeafId: null, oldLeafId: null },
        reason: "session-tree",
      },
      {
        event: "model_select",
        payload: { type: "model_select", model: MODEL, source: "set" },
        reason: "model-select",
      },
    ];

    for (const testCase of cases) {
      const h = await makeHarness();
      h.cache.stateValue = "cold";
      await startReady(h);
      await h.pi.emit(testCase.event, testCase.payload, h.ctx);

      expect(h.handle.getSession()?.phase).toBe("EMPTY");
      expect(lastDiscard(h)?.reason).toBe(testCase.reason);
      expect(h.ctx.applyCalls).toHaveLength(0);
    }
  });

  test("session_before_compact always returns undefined", async () => {
    const h = await makeHarness();
    const result = await h.pi.emit(
      "session_before_compact",
      { type: "session_before_compact", reason: "threshold" },
      h.ctx,
    );
    expect(result).toBeUndefined();
  });

  test("a context_edit after READY discards before apply", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);
    h.ctx.branch.push({
      id: "e5",
      parentId: "a2",
      timestamp: TIMESTAMP,
      type: "context_edit",
      targetId: "u1",
      replacement: null,
    } as unknown as SessionEntry);

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(lastDiscard(h)?.reason).toBe("context-edit");
    expect(h.handle.getSession()?.phase).toBe("EMPTY");
  });

  test("a rewritten prefix is a fingerprint mismatch", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);
    const target = h.ctx.branch[0] as unknown as {
      message: { content: Array<{ text: string }> };
    };
    target.message.content[0].text = "rewritten prefix";

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(lastDiscard(h)?.reason).toBe("fingerprint-mismatch");
  });

  test("READY staleness discards before apply", async () => {
    const h = await makeHarness();
    h.cache.stateValue = "cold";
    await startReady(h);
    h.ctx.usage.tokens = 60_001;

    await settle(h);
    expect(h.ctx.applyCalls).toHaveLength(0);
    expect(lastDiscard(h)?.reason).toBe("stale");
  });

  test("retired timers and continuations do nothing", async () => {
    const gen = deferredGenerate();
    const h = await makeHarness({ generate: gen.fn });
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    expect(h.handle.getSession()?.phase).toBe("GENERATING");

    await h.pi.emit(
      "session_shutdown",
      { type: "session_shutdown", reason: "reload" },
      h.ctx,
    );
    const countAfterShutdown = h.metrics.events.length;
    expect(h.timers.intervals[0]?.cleared).toBe(true);
    expect(h.ctx.activityUnsubscribed).toBe(true);
    expect(h.deactivateCalls).toHaveLength(1);
    expect(h.metrics.closed).toBe(true);
    expect(h.ctx.ui.status.at(-1)?.text).toBeUndefined();

    // Even if a stale timer callback is invoked directly, it is fenced.
    h.timers.intervals[0]?.cb();
    gen.resolve(okOutcome());
    await flush();

    expect(h.metrics.events.length).toBe(countAfterShutdown);
    expect(h.ctx.applyCalls).toHaveLength(0);
  });
});

describe("compaction bookkeeping", () => {
  test("lastYield mirrors accepted structuralYield and T follows it", async () => {
    const h = await makeHarness();

    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: true,
        reason: "threshold",
        requestId: "r1",
        compactionEntry: {
          id: "c1",
          summary: "S",
          tokensBefore: 80_000,
          details: {
            structuralYield: { savedTokens: 45_000, savingsRatio: 0.5625 },
          },
        },
      },
      h.ctx,
    );
    expect(h.handle.getSession()?.lastYield).toEqual({
      savedTokens: 45_000,
      tokensBefore: 80_000,
    });

    h.ctx.usage.tokens = 56_000;
    await h.pi.emit("turn_end", { type: "turn_end" }, h.ctx);
    const crossings = h.metrics.find("threshold_cross");
    expect(
      crossings.some(
        (crossing) =>
          crossing.fields.U === 56_000 && crossing.fields.T === 55_000,
      ),
    ).toBe(true);

    // A compaction without structuralYield leaves lastYield unchanged.
    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: true,
        reason: "threshold",
        requestId: "r2",
        compactionEntry: { id: "c2", summary: "S2", tokensBefore: 40_000 },
      },
      h.ctx,
    );
    expect(h.handle.getSession()?.lastYield).toEqual({
      savedTokens: 45_000,
      tokensBefore: 80_000,
    });
    expect(h.metrics.find("builtin_compact")).toHaveLength(2);

    // Rejected foreign compactions are still recorded.
    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: false,
        reason: "manual",
        requestId: "r3",
      },
      h.ctx,
    );
    const builtin = h.metrics.find("builtin_compact");
    expect(builtin).toHaveLength(3);
    expect(builtin[2].fields.tokensBefore).toBe(0);
    expect(builtin[2].fields.compactionEntryId).toBe("");
  });

  test("next_usage is recorded for the first provider usage after a compaction", async () => {
    const h = await makeHarness();
    await h.pi.emit(
      "session_compact",
      {
        type: "session_compact",
        accepted: true,
        reason: "threshold",
        requestId: "r1",
        compactionEntry: {
          id: "c1",
          summary: "S",
          tokensBefore: 40_000,
          details: {
            structuralYield: { savedTokens: 10_000, savingsRatio: 0.25 },
          },
        },
      },
      h.ctx,
    );

    const usageMessage = {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      usage: {
        input: 11,
        output: 2,
        cacheRead: 7,
        cacheWrite: 3,
        totalTokens: 23,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const systemHash = createHash("sha256")
      .update(SYSTEM_PROMPT)
      .digest("hex")
      .slice(0, 12);

    await h.pi.emit(
      "message_end",
      { type: "message_end", message: usageMessage },
      h.ctx,
    );
    const first = h.metrics.find("next_usage");
    expect(first).toHaveLength(1);
    expect(first[0].fields).toEqual({
      input: 11,
      cacheRead: 7,
      cacheWrite: 3,
      systemHash,
    });

    await h.pi.emit(
      "message_end",
      { type: "message_end", message: usageMessage },
      h.ctx,
    );
    expect(h.metrics.find("next_usage")).toHaveLength(1);
  });

  test("before_provider_request forwards and always returns undefined", async () => {
    const h = await makeHarness();
    const result = await h.pi.emit(
      "before_provider_request",
      {
        type: "before_provider_request",
        payload: { messages: [] },
        model: MODEL,
      },
      h.ctx,
    );

    expect(result).toBeUndefined();
    expect(h.cache.lastRequest?.payload).toEqual({ messages: [] });
    expect(h.cache.calls).toContain("request");
  });
});

test("the real ExtensionContext fits the handlers' JobContext", () => {
  expect(typeof acceptsRealExtensionContext).toBe("function");
});
