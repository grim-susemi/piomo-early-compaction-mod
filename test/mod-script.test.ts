import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "mod.mjs");

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempAgent(settings: string | null = "{}\n"): string {
  const directory = mkdtempSync(join(tmpdir(), "early-compaction-mod-"));
  temporaryDirs.push(directory);
  if (settings !== null) writeFileSync(join(directory, "settings.json"), settings);
  mkdirSync(join(directory, "extensions"), { recursive: true });
  return directory;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function fields(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) map.set(line.slice(0, index), line.slice(index + 1));
  }
  return map;
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) {
        out[relative(root, full).split("\\").join("/")] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("full lifecycle: install, status, off, on, mode, report, remove", () => {
  const agent = tempAgent();
  const state = join(agent, "early-compaction");
  const extension = join(agent, "extensions", "early-compaction.js");
  const parked = join(state, "parked", "early-compaction.js");

  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  expect(existsSync(extension)).toBe(true);

  const config = readJson(join(state, "config.json"));
  const defaults = readJson(join(REPO, "config.default.json"));
  expect(config.mode).toBe(defaults.mode);
  expect(config.schema).toBe(defaults.schema);

  const receipts = readdirSync(join(state, "receipts")).sort();
  expect(receipts.length).toBe(2);
  const receiptName = receipts.find((name) => name.endsWith(".json"));
  const sealName = receipts.find((name) => name.endsWith(".json.seal"));
  expect(receiptName).toBeDefined();
  expect(sealName).toBeDefined();
  const receiptBytes = readFileSync(join(state, "receipts", receiptName!));
  const receiptHash = createHash("sha256").update(receiptBytes).digest("hex");
  expect(readFileSync(join(state, "receipts", sealName!), "utf8").trim()).toBe(
    receiptHash,
  );
  const receipt = JSON.parse(receiptBytes.toString());
  expect(receipt.command).toBe("install");
  expect(receipt.files["extensions/early-compaction.js"]).toBe(
    createHash("sha256").update(readFileSync(extension)).digest("hex"),
  );
  expect(receipt.settings.after_sha256).toBe(receipt.settings.before_sha256);

  const activeStatus = runCli(["status", "--agent-dir", agent]);
  expect(activeStatus.status, activeStatus.stderr).toBe(0);
  const active = fields(activeStatus.stdout);
  expect(active.get("status")).toBe("active");
  expect(active.get("mode")).toBe("notes");
  expect(active.get("residue")).toBe("none");
  expect(active.get("drift")).toBe("none");

  const off = runCli(["off", "--agent-dir", agent]);
  expect(off.status, off.stderr).toBe(0);
  expect(existsSync(extension)).toBe(false);
  expect(existsSync(parked)).toBe(true);
  const parkedStatus = runCli(["status", "--agent-dir", agent]);
  expect(parkedStatus.status, parkedStatus.stderr).toBe(0);
  expect(fields(parkedStatus.stdout).get("status")).toBe("parked");

  const on = runCli(["on", "--agent-dir", agent]);
  expect(on.status, on.stderr).toBe(0);
  expect(existsSync(extension)).toBe(true);
  expect(existsSync(parked)).toBe(false);

  const mode = runCli(["mode", "rewrite", "--agent-dir", agent]);
  expect(mode.status, mode.stderr).toBe(0);
  expect(readJson(join(state, "config.json")).mode).toBe("rewrite");

  const metrics = [
    {
      v: 1,
      ts: "2026-10-19T00:00:00.000Z",
      session: "0123456789abcdef",
      model: "test",
      event: "apply",
      jobId: "job-1",
      route: "cold",
      site: "timer",
      result: "ok",
      tokensBefore: 1000,
      estimatedTokensAfter: 400,
      summaryTokens: 100,
      notesBlocks: 1,
    },
    {
      v: 1,
      ts: "2026-10-19T00:00:01.000Z",
      session: "0123456789abcdef",
      model: "test",
      event: "apply",
      jobId: "job-2",
      route: "boundary",
      site: "agent_settled",
      result: "stale",
      tokensBefore: 900,
      estimatedTokensAfter: 900,
      summaryTokens: 0,
      notesBlocks: 0,
    },
    {
      v: 1,
      ts: "2026-10-19T00:00:02.000Z",
      session: "0123456789abcdef",
      model: "test",
      event: "threshold_cross",
      U: 10,
      T: 9,
    },
    {
      v: 1,
      ts: "2026-10-19T00:00:03.000Z",
      session: "0123456789abcdef",
      model: "test",
      event: "next_usage",
      input: 100,
      cacheRead: 300,
      cacheWrite: 0,
      systemHash: "abc123abc123",
    },
  ];
  writeFileSync(
    join(state, "metrics.jsonl"),
    `${metrics.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  mkdirSync(join(agent, "logs"), { recursive: true });
  writeFileSync(
    join(agent, "logs", "compaction.log"),
    [
      JSON.stringify({ ts: "2026-10-19T00:00:04.000Z", event: "idle_applied" }),
      JSON.stringify({
        ts: "2026-10-19T00:00:05.000Z",
        event: "speculative_started",
      }),
      JSON.stringify({
        ts: "2026-10-19T00:00:06.000Z",
        event: "speculative_applied",
      }),
    ].join("\n") + "\n",
  );

  const report = runCli(["report", "--agent-dir", agent]);
  expect(report.status, report.stderr).toBe(0);
  for (const line of report.stdout.trim().split(/\r?\n/)) {
    expect(line).toMatch(/^[a-z][a-z0-9_.]*=-?\d+(?:\.\d+)?$/);
  }
  const numbers = fields(report.stdout);
  expect(numbers.get("applies.cold")).toBe("1");
  expect(numbers.get("applies.boundary")).toBe("0");
  expect(numbers.get("applies.threshold")).toBe("0");
  expect(numbers.get("tokens_saved")).toBe("600");
  expect(numbers.get("threshold_crossings")).toBe("1");
  expect(numbers.get("builtin_compactions")).toBe("2");
  expect(numbers.get("cache_read_ratio")).toBe("0.7500");

  const remove = runCli(["remove", "--agent-dir", agent, "--purge-logs"]);
  expect(remove.status, remove.stderr).toBe(0);
  expect(existsSync(extension)).toBe(false);
  expect(existsSync(state)).toBe(false);
  const removal = JSON.parse(remove.stdout);
  expect(removal.command).toBe("remove");
  expect(removal.purged_logs).toBe(true);

  const cleanStatus = runCli(["status", "--agent-dir", agent]);
  expect(cleanStatus.status, cleanStatus.stdout + cleanStatus.stderr).toBe(0);
  const clean = fields(cleanStatus.stdout);
  expect(clean.get("status")).toBe("absent");
  expect(clean.get("residue")).toBe("none");
  expect(clean.get("drift")).toBe("none");
});

test("install keeps an existing config.json", () => {
  const agent = tempAgent();
  const state = join(agent, "early-compaction");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "config.json"),
    `${JSON.stringify({ schema: 1, mode: "rewrite", custom: true })}\n`,
  );
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  expect(readJson(join(state, "config.json"))).toEqual({
    schema: 1,
    mode: "rewrite",
    custom: true,
  });
});

test("--dry-run leaves the agent tree unchanged", () => {
  const agent = tempAgent();
  const before = snapshot(agent);
  const result = runCli(["install", "--agent-dir", agent, "--dry-run"]);
  expect(result.status, result.stderr).toBe(0);
  expect(snapshot(agent)).toEqual(before);
});

test("missing or relative --agent-dir exits non-zero with a usage line", () => {
  const missing = runCli(["install"]);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("usage: bun scripts/mod.mjs");

  const relativeDir = runCli(["status", "--agent-dir", "relative/agent"]);
  expect(relativeDir.status).not.toBe(0);
  expect(relativeDir.stderr).toContain("usage: bun scripts/mod.mjs");
});

test("a settings.json edit during a writing command exits 3", () => {
  const agent = tempAgent();
  const hook = join(agent, "mutate-settings.mjs");
  writeFileSync(
    hook,
    [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(join(agent, "settings.json"))}, "\\n");`,
      "",
    ].join("\n"),
  );
  const qualifiedOut = join(agent, "qualified-out.json");
  const result = runCli(["qualify", "--agent-dir", agent], {
    PIOMO_MOD_QA_COMMAND: hook,
    PIOMO_MOD_QUALIFIED_PATH: qualifiedOut,
  });
  expect(result.status, result.stderr).toBe(3);
  expect(existsSync(qualifiedOut)).toBe(false);
});

