import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, getPackageDir } from "@code-yeongyu/senpi";
import {
  EARLY_COMPACTION_ENV,
  QUALIFIED_FILES,
  capabilityWarning,
  createRealSessionGate,
  createSessionGate,
  evaluateGate,
  evaluateRealGate,
  isQualified,
  isQualifiedSnapshot,
  parseQualifiedSnapshot,
  probeCapabilities,
  qualifiedFilePath,
  qualifiedFilesDirectory,
  readInstalledFingerprints,
  readQualifiedSnapshot,
  unqualifiedWarning,
  type GateDeps,
  type GateReason,
  type GateResult,
  type QualifiedFile,
  type RootCapabilities,
} from "../src/gate";

const TEST_VERSION = "2026.10.19";

const FIXED_HASHES: Record<QualifiedFile, string> = {
  "prompts.js": "a".repeat(64),
  "task-intent.js": "b".repeat(64),
  "policy.js": "c".repeat(64),
  "idle.js": "d".repeat(64),
  "speculative.js": "e".repeat(64),
};

function snapshotFor(
  version: string,
  fingerprints: Readonly<Partial<Record<QualifiedFile, string>>>,
  identity = `${TEST_VERSION}+1700000000.abcdef0`,
): unknown {
  return {
    schema: 1,
    versions: { [version]: { identity, fingerprints } },
  };
}

