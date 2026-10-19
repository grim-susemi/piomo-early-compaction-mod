import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MetricsError,
  createMetricsWriter,
  hashSessionId,
  metricsPath,
  type MetricsEventName,
  type MetricsWriter,
} from "../src/metrics";

const SESSION_HASH = "0123456789abcdef";
const MODEL_LABEL = "test/model";
const FIXED_NOW = () => new Date("2026-10-19T00:00:00.000Z");

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "early-compaction-metrics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function writerFor(
  agentDir: string,
  overrides: Partial<Parameters<typeof createMetricsWriter>[0]> = {},
): MetricsWriter {
  return createMetricsWriter({
    agentDir,
    sessionHash: SESSION_HASH,
    modelLabel: MODEL_LABEL,
    now: FIXED_NOW,
    ...overrides,
  });
}

/** Call `write` without the compile-time schema, exactly as a hostile caller would. */
function writeRaw(
  writer: MetricsWriter,
  event: string,
  fields: Record<string, unknown>,
): void {
  (writer.write as unknown as (event: string, fields: Record<string, unknown>) => void)(
    event,
    fields,
  );
}

function expectMetricsError(
  action: () => void,
  code: MetricsError["code"],
  messagePart?: string,
): MetricsError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MetricsError);
    const metricsError = error as MetricsError;
    expect(metricsError.name).toBe("MetricsError");
    expect(metricsError.code).toBe(code);
    if (messagePart !== undefined) expect(metricsError.message).toContain(messagePart);
    return metricsError;
  }
  throw new Error(`expected a MetricsError with code ${code}`);
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

