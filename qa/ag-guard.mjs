// AG guard: baseline + check for the live agent dir (READ-ONLY: this script
// never writes under AG; its only write is qa/out/ag-baseline.json).
//
//   node qa/ag-guard.mjs baseline   sha256 AG files + extensions listing
//   node qa/ag-guard.mjs check      exit 0 clean, 1 with named reasons
//
// Hashes and names only: file contents and values are never copied.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AG = "C:/Users/USER/.omo-stable-500/home/.omo/agent";
const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT_DIR = join(REPO, "qa", "out");
const BASELINE_PATH = join(OUT_DIR, "ag-baseline.json");

const BASELINE_FILES = [
  "settings.json",
  "auth.json",
  "models.json",
  "models.yml",
  "models-store.json",
  "credential-pool-state.json",
];

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fileHash(name) {
  const p = join(AG, name);
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  return sha256(readFileSync(p, "utf8"));
}

function sortedListing(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return readdirSync(dir).sort();
}

// Per-top-level-key hashes of settings.json: hashes and key names only, so
// check can tell a compaction/extension-field change (fail) apart from any
// other change (reported only) without ever storing values.
function settingsKeyHashes() {
  const p = join(AG, "settings.json");
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { __unparseable: true };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { __unparseable: true };
  }
  const out = {};
  for (const key of Object.keys(parsed).sort()) {
    out[key] = sha256(JSON.stringify(parsed[key]));
  }
  return out;
}

function snapshot() {
  const files = {};
  for (const name of BASELINE_FILES) files[name] = fileHash(name);
  return {
    files,
    extensions: sortedListing(join(AG, "extensions")),
    settingsKeys: settingsKeyHashes(),
  };
}

function doBaseline() {
  const snap = snapshot();
  mkdirSync(OUT_DIR, { recursive: true });
  const baseline = { ...snap, timestamp: new Date().toISOString() };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  const result = {
    command: "baseline",
    ok: true,
    out: "qa/out/ag-baseline.json",
    files: BASELINE_FILES.length,
    timestamp: baseline.timestamp,
  };
  console.log(JSON.stringify(result));
}

function findEarlyCompactionPaths() {
  // Scan AG top level (names only), AG/extensions and AG/early-compaction
  // recursively for any path whose name starts with "early-compaction".
  const hits = [];
  const top = sortedListing(AG) ?? [];
  for (const name of top) {
    if (name.startsWith("early-compaction")) hits.push(name);
  }
  for (const dir of ["extensions", "early-compaction"]) {
    const root = join(AG, dir);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const name of readdirSync(cur).sort()) {
        const p = join(cur, name);
        if (name.startsWith("early-compaction")) {
          hits.push(p.slice(AG.length + 1).replace(/\\/g, "/"));
        }
        if (statSync(p).isDirectory()) stack.push(p);
      }
    }
  }
  return hits.sort();
}

function isGuardedKey(key) {
  return key === "compaction" || /extension/i.test(key);
}

function doCheck() {
  const reasons = [];
  const reported = [];
  if (!existsSync(BASELINE_PATH)) {
    const result = {
      command: "check",
      ok: false,
      reasons: ["missing-baseline: run `node qa/ag-guard.mjs baseline` first"],
      reported,
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const now = snapshot();

  const hits = findEarlyCompactionPaths();
  if (hits.length > 0) {
    reasons.push(`early-compaction-residue: ${hits.join(", ")}`);
  }

  const baseExt = baseline.extensions ?? null;
  if (JSON.stringify(baseExt) !== JSON.stringify(now.extensions)) {
    reasons.push("extensions-listing-changed");
  }

  // Every other baseline file drift is REPORTED, never a failure (the owner
  // keeps using senpi during execution). settings.json has dedicated
  // guarded-key logic below and is excluded from this generic loop.
  for (const name of BASELINE_FILES) {
    if (name === "settings.json") continue;
    const before = (baseline.files ?? {})[name] ?? null;
    const after = (now.files ?? {})[name] ?? null;
    if (before !== after) reported.push(`${name}-changed`);
  }

  const baseKeys = baseline.settingsKeys ?? null;
  const nowKeys = now.settingsKeys ?? null;
  if (JSON.stringify(baseKeys) !== JSON.stringify(nowKeys)) {
    const allKeys = new Set([
      ...Object.keys(baseKeys ?? {}),
      ...Object.keys(nowKeys ?? {}),
    ]);
    const guardedChanged = [...allKeys]
      .filter(isGuardedKey)
      .filter((k) => (baseKeys ?? {})[k] !== (nowKeys ?? {})[k])
      .sort();
    if (guardedChanged.length > 0) {
      reasons.push(`settings-guarded-keys-changed: ${guardedChanged.join(", ")}`);
    } else {
      reported.push("settings-changed-outside-guarded-keys");
    }
  }
  if ((baseline.files ?? {}).settings === undefined) {
    // baseline predates nothing; kept for forward-compat, no-op.
  }
  if ((baseline.files?.["settings.json"] ?? null) !== (now.files?.["settings.json"] ?? null)) {
    const guarded = reasons.some((r) => r.startsWith("settings-guarded-keys-changed"));
    if (!guarded) reported.push("settings-sha-changed");
  }

  const result = { command: "check", ok: reasons.length === 0, reasons, reported };
  console.log(JSON.stringify(result));
  process.exit(reasons.length === 0 ? 0 : 1);
}

const cmd = process.argv[2];
if (cmd === "baseline") doBaseline();
else if (cmd === "check") doCheck();
else {
  console.log(JSON.stringify({ command: cmd ?? null, ok: false, reasons: ["usage: node qa/ag-guard.mjs baseline|check"], reported: [] }));
  process.exit(2);
}