function makeDeps(overrides: Partial<GateDeps> = {}): {
  deps: GateDeps;
  warnings: string[];
} {
  const warnings: string[] = [];
  const deps: GateDeps = {
    sessionKind: "interactive",
    version: TEST_VERSION,
    env: {},
    config: {},
    ctx: { mode: "tui", getCompactionSettings: () => ({ enabled: true }) },
    qualifiedSnapshot: snapshotFor(TEST_VERSION, FIXED_HASHES),
    installedFingerprints: FIXED_HASHES,
    capabilityProbe: () => [],
    overrideSelfTest: true,
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { deps, warnings };
}

function expectDormant(result: GateResult, reason: GateReason): void {
  expect(result.state).toBe("dormant");
  if (result.state !== "dormant") throw new Error("expected a dormant result");
  expect(result.reason).toBe(reason);
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeQualified(
  agentDir: string,
  version: string,
  fingerprints: Readonly<Partial<Record<QualifiedFile, string>>>,
): void {
  mkdirSync(join(agentDir, "early-compaction"), { recursive: true });
  writeFileSync(
    qualifiedFilePath(agentDir),
    JSON.stringify({
      schema: 1,
      versions: { [version]: { identity: "test-build", fingerprints } },
    }),
    "utf8",
  );
}

/** Independently hash the installed builtin files, without the module helper. */
function realFingerprints(): Record<QualifiedFile, string> {
  const directory = qualifiedFilesDirectory(getPackageDir());
  const fingerprints = {} as Record<QualifiedFile, string>;
  for (const file of QUALIFIED_FILES) {
    fingerprints[file] = createHash("sha256")
      .update(readFileSync(join(directory, file)))
      .digest("hex");
  }
  return fingerprints;
}

/** Fake live context with every capability present. */
function capableCtx(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "tui",
    agentDir: "/nonexistent",
    applyCompaction() {},
    getMessageRevision() {
      return 0;
    },
    isCompacting() {
      return false;
    },
    onUserActivity() {
      return () => {};
    },
    getCompactionSettings() {
      return { enabled: true };
    },
    getContextUsage() {
      return undefined;
    },
    isIdle() {
      return true;
    },
    hasPendingMessages() {
      return false;
    },
    modelRegistry: {
      find() {
        return undefined;
      },
      getApiKeyAndHeaders() {
        return { ok: false, error: "unused" };
      },
      complete() {
        throw new Error("unused");
      },
    },
    ...overrides,
  };
}

function capableRoot(
  overrides: RootCapabilities = {},
): RootCapabilities {
  return {
    findCutPoint() {},
    buildSessionProjection() {},
    estimateTokens() {},
    serializeConversation() {},
    convertToLlm() {},
    ExtensionRunner: { prototype: { bindCore() {} } },
    ...overrides,
  };
}

describe("gate: active", () => {
  test("all pieces present and self-test passing yields active with no warning", () => {
    const { deps, warnings } = makeDeps();
    expect(evaluateGate(deps)).toEqual({ state: "active" });
    expect(warnings).toHaveLength(0);
  });
});

describe("gate: one case per dormant reason", () => {
  test("env dormant is silent", () => {
    const { deps, warnings } = makeDeps({
      env: { [EARLY_COMPACTION_ENV]: "0" },
    });
    expectDormant(evaluateGate(deps), "env");
    expect(warnings).toHaveLength(0);
  });

  test("mode dormant is silent for a worker session", () => {
    const { deps, warnings } = makeDeps({ sessionKind: "worker" });
    expectDormant(evaluateGate(deps), "mode");
    expect(warnings).toHaveLength(0);
  });

  test("mode dormant is silent for a non-tui, non-rpc mode", () => {
    const { deps, warnings } = makeDeps({
      ctx: { mode: "json", getCompactionSettings: () => ({ enabled: true }) },
    });
    expectDormant(evaluateGate(deps), "mode");
    expect(warnings).toHaveLength(0);
  });

  test("compaction-off dormant is silent", () => {
    const { deps, warnings } = makeDeps({
      ctx: { mode: "tui", getCompactionSettings: () => ({ enabled: false }) },
    });
    expectDormant(evaluateGate(deps), "compaction-off");
    expect(warnings).toHaveLength(0);
  });

  test("unqualified dormant warns exactly once", () => {
    const { deps, warnings } = makeDeps({ qualifiedSnapshot: undefined });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(unqualifiedWarning(TEST_VERSION));
  });

  test("capability dormant warns exactly once", () => {
    const { deps, warnings } = makeDeps({
      capabilityProbe: () => ["ctx.getMessageRevision"],
    });
    expectDormant(evaluateGate(deps), "capability");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ctx.getMessageRevision");
    expect(warnings[0]).toBe(capabilityWarning(["ctx.getMessageRevision"], true));
  });
});

describe("gate: precedence", () => {
  test("env outranks mode, compaction-off, unqualified and capability", () => {
    let probed = false;
    const { deps, warnings } = makeDeps({
      env: { [EARLY_COMPACTION_ENV]: "0" },
      sessionKind: "worker",
      ctx: { mode: "json", getCompactionSettings: () => ({ enabled: false }) },
      qualifiedSnapshot: undefined,
      installedFingerprints: {},
      capabilityProbe: () => {
        probed = true;
        return ["ctx.isIdle"];
      },
      overrideSelfTest: false,
    });
    expectDormant(evaluateGate(deps), "env");
    expect(warnings).toHaveLength(0);
    expect(probed).toBe(false);
  });

  test("mode outranks compaction-off, unqualified and capability", () => {
    let probed = false;
    const { deps, warnings } = makeDeps({
      sessionKind: "worker",
      ctx: { mode: "json", getCompactionSettings: () => ({ enabled: false }) },
      qualifiedSnapshot: undefined,
      installedFingerprints: {},
      capabilityProbe: () => {
        probed = true;
        return ["ctx.isIdle"];
      },
    });
    expectDormant(evaluateGate(deps), "mode");
    expect(warnings).toHaveLength(0);
    expect(probed).toBe(false);
  });

  test("compaction-off outranks unqualified and capability", () => {
    let probed = false;
    const { deps, warnings } = makeDeps({
      ctx: { mode: "tui", getCompactionSettings: () => ({ enabled: false }) },
      qualifiedSnapshot: undefined,
      installedFingerprints: {},
      capabilityProbe: () => {
        probed = true;
        return ["ctx.isIdle"];
      },
    });
    expectDormant(evaluateGate(deps), "compaction-off");
    expect(warnings).toHaveLength(0);
    expect(probed).toBe(false);
  });

  test("unqualified outranks capability", () => {
    const { deps, warnings } = makeDeps({
      qualifiedSnapshot: undefined,
      capabilityProbe: () => ["ctx.isIdle"],
    });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("ctx.isIdle");
  });
});

describe("gate: rpc admission", () => {
  test("rpc mode is dormant without allowRpcInteractive", () => {
    const { deps, warnings } = makeDeps({
      ctx: { mode: "rpc", getCompactionSettings: () => ({ enabled: true }) },
      config: {},
    });
    expectDormant(evaluateGate(deps), "mode");
    expect(warnings).toHaveLength(0);
  });

  test("rpc mode is admitted with allowRpcInteractive", () => {
    const { deps, warnings } = makeDeps({
      ctx: { mode: "rpc", getCompactionSettings: () => ({ enabled: true }) },
      config: { allowRpcInteractive: true },
    });
    expect(evaluateGate(deps)).toEqual({ state: "active" });
    expect(warnings).toHaveLength(0);
  });

  test("rpc opt-in does not admit a worker session", () => {
    const { deps } = makeDeps({
      sessionKind: "worker",
      ctx: { mode: "rpc", getCompactionSettings: () => ({ enabled: true }) },
      config: { allowRpcInteractive: true },
    });
    expectDormant(evaluateGate(deps), "mode");
  });
});

describe("gate: qualified snapshot", () => {
  test("missing version is unqualified with one warning", () => {
    const { deps, warnings } = makeDeps({
      qualifiedSnapshot: snapshotFor("2025.1.1", FIXED_HASHES),
    });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
  });

  test("missing recorded fingerprint key is unqualified with one warning", () => {
    const fingerprints: Partial<Record<QualifiedFile, string>> = {
      ...FIXED_HASHES,
    };
    delete fingerprints["idle.js"];
    const { deps, warnings } = makeDeps({
      qualifiedSnapshot: snapshotFor(TEST_VERSION, fingerprints),
    });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
  });

  test("missing installed fingerprint is unqualified with one warning", () => {
    const installed: Partial<Record<QualifiedFile, string>> = {
      ...FIXED_HASHES,
    };
    delete installed["speculative.js"];
    const { deps, warnings } = makeDeps({ installedFingerprints: installed });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
  });

  test("changed installed hash is unqualified with one warning", () => {
    const installed: Partial<Record<QualifiedFile, string>> = {
      ...FIXED_HASHES,
      "policy.js": "f".repeat(64),
    };
    const { deps, warnings } = makeDeps({ installedFingerprints: installed });
    expectDormant(evaluateGate(deps), "unqualified");
    expect(warnings).toHaveLength(1);
  });

  test("wrong schema, missing identity and malformed hash are rejected", () => {
    const valid = snapshotFor(TEST_VERSION, FIXED_HASHES);
    expect(isQualifiedSnapshot(valid)).toBe(true);
    expect(isQualifiedSnapshot({ schema: 2, versions: {} })).toBe(false);
    expect(
      isQualifiedSnapshot({
        schema: 1,
        versions: { [TEST_VERSION]: { fingerprints: FIXED_HASHES } },
      }),
    ).toBe(false);
    expect(
      isQualifiedSnapshot(
        snapshotFor(TEST_VERSION, {
          ...FIXED_HASHES,
          "prompts.js": "not-a-hash",
        }),
      ),
    ).toBe(false);
  });

  test("parseQualifiedSnapshot handles unreadable JSON and valid JSON", () => {
    expect(parseQualifiedSnapshot(undefined)).toBeUndefined();
    expect(parseQualifiedSnapshot("{not json")).toBeUndefined();
    expect(parseQualifiedSnapshot(JSON.stringify({ schema: 1 }))).toBeUndefined();
    expect(
      parseQualifiedSnapshot(
        JSON.stringify(snapshotFor(TEST_VERSION, FIXED_HASHES)),
      ),
    ).toBeDefined();
  });

  test("isQualified compares every installed hash", () => {
    const snapshot = snapshotFor(TEST_VERSION, FIXED_HASHES);
    expect(isQualified(snapshot, TEST_VERSION, FIXED_HASHES)).toBe(true);
    expect(
      isQualified(snapshot, TEST_VERSION, {
        ...FIXED_HASHES,
        "idle.js": "0".repeat(64),
      }),
    ).toBe(false);
    expect(isQualified(snapshot, "2025.1.1", FIXED_HASHES)).toBe(false);
  });

  test("readQualifiedSnapshot returns undefined for a missing file", () => {
    const agentDir = tempDir("gate-read-");
    expect(readQualifiedSnapshot(agentDir)).toBeUndefined();
  });
});

describe("gate: capability", () => {
  test("a failing override self-test is dormant(capability) with one warning", () => {
    const { deps, warnings } = makeDeps({ overrideSelfTest: false });
    expectDormant(evaluateGate(deps), "capability");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("override self-test");
  });

  test("a throwing override self-test fails closed", () => {
    const { deps, warnings } = makeDeps({
      overrideSelfTest: () => {
        throw new Error("self-test blew up");
      },
    });
    expectDormant(evaluateGate(deps), "capability");
    expect(warnings).toHaveLength(1);
  });

  test("a throwing capability probe fails closed", () => {
    const { deps, warnings } = makeDeps({
      capabilityProbe: () => {
        throw new Error("probe blew up");
      },
    });
    expectDormant(evaluateGate(deps), "capability");
    expect(warnings).toHaveLength(1);
  });

  test("probeCapabilities names the missing context method", () => {
    const ctx = capableCtx({ getMessageRevision: undefined });
    expect(probeCapabilities(ctx, capableRoot())).toEqual([
      "ctx.getMessageRevision",
    ]);
  });

  test("probeCapabilities names missing root exports and the prototype seam", () => {
    expect(
      probeCapabilities(
        capableCtx(),
        capableRoot({
          findCutPoint: undefined,
          ExtensionRunner: { prototype: {} },
        }),
      ),
    ).toEqual(["findCutPoint", "ExtensionRunner.prototype.bindCore"]);
  });

  test("probeCapabilities accepts the live root surface", () => {
    expect(probeCapabilities(capableCtx())).toEqual([]);
  });
});

describe("gate: warning once per session", () => {
  test("the session gate emits one warning across repeated evaluations", () => {
    const { deps, warnings } = makeDeps({ qualifiedSnapshot: undefined });
    const gate = createSessionGate(deps);
    expectDormant(gate.evaluate(), "unqualified");
    expectDormant(gate.evaluate(), "unqualified");
    expect(warnings).toHaveLength(1);
  });

  test("an active session gate stays active and silent", () => {
    const { deps, warnings } = makeDeps();
    const gate = createSessionGate(deps);
    expect(gate.evaluate()).toEqual({ state: "active" });
    expect(gate.evaluate()).toEqual({ state: "active" });
    expect(warnings).toHaveLength(0);
  });
});

describe("gate: real adapter", () => {
  test("installed fingerprints match independently computed sha256 values", () => {
    expect(readInstalledFingerprints()).toEqual(realFingerprints());
  });

  test("active when qualified.json matches the installed package", () => {
    const agentDir = tempDir("gate-real-");
    writeQualified(agentDir, VERSION, realFingerprints());
    const warnings: string[] = [];

    const result = evaluateRealGate({
      pi: { sessionKind: "interactive" },
      ctx: capableCtx({ agentDir }),
      config: {},
      overrideSelfTest: true,
      warn: (message) => warnings.push(message),
      version: VERSION,
      env: {},
      packageDir: getPackageDir(),
      root: capableRoot(),
    });

    expect(result).toEqual({ state: "active" });
    expect(warnings).toHaveLength(0);
  });

  test("unqualified with one warning when qualified.json is absent", () => {
    const agentDir = tempDir("gate-real-missing-");
    const warnings: string[] = [];

    const result = evaluateRealGate({
      pi: { sessionKind: "interactive" },
      ctx: capableCtx({ agentDir }),
      config: {},
      overrideSelfTest: true,
      warn: (message) => warnings.push(message),
      env: {},
      packageDir: getPackageDir(),
      root: capableRoot(),
    });

    expectDormant(result, "unqualified");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(VERSION);
  });

  test("env kill switch stays silent in the real adapter", () => {
    const agentDir = tempDir("gate-real-env-");
    const warnings: string[] = [];

    const result = evaluateRealGate({
      pi: { sessionKind: "interactive" },
      ctx: capableCtx({ agentDir }),
      config: {},
      overrideSelfTest: true,
      warn: (message) => warnings.push(message),
      env: { [EARLY_COMPACTION_ENV]: "0" },
      packageDir: getPackageDir(),
      root: capableRoot(),
    });

    expectDormant(result, "env");
    expect(warnings).toHaveLength(0);
  });

  test("real session gate warns once per session", () => {
    const agentDir = tempDir("gate-real-session-");
    const warnings: string[] = [];
    const gate = createRealSessionGate({
      pi: { sessionKind: "interactive" },
      ctx: capableCtx({ agentDir }),
      config: {},
      overrideSelfTest: true,
      warn: (message) => warnings.push(message),
      env: {},
      packageDir: getPackageDir(),
      root: capableRoot(),
    });

    expectDormant(gate.evaluate(), "unqualified");
    expectDormant(gate.evaluate(), "unqualified");
    expect(warnings).toHaveLength(1);
  });
});