test("qualify records the version, identity and five fingerprints", () => {
  const agent = tempAgent();
  const hook = join(agent, "ok-qa.mjs");
  writeFileSync(hook, "process.exit(0);\n");
  const qualifiedOut = join(agent, "qualified.json");
  const result = runCli(["qualify", "--agent-dir", agent], {
    PIOMO_MOD_QA_COMMAND: hook,
    PIOMO_MOD_QUALIFIED_PATH: qualifiedOut,
  });
  expect(result.status, result.stderr).toBe(0);
  const document = readJson(qualifiedOut);
  expect(document.schema).toBe(1);
  const versions = Object.keys(document.versions);
  expect(versions.length).toBe(1);
  const entry = document.versions[versions[0]];
  expect(typeof entry.identity).toBe("string");
  expect(entry.identity.length).toBeGreaterThan(0);
  expect(Object.keys(entry.fingerprints).sort()).toEqual([
    "idle.js",
    "policy.js",
    "prompts.js",
    "speculative.js",
    "task-intent.js",
  ]);
  for (const fingerprint of Object.values(entry.fingerprints)) {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("qualify fails cleanly while qa:isolated does not exist", () => {
  const packageJson = readJson(join(REPO, "package.json"));
  if (typeof packageJson?.scripts?.["qa:isolated"] === "string") return;
  const agent = tempAgent();
  const result = runCli(["qualify", "--agent-dir", agent]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("qa:isolated");
});

test("remove leaves a foreign extension file untouched", () => {
  const agent = tempAgent();
  const receiptDir = mkdtempSync(join(tmpdir(), "early-compaction-receipt-"));
  temporaryDirs.push(receiptDir);
  const foreign = join(agent, "extensions", "other-mod.ts");
  writeFileSync(foreign, "export const x = 1;\n");
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  const off = runCli(["off", "--agent-dir", agent]);
  expect(off.status, off.stderr).toBe(0);
  expect(
    existsSync(join(agent, "early-compaction", "parked", "early-compaction.js")),
  ).toBe(true);

  const receiptOut = join(receiptDir, "removal-receipt.json");
  const remove = runCli([
    "remove",
    "--agent-dir",
    agent,
    "--receipt-out",
    receiptOut,
  ]);
  expect(remove.status, remove.stderr).toBe(0);
  expect(readJson(receiptOut).command).toBe("remove");
  expect(readFileSync(foreign, "utf8")).toBe("export const x = 1;\n");
  expect(existsSync(join(agent, "extensions", "early-compaction.js"))).toBe(
    false,
  );
  expect(
    existsSync(join(agent, "early-compaction", "parked", "early-compaction.js")),
  ).toBe(false);
  expect(existsSync(join(agent, "early-compaction"))).toBe(false);
});

test("remove rejects a receipt path at settings.json before removing anything", () => {
  const agent = tempAgent('{"sentinel":true}\n');
  const settings = join(agent, "settings.json");
  const extension = join(agent, "extensions", "early-compaction.js");
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  const before = readFileSync(settings);

  const result = runCli([
    "remove",
    "--agent-dir",
    agent,
    "--receipt-out",
    settings,
  ]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("usage: bun scripts/mod.mjs");
  expect(readFileSync(settings)).toEqual(before);
  expect(existsSync(extension)).toBe(true);
  expect(existsSync(join(agent, "early-compaction", "config.json"))).toBe(true);
});

test("remove rejects a receipt path at a foreign extension file", () => {
  const agent = tempAgent();
  const foreign = join(agent, "extensions", "other-mod.ts");
  const foreignBytes = "export const x = 1;\n";
  writeFileSync(foreign, foreignBytes);
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);

  const result = runCli([
    "remove",
    "--agent-dir",
    agent,
    "--receipt-out",
    foreign,
  ]);
  expect(result.status).toBe(2);
  expect(readFileSync(foreign, "utf8")).toBe(foreignBytes);
  expect(existsSync(join(agent, "extensions", "early-compaction.js"))).toBe(
    true,
  );
});

test("remove rejects a case-variant settings.json receipt path", () => {
  const agent = tempAgent();
  const settings = join(agent, "settings.json");
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  const before = readFileSync(settings);

  const result = runCli([
    "remove",
    "--agent-dir",
    agent,
    "--receipt-out",
    join(agent, "Settings.JSON"),
  ]);
  expect(result.status).toBe(2);
  expect(readFileSync(settings)).toEqual(before);
  expect(existsSync(join(agent, "extensions", "early-compaction.js"))).toBe(
    true,
  );
});

test("remove writes a legitimate receipt outside the agent dir", () => {
  const agent = tempAgent();
  const receiptDir = mkdtempSync(join(tmpdir(), "early-compaction-receipt-"));
  temporaryDirs.push(receiptDir);
  const receiptOut = join(receiptDir, "removal.json");
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);

  const remove = runCli([
    "remove",
    "--agent-dir",
    agent,
    "--receipt-out",
    receiptOut,
  ]);
  expect(remove.status, remove.stderr).toBe(0);
  expect(readJson(receiptOut).command).toBe("remove");
  expect(existsSync(join(agent, "extensions", "early-compaction.js"))).toBe(
    false,
  );
});

test("status exits 1 on installed drift", () => {
  const agent = tempAgent();
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  writeFileSync(join(agent, "extensions", "early-compaction.js"), "drift\n");
  const result = runCli(["status", "--agent-dir", agent]);
  expect(result.status).toBe(1);
  expect(fields(result.stdout).get("drift")).toBe("sha256-mismatch");
});

test("status reports residue when the state dir survives without the extension", () => {
  const agent = tempAgent();
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  rmSync(join(agent, "extensions", "early-compaction.js"));
  const result = runCli(["status", "--agent-dir", agent]);
  expect(result.status).toBe(1);
  expect(fields(result.stdout).get("residue")).toContain("state/config.json");
});

test("remove keeps metrics*.jsonl without --purge-logs", () => {
  const agent = tempAgent();
  const state = join(agent, "early-compaction");
  const install = runCli(["install", "--agent-dir", agent]);
  expect(install.status, install.stderr).toBe(0);
  writeFileSync(
    join(state, "metrics.jsonl"),
    `${JSON.stringify({ event: "threshold_cross", U: 1, T: 1 })}\n`,
  );
  const remove = runCli(["remove", "--agent-dir", agent]);
  expect(remove.status, remove.stderr).toBe(0);
  expect(existsSync(join(state, "metrics.jsonl"))).toBe(true);
  expect(existsSync(join(state, "config.json"))).toBe(false);
  const status = runCli(["status", "--agent-dir", agent]);
  expect(status.status, status.stdout).toBe(0);
  expect(fields(status.stdout).get("residue")).toBe("none");
});

test("report prints zeros when metrics and the compaction log are absent", () => {
  const agent = tempAgent();
  const result = runCli(["report", "--agent-dir", agent]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split(/\r?\n/)).toEqual([
    "applies.cold=0",
    "applies.boundary=0",
    "applies.threshold=0",
    "tokens_saved=0",
    "threshold_crossings=0",
    "builtin_compactions=0",
    "cache_read_ratio=0.0000",
  ]);
});
