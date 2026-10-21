# piomo-early-compaction-mod

A removable senpi extension that prepares compaction summaries in the
background and applies them at moments where the next provider request is
cheap: when the prompt cache is already cold, when a task ends with enough
new growth, or when the context reaches the builtin compaction threshold. The
first summary is a full rewrite; later notes are appended to the previous
summary so earlier summary text is kept verbatim.

It never writes `settings.json`, never changes `compaction.enabled` or
`compaction.model`, and when it is switched off, removed, dormant, or
unqualified, senpi behaves exactly like stock from the next `/reload` or new
session.

## Requirements

- senpi `2026.10.19`, with the five builtin compaction files matching the
  fingerprints recorded in `qualified.json`.
- `bun` for the build and the isolated QA harness.

The extension runs only in interactive terminal (`tui`) sessions. Worker,
print, and json sessions never activate it; `rpc` sessions activate only when
the installed config sets `allowRpcInteractive: true`.

## Install

```
node scripts/mod.mjs install --agent-dir <absolute path>
```

`install` builds `dist/early-compaction.js`, copies it to
`<agent-dir>/extensions/early-compaction.js`, seeds
`<agent-dir>/early-compaction/config.json` from `config.default.json` when no
config exists, copies `qualified.json` into the same state directory, and
writes `receipts/<timestamp>-install.json` plus its `.seal`. An existing
`config.json` is kept. Every writing command also accepts `--dry-run`, which
prints the planned actions and changes nothing.

After installing, run `/reload` or start a new senpi session.

The script prints this exact usage line when `--agent-dir` is missing or
relative:

```
usage: bun scripts/mod.mjs <install|on|off|remove|status|qualify|mode|report> --agent-dir <absolute path> [--dry-run] [--purge-logs] [--receipt-out <path>]
```

## Commands

All commands take `--agent-dir <absolute path>`.

| Command | What it does |
| --- | --- |
| `install` | Build, copy the extension, seed the config, copy `qualified.json`, write a sealed receipt. |
| `on` | Move a parked extension back to `<agent-dir>/extensions/early-compaction.js`. |
| `off` | Move the extension to `<agent-dir>/early-compaction/parked/early-compaction.js`. |
| `remove` | Delete the extension from either location and remove the state directory, keeping `metrics*.jsonl` unless `--purge-logs`. Prints a removal receipt; `--receipt-out <absolute path>` also writes it. |
| `status` | Read-only: active/parked, built vs installed sha256, mode, qualified versions, residue, drift. Exit 0 when clean, 1 on drift or residue. |
| `qualify` | Run `bun run qa:isolated`, then record the installed senpi `VERSION`, `engineBuildIdentity().text`, and the five builtin file fingerprints in `qualified.json`. With `--dry-run` it only prints what it would record. |
| `mode notes\|rewrite` | Atomically set `mode` in `<agent-dir>/early-compaction/config.json`. |
| `report` | Read-only, numbers-only join of `metrics.jsonl` and senpi's compaction log: applies by route, tokens saved, threshold crossings, builtin compactions, and the next-usage cache-read ratio. |

Examples:

```
node scripts/mod.mjs on --agent-dir <absolute path>
node scripts/mod.mjs off --agent-dir <absolute path>
node scripts/mod.mjs status --agent-dir <absolute path>
node scripts/mod.mjs mode rewrite --agent-dir <absolute path>
node scripts/mod.mjs mode notes --agent-dir <absolute path>
node scripts/mod.mjs report --agent-dir <absolute path>
node scripts/mod.mjs qualify --agent-dir <absolute path>
node scripts/mod.mjs remove --agent-dir <absolute path> --purge-logs
```

## Modes

- `notes` (default): the first summary is a full rewrite; each later append
  keeps the earlier summary byte-for-byte and adds one timestamped notes block
  with `New user requests`, `New constraints`, `Work done`, `Current state and
  files`, and `Current next steps`. Every block says that later notes supersede
  earlier Remaining Tasks / Exact Next Steps. A consolidation rewrites the whole
  summary when the running summary reaches 8,192 tokens or four notes blocks.
  When a rewrite of an existing summary is cut at its output cap, the same slot
  retries once as a notes append (the cut attempt is not counted as a failure),
  and while the summary stays at least that large later jobs append notes
  instead of rewriting again.
- `rewrite`: every summary is a full rewrite, the same representation stock
  uses.

The default was chosen from the replay and real-model evidence in
`reports/default-decision.md`.

## What is suppressed, and only while active

While the mod is active in a session, it disables, in memory only, two builtin
pre-summarization routes:

- speculative pre-summarization (`speculativeEnabled`);
- idle warm-up (`idleCompactionEnabled`).

The suppression is keyed per session and is installed by wrapping
`ExtensionRunner.prototype.bindCore` once per process. It is never written to
any settings file, and it is never restored on the prototype; when the mod is
dormant, parked, removed, or the current session shuts down, the builtin getter
returns its original settings.

Everything else remains stock: the blocking threshold check before the next
prompt, the hard context limit, overflow recovery, and manual `/compact`.

## The three apply routes

