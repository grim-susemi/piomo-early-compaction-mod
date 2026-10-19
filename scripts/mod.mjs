#!/usr/bin/env node
/**
 * Install / switch / report CLI for the early-compaction mod.
 *
 *   bun scripts/mod.mjs <command> --agent-dir <absolute path>
 *       [--dry-run] [--purge-logs] [--receipt-out <path>]
 *
 * Commands
 *   install  build the bundle, copy it to <agent>/extensions/early-compaction.js,
 *            seed early-compaction/config.json from REPO config.default.json,
 *            copy REPO qualified.json when present, write an install receipt
 *            plus its .seal.
 *   off      move the extension to early-compaction/parked/.
 *   on       move the parked extension back to extensions/.
 *   remove   delete the extension (either location) and the state dir, keeping
 *            metrics*.jsonl unless --purge-logs; print (and optionally write)
 *            a removal receipt.
 *   status   read-only: active/parked, built vs installed sha256, mode,
 *            qualified versions and residue. Exit 0 when clean, 1 otherwise.
 *   qualify  run `bun run qa:isolated`, then record VERSION,
 *            engineBuildIdentity().text and the five builtin file fingerprints
 *            in REPO qualified.json; --dry-run only prints the plan.
 *   mode     atomically set config.json mode to notes or rewrite.
 *   report   read-only, numbers-only join of metrics.jsonl and the builtin
 *            compaction log.
 *
 * Guarantees
 *   - settings.json is never written. Every writing command hashes it before
 *     and after and exits 3 when it changed.
 *   - Every file write goes through a temp file in the destination directory
 *     followed by rename(). No file is written through a symlink.
 *   - Only early-compaction.js and the early-compaction/ state dir are touched
 *     under an agent dir; foreign files under extensions/ are never removed.
 *
 * Test seams (used by test/mod-script.test.ts, never by normal operation)
 *   PIOMO_MOD_QA_COMMAND      absolute path to a JS file run instead of
 *                             `bun run qa:isolated`.
 *   PIOMO_MOD_QUALIFIED_PATH  alternate qualified.json path.
 *   PIOMO_SENPI_DIR           alternate @code-yeongyu/senpi package dir.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_FILE = "early-compaction.js";
const STATE_DIR = "early-compaction";
const METRICS_PATTERN = /^metrics(?:\.\d+)?\.jsonl$/;
const QUALIFIED_FILES = [
  "prompts.js",
  "task-intent.js",
  "policy.js",
  "idle.js",
  "speculative.js",
];
/** Builtin log events that mean a builtin compaction was applied or consumed. */
const BUILTIN_APPLIED_EVENTS = new Set([
  "idle_applied",
  "speculative_applied",
  "warm_consumed",
  "core_route_generated",
]);
const LIVE_AGENT_DIR = "C:/Users/USER/.omo-stable-500/home/.omo/agent";
const LIVE_COMPACTION_LOG = join(LIVE_AGENT_DIR, "logs", "compaction.log");

const COMMANDS = [
  "install",
  "on",
  "off",
  "remove",
  "status",
  "qualify",
  "mode",
  "report",
];
const USAGE =
  `usage: bun scripts/mod.mjs <${COMMANDS.join("|")}> ` +
  "--agent-dir <absolute path> [--dry-run] [--purge-logs] " +
  "[--receipt-out <path>]";

