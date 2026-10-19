/**
 * Load gate for the early-compaction mod.
 *
 * The mod must never run half-applied. `evaluateGate` walks the checks in one
 * fixed order and stops at the first failure:
 *
 *   1. env            PIOMO_EARLY_COMPACTION=0                 (silent)
 *   2. mode           sessionKind + ctx.mode (rpc opt-in)      (silent)
 *   3. compaction-off ctx.getCompactionSettings().enabled      (silent)
 *   4. unqualified    VERSION + builtin file fingerprints      (one warning)
 *   5. capability     ctx/root API surface + override self-test (one warning)
 *
 * `evaluateGate` is pure over an injected dependency object. The thin
 * `evaluateRealGate` adapter reads `qualified.json` and the installed builtin
 * files, probes the live context, and is the only place that touches the
 * filesystem or the real senpi package. Silent dormancy never calls `warn`,
 * so it produces no UI output.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExtensionRunner,
  VERSION,
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  findCutPoint,
  getPackageDir,
  serializeConversation,
} from "@code-yeongyu/senpi";

/** Environment variable that force-disables the mod. Only the literal `0` counts. */
export const EARLY_COMPACTION_ENV = "PIOMO_EARLY_COMPACTION";

/** Schema version of `<agentDir>/early-compaction/qualified.json`. */
export const QUALIFIED_SCHEMA = 1;

/** The five builtin compaction files covered by the fingerprint check. */
export const QUALIFIED_FILES = [
  "prompts.js",
  "task-intent.js",
  "policy.js",
  "idle.js",
  "speculative.js",
] as const;

export type QualifiedFile = (typeof QUALIFIED_FILES)[number];

/** Directory of the builtin files, relative to `getPackageDir()`. */
export const QUALIFIED_FILES_PATH = [
  "dist",
  "core",
  "extensions",
  "builtin",
  "compaction",
] as const;

export type GateReason =
  | "env"
  | "mode"
  | "compaction-off"
  | "unqualified"
  | "capability";

export type GateResult =
  | { readonly state: "active" }
  | { readonly state: "dormant"; readonly reason: GateReason };

/** The part of the mod config the gate reads. */
export interface GateConfig {
  /** Admit `ctx.mode === "rpc"` sessions. Defaults to false. */
  readonly allowRpcInteractive?: boolean;
}

/** The part of `ExtensionContext` the pure gate reads. */
export interface GateContext {
  readonly mode: string;
  readonly getCompactionSettings?:
    | (() => { readonly enabled?: boolean } | undefined)
    | undefined;
}

/**
 * Everything `evaluateGate` may consult. Nothing here performs I/O: files are
 * read by the adapter and supplied as a parsed snapshot plus a hash map.
 */
export interface GateDeps {
  readonly sessionKind: string;
  readonly version: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config?: GateConfig | undefined;
  readonly ctx: GateContext;
  /** Parsed `qualified.json`, or undefined when it is missing/unreadable. */
  readonly qualifiedSnapshot: unknown;
  /** Actual sha256 of each installed builtin file; absent = missing file. */
  readonly installedFingerprints: Readonly<
    Partial<Record<QualifiedFile, string>>
  >;
  /** Names of missing capabilities; empty = complete. */
  readonly capabilityProbe: () => readonly string[];
  /** Todo-8 override self-test result (or a thunk for lazy evaluation). */
  readonly overrideSelfTest: boolean | (() => boolean);
  /** Emits at most one warning, for `unqualified` and `capability` only. */
  readonly warn: (message: string) => void;
}

/** One `versions` entry in qualified.json. */
export interface QualifiedEntry {
  /** `engineBuildIdentity().text` at qualification time. */
  readonly identity: string;
  readonly fingerprints: Readonly<Record<QualifiedFile, string>>;
}

