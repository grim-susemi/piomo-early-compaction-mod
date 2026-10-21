import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const GUARD = join(REPO, "qa", "ag-guard.mjs");

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  ag: string;
  out: string;
}

function installedAgent(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ag-guard-"));
  temporaryDirs.push(root);
  const ag = join(root, "agent");
  mkdirSync(join(ag, "extensions"), { recursive: true });
  mkdirSync(join(ag, "early-compaction"), { recursive: true });
  writeFileSync(join(ag, "settings.json"), "{}\n");
  writeFileSync(join(ag, "extensions", "early-compaction.js"), "export default () => {};\n");
  writeFileSync(join(ag, "early-compaction", "config.json"), "{}\n");
  writeFileSync(join(ag, "early-compaction", "qualified.json"), "{}\n");
  return { ag, out: join(root, "out") };
}

function guard(command: string, fixture: Fixture): { status: number | null; reasons: string[] } {
  const result = spawnSync(process.execPath, [GUARD, command], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, PIOMO_AG_GUARD_DIR: fixture.ag, PIOMO_AG_GUARD_OUT: fixture.out },
  });
  const parsed = JSON.parse((result.stdout ?? "").trim()) as { reasons?: string[] };
  return { status: result.status, reasons: parsed.reasons ?? [] };
}

test("an installed mod that exists at baseline time is not residue", () => {
  const fixture = installedAgent();
  expect(guard("baseline", fixture).status).toBe(0);
  expect(guard("check", fixture)).toEqual({ status: 0, reasons: [] });
});

test("an early-compaction path created after the baseline is residue", () => {
  const fixture = installedAgent();
  guard("baseline", fixture);
  writeFileSync(join(fixture.ag, "extensions", "early-compaction-extra.js"), "leak\n");
  const result = guard("check", fixture);
  expect(result.status).toBe(1);
  expect(result.reasons).toContain("early-compaction-residue: extensions/early-compaction-extra.js");
});

test("a change to an installed mod file fails the check", () => {
  const fixture = installedAgent();
  guard("baseline", fixture);
  writeFileSync(join(fixture.ag, "early-compaction", "qualified.json"), "{\"changed\":true}\n");
  const result = guard("check", fixture);
  expect(result.status).toBe(1);
  expect(result.reasons).toEqual(["early-compaction-changed: early-compaction/qualified.json"]);
});

test("a baseline without the installed-path record keeps the original residue rule", () => {
  const fixture = installedAgent();
  guard("baseline", fixture);
  const path = join(fixture.out, "ag-baseline.json");
  const baseline = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete baseline.earlyCompaction;
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  const result = guard("check", fixture);
  expect(result.status).toBe(1);
  expect(result.reasons).toEqual(["early-compaction-residue: early-compaction, extensions/early-compaction.js"]);
});