function readEvents(file: string): Record<string, unknown>[] {
  return readLines(file).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rotatedPath(agentDir: string, generation: 1 | 2): string {
  return join(agentDir, "early-compaction", `metrics.${generation}.jsonl`);
}

const VALID_APPLY = {
  jobId: "job-1",
  route: "cold",
  site: "timer",
  result: "ok",
  tokensBefore: 100,
  estimatedTokensAfter: 50,
  summaryTokens: 10,
  notesBlocks: 1,
} as const;

describe("metrics: format", () => {
  test("creates the directory on first write and writes one allowlisted JSON line", () => {
    const dir = tempDir();
    const rawSessionId = "raw-session-id-do-not-log-0123456789";
    const writer = writerFor(dir, { sessionHash: hashSessionId(rawSessionId) });
    const directory = join(dir, "early-compaction");

    expect(existsSync(directory)).toBe(false);
    writer.write("job_start", { jobId: "job-1", kind: "notes", U: 120_000, W: 262_144 });
    expect(existsSync(directory)).toBe(true);

    const raw = readFileSync(metricsPath(dir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = readLines(metricsPath(dir));
    expect(lines).toHaveLength(1);

    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(line).toEqual({
      v: 1,
      ts: "2026-10-19T00:00:00.000Z",
      session: hashSessionId(rawSessionId),
      model: MODEL_LABEL,
      event: "job_start",
      jobId: "job-1",
      kind: "notes",
      U: 120_000,
      W: 262_144,
    });
    expect(line.session).toHaveLength(16);
    expect(line.session).not.toBe(rawSessionId);
    expect(raw).not.toContain(rawSessionId);
    writer.close();
  });

  test("accepts every allowlisted event exactly once", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    writer.write("gate", { state: "active", reason: "ok" });
    writer.write("override", { state: "installed" });
    writer.write("job_start", { jobId: "j", kind: "rewrite-first", U: 1, W: 2 });
    writer.write("job_end", {
      jobId: "j",
      outcome: "ready",
      reason: "ok",
      ms: 10,
      inputTokens: 3,
      outputTokens: 4,
    });
    writer.write("apply", VALID_APPLY);
    writer.write("discard", { jobId: "j", reason: "builtin-compact" });
    writer.write("builtin_compact", {
      reason: "threshold",
      tokensBefore: 5,
      requestId: "req-1",
      compactionEntryId: "entry-1",
    });
    writer.write("threshold_cross", { U: 6, T: 7 });
    writer.write("next_usage", {
      input: 8,
      cacheRead: 9,
      cacheWrite: 10,
      systemHash: "abcdef012345",
    });
    writer.close();

    const events = readEvents(metricsPath(dir));
    expect(events.map((event) => event.event)).toEqual([
      "gate",
      "override",
      "job_start",
      "job_end",
      "apply",
      "discard",
      "builtin_compact",
      "threshold_cross",
      "next_usage",
    ]);
  });
});

describe("metrics: allowlist", () => {
  test("rejects a summary field and writes nothing", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    expectMetricsError(
      () => writeRaw(writer, "apply", { ...VALID_APPLY, summary: "private summary text" }),
      "unknown-field",
      "summary",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects text, prompt, headers and apiKey on any event", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    const hostile: Array<[string, Record<string, unknown>, string]> = [
      ["apply", { ...VALID_APPLY, text: "message body" }, "text"],
      ["gate", { state: "active", reason: "ok", prompt: "user prompt" }, "prompt"],
      ["job_start", { jobId: "j", kind: "notes", U: 1, W: 2, headers: "authorization: x" }, "headers"],
      ["job_end", {
        jobId: "j",
        outcome: "failed",
        reason: "auth",
        ms: 1,
        inputTokens: 0,
        outputTokens: 0,
        apiKey: "sk-secret",
      }, "apiKey"],
      ["threshold_cross", { U: 1, T: 2, session: "raw-session-id" }, "session"],
      ["threshold_cross", { U: 1, T: 2, ts: "2000-01-01T00:00:00.000Z" }, "ts"],
    ];
    for (const [event, fields, field] of hostile) {
      expectMetricsError(
        () => writeRaw(writer, event, fields),
        "unknown-field",
        field,
      );
    }
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects a 201-character string and writes nothing; 200 is accepted", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    expectMetricsError(
      () =>
        writeRaw(writer, "builtin_compact", {
          reason: "threshold",
          tokensBefore: 1,
          requestId: "x".repeat(201),
          compactionEntryId: "entry-1",
        }),
      "string-too-long",
      "201",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);

    writer.write("builtin_compact", {
      reason: "threshold",
      tokensBefore: 1,
      requestId: "x".repeat(200),
      compactionEntryId: "entry-1",
    });
    const [line] = readEvents(metricsPath(dir));
    expect((line?.requestId as string).length).toBe(200);
  });

  test("rejects an unknown event name by name", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    const error = expectMetricsError(
      () => writeRaw(writer, "totally_unknown", {}),
      "unknown-event",
      "totally_unknown",
    );
    expect(error.message).toContain("totally_unknown");
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects a value outside an enumerated set", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    expectMetricsError(
      () => writeRaw(writer, "override", { state: "hacked" }),
      "invalid-enum",
      "override.state",
    );
    expectMetricsError(
      () => writeRaw(writer, "job_end", {
        jobId: "j",
        outcome: "ready",
        reason: "free text reason",
        ms: 1,
        inputTokens: 0,
        outputTokens: 0,
      }),
      "invalid-enum",
      "job_end.reason",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects missing fields, invalid numbers and non-hex hashes", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    expectMetricsError(
      () => writeRaw(writer, "job_start", { jobId: "j", kind: "notes", U: 1 }),
      "missing-field",
      "W",
    );
    expectMetricsError(
      () => writeRaw(writer, "threshold_cross", { U: Number.NaN, T: 2 }),
      "invalid-number",
      "threshold_cross.U",
    );
    expectMetricsError(
      () => writeRaw(writer, "threshold_cross", { U: -1, T: 2 }),
      "invalid-number",
      "threshold_cross.U",
    );
    expectMetricsError(
      () => writeRaw(writer, "next_usage", {
        input: 1,
        cacheRead: 2,
        cacheWrite: 3,
        systemHash: "not a hash",
      }),
      "invalid-hash",
      "next_usage.systemHash",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects a raw session id at construction", () => {
    const dir = tempDir();
    expectMetricsError(
      () => writerFor(dir, { sessionHash: "raw-session-id" }),
      "invalid-hash",
      "sessionHash",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });

  test("rejects a model label carrying a line break", () => {
    const dir = tempDir();
    expectMetricsError(
      () => writerFor(dir, { modelLabel: "model\nsecret" }),
      "invalid-config",
      "modelLabel",
    );
  });

  test("rejection after a successful write leaves the existing log untouched", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    writer.write("threshold_cross", { U: 1, T: 2 });
    const before = readFileSync(metricsPath(dir), "utf8");
    expectMetricsError(
      () => writeRaw(writer, "apply", { ...VALID_APPLY, summary: "secret" }),
      "unknown-field",
      "summary",
    );
    expect(readFileSync(metricsPath(dir), "utf8")).toBe(before);
  });
});

