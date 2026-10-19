import { afterEach, describe, expect, test } from "bun:test";
import {
  ANTHROPIC_CACHE_TTL_SECONDS,
  ANTHROPIC_LONG_CACHE_TTL_SECONDS,
  CACHE_EXPIRY_GRACE_MS,
  CACHE_WARM_PING_EVENT,
  GOAL_CACHE_WARMUP_ENTRY_TYPE,
  LOCAL_PROBE_INTERVAL_MS,
  LOCAL_PROBE_TIMEOUT_MS,
  createCacheStateTracker,
  type CacheModelLike,
} from "../src/cache-state";

const ANTHROPIC: CacheModelLike = {
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  cacheRetention: "short",
};

const SHORT_PAYLOAD = {
  model: "claude-sonnet-4-5",
  system: [
    {
      type: "text",
      text: "system",
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [],
};

const LONG_PAYLOAD = {
  model: "claude-sonnet-4-5",
  system: [
    {
      type: "text",
      text: "system",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    {
      type: "tool",
      name: "read",
      cache_control: null,
    },
  ],
  messages: [],
};

function mutableClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    set: (ms) => {
      value = ms;
    },
  };
}

interface SlotsHarness {
  readonly baseUrl: string;
  readonly requests: number;
  readonly methods: string[];
  readonly paths: string[];
  setSlots: (body: unknown) => void;
  setStatus: (status: number) => void;
  setHang: (hang: boolean) => void;
}

const serverStops: Array<() => void> = [];

afterEach(() => {
  while (serverStops.length > 0) {
    const stop = serverStops.pop();
    stop?.();
  }
});

function startSlotsHarness(initial: unknown): SlotsHarness {
  let slots = initial;
  let status = 200;
  let hang = false;
  let requests = 0;
  const methods: string[] = [];
  const paths: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests += 1;
      methods.push(request.method);
      paths.push(new URL(request.url).pathname);
      if (hang) return new Promise<Response>(() => {});
      if (status !== 200) return new Response("probe failed", { status });
      return Response.json(slots);
    },
  });
  serverStops.push(() => server.stop(true));

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    get requests() {
      return requests;
    },
    get methods() {
      return methods;
    },
    get paths() {
      return paths;
    },
    setSlots(next) {
      slots = next;
    },
    setStatus(next) {
      status = next;
    },
    setHang(next) {
      hang = next;
    },
  };
}

function slot(nPromptTokens: number, isProcessing = false): unknown {
  return {
    id: 0,
    n_ctx: 65_536,
    is_processing: isProcessing,
    n_prompt_tokens: nPromptTokens,
  };
}

describe("Anthropic prompt-cache TTL", () => {
  test("short retention is warm until ttl+30s and cold at/after it", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: SHORT_PAYLOAD, model: ANTHROPIC });
    expect(tracker.state(ANTHROPIC)).toBe("unknown");
    tracker.observeResponse();

    const edge = (ANTHROPIC_CACHE_TTL_SECONDS * 1000) + CACHE_EXPIRY_GRACE_MS;
    clock.set(edge - 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");

    clock.set(edge);
    expect(tracker.state(ANTHROPIC)).toBe("cold");

    clock.set(edge + 1);
    expect(tracker.state(ANTHROPIC)).toBe("cold");
  });

  test("a cache_control breakpoint with ttl 1h uses 3600s", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: LONG_PAYLOAD, model: ANTHROPIC });
    tracker.observeResponse();

    // Well past the 300s short TTL, still warm under long retention.
    clock.set(ANTHROPIC_CACHE_TTL_SECONDS * 1000 + CACHE_EXPIRY_GRACE_MS + 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");

    const edge = (ANTHROPIC_LONG_CACHE_TTL_SECONDS * 1000) + CACHE_EXPIRY_GRACE_MS;
    clock.set(edge - 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");
    clock.set(edge);
    expect(tracker.state(ANTHROPIC)).toBe("cold");
  });

  test("retention none is always cold", () => {
    const none: CacheModelLike = { ...ANTHROPIC, cacheRetention: "none" };
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    expect(tracker.state(none)).toBe("cold");
    tracker.observeRequest({ payload: LONG_PAYLOAD, model: none });
    tracker.observeResponse();
    expect(tracker.state(none)).toBe("cold");
  });

  test("an assistant message_end with usage refreshes the timer", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: SHORT_PAYLOAD, model: ANTHROPIC });
    expect(tracker.observeMessageEnd({ role: "user", content: "hello" })).toBe(false);
    expect(tracker.observeMessageEnd({ role: "assistant", content: [] })).toBe(false);
    expect(
      tracker.observeMessageEnd({
        role: "assistant",
        content: [],
        usage: { input: 10, output: 2 },
      }),
    ).toBe(true);

    clock.set(ANTHROPIC_CACHE_TTL_SECONDS * 1000 + CACHE_EXPIRY_GRACE_MS - 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");
  });

  test("other providers and unknown models return unknown", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });
    const openai: CacheModelLike = {
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };

    tracker.observeRequest({ payload: LONG_PAYLOAD, model: openai });
    tracker.observeResponse();
    clock.set(10 * ANTHROPIC_LONG_CACHE_TTL_SECONDS * 1000);
    expect(tracker.state(openai)).toBe("unknown");
    expect(tracker.state(undefined)).toBe("unknown");
  });
});