class CliError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** @param {string | Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} file */
function hashFile(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

/** Slash-normalized relative path for receipts and output. */
function rel(root, file) {
  return relative(root, file).split(sep).join("/");
}

let tempCounter = 0;

/**
 * Write `data` through a unique temp file in the destination directory,
 * then rename it into place.
 * @param {string} file
 * @param {string | Buffer} data
 */
function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(
    dirname(file),
    `.${basename(file)}.tmp-${process.pid}-${tempCounter++}`,
  );
  try {
    writeFileSync(temp, data, { flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  return atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** True when `target` is `root` itself or lies inside it. */
function isInside(root, target) {
  const relPath = relative(resolve(root), resolve(target));
  return (
    relPath === "" ||
    (!relPath.startsWith(`..${sep}`) &&
      relPath !== ".." &&
      !isAbsolute(relPath))
  );
}

/**
 * Normalize a Windows path spelling for comparison. Extended-length prefixes
 * are stripped, and a local UNC spelling of a drive is mapped back to the
 * drive letter. The result is used only for comparison, never for writes.
 * @param {string} file
 */
function comparisonPath(file) {
  let value = resolve(file);
  if (process.platform !== "win32") return value;
  const lower = value.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) {
    value = `\\\\${value.slice(8)}`;
  } else if (lower.startsWith("\\\\?\\")) {
    value = value.slice(4);
  }
  const unc = /^\\\\([^\\]+)\\([A-Za-z])\$(?=\\|$)/.exec(value);
  const machine = (process.env.COMPUTERNAME ?? "").toLowerCase();
  if (
    unc !== null &&
    (unc[1].toLowerCase() === "localhost" ||
      unc[1] === "127.0.0.1" ||
      (machine !== "" && unc[1].toLowerCase() === machine))
  ) {
    value = `${unc[2].toUpperCase()}:${value.slice(unc[0].length)}`;
  }
  return value;
}

/** Resolve a path for comparison; Windows paths compare case-insensitively. */
function foldPath(file) {
  const absolute = comparisonPath(file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** True when `target` is `root` or lies inside it, ignoring Windows case. */
function isInsideFolded(root, target) {
  const relPath = relative(foldPath(root), foldPath(target));
  return (
    relPath === "" ||
    (!relPath.startsWith(`..${sep}`) &&
      relPath !== ".." &&
      !isAbsolute(relPath))
  );
}

/**
 * Resolve an output path through the native real path of its nearest existing
 * ancestor. Native realpath expands 8.3 short names and junctions; the JS
 * implementation retains short names, which made an aliased settings.json
 * look like an unrelated file. Null means the path exists but cannot be
 * resolved, or that a non-directory ancestor blocks it.
 * @param {string} file
 */
function canonicalOutputPath(file) {
  const absolute = resolve(file);
  /** @type {string[]} */
  const tail = [];
  let current = absolute;
  for (;;) {
    let real;
    try {
      real = realpathSync.native(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      try {
        // The leaf exists but realpath cannot resolve it (for example, a
        // dangling symlink). Refuse rather than guess. ENOENT means it is
        // simply missing, so continue with the parent.
        lstatSync(current);
        return null;
      } catch {
        // Missing: walk up to the nearest existing ancestor.
      }
      tail.push(basename(current));
      current = parent;
      continue;
    }
    if (tail.length === 0) return real;
    try {
      if (!statSync(real).isDirectory()) return null;
    } catch {
      return null;
    }
    return join(real, ...tail.slice().reverse());
  }
}

/** `${dev}:${ino}` for an existing path, else null. */
function fileIdentity(file) {
  try {
    const info = statSync(file, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

/** Collect every entry below `directory` without following links. */
function collectFiles(directory, out) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

/**
 * Identity set of every file this command manages or could clobber. File
 * identity, unlike a path string, also detects hardlinks and aliases.
 * @param {string} root
 */
function managedIdentities(root) {
  const stateDir = join(root, STATE_DIR);
  const files = [
    join(root, "settings.json"),
    join(stateDir, "config.json"),
    join(stateDir, "qualified.json"),
  ];
  try {
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      if (METRICS_PATTERN.test(entry.name)) {
        files.push(join(stateDir, entry.name));
      }
    }
  } catch {
    // The state dir need not exist.
  }
  collectFiles(join(stateDir, "parked"), files);
  collectFiles(join(root, "extensions"), files);
  const identities = new Set();
  for (const file of files) {
    const identity = fileIdentity(file);
    if (identity !== null) identities.add(identity);
  }
  return identities;
}

/**
 * Reject Windows spellings that bypass the case-folded comparison: Win32
 * normalizes names ending in a dot or space, and a colon after the drive
 * letter denotes an NTFS alternate data stream.
 * @param {string} value
 */
function assertWindowsDestinationSpelling(value) {
  if (process.platform !== "win32") return;
  let remainder = value;
  const lower = remainder.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) remainder = remainder.slice(8);
  else if (lower.startsWith("\\\\?\\")) remainder = remainder.slice(4);
  if (/^[A-Za-z]:/.test(remainder)) remainder = remainder.slice(2);
  if (remainder.includes(":")) {
    throw usageError(
      `--receipt-out must not use an NTFS alternate data stream: ${value}`,
    );
  }
  for (const part of value.split(/[\\/]+/)) {
    if (part === "" || part === "." || part === "..") continue;
    if (
      /^[A-Za-z]:$/.test(part) ||
      part === "?" ||
      part.toLowerCase() === "unc"
    ) {
      continue;
    }
    if (part.endsWith(".") || part.endsWith(" ")) {
      throw usageError(
        `--receipt-out must not contain a name ending in a dot or space: ${value}`,
      );
    }
  }
}

/**
 * Map `target` into the agent's canonical spelling when it is reachable
 * through a junction, short name, drive substitution or UNC alias. Detection
 * is by dev+ino identity of an ancestor, not by spelling.
 * @param {string} target @param {string} realRoot @param {string} realState
 * @param {string} rootIdentity @param {string | null} stateIdentity
 */
function mapThroughAgentAliases(
  target,
  realRoot,
  realState,
  rootIdentity,
  stateIdentity,
) {
  let current = target;
  /** @type {string[]} */
  const suffix = [];
  for (;;) {
    const identity = fileIdentity(current);
    if (identity !== null && identity === rootIdentity) {
      return join(realRoot, ...suffix.slice().reverse());
    }
    if (
      identity !== null &&
      stateIdentity !== null &&
      identity === stateIdentity
    ) {
      return join(realState, ...suffix.slice().reverse());
    }
    const parent = dirname(current);
    if (parent === current) return null;
    suffix.push(basename(current));
    current = parent;
  }
}

/**
 * Validate an output destination before any command writes or removes
 * anything. Identity decides: an existing destination that is settings.json,
 * any other managed file, or a hardlink to one is rejected even through an
 * 8.3 alias, junction or alternate spelling. An output may live outside the
 * agent dir, or under the mod's own early-compaction/ state dir, but never
 * inside the agent dir elsewhere.
 * @param {string} root @param {string} value
 */
function validateOutputPath(root, value) {
  if (!isAbsolute(value)) {
    throw usageError("--receipt-out must be an absolute path");
  }
  assertWindowsDestinationSpelling(value);
  const target = canonicalOutputPath(value);
  if (target === null) {
    throw usageError(
      `--receipt-out cannot be resolved to a file path: ${value}`,
    );
  }
  // No settings.json anywhere: another agent dir's settings file is not
  // managed by this command, but it must still never be replaced. This is
  // kept in addition to the identity checks below.
  if (
    basename(value).toLowerCase() === "settings.json" ||
    basename(target).toLowerCase() === "settings.json"
  ) {
    throw usageError(
      `--receipt-out must not point at settings.json (any case): ${value}`,
    );
  }
  let targetInfo;
  try {
    targetInfo = statSync(target, { bigint: true });
  } catch {
    targetInfo = undefined;
  }
  if (targetInfo !== undefined && !targetInfo.isFile()) {
    throw usageError(
      `--receipt-out must be a file path, not a directory: ${value}`,
    );
  }
  if (
    targetInfo !== undefined &&
    managedIdentities(root).has(`${targetInfo.dev}:${targetInfo.ino}`)
  ) {
    throw usageError(
      `--receipt-out must not overwrite a file the command manages: ${value}`,
    );
  }

  const realRoot = canonicalOutputPath(root);
  if (realRoot === null) {
    throw usageError(`agent dir cannot be resolved: ${root}`);
  }
  const realState = join(realRoot, STATE_DIR);
  const rootIdentity = fileIdentity(realRoot);
  const mapped =
    rootIdentity === null
      ? null
      : mapThroughAgentAliases(
          target,
          realRoot,
          realState,
          rootIdentity,
          fileIdentity(realState),
        );
  const checked = mapped ?? target;
  if (!isInsideFolded(realRoot, checked)) {
    return target;
  }
  if (
    foldPath(realState) === foldPath(checked) ||
    !isInsideFolded(realState, checked)
  ) {
    throw usageError(
      `--receipt-out inside the agent dir must be under ${STATE_DIR}/: ${value}`,
    );
  }
  const stateRel = relative(foldPath(realState), foldPath(checked))
    .split(sep)
    .join("/");
  const top = stateRel.split("/")[0];
  if (top === "parked") {
    throw usageError(
      `--receipt-out must not point into ${STATE_DIR}/parked/: ${value}`,
    );
  }
  if (
    top === "config.json" ||
    top === "qualified.json" ||
    METRICS_PATTERN.test(top)
  ) {
    throw usageError(
      `--receipt-out must not overwrite a managed file: ${value}`,
    );
  }
  if (targetInfo !== undefined && top !== "receipts") {
    throw usageError(
      `--receipt-out must not overwrite an existing file the command manages: ${value}`,
    );
  }
  return target;
}

/**
 * Resolve a path that must stay inside the agent dir and must not be reached
 * through a symlink. Non-existent leaves are fine; every existing ancestor is
 * checked.
 * @param {string} root @param {string} target
 */
function safe(root, target) {
  const absolute = resolve(target);
  if (!isInside(root, absolute)) {
    throw new CliError(`refusing to touch a path outside the agent dir: ${absolute}`);
  }
  let current = absolute;
  while (isInside(root, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new CliError(`refusing to write through a symlink: ${current}`);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      // ENOENT: the path does not exist yet.
    }
    if (resolve(current) === resolve(root)) break;
    current = dirname(current);
  }
  return absolute;
}

/** Hash settings.json as it is now (null when the file is absent). */
function currentSettingsHash(root) {
  return hashFile(join(root, "settings.json"));
}

/**
 * Capture settings.json before a writing command. `check()` throws CliError
 * with exit code 3 when the file changed since capture.
 * @param {string} root
 */
function settingsGuard(root) {
  const before = currentSettingsHash(root);
  return {
    before,
    check() {
      const after = currentSettingsHash(root);
      if (after !== before) {
        throw new CliError(
          "settings.json changed during the command; refusing to continue (exit 3)",
          3,
        );
      }
    },
  };
}

/** @param {string} argv */
function usageError(message) {
  return new CliError(`${message}\n${USAGE}`, 2);
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    agentDir: undefined,
    receiptOut: undefined,
    dryRun: false,
    purgeLogs: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--purge-logs") {
      options.purgeLogs = true;
    } else if (arg === "--agent-dir") {
      const value = argv[index + 1];
      if (value === undefined) throw usageError("--agent-dir needs a value");
      options.agentDir = value;
      index += 1;
    } else if (arg.startsWith("--agent-dir=")) {
      options.agentDir = arg.slice("--agent-dir=".length);
    } else if (arg === "--receipt-out") {
      const value = argv[index + 1];
      if (value === undefined) throw usageError("--receipt-out needs a value");
      options.receiptOut = value;
      index += 1;
    } else if (arg.startsWith("--receipt-out=")) {
      options.receiptOut = arg.slice("--receipt-out=".length);
    } else if (arg.startsWith("--")) {
      throw usageError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

/** bun executable for child commands: the running bun, else "bun" on PATH. */
function bunCommand() {
  if (typeof process.versions.bun === "string") return process.execPath;
  return "bun";
}

function tail(result) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text.split(/\r?\n/).slice(-12).join("\n");
}

function runBun(args, label) {
  const result = spawnSync(bunCommand(), args, {
    cwd: REPO,
    encoding: "utf8",
  });
  if (result.error) {
    throw new CliError(`${label} failed to start: ${result.error.message}`);
  }
  return result;
}

function runBuild() {
  const result = runBun(["run", "build"], "bun run build");
  if (result.status !== 0) {
    throw new CliError(
      `bun run build failed with exit ${result.status}\n${tail(result)}`,
    );
  }
}

/** Unique `<agent>/early-compaction/receipts/<timestamp>-<command>.json`. */
function receiptPath(root, command) {
  const receipts = safe(root, join(root, STATE_DIR, "receipts"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = join(receipts, `${stamp}-${command}.json`);
  let suffix = 1;
  while (existsSync(candidate) || existsSync(`${candidate}.seal`)) {
    candidate = join(receipts, `${stamp}-${command}-${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}

/** @param {ReturnType<typeof parseArgs>} parsed */
async function install(parsed) {
  const { root, options } = context(parsed);
  const guard = settingsGuard(root);
  const extension = safe(root, join(root, "extensions", EXTENSION_FILE));
  const stateDir = safe(root, join(root, STATE_DIR));
  const configFile = join(stateDir, "config.json");
  const qualifiedTarget = join(stateDir, "qualified.json");
  const distFile = join(REPO, "dist", EXTENSION_FILE);
  const defaultConfig = join(REPO, "config.default.json");
  const repoQualified = join(REPO, "qualified.json");

  const configExists = existsSync(configFile);
  const qualifiedExists = existsSync(repoQualified);
  if (options.dryRun) {
    console.log(`install: dry-run agent_dir=${root}`);
    console.log(`install: would run bun run build and copy ${rel(REPO, distFile)}`);
    console.log(`install: would write ${rel(root, extension)}`);
    console.log(
      `install: would ${configExists ? "keep" : "seed"} ${rel(root, configFile)}`,
    );
    console.log(
      qualifiedExists
        ? `install: would copy ${rel(root, qualifiedTarget)} from REPO qualified.json`
        : "install: would skip qualified.json (REPO qualified.json is absent)",
    );
    console.log("install: would write receipts/<timestamp>-install.json and .seal");
    return;
  }

  runBuild();
  if (!existsSync(distFile)) {
    throw new CliError(`build produced no ${distFile}`);
  }
  // The build can take a while; verify settings immediately before writing.
  guard.check();

  /** @type {Record<string, string>} */
  const files = {};
  atomicWrite(extension, readFileSync(distFile));
  files[rel(root, extension)] = hashFile(extension);

  let configStatus;
  if (configExists) {
    configStatus = `kept ${rel(root, configFile)}`;
  } else {
    if (!existsSync(defaultConfig)) {
      throw new CliError(`REPO config.default.json is missing: ${defaultConfig}`);
    }
    atomicWrite(configFile, readFileSync(defaultConfig));
    configStatus = `seeded ${rel(root, configFile)} from config.default.json`;
  }
  files[rel(root, configFile)] = hashFile(configFile);

  let qualifiedStatus;
  if (qualifiedExists) {
    atomicWrite(qualifiedTarget, readFileSync(repoQualified));
    files[rel(root, qualifiedTarget)] = hashFile(qualifiedTarget);
    qualifiedStatus = `copied ${rel(root, qualifiedTarget)} from REPO qualified.json`;
  } else {
    qualifiedStatus =
      "REPO qualified.json is absent; install continues without it";
  }

  const after = currentSettingsHash(root);
  if (after !== guard.before) {
    throw new CliError(
      "settings.json changed during the command; refusing to continue (exit 3)",
      3,
    );
  }
  /** @type {{schema:number,command:string,at:string,agent_dir:string,files:Record<string,string>,settings:{path:string,before_sha256:string|null,after_sha256:string|null},status:Record<string,string>}} */
  const receipt = {
    schema: 1,
    command: "install",
    at: new Date().toISOString(),
    agent_dir: root,
    files,
    settings: {
      path: "settings.json",
      before_sha256: guard.before,
      after_sha256: after,
    },
    status: {
      extension: "installed",
      config: configStatus,
      qualified: qualifiedStatus,
    },
  };
  const receiptFile = receiptPath(root, "install");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  atomicWrite(receiptFile, receiptBytes);
  atomicWrite(`${receiptFile}.seal`, `${sha256(receiptBytes)}\n`);
  guard.check();

  console.log(`install: extension ${rel(root, extension)} sha256=${files[rel(root, extension)]}`);
  console.log(`install: ${configStatus}`);
  console.log(`install: ${qualifiedStatus}`);
  console.log(`install: receipt ${rel(root, receiptFile)}`);
  console.log(`install: seal ${rel(root, `${receiptFile}.seal`)}`);
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function off(parsed) {
  const { root, options } = context(parsed);
  const guard = settingsGuard(root);
  const extension = safe(root, join(root, "extensions", EXTENSION_FILE));
  const parked = safe(root, join(root, STATE_DIR, "parked", EXTENSION_FILE));

  if (options.dryRun) {
    console.log(
      existsSync(extension)
        ? `off: would move ${rel(root, extension)} to ${rel(root, parked)}`
        : "off: extension is not installed; nothing to move",
    );
    return;
  }
  if (existsSync(extension) && existsSync(parked)) {
    throw new CliError(
      `both ${rel(root, extension)} and ${rel(root, parked)} exist; refusing to overwrite`,
    );
  }
  if (!existsSync(extension)) {
    if (existsSync(parked)) {
      console.log("off: already parked");
      guard.check();
      return;
    }
    throw new CliError("off: extension is not installed in this agent dir");
  }
  mkdirSync(dirname(parked), { recursive: true });
  renameSync(extension, parked);
  guard.check();
  console.log(`off: parked ${rel(root, parked)}`);
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function on(parsed) {
  const { root, options } = context(parsed);
  const guard = settingsGuard(root);
  const extension = safe(root, join(root, "extensions", EXTENSION_FILE));
  const parked = safe(root, join(root, STATE_DIR, "parked", EXTENSION_FILE));

  if (options.dryRun) {
    console.log(
      existsSync(parked)
        ? `on: would move ${rel(root, parked)} to ${rel(root, extension)}`
        : "on: no parked extension; nothing to move",
    );
    return;
  }
  if (existsSync(extension) && existsSync(parked)) {
    throw new CliError(
      `both ${rel(root, extension)} and ${rel(root, parked)} exist; refusing to overwrite`,
    );
  }
  if (!existsSync(parked)) {
    if (existsSync(extension)) {
      console.log("on: already active");
      guard.check();
      return;
    }
    throw new CliError("on: no parked extension in this agent dir");
  }
  mkdirSync(dirname(extension), { recursive: true });
  renameSync(parked, extension);
  guard.check();
  console.log(`on: active ${rel(root, extension)}`);
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function setMode(parsed) {
  const { root, options, positional } = context(parsed);
  const value = positional[1];
  if (value !== "notes" && value !== "rewrite") {
    throw usageError("mode needs exactly one value: notes or rewrite");
  }
  const guard = settingsGuard(root);
  const configFile = safe(root, join(root, STATE_DIR, "config.json"));

  let config;
  if (existsSync(configFile)) {
    try {
      config = readJson(configFile);
    } catch (error) {
      throw new CliError(
        `cannot parse ${rel(root, configFile)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    config = readJson(join(REPO, "config.default.json"));
  }
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config)
  ) {
    throw new CliError(`${rel(root, configFile)} is not a JSON object`);
  }

  const next = { ...config, mode: value };
  if (options.dryRun) {
    console.log(`mode: dry-run would set mode=${value} in ${rel(root, configFile)}`);
    return;
  }
  writeJson(configFile, next);
  guard.check();
  console.log(`mode=${value}`);
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function remove(parsed) {
  const { root, options } = context(parsed);
  const guard = settingsGuard(root);
  const extension = safe(root, join(root, "extensions", EXTENSION_FILE));
  const parked = safe(root, join(root, STATE_DIR, "parked", EXTENSION_FILE));
  const stateDir = safe(root, join(root, STATE_DIR));

  /** @type {string[]} */
  const toRemove = [];
  for (const target of [extension, parked]) {
    if (existsSync(target)) toRemove.push(target);
  }
  /** @type {string[]} */
  const keptLogs = [];
  if (existsSync(stateDir)) {
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      const full = join(stateDir, entry.name);
      if (!options.purgeLogs && METRICS_PATTERN.test(entry.name)) {
        keptLogs.push(rel(root, full));
      } else {
        toRemove.push(full);
      }
    }
  }

  if (options.dryRun) {
    console.log(
      `remove: dry-run would delete ${toRemove.length === 0 ? "nothing" : toRemove.map((file) => rel(root, file)).join(",")}`,
    );
    console.log(
      `remove: dry-run would keep ${keptLogs.length === 0 ? "no metrics logs" : keptLogs.join(",")}`,
    );
    return;
  }

  const removed = [];
  for (const target of toRemove) {
    rmSync(target, { recursive: true, force: true });
    removed.push(rel(root, target));
  }
  if (existsSync(stateDir) && readdirSync(stateDir).length === 0) {
    rmSync(stateDir, { recursive: true, force: true });
  }

  const receipt = {
    schema: 1,
    command: "remove",
    at: new Date().toISOString(),
    agent_dir: root,
    removed,
    kept_metrics: keptLogs,
    purged_logs: options.purgeLogs,
    settings: {
      path: "settings.json",
      before_sha256: guard.before,
      after_sha256: currentSettingsHash(root),
    },
  };
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  console.log(text.trimEnd());
  if (options.receiptOut !== undefined) {
    atomicWrite(resolve(options.receiptOut), text);
  }
  guard.check();
}

/** @param {string} root */
function readConfigMode(root) {
  try {
    const value = readJson(join(root, STATE_DIR, "config.json"));
    return typeof value?.mode === "string" ? value.mode : "missing";
  } catch {
    return "missing";
  }
}

/** @param {string} root */
function readQualifiedVersions(root) {
  try {
    const value = readJson(join(root, STATE_DIR, "qualified.json"));
    const versions = value?.versions;
    if (typeof versions !== "object" || versions === null) return "none";
    const names = Object.keys(versions);
    return names.length === 0 ? "none" : names.join(",");
  } catch {
    return "none";
  }
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function status(parsed) {
  const { root } = context(parsed);
  const extension = join(root, "extensions", EXTENSION_FILE);
  const parked = join(root, STATE_DIR, "parked", EXTENSION_FILE);
  const stateDir = join(root, STATE_DIR);
  const built = hashFile(join(REPO, "dist", EXTENSION_FILE));
  const activeHash = hashFile(extension);
  const parkedHash = hashFile(parked);

  const residues = [];
  let state = "absent";
  if (activeHash !== null && parkedHash !== null) {
    state = "active";
    residues.push("extension-in-both-locations");
  } else if (activeHash !== null) {
    state = "active";
  } else if (parkedHash !== null) {
    state = "parked";
  }

  const installed = activeHash ?? parkedHash;
  let drift = "none";
  if (installed !== null) {
    if (built === null) drift = "built-missing";
    else if (installed !== built) drift = "sha256-mismatch";
  }

  if (existsSync(stateDir)) {
    const known = new Set(["config.json", "qualified.json", "receipts", "parked"]);
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      if (known.has(entry.name)) {
        // With no extension anywhere, anything but retained metrics logs is
        // leftovers from a partial remove.
        if (state === "absent") residues.push(`state/${entry.name}`);
        continue;
      }
      if (METRICS_PATTERN.test(entry.name)) continue;
      residues.push(`state/${entry.name}`);
    }
    const parkedDir = join(stateDir, "parked");
    if (existsSync(parkedDir)) {
      for (const entry of readdirSync(parkedDir, { withFileTypes: true })) {
        if (entry.name !== EXTENSION_FILE) {
          residues.push(`state/parked/${entry.name}`);
        }
      }
    }
  }

  console.log(`status=${state}`);
  console.log(`built_sha256=${built ?? "missing"}`);
  console.log(`installed_sha256=${installed ?? "missing"}`);
  console.log(`mode=${readConfigMode(root)}`);
  console.log(`qualified_versions=${readQualifiedVersions(root)}`);
  console.log(`residue=${residues.length === 0 ? "none" : residues.join(",")}`);
  console.log(`drift=${drift}`);
  if (drift !== "none" || residues.length > 0) process.exitCode = 1;
}

/** Locate the installed @code-yeongyu/senpi package directory. */
function locateSenpi() {
  const candidates = [];
  if (process.env.PIOMO_SENPI_DIR) {
    candidates.push(resolve(process.env.PIOMO_SENPI_DIR));
  }
  const bunRoot = process.env.BUN_INSTALL
    ? resolve(process.env.BUN_INSTALL)
    : join(homedir(), ".bun");
  candidates.push(
    join(bunRoot, "install", "global", "node_modules", "@code-yeongyu", "senpi"),
  );
  candidates.push(join(bunRoot, "node_modules", "@code-yeongyu", "senpi"));
  // The running bun binary sits in <bun root>/bin; its global node_modules
  // are always a sibling of that bin directory.
  if (basename(process.execPath).toLowerCase().startsWith("bun")) {
    const execRoot = dirname(dirname(process.execPath));
    candidates.push(
      join(
        execRoot,
        "install",
        "global",
        "node_modules",
        "@code-yeongyu",
        "senpi",
      ),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new CliError(
    "cannot locate @code-yeongyu/senpi; set PIOMO_SENPI_DIR to its package directory",
  );
}

/** @param {ReturnType<typeof parseArgs>} parsed */
async function qualify(parsed) {
  const { root, options } = context(parsed);
  const guard = settingsGuard(root);
  const target = process.env.PIOMO_MOD_QUALIFIED_PATH
    ? resolve(process.env.PIOMO_MOD_QUALIFIED_PATH)
    : join(REPO, "qualified.json");

  if (options.dryRun) {
    console.log(`qualify: dry-run agent_dir=${root}`);
    console.log("qualify: would run bun run qa:isolated");
    console.log(
      "qualify: would record the installed senpi VERSION, engine identity " +
        `and ${QUALIFIED_FILES.length} builtin fingerprints in ${target}`,
    );
    return;
  }

  const fakeQa = process.env.PIOMO_MOD_QA_COMMAND;
  const packageJson = readJson(join(REPO, "package.json"));
  if (!fakeQa && typeof packageJson?.scripts?.["qa:isolated"] !== "string") {
    throw new CliError(
      "qualify: package.json has no qa:isolated script (todo 14 adds the " +
        "isolated harness); qualified.json was not written.",
    );
  }

  const qa = fakeQa
    ? spawnSync(process.execPath, [resolve(fakeQa)], {
        cwd: REPO,
        encoding: "utf8",
      })
    : runBun(["run", "qa:isolated"], "bun run qa:isolated");
  if (qa.error) {
    throw new CliError(
      `qualify: qa:isolated failed to start: ${qa.error.message}`,
    );
  }
  if (qa.status !== 0) {
    throw new CliError(
      `qualify: qa:isolated failed with exit ${qa.status}; qualified.json was not written.\n${tail(qa)}`,
    );
  }

  // A QA run can take minutes; never record a qualification across a
  // settings.json edit.
  guard.check();

  const senpiDir = locateSenpi();
  const entryPoint = join(senpiDir, "dist", "index.js");
  let senpi;
  try {
    senpi = await import(pathToFileURL(entryPoint).href);
  } catch (error) {
    throw new CliError(
      `qualify: cannot load ${entryPoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = senpi.VERSION;
  const identity =
    typeof senpi.engineBuildIdentity === "function"
      ? senpi.engineBuildIdentity()?.text
      : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new CliError("qualify: @code-yeongyu/senpi exports no VERSION");
  }
  if (typeof identity !== "string" || identity.length === 0) {
    throw new CliError(
      "qualify: engineBuildIdentity().text is empty; refusing to qualify",
    );
  }

  const builtinDir = join(
    senpiDir,
    "dist",
    "core",
    "extensions",
    "builtin",
    "compaction",
  );
  /** @type {Record<string, string>} */
  const fingerprints = {};
  for (const file of QUALIFIED_FILES) {
    const full = join(builtinDir, file);
    const hash = hashFile(full);
    if (hash === null) {
      throw new CliError(`qualify: installed builtin file is missing: ${full}`);
    }
    fingerprints[file] = hash;
  }

  let document = { schema: 1, versions: {} };
  if (existsSync(target)) {
    let parsed;
    try {
      parsed = readJson(target);
    } catch (error) {
      throw new CliError(
        `qualify: cannot parse ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schema !== 1 ||
      typeof parsed.versions !== "object" ||
      parsed.versions === null ||
      Array.isArray(parsed.versions)
    ) {
      throw new CliError(
        `qualify: ${target} is not a schema:1 qualified document; refusing to overwrite`,
      );
    }
    document = parsed;
  }
  document.versions[version] = { identity, fingerprints };
  writeJson(target, document);
  guard.check();
  console.log(
    `qualify: recorded ${version} identity=${identity} fingerprints=${QUALIFIED_FILES.length} in ${target}`,
  );
}

/** Parse a JSONL file, silently skipping malformed lines and missing files. */
function readJsonLines(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (typeof value === "object" && value !== null) out.push(value);
    } catch {
      // A torn line from a crashed writer is not a report failure.
    }
  }
  return out;
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function report(parsed) {
  const { root } = context(parsed);
  const stateDir = join(root, STATE_DIR);
  const metricsFiles = existsSync(stateDir)
    ? readdirSync(stateDir)
        .filter((name) => METRICS_PATTERN.test(name))
        .sort()
    : [];

  /** @type {{cold:number,boundary:number,threshold:number}} */
  const applies = { cold: 0, boundary: 0, threshold: 0 };
  let tokensSaved = 0;
  let thresholdCrossings = 0;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (const name of metricsFiles) {
    for (const event of readJsonLines(join(stateDir, name))) {
      if (event.event === "apply" && event.result === "ok") {
        if (Object.hasOwn(applies, event.route)) applies[event.route] += 1;
        const before = Number(event.tokensBefore);
        const after = Number(event.estimatedTokensAfter);
        if (Number.isFinite(before) && Number.isFinite(after)) {
          tokensSaved += Math.max(0, before - after);
        }
      } else if (event.event === "threshold_cross") {
        thresholdCrossings += 1;
      } else if (event.event === "next_usage") {
        if (Number.isFinite(Number(event.input))) input += Number(event.input);
        if (Number.isFinite(Number(event.cacheRead))) {
          cacheRead += Number(event.cacheRead);
        }
        if (Number.isFinite(Number(event.cacheWrite))) {
          cacheWrite += Number(event.cacheWrite);
        }
      }
    }
  }

  // The live agent dir is the only place where joining the installed
  // compaction log is unambiguous; temp dirs use their own logs/.
  const live = resolve(root).toLowerCase() === resolve(LIVE_AGENT_DIR).toLowerCase();
  const logPath = live
    ? LIVE_COMPACTION_LOG
    : join(root, "logs", "compaction.log");
  let builtinCompactions = 0;
  for (const event of readJsonLines(logPath)) {
    if (BUILTIN_APPLIED_EVENTS.has(event.event)) builtinCompactions += 1;
  }

  const usageTotal = input + cacheRead + cacheWrite;
  const ratio = usageTotal === 0 ? 0 : cacheRead / usageTotal;

  console.log(`applies.cold=${applies.cold}`);
  console.log(`applies.boundary=${applies.boundary}`);
  console.log(`applies.threshold=${applies.threshold}`);
  console.log(`tokens_saved=${tokensSaved}`);
  console.log(`threshold_crossings=${thresholdCrossings}`);
  console.log(`builtin_compactions=${builtinCompactions}`);
  console.log(`cache_read_ratio=${ratio.toFixed(4)}`);
}

/** @param {ReturnType<typeof parseArgs>} parsed */
function context(parsed) {
  const { options, positional } = parsed;
  const root = resolve(options.agentDir);
  return { root, options, positional };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (command === undefined || !COMMANDS.includes(command)) {
    throw usageError(
      command === undefined ? "missing command" : `unknown command: ${command}`,
    );
  }
  if (parsed.options.agentDir === undefined || parsed.options.agentDir === "") {
    throw usageError("--agent-dir is required");
  }
  if (!isAbsolute(parsed.options.agentDir)) {
    throw usageError("--agent-dir must be an absolute path");
  }
  const root = resolve(parsed.options.agentDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw usageError(`agent dir does not exist: ${root}`);
  }
  // Every output option is checked here, before a command can build, write or
  // remove anything. The post-command settings guard remains as a backstop.
  if (parsed.options.receiptOut !== undefined) {
    parsed.options.receiptOut = validateOutputPath(
      root,
      parsed.options.receiptOut,
    );
  }

  switch (command) {
    case "install":
      await install(parsed);
      break;
    case "off":
      off(parsed);
      break;
    case "on":
      on(parsed);
      break;
    case "remove":
      remove(parsed);
      break;
    case "status":
      status(parsed);
      break;
    case "qualify":
      await qualify(parsed);
      break;
    case "mode":
      setMode(parsed);
      break;
    case "report":
      report(parsed);
      break;
    default:
      throw usageError(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  const code = error instanceof CliError ? error.code : 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(code);
});
