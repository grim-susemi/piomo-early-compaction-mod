/**
 * Allowlisted JSONL metrics for the early-compaction mod.
 *
 * One file per agent dir: `<agentDir>/early-compaction/metrics.jsonl`. Every
 * line is one self-contained JSON object with the common fields
 * `v` (schema), `ts`, `session` (a hash, never the raw id), `model` (a label)
 * and `event`, followed by the event's own allowlisted fields.
 *
 * The writer never accepts free text: a field outside the event schema, a
 * string longer than 200 characters, or a value outside an enumerated set is
 * rejected before anything touches the disk. Message, prompt, summary, auth
 * and header values therefore cannot reach the log, even by accident.
 *
 * Rotation happens before a write that would exceed `maxBytes` (5 MiB by
 * default): `metrics.1.jsonl` -> `metrics.2.jsonl`, `metrics.jsonl` ->
 * `metrics.1.jsonl`, then a fresh live file. Only those three files are kept.
 *
 * Writes are synchronous and append one complete line per call, so concurrent
 * writers in one process cannot interleave halves of a line.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const METRICS_SCHEMA_VERSION = 1;
export const METRICS_DIRECTORY = "early-compaction";
export const METRICS_FILE = "metrics.jsonl";
export const METRICS_MAX_BYTES = 5 * 1024 * 1024;
export const METRICS_MAX_STRING_LENGTH = 200;
/** Session hashes keep 64 bits of sha256: enough to join lines, short on disk. */
export const SESSION_HASH_HEX_LENGTH = 16;

export const GATE_STATES = ["active", "dormant"] as const;
export const GATE_REASONS = [
  "ok",
  "env",
  "mode",
  "compaction-off",
  "unqualified",
  "capability",
] as const;
export const OVERRIDE_STATES = ["installed", "self-test-failed", "skipped"] as const;
export const JOB_KINDS = [
  "notes",
  "rewrite",
  "rewrite-first",
  "rewrite-consolidate",
] as const;
export const JOB_OUTCOMES = ["ready", "failed", "aborted", "skipped"] as const;
export const JOB_END_REASONS = [
  "ok",
  "auth",
  "model-unresolved",
  "local-session-model",
  "source-too-large",
  "truncated",
  "aborted",
  "timeout",
  "rate-limited",
  "unavailable",
  "builtin-compact",
  "fingerprint-mismatch",
  "stale",
  "failed",
  "skipped",
] as const;
export const APPLY_ROUTES = ["cold", "boundary", "threshold"] as const;
export const APPLY_SITES = ["agent_settled", "timer", "input"] as const;
export const APPLY_RESULTS = ["ok", "stale", "rejected"] as const;
export const DISCARD_REASONS = [
  "builtin-compact",
  "session-before-compact",
  "session-tree",
  "context-edit",
  "fingerprint-mismatch",
  "stale",
  "model-select",
  "session-shutdown",
  "job-superseded",
  "user-activity",
  "not-idle",
  "pending-messages",
  "compacting",
  "todo-restore",
  "benefit",
  "apply-rejected",
] as const;

export type GateState = (typeof GATE_STATES)[number];
export type GateReason = (typeof GATE_REASONS)[number];
export type OverrideState = (typeof OVERRIDE_STATES)[number];
export type JobKind = (typeof JOB_KINDS)[number];
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export type JobEndReason = (typeof JOB_END_REASONS)[number];
export type ApplyRoute = (typeof APPLY_ROUTES)[number];
export type ApplySite = (typeof APPLY_SITES)[number];
export type ApplyResult = (typeof APPLY_RESULTS)[number];
export type DiscardReason = (typeof DISCARD_REASONS)[number];

type StringRule = {
  readonly kind: "string";
  readonly values?: readonly string[];
  readonly hash?: boolean;
};
type NumberRule = { readonly kind: "number" };
type FieldRule = StringRule | NumberRule;

/**
 * The allowlist. Object key order is the output field order, which keeps lines
 * deterministic and diffable. `builtin_compact.reason` stays a label because
 * the builtin owns that vocabulary; every other string field that names a
 * state, kind, route, site, result or reason is an enumerated set.
 */
