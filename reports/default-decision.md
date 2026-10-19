# Default mode decision - 2026-10-19

## Rule

Todo 17 of the plan keeps `notes` unless either of these holds:

1. the median session's `early-notes` total prefill exceeds `early-rewrite`
   by more than 10%; or
2. the notes block kept fewer than 4 of the 5 planted second-half items while
   the consolidation kept at least 9 of the 10 planted items.

The median is computed per session from `reports/replay-2026-10-19.json`, not
from the totals row. Two readings of "median session" are shown below: the
median of the five per-session relative deltas, and the ratio of the median
notes total to the median rewrite total. Both agree.

## Inputs

- Replay (todo 15): `reports/replay-2026-10-19.json`,
  `reports/replay-2026-10-19.md`; 5 sessions replayed over a 14-day window;
  stock 176 applies, early-rewrite 390 applies, early-notes 392 applies.
  Prefill charges the first recorded request in full in both cache models for
  every policy, even when a compaction applies at it; the post-apply context
  is charged on the following request.
- Real-model run (todo 16):
  `.omo/evidence/overlay-early-compaction-mod/task-16-overlay-early-compaction-mod.json`;
  2 calls on `ollama/deepseek-v4.1-flash`, both succeeded.
- Notes size model: 0.08 x span tokens. Rewrite size model: median recorded
  builtin summary tokens (fallback 0.1 x span).

## Per-session totals

Token-prefix caching is the primary cache model. Block-level caching is an
Anthropic model and is INFERRED, not measured here.

| session | notes prefill (token-prefix) | rewrite prefill (token-prefix) | delta | notes prefill (block-level, INFERRED) | rewrite prefill (block-level, INFERRED) | delta | notes applies | consolidations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 649ef8033436 | 28,565,085 | 28,527,198 | +0.13% | 14,868,481 | 14,889,359 | -0.14% | 64 | 24 |
| 0a8240306866 | 35,600,692 | 34,423,894 | +3.42% | 16,133,644 | 15,965,063 | +1.06% | 122 | 40 |
| d4a88b07e98d | 22,437,609 | 22,228,985 | +0.94% | 10,195,441 | 10,198,248 | -0.03% | 56 | 14 |
| 2052a6a355d8 | 24,641,480 | 24,305,359 | +1.38% | 11,021,629 | 10,971,433 | +0.46% | 83 | 34 |
| 513996effe65 | 21,431,693 | 21,432,154 | -0.00% | 10,168,418 | 10,146,415 | +0.22% | 67 | 28 |

Medians from the five rows:

| measure | token-prefix | block-level (INFERRED) |
| --- | ---: | ---: |
| median of per-session deltas | +0.94% | +0.22% |
| ratio of median notes total to median rewrite total | +1.38% | +0.46% |
| totals delta (context, not the decision statistic) | +1.34% | +0.35% |

The largest single-session token-prefix delta is +3.42%, well under the 10%
limit. No reading of the rule crosses 10%.

## Retention check

The real-model run recorded:

- notes block: 5 of 5 planted second-half items kept, and all five section
  titles present (`New user requests`, `New constraints`, `Work done`,
  `Current state and files`, `Current next steps`);
- consolidation: 10 of 10 planted items kept (five first-half, five
  second-half);
- usage: call 1 input 14,571 / output 682; call 2 input 15,522 / output 1,032;
  no timeout, no retry.

5/5 is not fewer than 4/5, so the second branch of the rule does not fire.

## Decision

Keep `notes`.

`config.default.json` stays `{"schema":1,"mode":"notes","policy":{}}`, and
installs seed that mode into a new agent dir. `mode rewrite` remains available
as the switchable alternative.

## Observed caveats

- Consolidation frequency. The specified 0.08 x span notes size grows the
  running summary quickly: 140 of 392 notes applies (35.7%) were
  `rewrite-consolidate`, and the final summary retains only one notes block in
  total across the five sessions. After roughly 1-2 appends the 8,192-token
  consolidation floor (or the 4-block cap) is reached, so notes mode
  degenerates toward rewrite-consolidate on these long sessions. The decision
  still holds because the prefill delta stays near zero, but the cache benefit
  of appending is smaller than the representation alone suggests.
- Block-level caching is INFERRED. The block-level figures come from the
  replay's model of Anthropic-style caching, not from a live Claude run. On
  Claude a changed summary is re-read under either representation, so notes
  should show little or no cache gain there; the token-prefix figures are the
  ones this environment can exercise.
- Fixture and model specificity. Todo 16 is a synthetic ~30,000-token fixture
  with five planted verbatim items in each half, summarized by
  `ollama/deepseek-v4.1-flash`. Retention 5/5 and 10/10 shows the prompts and
  section contract work on that fixture and model; it is not a broad quality
  benchmark across models or real conversations.
- Single paid run. The real-model evidence is one notes call plus one
  consolidation call, with no retry. It is one sample, not a distribution.
- Replay assumptions. Jobs are treated as READY at the request that starts
  them; generation latency, cooldowns beyond the start-time caps, and breaker
  state are not modelled. These assumptions are stated in the replay report
  and apply equally to both early policies.

## Superseded figures

Superseded (pre-fix replay, not used): early-notes 132,233,856 token-prefix /
62,276,637 block-level versus early-rewrite 130,488,093 / 62,058,938, or
+1.34% / +0.35%, with 139 consolidations. That run omitted the first cold
request when it triggered or coincided with an apply. The regenerated replay
above replaces those figures.
