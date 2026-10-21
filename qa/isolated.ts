/**
 * Isolated QA harness for the early-compaction overlay (todo 14).
 *
 * Runs one subprocess per arm. Each arm loads the bundled
 * `dist/early-compaction.js` from its own temporary agent dir, together with a
 * generated `early-compaction/qualified.json` for the installed senpi version
 * and the five builtin compaction file fingerprints. A deliberately broken
 * bundle can be selected with `--broken-bundle` to prove that the harness
 * reports dormant(capability), fails S1, and exits non-zero.
 *
 * Resource rules: no network except loopback fakes, no writes under the live
 * agent dir, every temp dir is removed in `finally`, and every child is
 * awaited before the next one starts.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { VERSION, engineBuildIdentity } from "@code-yeongyu/senpi";
import { QUALIFIED_FILES, QUALIFIED_SCHEMA, readInstalledFingerprints } from "../src/gate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WORKER = path.join(HERE, "isolated-worker.ts");
const DIST = path.join(REPO, "dist", "early-compaction.js");
const OUT_DIR = path.join(REPO, "qa", "out");
const REPORT_PATH = path.join(OUT_DIR, "isolated-report.json");
const BROKEN_REPORT_PATH = path.join(OUT_DIR, "isolated-broken-report.json");
const OMO_SOURCE = "C:/Users/USER/.omo-stable-500/home/.omo/agent/extensions/omo-compaction-model.ts";
// The coordination mod source built for the coexistence arms; point it at the checkout that
// supports the installed senpi (for example a port worktree before it is merged).
const CM_ROOT = process.env.PIOMO_QA_CM_ROOT || "C:/Users/USER/orca/projects/piomo-agent-coordination-mod";
const EVIDENCE_FILE =
  "C:/Users/USER/orca/projects/기타 작업/.omo/evidence/overlay-early-compaction-mod/task-14-overlay-early-compaction-mod.json";

type Json = Record<string, unknown>;

interface ChildResult {
  caseName: string;
  pass: boolean;
  scenarios: Array<{ id: string; pass: boolean; observable: string; details?: Json }>;
  artifacts: Json;
  cleanup: { sessions: number; tempDirsRemoved: number; tempDirs: string[] };
  uncaught: string[];
  exitCode: number | null;
  spawnError?: string;
  stdout?: string;
  stderr?: string;
}

const BROKEN = process.argv.includes("--broken-bundle");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureDist(): void {
  if (!fs.existsSync(DIST)) {
    throw new Error(`missing ${DIST}; run \`bun run build\` first`);
  }
}

function qualifiedDocument(variant: "base" | "version" | "fingerprint"): Json {
  const fingerprints = readInstalledFingerprints();
  const identity =
    typeof engineBuildIdentity === "function" ? engineBuildIdentity()?.text : undefined;
  const entry = {
    identity: typeof identity === "string" && identity.length > 0 ? identity : VERSION,
    fingerprints: Object.fromEntries(QUALIFIED_FILES.map((file) => [file, fingerprints[file]])),
  };
  if (variant === "version") {
    return { schema: QUALIFIED_SCHEMA, versions: {} };
  }
  if (variant === "fingerprint") {
    return {
      schema: QUALIFIED_SCHEMA,
      versions: {
        [VERSION]: {
          ...entry,
          fingerprints: { ...entry.fingerprints, "prompts.js": "0".repeat(64) },
        },
      },
    };
  }
  return { schema: QUALIFIED_SCHEMA, versions: { [VERSION]: entry } };
}

function buildCmBundle(root: string): string {
  const outdir = path.join(root, "cm-build");
  fs.mkdirSync(outdir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "build",
      path.join(CM_ROOT, "src", "extension.ts"),
      path.join(CM_ROOT, "src", "public-api.ts"),
      "--outdir",
      outdir,
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "@code-yeongyu/senpi",
    ],
    { cwd: CM_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  if (result.error) throw new Error(`CM build failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`CM build failed (${result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  const extension = path.join(outdir, "extension.js");
  if (!fs.existsSync(extension)) throw new Error(`CM build produced no ${extension}`);
  return extension;
}

function makeBrokenBundle(root: string): string {
  const directory = path.join(root, "broken");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "early-compaction.js");
  const source = fs.readFileSync(DIST, "utf8");
  const patch = [
    "",
    'import { ModelRegistry as __qaBrokenRegistry } from "@code-yeongyu/senpi";',
    "__qaBrokenRegistry.prototype.complete = undefined;",
    "",
  ].join("\n");
  fs.writeFileSync(target, source + patch, "utf8");
  return target;
}

function runWorker(
  root: string,
  caseName: string,
  options: {
    armDir: string;
    workerCase?: string;
    bundlePath?: string;
    qualified?: Json;
    env?: Record<string, string>;
    order?: string[];
    variant?: "version" | "fingerprint";
    s8SessionFile?: string;
    config?: Json;
    cmExtensionPath?: string;
  },
): ChildResult {
  const configPath = path.join(options.armDir, `${caseName}-config.json`);
  const resultPath = path.join(options.armDir, `${caseName}-result.json`);
  const config = {
    caseName: options.workerCase ?? caseName,
    bundlePath: options.bundlePath ?? DIST,
    omoSource: OMO_SOURCE,
    cmExtensionPath: options.cmExtensionPath,
    armDir: options.armDir,
    qualified: options.qualified ?? qualifiedDocument("base"),
    config: options.config ?? { mode: "notes", policy: {}, allowRpcInteractive: false },
    order: options.order,
    variant: options.variant,
    s8SessionFile: options.s8SessionFile,
    brokenBundle: BROKEN,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const spawned = spawnSync(
    process.execPath,
    [WORKER, "--config", configPath, "--out", resultPath],
    {
      cwd: REPO,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
    },
  );
  if (spawned.error) {
    return {
      caseName,
      pass: false,
      scenarios: [],
      artifacts: {},
      cleanup: { sessions: 0, tempDirsRemoved: 0, tempDirs: [] },
      uncaught: [],
      exitCode: null,
      spawnError: spawned.error.message,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
    };
  }
  if (!fs.existsSync(resultPath)) {
    return {
      caseName,
      pass: false,
      scenarios: [],
      artifacts: {},
      cleanup: { sessions: 0, tempDirsRemoved: 0, tempDirs: [] },
      uncaught: [],
      exitCode: spawned.status,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")) as ChildResult;
  return {
    ...parsed,
    exitCode: spawned.status,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
  };
}

function scenarioOf(child: ChildResult, id: string): ChildResult["scenarios"][number] | undefined {
  return child.scenarios.find((scenario) => scenario.id === id);
}

function childFailed(child: ChildResult): boolean {
  return child.exitCode !== 0 || child.spawnError !== undefined || child.uncaught.length > 0;
}

function guardCheck(): { pass: boolean; observable: string; details: Json } {
  const result = spawnSync("node", ["qa/ag-guard.mjs", "check"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
  });
  let parsed: Json = {};
  try {
    parsed = JSON.parse((result.stdout ?? "").trim()) as Json;
  } catch {
    parsed = { command: "check", ok: false, reasons: ["unparseable-output"] };
  }
  return {
    pass: result.status === 0 && parsed.ok === true,
    observable:
      result.status === 0
        ? `ag-guard check ok (reported=${JSON.stringify(parsed.reported ?? [])})`
        : `ag-guard check failed: ${JSON.stringify(parsed.reasons ?? result.stderr ?? "")}`,
    details: parsed,
  };
}

// The guard compares the live agent dir with its state when this run starts, so an
// installed mod is not residue; only what this run would add or change fails S9.
function guardBaseline(): void {
  const result = spawnSync("node", ["qa/ag-guard.mjs", "baseline"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`ag-guard baseline failed (${result.status}): ${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
}

function tempAgentDirs(): Set<string> {
  try {
    return new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("piomo-continuity-agent-")),
    );
  } catch {
    return new Set();
  }
}

function runBroken(root: string): never {
  const armDir = fs.mkdtempSync(path.join(root, "broken-arm-"));
  const brokenBundle = makeBrokenBundle(root);
  const child = runWorker(root, "BROKEN", {
    armDir,
    bundlePath: brokenBundle,
    config: { mode: "notes", policy: { startJitterMaxMs: 0 }, allowRpcInteractive: false },
  });
  const gate = scenarioOf(child, "broken-gate");
  const s1 = scenarioOf(child, "S1");
  const detected =
    child.exitCode === 0 &&
    child.uncaught.length === 0 &&
    gate?.pass === true &&
    s1?.pass === false;
  const report = {
    schema: 1,
    task: 14,
    mode: "broken-bundle",
    generatedAt: new Date().toISOString(),
    detected,
    armB: {
      pass: child.pass === false,
      gate: gate ?? null,
      s1: s1 ?? null,
      uncaught: child.uncaught,
      exitCode: child.exitCode,
      spawnError: child.spawnError ?? null,
    },
    report: child.artifacts,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BROKEN_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ mode: "broken-bundle", detected, report: BROKEN_REPORT_PATH }));
  process.exit(detected ? 1 : 2);
}

async function main(): Promise<void> {
  ensureDist();
  if (!fs.existsSync(OMO_SOURCE)) throw new Error(`missing OMO source ${OMO_SOURCE}`);
  guardBaseline();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piomo-isolated-"));
  const beforeAgentDirs = tempAgentDirs();
  const startedAt = new Date().toISOString();
  const distSha = sha256(fs.readFileSync(DIST));
  try {
    if (BROKEN) runBroken(root);

    const cmExtension = buildCmBundle(root);
    const baseQualified = qualifiedDocument("base");

    const children: Record<string, ChildResult> = {};
    const run = (name: string, options: Parameters<typeof runWorker>[2]): ChildResult => {
      const child = runWorker(root, name, {
        ...options,
        cmExtensionPath: options.cmExtensionPath ?? cmExtension,
      });
      children[name] = child;
      return child;
    };

    run("A", { armDir: fs.mkdtempSync(path.join(root, "arm-A-")) });

    const b = run("B", { armDir: fs.mkdtempSync(path.join(root, "arm-B-")) });
    const bSessionFile = (b.artifacts.s8 as Json | undefined)?.sessionFile;
    const s8Open =
      typeof bSessionFile === "string"
        ? run("S8-OPEN", {
            armDir: fs.mkdtempSync(path.join(root, "arm-S8open-")),
            workerCase: "S8-OPEN",
            s8SessionFile: bSessionFile,
            env: { PIOMO_EARLY_COMPACTION: "0" },
          })
        : undefined;

    run("C-omo-mod", {
      armDir: fs.mkdtempSync(path.join(root, "arm-C1-")),
      workerCase: "C",
      order: ["omo", "mod"],
      env: { OMO_COMPACTION_MODEL_RECEIPT: path.join(root, "omo-c1.jsonl") },
    });
    run("C-mod-omo", {
      armDir: fs.mkdtempSync(path.join(root, "arm-C2-")),
      workerCase: "C",
      order: ["mod", "omo"],
      env: { OMO_COMPACTION_MODEL_RECEIPT: path.join(root, "omo-c2.jsonl") },
    });

    run("D", {
      armDir: fs.mkdtempSync(path.join(root, "arm-D-")),
      env: { PIOMO_EARLY_COMPACTION: "0" },
    });
    run("E", { armDir: fs.mkdtempSync(path.join(root, "arm-E-")) });
    run("F-version", {
      armDir: fs.mkdtempSync(path.join(root, "arm-F1-")),
      workerCase: "F",
      qualified: qualifiedDocument("version"),
      variant: "version",
    });
    run("F-fingerprint", {
      armDir: fs.mkdtempSync(path.join(root, "arm-F2-")),
      workerCase: "F",
      qualified: qualifiedDocument("fingerprint"),
      variant: "fingerprint",
    });
    run("G", { armDir: fs.mkdtempSync(path.join(root, "arm-G-")) });
    run("H-cm-mod", {
      armDir: fs.mkdtempSync(path.join(root, "arm-H1-")),
      workerCase: "H",
      order: ["cm", "mod"],
      env: { OMO_COMPACTION_MODEL_RECEIPT: path.join(root, "omo-h1.jsonl") },
    });
    run("H-mod-cm", {
      armDir: fs.mkdtempSync(path.join(root, "arm-H2-")),
      workerCase: "H",
      order: ["mod", "cm"],
      env: { OMO_COMPACTION_MODEL_RECEIPT: path.join(root, "omo-h2.jsonl") },
    });
    run("RELOAD-PARKED", { armDir: fs.mkdtempSync(path.join(root, "arm-reload-")) });
    run("TWO-SESSIONS", { armDir: fs.mkdtempSync(path.join(root, "arm-two-")) });
    run("SLOTS", { armDir: fs.mkdtempSync(path.join(root, "arm-slots-")) });

    const guard = guardCheck();

    const scenarioMap: Record<string, { pass: boolean; observable: string; details?: Json }> = {};
    const put = (id: string, pass: boolean, observable: string, details?: Json): void => {
      scenarioMap[id] = { pass, observable, ...(details ? { details } : {}) };
    };
    const fromChild = (child: ChildResult, scenarioId: string): ChildResult["scenarios"][number] | undefined =>
      scenarioOf(child, scenarioId);

    // S1-S5, S13-S20: arm B.
    for (const id of [
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S13",
      "S14",
      "S15",
      "S16",
      "S17",
      "S18",
      "S19",
      "S20",
    ]) {
      const scenario = fromChild(b, id);
      put(id, scenario?.pass === true, scenario?.observable ?? `arm B produced no ${id} result`, scenario?.details);
    }

    // S6: arm A >= 1 speculative start, arm B 0.
    const a = children.A;
    const s6a = fromChild(a, "S6-arm-A");
    const s6b = fromChild(b, "S6-arm-B");
    put(
      "S6",
      s6a?.pass === true && s6b?.pass === true,
      `A: ${s6a?.observable ?? "missing"}; B: ${s6b?.observable ?? "missing"}`,
      { a: a.artifacts.s6a ?? null, b: b.artifacts.s6b ?? null },
    );

    // S7: arm G equals arm A (entry types, compaction count, no footer).
    const g = children.G;
    const s7a = fromChild(a, "S7-arm-A");
    const s7g = fromChild(g, "S7-arm-G");
    const aSnap = a.artifacts.s7a as Json | undefined;
    const gSnap = g.artifacts.s7g as Json | undefined;
    const sameTypes =
      JSON.stringify(aSnap?.entryTypes) === JSON.stringify(gSnap?.entryTypes) &&
      aSnap?.compactionCount === gSnap?.compactionCount;
    const noFooter = aSnap?.uiStatuses === 0 && gSnap?.uiStatuses === 0;
    put(
      "S7",
      s7a?.pass === true && s7g?.pass === true && sameTypes && noFooter,
      `A=${JSON.stringify(aSnap)} G=${JSON.stringify(gSnap)} same=${sameTypes} noFooter=${noFooter}`,
      { a: aSnap ?? null, g: gSnap ?? null },
    );

    // S8: the mod session file opens in a stock session.
    const s8Produce = fromChild(b, "S8-produce");
    const s8OpenScenario = s8Open ? fromChild(s8Open, "S8-open") : undefined;
    put(
      "S8",
      s8Produce?.pass === true && s8OpenScenario?.pass === true && s8Open?.exitCode === 0,
      `${s8Produce?.observable ?? "missing"}; ${s8OpenScenario?.observable ?? "missing"}`,
      { sessionFile: bSessionFile ?? null },
    );

    put("S9", guard.pass, guard.observable, guard.details);

    const s10 = fromChild(children.SLOTS, "S10");
    put("S10", s10?.pass === true, s10?.observable ?? "missing", s10?.details);
    const s11 = fromChild(children["RELOAD-PARKED"], "S11");
    put("S11", s11?.pass === true, s11?.observable ?? "missing", s11?.details);
    const s12 = fromChild(children["TWO-SESSIONS"], "S12");
    put("S12", s12?.pass === true, s12?.observable ?? "missing", s12?.details);

    const c1 = children["C-omo-mod"];
    const c2 = children["C-mod-omo"];
    const c1Scenario = c1.scenarios.find((scenario) => scenario.id.startsWith("C-"));
    const c2Scenario = c2.scenarios.find((scenario) => scenario.id.startsWith("C-"));
    const dScenario = fromChild(children.D, "D-env");
    const eScenarios = children.E?.scenarios.filter((scenario) => scenario.id.startsWith("E-")) ?? [];
    const f1Scenario = fromChild(children["F-version"], "F-version");
    const f2Scenario = fromChild(children["F-fingerprint"], "F-fingerprint");
    const h1 = children["H-cm-mod"];
    const h2 = children["H-mod-cm"];

    const armPass: Record<string, boolean> = {
      A: a?.pass === true && childFailed(a) === false,
      B: b?.pass === true && childFailed(b) === false && scenarioMap.S8?.pass === true,
      C: c1?.pass === true && c2?.pass === true && !childFailed(c1) && !childFailed(c2),
      D: dScenario?.pass === true && !childFailed(children.D),
      E:
        children.E?.pass === true &&
        eScenarios.length === 3 &&
        eScenarios.every((scenario) => scenario.pass) &&
        !childFailed(children.E),
      F:
        f1Scenario?.pass === true &&
        f2Scenario?.pass === true &&
        !childFailed(children["F-version"]) &&
        !childFailed(children["F-fingerprint"]),
      G:
        s7g?.pass === true &&
        scenarioMap.S7?.pass === true &&
        !childFailed(g),
      H:
        h1?.pass === true &&
        h2?.pass === true &&
        !childFailed(h1) &&
        !childFailed(h2) &&
        h1.scenarios.filter((scenario) => scenario.id.startsWith("H-")).length === 3 &&
        h2.scenarios.filter((scenario) => scenario.id.startsWith("H-")).length === 3,
    };

    let allPass =
      Object.keys(armPass).every((arm) => armPass[arm]) &&
      Array.from({ length: 20 }, (_, index) => `S${index + 1}`).every((id) => scenarioMap[id]?.pass === true) &&
      Object.values(scenarioMap).every((scenario) => scenario.pass);

    for (const child of Object.values(children)) {
      if (childFailed(child)) allPass = false;
    }

    const afterAgentDirs = tempAgentDirs();
    const leakedAgentDirs = [...afterAgentDirs].filter((name) => !beforeAgentDirs.has(name));
    const leakedTempRoots = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("piomo-isolated-") && path.join(os.tmpdir(), name) !== root);

    const cleanup: Json = {
      root,
      rootRemoved: false,
      children: Object.fromEntries(
        Object.entries(children).map(([name, child]) => [
          name,
          {
            tempDirsRemoved: child.cleanup.tempDirsRemoved,
            sessions: child.cleanup.sessions,
            uncaught: child.uncaught.length,
          },
        ]),
      ),
      leakedAgentDirs,
      leakedTempRoots,
    };

    const report: Json = {
      schema: 1,
      task: 14,
      generatedAt: new Date().toISOString(),
      startedAt,
      senpiVersion: VERSION,
      dist: { path: "dist/early-compaction.js", sha256: distSha },
      scenarios: scenarioMap,
      arms: Object.fromEntries(
        Object.entries(armPass).map(([arm, pass]) => [
          arm,
          {
            pass,
            cases: Object.entries(children)
              .filter(([name]) => name === arm || name.startsWith(`${arm}-`))
              .map(([name, child]) => ({
                caseName: name,
                exitCode: child.exitCode,
                scenarios: child.scenarios.map((scenario) => ({
                  id: scenario.id,
                  pass: scenario.pass,
                  observable: scenario.observable,
                })),
                uncaught: child.uncaught,
              })),
          },
        ]),
      ),
      armDetails: {
        C: [c1Scenario ?? null, c2Scenario ?? null],
        D: dScenario ?? null,
        E: eScenarios,
        F: [f1Scenario ?? null, f2Scenario ?? null],
        H: {
          "cm-mod": h1?.scenarios ?? [],
          "mod-cm": h2?.scenarios ?? [],
        },
      },
      cleanup,
      exitCodes: Object.fromEntries(Object.entries(children).map(([name, child]) => [name, child.exitCode])),
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });

    fs.rmSync(root, { recursive: true, force: true });
    cleanup.rootRemoved = !fs.existsSync(root);
    cleanup.evidenceCopied = allPass;

    report.cleanup = cleanup;
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (allPass) {
      try {
        fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
        fs.copyFileSync(REPORT_PATH, EVIDENCE_FILE);
      } catch (error) {
        cleanup.evidenceCopied = false;
        cleanup.evidenceError = error instanceof Error ? error.message : String(error);
        allPass = false;
        fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
    }

    console.log(
      JSON.stringify({
        report: REPORT_PATH,
        pass: allPass,
        scenarios: scenarioMap,
        arms: armPass,
        cleanup,
      }),
    );
    process.exit(allPass && cleanup.rootRemoved === true ? 0 : 1);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // The report already records whether removal succeeded.
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