const EVENT_FIELDS = {
  gate: {
    state: { kind: "string", values: GATE_STATES },
    reason: { kind: "string", values: GATE_REASONS },
  },
  override: {
    state: { kind: "string", values: OVERRIDE_STATES },
  },
  job_start: {
    jobId: { kind: "string" },
    kind: { kind: "string", values: JOB_KINDS },
    U: { kind: "number" },
    W: { kind: "number" },
  },
  job_end: {
    jobId: { kind: "string" },
    outcome: { kind: "string", values: JOB_OUTCOMES },
    reason: { kind: "string", values: JOB_END_REASONS },
    ms: { kind: "number" },
    inputTokens: { kind: "number" },
    outputTokens: { kind: "number" },
  },
  apply: {
    jobId: { kind: "string" },
    route: { kind: "string", values: APPLY_ROUTES },
    site: { kind: "string", values: APPLY_SITES },
    result: { kind: "string", values: APPLY_RESULTS },
    tokensBefore: { kind: "number" },
    estimatedTokensAfter: { kind: "number" },
    summaryTokens: { kind: "number" },
    notesBlocks: { kind: "number" },
  },
  discard: {
    jobId: { kind: "string" },
    reason: { kind: "string", values: DISCARD_REASONS },
  },
  builtin_compact: {
    reason: { kind: "string" },
    tokensBefore: { kind: "number" },
    requestId: { kind: "string" },
    compactionEntryId: { kind: "string" },
  },
  threshold_cross: {
    U: { kind: "number" },
    T: { kind: "number" },
  },
  next_usage: {
    input: { kind: "number" },
    cacheRead: { kind: "number" },
    cacheWrite: { kind: "number" },
    systemHash: { kind: "string", hash: true },
  },
} as const satisfies Record<string, Record<string, FieldRule>>;

export type MetricsEventName = keyof typeof EVENT_FIELDS;

type FieldValue<F> = F extends { readonly kind: "number" } ? number : string;

/** Fields accepted by `write(event, fields)` for one event name. */
export type MetricsFieldsFor<E extends MetricsEventName> = {
  readonly [K in keyof (typeof EVENT_FIELDS)[E]]: FieldValue<(typeof EVENT_FIELDS)[E][K]>;
};

export type MetricsEventFields = {
  readonly [E in MetricsEventName]: MetricsFieldsFor<E>;
};

export type MetricsErrorCode =
  | "invalid-config"
  | "unknown-event"
  | "unknown-field"
  | "missing-field"
  | "string-too-long"
  | "invalid-string"
  | "invalid-enum"
  | "invalid-hash"
  | "invalid-number"
  | "invalid-field-object"
  | "invalid-clock"
  | "closed";

/** Named rejection. `code` is stable; the message names the event and field. */
export class MetricsError extends Error {
  readonly code: MetricsErrorCode;

  constructor(code: MetricsErrorCode, message: string) {
    super(message);
    this.name = "MetricsError";
    this.code = code;
  }
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HASH_RE = /^[0-9a-f]{12,64}$/i;

function checkString(
  code: MetricsErrorCode,
  subject: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string") {
    throw new MetricsError(code, `${subject} must be a string`);
  }
  if (value.length > METRICS_MAX_STRING_LENGTH) {
    throw new MetricsError(
      "string-too-long",
      `${subject} is ${value.length} characters; the limit is ${METRICS_MAX_STRING_LENGTH}`,
    );
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new MetricsError(code, `${subject} must not contain control characters or line breaks`);
  }
}

function checkNumber(subject: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MetricsError(
      "invalid-number",
      `${subject} must be a finite non-negative number`,
    );
  }
}

/** A hash-only session identifier: sha256 hex, first 16 characters. */
export function hashSessionId(sessionId: string): string {
  checkString("invalid-config", "sessionId", sessionId);
  if (sessionId.length === 0) {
    throw new MetricsError("invalid-config", "sessionId must not be empty");
  }
  return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, SESSION_HASH_HEX_LENGTH);
}

export function metricsDirectory(agentDir: string): string {
  return join(resolve(agentDir), METRICS_DIRECTORY);
}

export function metricsPath(agentDir: string): string {
  return join(metricsDirectory(agentDir), METRICS_FILE);
}

/** `metrics.1.jsonl` / `metrics.2.jsonl`; only generations 1 and 2 exist. */
export function metricsRotatedPath(agentDir: string, generation: 1 | 2): string {
  return join(metricsDirectory(agentDir), `metrics.${generation}.jsonl`);
}

export interface MetricsWriterOptions {
  /** Agent dir that owns the session; the log goes under its early-compaction/. */
  readonly agentDir: string;
  /** Required hash from `hashSessionId`; a raw session id is rejected. */
  readonly sessionHash: string;
  /** Model label only (e.g. "anthropic/claude-sonnet-4-5"), never a payload. */
  readonly modelLabel: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Injectable rotation cap for deterministic tests. Default 5 MiB. */
  readonly maxBytes?: number;
}

export interface MetricsWriter {
  readonly path: string;
  readonly directory: string;
  write<E extends MetricsEventName>(event: E, fields: MetricsFieldsFor<E>): void;
  close(): void;
}

