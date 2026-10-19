# Apply sites (todo 11)

| Site | Admission | Survived | Evidence |
| --- | --- | --- | --- |
| `agent_settled` | boundary, cold, threshold | yes | `test/job.test.ts`: "agent_settled applies the boundary route after a normal run", "no apply while the session is not idle" |
| idle timer (30 s) | cold, threshold (boundary filtered) | yes | `test/job.test.ts`: "the idle timer applies cold/threshold only and respects the draft hold", "the idle timer does not apply a boundary route" |
| `input` (`streamingBehavior === undefined`, `source === "interactive"`) | threshold (`U + promptTokens >= T`) or cold | yes | `test/job.test.ts`: "the input seam uses the submitted prompt tokens for the threshold" |

All three apply sites survived; none was removed.

- The timer filters the policy's `boundary` route because the plan admits boundary applies only at `agent_settled`.
- The input handler awaits the `applyCompaction` promise (not the generation promise) so a threshold handoff lands before the prompt is built.
- Every apply passes `{ reason: "extension", expectedWarmAnchor, expectedRevision }` with no `signal`.
- `ctx.isCompacting?.()`, `ctx.isIdle()`, `ctx.hasPendingMessages()` and the message revision are re-checked immediately before the call.
