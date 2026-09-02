# Prompt: loop runner (roadmap #3)

Paste into a fresh Claude Code or Codex session on `main` after the
automations PR is merged.

```text
Implement roadmap item 3, the "loop runner", in this repo (Switchyard). Read docs/roadmap.md (especially "Anti-slop levers"), design.md, and CLAUDE.md first.

Goal: a user gives an automation a brief ("Add rate limiting to the public API with tests") and Switchyard runs it as a bounded loop: plan the work as a task list, then execute one task per iteration in a fresh session with fresh context, until every task is done, the iteration cap is hit, or the budget is exhausted. Each iteration lands in the review inbox; the task list is visible on the Kanban page.

Pattern to copy, not invent: the Ralph loop (a while-loop over a prompt with progress kept in a file, fresh context every iteration) plus a Beads-style task file. Keep v1 minimal.

Build on what exists, do not build a parallel system:
- Automations (web/server/cron-scheduler.ts, cron-types.ts, routes/cron-routes.ts, src/components/AutomationsPage.tsx) already provide triggers, a fresh worktree per run, budget caps, auto-PR, and run tracking via isTurnFinished in server/inbox.ts.
- The inbox (server/inbox.ts, routes/inbox-routes.ts, src/components/InboxPage.tsx) already surfaces finished sessions.
- KanbanPage.tsx is a read-only view of TodoWrite tasks; point it at the loop's task file. Read-only in v1.
- wsBridge.injectUserMessage and interruptSession are the server-side session controls.

Design:
1. Add a `loop` option to automations: `{ enabled: boolean; maxIterations: number }` (default 10). Persist on CronJob, accept on create/update, expose in the form as a "Run as a loop" checkbox with an iteration cap.
2. Server: `server/loop-runner.ts`. For a loop-enabled run:
   a. Planning iteration: one session in the run's worktree with a planning prompt that writes `.switchyard/tasks.json` (array of { id, title, description, status: "pending" | "in_progress" | "done" | "blocked", notes }) and nothing else. Parse it; fail the run with a clear error if missing or invalid.
   b. Work iterations: for each pending task in order, launch a fresh session in the same worktree with a prompt containing the brief, the full task list, the one task to do, and the rules: do only this task; run the project's tests and do not mark the task done unless they pass; update .switchyard/tasks.json; commit with a conventional message; stop. Track it with isTurnFinished. Re-read tasks.json after each iteration. Stop when no pending tasks remain, maxIterations is reached, or cumulative cost passes budgetUsd (interrupt the current session).
   c. Record each iteration as a CronJobExecution (sessionId, taskId, cost, lines, success) plus one parent record for the loop (status, iterations used, tasks done/total/blocked). Non-loop automations must behave exactly as before.
   d. If autoPr is on, open one PR at the end for the worktree branch, not one per iteration.
3. Inbox: one item per finished loop run (Open goes to the last session; summary lists done and blocked tasks; subtitle "Loop · 5/7 tasks"). Individual iteration sessions stay hidden from the inbox unless they failed. Keep the item shape backwards compatible.
4. Kanban: `GET /api/cron/jobs/:id/loops/:runId/tasks` reads `.switchyard/tasks.json` from the run's worktree; the page shows To do / In progress / Done / Blocked for the selected loop run, and falls back to the current TodoWrite view otherwise.
5. UI: the Automations row shows "Loop · N iterations", and run history shows iterations nested under the run. Follow design.md.

Constraints:
- Both Claude Code and Codex must work; gate anything backend-specific in the UI.
- All new server and frontend code needs Vitest tests with comments explaining what each test validates; never delete or weaken existing tests. Use fake timers and mock launcher/bridge doubles like server/cron-automations.test.ts does.
- Add any new message-flow component states to the Playground.
- Run `bun run typecheck` and `bun run test` in web/ until green. Then run one real loop against this repo: manual-trigger automation, maxIterations 3, budget $1, Haiku for Claude, brief "add a --version flag to web/bin/cli.ts with a test". Verify tasks.json, the nested iterations in run history, the inbox item, and the Kanban board. Delete the smoke automation afterwards.
- Work on a branch named feat/loop-runner with conventional commits and open a PR against main with Summary, Why, Testing, and Review provenance sections. Do not merge.
```