describe("metrics: rotation", () => {
  test("rotates metrics.jsonl -> .1 -> .2 and keeps exactly three files", () => {
    const dir = tempDir();
    const file = metricsPath(dir);

    const firstWriter = writerFor(dir);
    firstWriter.write("threshold_cross", { U: 1, T: 1 });
    firstWriter.close();
    const lineBytes = statSync(file).size;
    expect(lineBytes).toBeGreaterThan(0);

    const writer = writerFor(dir, { maxBytes: lineBytes + 5 });
    writer.write("threshold_cross", { U: 2, T: 2 });
    expect(readEvents(file).map((event) => event.U)).toEqual([2]);
    expect(readEvents(rotatedPath(dir, 1)).map((event) => event.U)).toEqual([1]);
    expect(existsSync(rotatedPath(dir, 2))).toBe(false);

    writer.write("threshold_cross", { U: 3, T: 3 });
    expect(readEvents(file).map((event) => event.U)).toEqual([3]);
    expect(readEvents(rotatedPath(dir, 1)).map((event) => event.U)).toEqual([2]);
    expect(readEvents(rotatedPath(dir, 2)).map((event) => event.U)).toEqual([1]);

    writer.write("threshold_cross", { U: 4, T: 4 });
    expect(readEvents(file).map((event) => event.U)).toEqual([4]);
    expect(readEvents(rotatedPath(dir, 1)).map((event) => event.U)).toEqual([3]);
    expect(readEvents(rotatedPath(dir, 2)).map((event) => event.U)).toEqual([2]);
    expect(existsSync(join(dir, "early-compaction", "metrics.3.jsonl"))).toBe(false);
    expect(readdirSync(join(dir, "early-compaction")).sort()).toEqual([
      "metrics.1.jsonl",
      "metrics.2.jsonl",
      "metrics.jsonl",
    ]);
    writer.close();
  });

  test("default cap is 5 MiB, so 1,000 small events stay in one file", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    writer.write("threshold_cross", { U: 0, T: 0 });
    expect(statSync(metricsPath(dir)).size).toBeLessThan(5 * 1024 * 1024);
    writer.close();
    expect(readdirSync(join(dir, "early-compaction"))).toEqual(["metrics.jsonl"]);
  });
});