describe("warm refreshes", () => {
  test("the keep-alive ping event restarts the TTL", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: SHORT_PAYLOAD, model: ANTHROPIC });
    tracker.observeResponse();
    const edge = (ANTHROPIC_CACHE_TTL_SECONDS * 1000) + CACHE_EXPIRY_GRACE_MS;

    clock.set(edge);
    expect(tracker.state(ANTHROPIC)).toBe("cold");

    tracker.observeWarmPing();
    expect(tracker.state(ANTHROPIC)).toBe("warm");

    clock.set(edge * 2 - 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");
    clock.set(edge * 2);
    expect(tracker.state(ANTHROPIC)).toBe("cold");
  });

  test("a goal cache-warm entry restarts the TTL", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: SHORT_PAYLOAD, model: ANTHROPIC });
    tracker.observeResponse();
    const edge = (ANTHROPIC_CACHE_TTL_SECONDS * 1000) + CACHE_EXPIRY_GRACE_MS;
    clock.set(edge);
    expect(tracker.state(ANTHROPIC)).toBe("cold");

    expect(
      tracker.observeGoalCacheWarmEntry({
        type: "custom",
        customType: "another-entry",
        data: { phase: "scheduled" },
      }),
    ).toBe(false);
    expect(tracker.state(ANTHROPIC)).toBe("cold");

    expect(
      tracker.observeGoalCacheWarmEntry({
        type: "custom",
        customType: GOAL_CACHE_WARMUP_ENTRY_TYPE,
        data: { phase: "scheduled" },
      }),
    ).toBe(true);
    expect(tracker.state(ANTHROPIC)).toBe("warm");

    clock.set(edge * 2 - 1);
    expect(tracker.state(ANTHROPIC)).toBe("warm");
    clock.set(edge * 2);
    expect(tracker.state(ANTHROPIC)).toBe("cold");
  });

  test("keep-alive enabled without an observable ping is unknown, not cold", () => {
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    tracker.observeRequest({ payload: SHORT_PAYLOAD, model: ANTHROPIC });
    tracker.observeResponse();
    const edge = (ANTHROPIC_CACHE_TTL_SECONDS * 1000) + CACHE_EXPIRY_GRACE_MS;
    clock.set(edge);

    // No ping observed: a ping we cannot see may have refreshed the cache.
    expect(tracker.state(ANTHROPIC, { keepAliveEnabled: true })).toBe("unknown");
    tracker.setKeepAliveEnabled(true);
    expect(tracker.state(ANTHROPIC)).toBe("unknown");

    // Once a ping is observed the mechanism is proven observable.
    tracker.observeWarmPing();
    expect(tracker.state(ANTHROPIC)).toBe("warm");
    clock.set(edge * 2);
    expect(tracker.state(ANTHROPIC)).toBe("cold");
  });

  test("CACHE_WARM_PING_EVENT is the builtin event name", () => {
    expect(CACHE_WARM_PING_EVENT).toBe("cache_warm_ping");
    expect(GOAL_CACHE_WARMUP_ENTRY_TYPE).toBe("goal-cache-warmup");
  });
});