function assertOptions(options: MetricsWriterOptions): {
  directory: string;
  file: string;
  sessionHash: string;
  modelLabel: string;
  now: () => Date;
  maxBytes: number;
} {
  if (typeof options !== "object" || options === null) {
    throw new MetricsError("invalid-config", "metrics options must be an object");
  }
  checkString("invalid-config", "agentDir", options.agentDir);
  if (options.agentDir.length === 0) {
    throw new MetricsError("invalid-config", "agentDir must not be empty");
  }
  checkString("invalid-config", "sessionHash", options.sessionHash);
  if (!HASH_RE.test(options.sessionHash)) {
    throw new MetricsError(
      "invalid-hash",
      "sessionHash must be a 12-64 character hex hash, never a raw session id",
    );
  }
  checkString("invalid-config", "modelLabel", options.modelLabel);
  if (options.modelLabel.length === 0) {
    throw new MetricsError("invalid-config", "modelLabel must not be empty");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new MetricsError("invalid-config", "now must be a function returning a Date");
  }
  if (options.maxBytes !== undefined) {
    if (
      typeof options.maxBytes !== "number" ||
      !Number.isFinite(options.maxBytes) ||
      options.maxBytes <= 0 ||
      !Number.isInteger(options.maxBytes)
    ) {
      throw new MetricsError("invalid-config", "maxBytes must be a positive integer");
    }
  }
  return {
    directory: metricsDirectory(options.agentDir),
    file: metricsPath(options.agentDir),
    sessionHash: options.sessionHash,
    modelLabel: options.modelLabel,
    now: options.now ?? (() => new Date()),
    maxBytes: options.maxBytes ?? METRICS_MAX_BYTES,
  };
}

function isEventName(event: unknown): event is MetricsEventName {
  return typeof event === "string" && Object.prototype.hasOwnProperty.call(EVENT_FIELDS, event);
}

function validateFields(
  event: MetricsEventName,
  fields: unknown,
): Record<string, string | number> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new MetricsError("invalid-field-object", `${event} fields must be a plain object`);
  }
  const input = fields as Record<string, unknown>;
  const schema = EVENT_FIELDS[event] as Record<string, FieldRule>;
  const allowed = Object.keys(schema);

  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      throw new MetricsError(
        "unknown-field",
        `${event} does not allow field "${key}"`,
      );
    }
  }

  const validated: Record<string, string | number> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw new MetricsError("missing-field", `${event} requires field "${key}"`);
    }
    const rule = schema[key];
    const value = input[key];
    const subject = `${event}.${key}`;
    if (rule.kind === "number") {
      checkNumber(subject, value);
      validated[key] = value;
      continue;
    }
    checkString("invalid-string", subject, value);
    if (rule.values !== undefined && !rule.values.includes(value)) {
      throw new MetricsError(
        "invalid-enum",
        `${subject} must be one of: ${rule.values.join(", ")}`,
      );
    }
    if (rule.hash === true && !HASH_RE.test(value)) {
      throw new MetricsError("invalid-hash", `${subject} must be a 12-64 character hex hash`);
    }
    validated[key] = value;
  }
  return validated;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Create one writer. The directory is created on the first successful write,
 * so a rejected event leaves the agent dir untouched.
 */
export function createMetricsWriter(options: MetricsWriterOptions): MetricsWriter {
  const config = assertOptions(options);
  let closed = false;

  const rotated1 = join(config.directory, "metrics.1.jsonl");
  const rotated2 = join(config.directory, "metrics.2.jsonl");

  function rotate(): void {
    // Oldest first: drop metrics.2, shift metrics.1 up, shift the live file up.
    rmSync(rotated2, { force: true });
    renameIfPresent(rotated1, rotated2);
    renameIfPresent(config.file, rotated1);
  }

  return {
    path: config.file,
    directory: config.directory,
    write<E extends MetricsEventName>(event: E, fields: MetricsFieldsFor<E>): void {
      if (closed) {
        throw new MetricsError("closed", "metrics writer is closed");
      }
      if (!isEventName(event)) {
        throw new MetricsError("unknown-event", `unknown metrics event "${String(event)}"`);
      }
      const validated = validateFields(event, fields as unknown);

      const timestamp = config.now();
      if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
        throw new MetricsError("invalid-clock", "now() must return a valid Date");
      }

      const line = `${JSON.stringify({
        v: METRICS_SCHEMA_VERSION,
        ts: timestamp.toISOString(),
        session: config.sessionHash,
        model: config.modelLabel,
        event,
        ...validated,
      })}\n`;
      const bytes = Buffer.byteLength(line, "utf8");

      mkdirSync(config.directory, { recursive: true });
      const size = fileSize(config.file);
      if (size > 0 && size + bytes > config.maxBytes) {
        rotate();
      }
      appendFileSync(config.file, line, "utf8");
    },
    close(): void {
      closed = true;
    },
  };
}