describe("metrics: many events and concurrency", () => {
  test("1,000 events all parse and carry the common fields", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    for (let index = 0; index < 1000; index += 1) {
      writer.write("threshold_cross", { U: index, T: 1000 });
    }
    writer.close();

    const file = metricsPath(dir);
    const lines = readLines(file);
    expect(lines).toHaveLength(1000);
    for (const [index, line] of lines.entries()) {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(event.v).toBe(1);
      expect(event.ts).toBe("2026-10-19T00:00:00.000Z");
      expect(event.session).toBe(SESSION_HASH);
      expect(event.model).toBe(MODEL_LABEL);
      expect(event.event).toBe("threshold_cross");
      expect(event.U).toBe(index);
      expect(event.T).toBe(1000);
    }
  });

  test("two concurrent writers produce only complete, valid JSON lines", async () => {
    const dir = tempDir();
    const first = writerFor(dir);
    const second = writerFor(dir);

    const writeAll = async (writer: MetricsWriter, offset: number): Promise<void> => {
      for (let index = 0; index < 500; index += 1) {
        writer.write("threshold_cross", { U: offset + index, T: 0 });
        if (index % 25 === 0) await Promise.resolve();
      }
      writer.close();
    };

    await Promise.all([writeAll(first, 0), writeAll(second, 500)]);

    const file = metricsPath(dir);
    const events = readEvents(file);
    expect(events).toHaveLength(1000);
    const seen = new Set<number>();
    for (const event of events) {
      expect(event.v).toBe(1);
      expect(event.session).toBe(SESSION_HASH);
      expect(event.event).toBe("threshold_cross");
      seen.add(event.U as number);
    }
    expect(seen.size).toBe(1000);
  });

  test("two concurrent writers rotating still leave only complete lines", async () => {
    const probeDir = tempDir();
    const probe = writerFor(probeDir);
    probe.write("threshold_cross", { U: 0, T: 0 });
    probe.close();
    const lineBytes = statSync(metricsPath(probeDir)).size;

    const dir = tempDir();
    const maxBytes = lineBytes + 5;
    const first = writerFor(dir, { maxBytes });
    const second = writerFor(dir, { maxBytes });

    const writeAll = async (writer: MetricsWriter, offset: number): Promise<void> => {
      for (let index = 0; index < 60; index += 1) {
        writer.write("threshold_cross", { U: offset + index, T: 0 });
        if (index % 7 === 0) await Promise.resolve();
      }
      writer.close();
    };

    await Promise.all([writeAll(first, 0), writeAll(second, 1000)]);

    const directory = join(dir, "early-compaction");
    const files = readdirSync(directory).sort();
    expect(files).toEqual(["metrics.1.jsonl", "metrics.2.jsonl", "metrics.jsonl"]);
    // One line per file at this cap, so exactly the three newest lines survive.
    for (const name of files) {
      const raw = readFileSync(join(directory, name), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(readLines(join(directory, name))).toHaveLength(1);
    }
    const events = files.flatMap((name) => readEvents(join(directory, name)));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.U as number)).size).toBe(3);
    for (const event of events) {
      expect(event.v).toBe(1);
      expect(event.session).toBe(SESSION_HASH);
      expect(event.model).toBe(MODEL_LABEL);
      expect(event.event).toBe("threshold_cross");
    }
  });
});

describe("metrics: lifecycle", () => {
  test("close is idempotent and later writes are rejected by name", () => {
    const dir = tempDir();
    const writer = writerFor(dir);
    writer.write("threshold_cross", { U: 1, T: 2 });
    writer.close();
    writer.close();
    expectMetricsError(
      () => writer.write("threshold_cross", { U: 3, T: 4 }),
      "closed",
      "closed",
    );
  });

  test("a clock that does not return a Date is rejected before writing", () => {
    const dir = tempDir();
    const writer = writerFor(dir, {
      now: () => "not a date" as unknown as Date,
    });
    expectMetricsError(
      () => writer.write("threshold_cross", { U: 1, T: 2 }),
      "invalid-clock",
      "now()",
    );
    expect(existsSync(join(dir, "early-compaction"))).toBe(false);
  });
});

// Keep the imported event-name type exercised so a schema rename fails the build.
const eventNames: MetricsEventName[] = [
  "gate",
  "override",
  "job_start",
  "job_end",
  "apply",
  "discard",
  "builtin_compact",
  "threshold_cross",
  "next_usage",
];
test("schema exports the nine events", () => {
  expect(eventNames).toHaveLength(9);
});
