/**
 * Deterministic clock and long-timer capture for the isolated QA arms.
 *
 * The mod captures `Date.now` when its factory runs, so the fake clock must be
 * installed before the bundled extension is loaded. Timers at or above the
 * threshold (the mod's 30 s idle interval and its generation deadlines) are
 * recorded instead of scheduled; the arm fires them explicitly. Short timers
 * stay real, so the session engine's own event-loop behavior is untouched.
 *
 * There is no sleep anywhere: `fireIntervals` invokes the recorded callbacks,
 * and `advance` only moves the fake epoch.
 */

export const LONG_TIMER_THRESHOLD_MS = 30_000;

export interface IsolationClock {
  now(): number;
  set(epochMs: number): void;
  advance(ms: number): number;
  fireIntervals(): number;
  fireTimeouts(): number;
  restore(): void;
  readonly longIntervals: number[];
}

interface RecordedTimer {
  callback: () => void;
  ms: number;
  cleared: boolean;
  kind: "interval" | "timeout";
}

export function installIsolationClock(startAt = 1_700_000_000_000): IsolationClock {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;

  let current = startAt;
  let restored = false;
  const record = new Map<object, RecordedTimer>();
  const longIntervals: number[] = [];

  const handle = (entry: RecordedTimer): object => {
    const token = {
      unref() {
        return token;
      },
      ref() {
        return token;
      },
      hasRef() {
        return false;
      },
    };
    record.set(token, entry);
    return token;
  };

  Date.now = () => current;

  globalThis.setInterval = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    const delay = Number(ms ?? 0);
    if (delay >= LONG_TIMER_THRESHOLD_MS) {
      longIntervals.push(delay);
      return handle({ callback: () => callback(...(args as [])), ms: delay, cleared: false, kind: "interval" });
    }
    return originalSetInterval(callback, delay, ...args);
  }) as typeof globalThis.setInterval;

  globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    const delay = Number(ms ?? 0);
    if (delay >= LONG_TIMER_THRESHOLD_MS) {
      return handle({ callback: () => callback(...(args as [])), ms: delay, cleared: false, kind: "timeout" });
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;

  globalThis.clearInterval = ((token: object) => {
    const entry = record.get(token);
    if (entry !== undefined) {
      entry.cleared = true;
      record.delete(token);
      return;
    }
    originalClearInterval(token as ReturnType<typeof setInterval>);
  }) as typeof globalThis.clearInterval;

  globalThis.clearTimeout = ((token: object) => {
    const entry = record.get(token);
    if (entry !== undefined) {
      entry.cleared = true;
      record.delete(token);
      return;
    }
    originalClearTimeout(token as ReturnType<typeof setTimeout>);
  }) as typeof globalThis.clearTimeout;

  return {
    now() {
      return current;
    },
    set(epochMs: number) {
      current = epochMs;
    },
    advance(ms: number) {
      current += Math.max(0, ms);
      return current;
    },
    fireIntervals() {
      let fired = 0;
      for (const entry of [...record.values()]) {
        if (entry.cleared || entry.kind !== "interval") continue;
        fired += 1;
        entry.callback();
      }
      return fired;
    },
    fireTimeouts() {
      let fired = 0;
      for (const [token, entry] of [...record.entries()]) {
        if (entry.cleared || entry.kind !== "timeout") continue;
        entry.cleared = true;
        record.delete(token);
        fired += 1;
        entry.callback();
      }
      return fired;
    },
    restore() {
      if (restored) return;
      restored = true;
      Date.now = originalNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      record.clear();
    },
    longIntervals,
  };
}