describe("local /slots probing", () => {
  test("takes a baseline and reports an evicted slot", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const model: CacheModelLike = {
      api: "openai-completions",
      provider: "ollama",
      baseUrl: harness.baseUrl,
    };
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    expect(await tracker.baselineLocal(model)).toBe("warm");
    expect(tracker.state(model)).toBe("warm");
    expect(harness.requests).toBe(1);
    expect(harness.methods).toEqual(["GET"]);
    expect(harness.paths).toEqual(["/slots"]);

    harness.setSlots([slot(2000)]);
    expect(await tracker.probeLocal(model)).toBe("cold");
    expect(harness.requests).toBe(2);
    expect(tracker.state(model)).toBe("cold");

    clock.advance(LOCAL_PROBE_INTERVAL_MS);
    harness.setSlots([slot(1000)]);
    expect(await tracker.probeLocal(model)).toBe("warm");

    // A processing slot is in use, so it is not called evicted.
    clock.advance(LOCAL_PROBE_INTERVAL_MS);
    harness.setSlots([slot(5000, true)]);
    expect(await tracker.probeLocal(model)).toBe("warm");

    // Never anything but a GET /slots.
    expect(harness.methods.every((method) => method === "GET")).toBe(true);
    expect(harness.paths.every((path) => path === "/slots")).toBe(true);
  });

  test("throttles probes to at most one per 30 seconds", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const model: CacheModelLike = {
      api: "openai-completions",
      provider: "ollama",
      baseUrl: harness.baseUrl,
    };
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    await tracker.baselineLocal(model);
    expect(await tracker.probeLocal(model)).toBe("warm");
    expect(harness.requests).toBe(2);

    harness.setSlots([slot(2000)]);
    clock.advance(LOCAL_PROBE_INTERVAL_MS - 1);
    expect(await tracker.probeLocal(model)).toBe("warm");
    expect(harness.requests).toBe(2);

    clock.advance(1);
    expect(await tracker.probeLocal(model)).toBe("cold");
    expect(harness.requests).toBe(3);
  });

  test("a hanging /slots server returns unknown within the 1500ms timeout", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const model: CacheModelLike = {
      api: "openai-completions",
      provider: "ollama",
      baseUrl: harness.baseUrl,
    };
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    await tracker.baselineLocal(model);
    harness.setHang(true);
    clock.advance(LOCAL_PROBE_INTERVAL_MS);

    const started = performance.now();
    const result = await tracker.probeLocal(model);
    const elapsed = performance.now() - started;

    expect(result).toBe("unknown");
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(elapsed).toBeLessThan(2000);
    // The timeout constant is the intent; the measured bound above allows timer slack.
    expect(LOCAL_PROBE_TIMEOUT_MS).toBe(1500);
  });

  test("a failed or malformed probe is unknown", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const model: CacheModelLike = {
      api: "openai-completions",
      provider: "ollama",
      baseUrl: harness.baseUrl,
    };
    const clock = mutableClock();
    const tracker = createCacheStateTracker({ now: clock.now });

    await tracker.baselineLocal(model);

    harness.setStatus(500);
    clock.advance(LOCAL_PROBE_INTERVAL_MS);
    expect(await tracker.probeLocal(model)).toBe("unknown");
    expect(tracker.state(model)).toBe("unknown");

    harness.setStatus(200);
    harness.setSlots({ unexpected: true });
    clock.advance(LOCAL_PROBE_INTERVAL_MS);
    expect(await tracker.probeLocal(model)).toBe("unknown");
  });

  test("a probe without a baseline is unknown and sends no request", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const model: CacheModelLike = {
      api: "openai-completions",
      provider: "ollama",
      baseUrl: harness.baseUrl,
    };
    const tracker = createCacheStateTracker({ now: mutableClock().now });

    expect(await tracker.probeLocal(model)).toBe("unknown");
    expect(harness.requests).toBe(0);
  });

  test("non-local models do not touch /slots", async () => {
    const harness = startSlotsHarness([slot(1000)]);
    const tracker = createCacheStateTracker();
    expect(await tracker.baselineLocal(ANTHROPIC)).toBe("unknown");
    expect(await tracker.probeLocal(ANTHROPIC)).toBe("unknown");
    expect(harness.requests).toBe(0);
  });
});