/** The qualified.json document shape shared with todo 13. */
export interface QualifiedSnapshot {
  readonly schema: typeof QUALIFIED_SCHEMA;
  readonly versions: Readonly<Record<string, QualifiedEntry>>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Structural validation of a qualified.json document. Every listed version
 * must carry an identity and all five fingerprint keys as lowercase sha256
 * strings; anything else makes the whole document untrusted.
 */
export function isQualifiedSnapshot(
  value: unknown,
): value is QualifiedSnapshot {
  const root = asRecord(value);
  if (root === undefined || root.schema !== QUALIFIED_SCHEMA) return false;

  const versions = asRecord(root.versions);
  if (versions === undefined) return false;

  for (const candidate of Object.values(versions)) {
    const entry = asRecord(candidate);
    if (entry === undefined) return false;
    if (typeof entry.identity !== "string" || entry.identity.length === 0) {
      return false;
    }
    const fingerprints = asRecord(entry.fingerprints);
    if (fingerprints === undefined) return false;
    for (const file of QUALIFIED_FILES) {
      const hash = fingerprints[file];
      if (typeof hash !== "string" || !SHA256_RE.test(hash)) return false;
    }
  }
  return true;
}

/** True when `version` is qualified and every installed hash matches. */
export function isQualified(
  snapshot: unknown,
  version: string,
  installed: Readonly<Partial<Record<QualifiedFile, string>>>,
): boolean {
  if (!isQualifiedSnapshot(snapshot)) return false;
  if (!Object.hasOwn(snapshot.versions, version)) return false;

  const entry = snapshot.versions[version];
  if (entry === undefined) return false;

  for (const file of QUALIFIED_FILES) {
    if (installed[file] !== entry.fingerprints[file]) return false;
  }
  return true;
}

/** Parse a qualified.json payload; malformed JSON or shape yields undefined. */
export function parseQualifiedSnapshot(
  raw: string | undefined,
): QualifiedSnapshot | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isQualifiedSnapshot(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Path of `<packageDir>/dist/core/extensions/builtin/compaction`. */
export function qualifiedFilesDirectory(packageDir: string): string {
  return join(packageDir, ...QUALIFIED_FILES_PATH);
}

/** Path of `<agentDir>/early-compaction/qualified.json`. */
export function qualifiedFilePath(agentDir: string): string {
  return join(agentDir, "early-compaction", "qualified.json");
}

/** sha256 of the installed builtin files; a missing file stays absent. */
export function readInstalledFingerprints(
  packageDir: string = getPackageDir(),
): Partial<Record<QualifiedFile, string>> {
  const directory = qualifiedFilesDirectory(packageDir);
  const fingerprints: Partial<Record<QualifiedFile, string>> = {};
  for (const file of QUALIFIED_FILES) {
    try {
      fingerprints[file] = createHash("sha256")
        .update(readFileSync(join(directory, file)))
        .digest("hex");
    } catch {
      // Missing/unreadable file: leave the key absent so isQualified fails.
    }
  }
  return fingerprints;
}

/** Read and validate qualified.json; missing or unreadable yields undefined. */
export function readQualifiedSnapshot(
  agentDir: string,
): QualifiedSnapshot | undefined {
  try {
    return parseQualifiedSnapshot(readFileSync(qualifiedFilePath(agentDir), "utf8"));
  } catch {
    return undefined;
  }
}

/** Root exports and prototype seam the capability probe inspects. */
export interface RootCapabilities {
  readonly findCutPoint?: unknown;
  readonly buildSessionProjection?: unknown;
  readonly estimateTokens?: unknown;
  readonly serializeConversation?: unknown;
  readonly convertToLlm?: unknown;
  readonly ExtensionRunner?: {
    readonly prototype?: { readonly bindCore?: unknown } | undefined;
  } | undefined;
}

/** Live root exports, the default argument of `probeCapabilities`. */
export function defaultRootCapabilities(): RootCapabilities {
  return {
    findCutPoint,
    buildSessionProjection,
    estimateTokens,
    serializeConversation,
    convertToLlm,
    ExtensionRunner,
  };
}

const CTX_CAPABILITIES = [
  "applyCompaction",
  "getMessageRevision",
  "isCompacting",
  "onUserActivity",
  "getCompactionSettings",
  "getContextUsage",
  "isIdle",
  "hasPendingMessages",
] as const;

const REGISTRY_CAPABILITIES = [
  "find",
  "getApiKeyAndHeaders",
  "complete",
] as const;

const ROOT_CAPABILITIES = [
  "findCutPoint",
  "buildSessionProjection",
  "estimateTokens",
  "serializeConversation",
  "convertToLlm",
] as const;

/**
 * List every missing capability by its dotted name. An empty list means the
 * context, the model registry, the root exports and the one internal seam are
 * all present.
 */
export function probeCapabilities(
  ctx: unknown,
  root: RootCapabilities = defaultRootCapabilities(),
): string[] {
  const missing: string[] = [];
  const context = asRecord(ctx) ?? {};

  for (const name of CTX_CAPABILITIES) {
    if (typeof context[name] !== "function") missing.push(`ctx.${name}`);
  }

  const registry = asRecord(context.modelRegistry) ?? {};
  for (const name of REGISTRY_CAPABILITIES) {
    if (typeof registry[name] !== "function") {
      missing.push(`ctx.modelRegistry.${name}`);
    }
  }

  for (const name of ROOT_CAPABILITIES) {
    if (typeof root[name] !== "function") missing.push(name);
  }
  if (typeof root.ExtensionRunner?.prototype?.bindCore !== "function") {
    missing.push("ExtensionRunner.prototype.bindCore");
  }

  return missing;
}

/** Warning text for an unqualified version. */
export function unqualifiedWarning(version: string): string {
  return (
    `piomo early-compaction: senpi ${version} is not qualified ` +
    "(qualified.json is missing, unreadable, or its fingerprints changed); " +
    "staying dormant."
  );
}

/** Warning text for a missing capability or a failed override self-test. */
export function capabilityWarning(
  missing: readonly string[],
  selfTestOk: boolean,
): string {
  const names = [...missing];
  if (!selfTestOk) names.push("override self-test");
  return (
    "piomo early-compaction: required capability missing " +
    `(${names.join(", ")}); staying dormant.`
  );
}

/**
 * Pure gate evaluation in the documented precedence order. `warn` is called
 * at most once: unqualified and capability fail loudly; env, mode and
 * compaction-off fail silently.
 */
export function evaluateGate(deps: GateDeps): GateResult {
  // 1. Environment kill switch, silent.
  if (deps.env[EARLY_COMPACTION_ENV] === "0") {
    return { state: "dormant", reason: "env" };
  }

  // 2. Session kind and mode, silent. "rpc" needs an explicit opt-in.
  const mode = deps.ctx.mode;
  const modeAdmitted =
    mode === "tui" ||
    (mode === "rpc" && deps.config?.allowRpcInteractive === true);
  if (deps.sessionKind !== "interactive" || !modeAdmitted) {
    return { state: "dormant", reason: "mode" };
  }

  // 3. Compaction disabled by the user, silent. A getter that throws or is
  // absent falls through to the capability check instead of crashing.
  let settings: { readonly enabled?: boolean } | undefined;
  let settingsReadFailed = false;
  const readSettings = deps.ctx.getCompactionSettings;
  if (typeof readSettings === "function") {
    try {
      settings = readSettings.call(deps.ctx);
    } catch {
      settingsReadFailed = true;
    }
  }
  if (settings?.enabled === false) {
    return { state: "dormant", reason: "compaction-off" };
  }

  // 4. Qualified version + unchanged builtin files, one warning.
  if (
    !isQualified(
      deps.qualifiedSnapshot,
      deps.version,
      deps.installedFingerprints,
    )
  ) {
    deps.warn(unqualifiedWarning(deps.version));
    return { state: "dormant", reason: "unqualified" };
  }

  // 5. Capability surface and the todo-8 override self-test, one warning.
  let missing: readonly string[];
  try {
    missing = deps.capabilityProbe();
  } catch {
    missing = ["capability probe"];
  }
  if (settingsReadFailed) {
    missing = [...missing, "ctx.getCompactionSettings()"];
  }

  let selfTestOk = false;
  try {
    const selfTest = deps.overrideSelfTest;
    selfTestOk =
      typeof selfTest === "function" ? selfTest() === true : selfTest === true;
  } catch {
    selfTestOk = false;
  }

  if (missing.length > 0 || !selfTestOk) {
    deps.warn(capabilityWarning(missing, selfTestOk));
    return { state: "dormant", reason: "capability" };
  }

  return { state: "active" };
}

/** Per-session wrapper: the gate runs once and warnings are emitted once. */
export interface SessionGate {
  evaluate(): GateResult;
}

/** Evaluate `deps` at most once; later calls return the first result. */
export function createSessionGate(deps: GateDeps): SessionGate {
  let result: GateResult | undefined;
  return {
    evaluate(): GateResult {
      result ??= evaluateGate(deps);
      return result;
    },
  };
}

/** Options for the real adapter. `ctx` is the live `ExtensionContext`. */
export interface RealGateOptions {
  readonly pi: { readonly sessionKind: string };
  readonly ctx: unknown;
  readonly config?: GateConfig | undefined;
  readonly overrideSelfTest: boolean | (() => boolean);
  /** Defaults to `ctx.ui.notify(message, "warning")` when available. */
  readonly warn?: ((message: string) => void) | undefined;
  readonly version?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Defaults to `getPackageDir()`; tests inject a fixture package root. */
  readonly packageDir?: string | undefined;
  /** Defaults to the live root exports; tests inject a fake surface. */
  readonly root?: RootCapabilities | undefined;
}

function defaultWarn(ctx: Record<string, unknown>, message: string): void {
  const ui = asRecord(ctx.ui);
  const notify = ui?.notify;
  if (typeof notify === "function") {
    try {
      (notify as (text: string, level?: string) => void).call(
        ui,
        message,
        "warning",
      );
    } catch {
      // A broken UI must not turn a dormant gate into a load failure.
    }
  }
}

/** Build pure dependencies from the live session, files and package. */
export function realGateDeps(options: RealGateOptions): GateDeps {
  const ctx = asRecord(options.ctx) ?? {};
  const agentDir = typeof ctx.agentDir === "string" ? ctx.agentDir : "";
  const mode = typeof ctx.mode === "string" ? ctx.mode : "";
  const getSettings = ctx.getCompactionSettings;

  const gateContext: GateContext = {
    mode,
    getCompactionSettings:
      typeof getSettings === "function"
        ? () =>
            (
              getSettings as () => { readonly enabled?: boolean } | undefined
            ).call(ctx)
        : undefined,
  };

  return {
    sessionKind: options.pi.sessionKind,
    version: options.version ?? VERSION,
    env: options.env ?? process.env,
    config: options.config,
    ctx: gateContext,
    qualifiedSnapshot: agentDir === "" ? undefined : readQualifiedSnapshot(agentDir),
    installedFingerprints: readInstalledFingerprints(options.packageDir),
    capabilityProbe: () => probeCapabilities(options.ctx, options.root),
    overrideSelfTest: options.overrideSelfTest,
    warn: options.warn ?? ((message) => defaultWarn(ctx, message)),
  };
}

/** Thin real adapter: read the session/files and run the gate once. */
export function evaluateRealGate(options: RealGateOptions): GateResult {
  return evaluateGate(realGateDeps(options));
}

/** Real adapter wrapped for a single session (one warning per session). */
export function createRealSessionGate(options: RealGateOptions): SessionGate {
  return createSessionGate(realGateDeps(options));
}