A prepared summary is applied only while the session is idle, with no run, no
compaction, and no pending message:

- **cold** (`식은 캐시`): the provider cache is already cold - the Anthropic
  cache TTL has passed (or retention is `none`), or the local Strata slot was
  evicted. The re-read would happen anyway.
- **boundary** (`작업 끝`): the last run ended normally and the context has grown
  by at least `max(16384, 0.10W)` since the last compaction, enough to amortize
  the re-read.
- **threshold** (`한계 도달`): the context reaches the builtin threshold `T`.
  This route replaces the builtin idle apply that the suppression removes;
  stock would have summarized at this point anyway.

The mod also applies at the input seam when a submitted prompt would cross `T`,
so the next request already carries the summary. It never applies on a fixed
timer, in the middle of a reply, or while a prompt submission or a compaction is
active.

## Visible surface

While active in an interactive session the footer shows `EC 대기`,
`EC 준비중`, `EC 재시도중(잘림)`, `EC 준비됨 -<N>k`, or `EC 실패(<사유>)`
(`잘림`, `인증`, `중단` or `오류`; it stays until the next start, discard or
apply). Each successful apply emits one notice:
`조기 요약 적용: <before>k -> <after>k (식은 캐시|작업 끝|한계 도달)`.
`/early-compaction` prints the current state, mode, applies by route, the last
apply, and the dormant reason. Warnings appear only for warning dormancy
(unqualified version or a missing capability), an open failure breaker, or an
unresolved compaction model.

## Metrics and reports

Metrics are allowlisted JSONL at
`<agent-dir>/early-compaction/metrics.jsonl`, rotated at 5 MiB to
`metrics.1.jsonl` (two kept). They contain ids, counts, enums, hashes, and
durations only - never message, prompt, or summary text.

`report` joins those metrics with senpi's own compaction log
(`<agent-dir>/logs/compaction.log`; the live agent dir uses its live log).

To read the effect next to senpi's own output:

- senpi prints `TPS ... Cache hit N%` per response. A **cold** apply is followed
  by a low cache hit that would have happened anyway; a **boundary** apply's
  drop is the re-read cost the growth rule deliberately pays.
- The goal feature's `Cache-warm wait` line means the prompt cache is being kept
  warm; it is read as a warm event, so a pending cold-route apply waits.

## Rollback

Turn it off with `off` (the extension file is parked under
`early-compaction/parked/` and can be brought back with `on`), or remove it
with `remove`. Then run `/reload` or start a new session. That restores exact
stock senpi: no suppression, no jobs, no footer, no notices, and the builtin
speculative and idle pre-summarization run again. The current process keeps the
in-memory prototype wrapper until it reloads, but its per-session active entry
is removed on `session_shutdown`, so it changes nothing.

No settings file is written at any point, so there is nothing else to undo.
`remove` keeps metrics logs unless `--purge-logs` is passed.

## Known risks

- The local Strata `/slots` meaning (slot `n_prompt_tokens` and
  `is_processing`) is inferred; it has not been checked against a live local
  server during this plan. If a probe cannot be made, the cold route sees
  `unknown` and does not fire.
- On Claude, block-level prompt caching means a changed summary is re-read under
  either representation; notes therefore give little or no cache gain there.
  The measured gain is in token-prefix caching.
- Keep-alive interplay: if senpi's cache keep-alive is enabled but its ping is
  not observable, cold detection reports `unknown` rather than guessing.
- The mod uses exactly one internal seam,
  `ExtensionRunner.prototype.bindCore` and its `getCompactionSettingsFn`, with a
  self-test. An unqualified senpi version, changed builtin fingerprint, or
  missing capability makes the mod dormant and leaves stock behavior in place.
- The `PIOMO_EARLY_COMPACTION=0` environment variable is a silent kill switch;
  it also prevents the prototype wrapper from being installed.

## Development

```
bun test
bun run check
bun run build
bun run qa:isolated
bun run qa:replay
```

`qa:real-model` makes paid model calls and is run only when explicitly
requested.

## License

MIT, see `LICENSE`. The builtin compaction prompts, task-intent derivation and threshold math are ported from `@code-yeongyu/senpi` (MIT); see `NOTICE`.

## 한국어 요약

이 모드는 senpi의 조기 요약을 백그라운드에서 미리 준비해 두고, 캐시가 이미
식었거나 작업이 끝나 충분히 자랐거나 컨텍스트가 기존 임계값에 닿은 순간에만
조용히 적용합니다. 첫 요약은 전체 재작성이고, 이후에는 이전 요약을 그대로
두고 새 노트 블록을 덧붙입니다. 활성 세션에서만, 메모리 안에서만 내장 추측
요약과 유휴 예열을 끄며, 임계값 경로가 그 유휴 적용을 대신합니다. 설정 파일은
전혀 쓰지 않습니다. `off` 또는 `remove` 후 `/reload`하거나 새 세션을 열면
재고 상태의 senpi로 정확히 돌아갑니다. 기본 모드는 재생 비교와 실제 모델
검증 결과에 따라 `notes`로 정했습니다.
