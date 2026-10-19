# Changelog

## 0.1.0 - 2026-10-19

- Early compaction summaries prepared in the background and applied only at
  idle cold-cache, task-boundary, and threshold moments.
- Notes-append representation by default (first summary and consolidations are
  full rewrites); `mode rewrite` switches to full rewrites.
- In-memory, per-session suppression of the builtin speculative and idle
  pre-summarization while active; the mod's threshold route replaces the
  suppressed builtin idle apply.
- Fail-closed load gate: version and builtin fingerprint qualification,
  capability probe, reload-safe override self-test.
- Footer status, one notice per apply, warnings for failure or warning
  dormancy, and the read-only `/early-compaction` command.
- Allowlisted JSONL metrics and a numbers-only `report` command.
- `scripts/mod.mjs` with `install`, `on`, `off`, `remove`, `status`, `qualify`,
  `mode`, and `report`, sealed install receipts, dry runs, and no settings
  writes.
- Unit tests, an isolated QA harness, an offline replay comparison, and one
  two-call real-model retention run.
- Default decision: keep `notes` (median per-session prefill delta +0.94%
  token-prefix; notes retained 5/5 items and consolidation 10/10).
