import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInboxItems,
  countInbox,
  extractFinalTurnSummary,
  sessionToInboxItem,
  raceToInboxItem,
  pipelineRunToInboxItem,
  InboxReviewStore,
  type InboxSessionSource,
  type InboxRaceSource,
} from "./inbox.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { PipelineRun } from "./orchestrator-types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function userMsg(content: string, timestamp: number): BrowserIncomingMessage {
  return { type: "user_message", content, timestamp } as BrowserIncomingMessage;
}

function assistantMsg(text: string, timestamp: number, parentToolUseId: string | null = null): BrowserIncomingMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    timestamp,
    message: {
      id: `m-${timestamp}`,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  } as unknown as BrowserIncomingMessage;
}

function resultMsg(isError: boolean): BrowserIncomingMessage {
  return { type: "result", data: { is_error: isError, total_cost_usd: 0.1 } } as unknown as BrowserIncomingMessage;
}

function statusMsg(status: "idle" | "running" | "compacting"): BrowserIncomingMessage {
  return { type: "status_change", status } as BrowserIncomingMessage;
}

function finishedSession(overrides: Partial<InboxSessionSource> = {}): InboxSessionSource {
  return {
    sessionId: "sess-1234-abcd",
    name: "Fix login bug",
    backendType: "claude",
    cwd: "/repo",
    createdAt: 1_000,
    state: "exited",
    bridge: {
      total_cost_usd: 0.42,
      total_lines_added: 12,
      total_lines_removed: 3,
      git_branch: "fix/login",
      is_worktree: true,
      cwd: "/repo/.worktrees/fix-login",
    },
    messages: [
      userMsg("Fix the login bug", 2_000),
      assistantMsg("Looking into it.", 2_100),
      assistantMsg("Fixed the null check in auth.ts.", 2_200),
      resultMsg(false),
      statusMsg("idle"),
    ],
    ...overrides,
  };
}

// ─── extractFinalTurnSummary ────────────────────────────────────────────────

describe("extractFinalTurnSummary", () => {
  it("returns only assistant text after the last user message", () => {
    // Validates: the summary reflects the final turn, not the whole thread.
    const messages = [
      userMsg("first", 1),
      assistantMsg("old answer", 2),
      userMsg("second", 3),
      assistantMsg("new answer", 4),
    ];
    expect(extractFinalTurnSummary(messages)).toBe("new answer");
  });

  it("skips subagent messages that carry a parent_tool_use_id", () => {
    // Validates: nested Task subagent chatter does not leak into the summary.
    const messages = [userMsg("go", 1), assistantMsg("subagent noise", 2, "tool-1"), assistantMsg("final", 3)];
    expect(extractFinalTurnSummary(messages)).toBe("final");
  });

  it("truncates very long summaries with an ellipsis", () => {
    const long = "x".repeat(1_000);
    const summary = extractFinalTurnSummary([userMsg("go", 1), assistantMsg(long, 2)]);
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary.endsWith("…")).toBe(true);
  });
});

// ─── sessionToInboxItem ─────────────────────────────────────────────────────

describe("sessionToInboxItem", () => {
  it("builds a reviewable item from a finished session", () => {
    // Validates: title, origin, summary, cost, line stats, branch and worktree
    // flags are lifted from the launcher + bridge state.
    const item = sessionToInboxItem(finishedSession());
    expect(item).not.toBeNull();
    expect(item!.id).toBe("session:sess-1234-abcd");
    expect(item!.kind).toBe("session");
    expect(item!.title).toBe("Fix login bug");
    expect(item!.subtitle).toBe("Claude Code");
    expect(item!.summary).toBe("Looking into it.\n\nFixed the null check in auth.ts.");
    expect(item!.costUsd).toBe(0.42);
    expect(item!.linesAdded).toBe(12);
    expect(item!.linesRemoved).toBe(3);
    expect(item!.hasChanges).toBe(true);
    expect(item!.branch).toBe("fix/login");
    expect(item!.isWorktree).toBe(true);
    expect(item!.cwd).toBe("/repo/.worktrees/fix-login");
    expect(item!.completedAt).toBe(2_200);
    expect(item!.outcome).toBe("completed");
    expect(item!.review).toBe("pending");
  });

  it("labels cron-spawned sessions with the job name and keeps the job id for retry", () => {
    const item = sessionToInboxItem(finishedSession({ cronJobId: "nightly-tests", cronJobName: "Nightly tests" }));
    expect(item!.subtitle).toBe("Cron · Nightly tests");
    expect(item!.cronJobId).toBe("nightly-tests");
  });

  it("marks sessions whose last result was an error as failed", () => {
    const s = finishedSession();
    s.messages = [userMsg("go", 1), assistantMsg("boom", 2), resultMsg(true), statusMsg("idle")];
    expect(sessionToInboxItem(s)!.outcome).toBe("failed");
  });

  it("skips sessions that are still running (launcher state or last status_change)", () => {
    // Validates: in-flight work never shows up as reviewable. Both signals are
    // checked because the launcher state can lag behind the bridge status.
    expect(sessionToInboxItem(finishedSession({ state: "running" }))).toBeNull();
    const s = finishedSession();
    s.messages = [...s.messages, statusMsg("running")];
    expect(sessionToInboxItem(s)).toBeNull();
  });

  it("skips sessions whose last user message has no result yet, but ignores a stale 'starting' launcher state", () => {
    // Validates: the message history decides completion. A persisted launcher
    // state of "starting" is common for processes that exited long ago, so it
    // must not hide finished work; a missing result after the last prompt must.
    expect(sessionToInboxItem(finishedSession({ state: "starting" }))).not.toBeNull();
    const s = finishedSession();
    s.messages = [...s.messages, userMsg("one more thing", 3_000)];
    expect(sessionToInboxItem(s)).toBeNull();
  });

  it("skips archived sessions, subagents, race entries, and sessions with no user turn", () => {
    expect(sessionToInboxItem(finishedSession({ archived: true }))).toBeNull();
    expect(sessionToInboxItem(finishedSession({ orchestrationRole: "subagent" }))).toBeNull();
    expect(sessionToInboxItem(finishedSession({ orchestrationRole: "race_entry" }))).toBeNull();
    expect(sessionToInboxItem(finishedSession({ parentSessionId: "parent" }))).toBeNull();
    expect(sessionToInboxItem(finishedSession({ messages: [] }))).toBeNull();
  });

  it("falls back to a short id title and createdAt when there is no name or timestamp", () => {
    const s = finishedSession({ name: undefined });
    s.messages = [{ type: "user_message", content: "hi" } as BrowserIncomingMessage, resultMsg(false)];
    const item = sessionToInboxItem(s)!;
    expect(item.title).toBe("Session sess-123");
    expect(item.completedAt).toBe(1_000);
    expect(item.summary).toBe("");
  });
});

// ─── races + pipelines ──────────────────────────────────────────────────────

describe("raceToInboxItem", () => {
  const race: InboxRaceSource = {
    raceId: "race-1",
    prompt: "Add rate limiting to the API\n\nDetails...",
    repoRoot: "/repo",
    baseBranch: "main",
    status: "completed",
    createdAt: 10,
    completedAt: 20,
    entries: [
      { id: "e-a", sessionId: "a", backendType: "claude", status: "completed", metrics: { costUsd: 0.5, linesAdded: 10, linesRemoved: 2, filesChanged: 2 } },
      { id: "e-b", sessionId: "b", backendType: "codex", status: "failed", metrics: { costUsd: 0.2 } },
    ],
  };

  it("summarises a finished race, summing cost across entries", () => {
    const item = raceToInboxItem(race)!;
    expect(item.id).toBe("race:race-1");
    expect(item.title).toBe("Add rate limiting to the API");
    expect(item.subtitle).toBe("Race · Claude Code, Codex");
    expect(item.costUsd).toBeCloseTo(0.7);
    expect(item.sessionId).toBe("a");
    expect(item.hasChanges).toBe(true);
    expect(item.summary).toContain("1 of 2 entries completed");
  });

  it("names the winner when one was picked and skips running races", () => {
    expect(raceToInboxItem({ ...race, winnerId: "a" })!.summary).toBe("Winner: Claude Code");
    expect(raceToInboxItem({ ...race, status: "running" })).toBeNull();
  });
});

describe("pipelineRunToInboxItem", () => {
  const run: PipelineRun = {
    id: "run-1",
    pipelineId: "p1",
    pipelineName: "Ship feature",
    cwd: "/repo",
    status: "completed",
    stageResults: [
      { stageId: "s1", status: "completed", sessionId: "sess-a", outputSummary: "Implemented." },
      { stageId: "s2", status: "completed", sessionId: "sess-b", outputSummary: "Tests pass." },
    ],
    startedAt: 1,
    completedAt: 2,
    totalCostUsd: 1.25,
    totalDurationMs: 100,
  };

  it("uses the last stage's session and summary", () => {
    const item = pipelineRunToInboxItem(run)!;
    expect(item.id).toBe("pipeline:run-1");
    expect(item.sessionId).toBe("sess-b");
    expect(item.summary).toBe("Tests pass.");
    expect(item.subtitle).toBe("Pipeline · 2/2 stages");
    expect(item.costUsd).toBe(1.25);
  });

  it("surfaces the failing stage's error and skips runs still in progress", () => {
    const failed: PipelineRun = {
      ...run,
      status: "failed",
      stageResults: [run.stageResults[0], { stageId: "s2", status: "failed", error: "tests failed" }],
    };
    const item = pipelineRunToInboxItem(failed)!;
    expect(item.outcome).toBe("failed");
    expect(item.summary).toBe("Failed: tests failed");
    expect(pipelineRunToInboxItem({ ...run, status: "running" })).toBeNull();
  });
});

// ─── buildInboxItems ────────────────────────────────────────────────────────

describe("buildInboxItems", () => {
  it("merges sources, applies persisted reviews, and sorts newest first", () => {
    // Validates: review state overlays derived items, and ordering is by
    // completion time regardless of source.
    const items = buildInboxItems({
      sessions: [finishedSession(), finishedSession({ sessionId: "older", name: "Older", createdAt: 1, messages: [userMsg("x", 5), assistantMsg("y", 6), resultMsg(false)] })],
      runs: [{
        id: "run-9", pipelineId: "p", pipelineName: "P", cwd: "/r", status: "completed",
        stageResults: [], startedAt: 1, completedAt: 9_000, totalCostUsd: 0, totalDurationMs: 0,
      }],
      reviews: { "session:sess-1234-abcd": { status: "reviewed", at: 123 } },
    });
    expect(items.map((i) => i.id)).toEqual(["pipeline:run-9", "session:sess-1234-abcd", "session:older"]);
    expect(items[1].review).toBe("reviewed");
    expect(items[1].reviewedAt).toBe(123);
    expect(countInbox(items)).toEqual({ pending: 2, reviewed: 1, dismissed: 0 });
  });
});

// ─── InboxReviewStore ───────────────────────────────────────────────────────

describe("InboxReviewStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inbox-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists review decisions to disk and reloads them", () => {
    // Validates: the JSON file is the source of truth across store instances.
    const path = join(dir, "nested", "inbox.json");
    const store = new InboxReviewStore(path);
    expect(store.getAll()).toEqual({});
    const rec = store.set("session:a", "reviewed");
    expect(rec?.status).toBe("reviewed");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))["session:a"].status).toBe("reviewed");

    const reloaded = new InboxReviewStore(path);
    expect(reloaded.getAll()["session:a"].status).toBe("reviewed");
  });

  it("setting pending clears the record, and clear() does the same", () => {
    const store = new InboxReviewStore(join(dir, "inbox.json"));
    store.set("x", "dismissed");
    expect(store.set("x", "pending")).toBeNull();
    expect(store.getAll()).toEqual({});
    store.set("y", "reviewed");
    store.clear("y");
    expect(store.getAll()).toEqual({});
  });

  it("survives a corrupt file", () => {
    const path = join(dir, "inbox.json");
    require("node:fs").writeFileSync(path, "{not json", "utf-8");
    expect(new InboxReviewStore(path).getAll()).toEqual({});
  });
});

// ─── Loop runs (docs/roadmap.md #3) ─────────────────────────────────────────

import { loopRunToInboxItem, summarizeLoop, describeStopReason, type InboxLoopSource } from "./inbox.js";
import type { CronJobExecution } from "./cron-types.js";

function loopRun(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    sessionId: "sess-last",
    jobId: "rate-limits",
    startedAt: 5_000,
    completedAt: 9_000,
    success: true,
    costUsd: 1.25,
    branch: "auto/rate-limits/20260902-1710",
    cwd: "/wt/rate-limits",
    linesAdded: 40,
    linesRemoved: 3,
    loopRunId: "20260902-1710-abc123",
    loopRole: "loop",
    loopStatus: "stopped",
    stopReason: "max_iterations",
    iterationsUsed: 3,
    maxIterations: 3,
    tasksDone: 2,
    tasksTotal: 4,
    tasksBlocked: 1,
    tasks: [
      { id: "t1", title: "Add limiter", description: "", status: "done", notes: "" },
      { id: "t2", title: "Wire router", description: "", status: "done", notes: "" },
      { id: "t3", title: "Per-key limits", description: "", status: "blocked", notes: "needs auth middleware" },
      { id: "t4", title: "Docs", description: "", status: "pending", notes: "" },
    ],
    ...overrides,
  };
}

describe("loopRunToInboxItem", () => {
  it("builds one item per finished loop with the task tally as subtitle and done/blocked in the summary", () => {
    // Validates the item shape the inbox row relies on: `loop:<runId>` id,
    // kind "loop", "Loop · done/total tasks", Open → last session, Retry via
    // cronJobId, Board via loopRunId, and diff stats summed over iterations.
    const item = loopRunToInboxItem({ execution: loopRun(), jobName: "Rate limits" })!;
    expect(item.id).toBe("loop:20260902-1710-abc123");
    expect(item.kind).toBe("loop");
    expect(item.title).toBe("Rate limits");
    expect(item.subtitle).toBe("Loop · 2/4 tasks");
    expect(item.summary).toContain("Done: Add limiter; Wire router");
    expect(item.summary).toContain("Blocked: Per-key limits (needs auth middleware)");
    expect(item.summary).toContain("Not started: Docs");
    expect(item.summary).toContain("Stopped at the iteration cap (3).");
    expect(item.sessionId).toBe("sess-last");
    expect(item.cronJobId).toBe("rate-limits");
    expect(item.loopRunId).toBe("20260902-1710-abc123");
    expect(item.cwd).toBe("/wt/rate-limits");
    expect(item.branch).toBe("auto/rate-limits/20260902-1710");
    expect(item.isWorktree).toBe(true);
    expect(item.completedAt).toBe(9_000);
    expect(item.costUsd).toBe(1.25);
    expect(item.linesAdded).toBe(40);
    expect(item.hasChanges).toBe(true);
    expect(item.outcome).toBe("completed");
    expect(item.review).toBe("pending");
  });

  it("falls back to the job id as title, skips running loops, and flags failed ones", () => {
    expect(loopRunToInboxItem({ execution: loopRun() })!.title).toBe("rate-limits");
    expect(loopRunToInboxItem({ execution: loopRun({ completedAt: undefined }) })).toBeNull();
    expect(loopRunToInboxItem({ execution: loopRun({ loopRole: "task" }) })).toBeNull();
    const failed = loopRunToInboxItem({ execution: loopRun({ loopStatus: "failed", stopReason: "error", error: "Planning did not produce a valid .switchyard/tasks.json" }) })!;
    expect(failed.outcome).toBe("failed");
    expect(failed.summary).toContain("Failed: Planning did not produce");
  });

  it("describes every stop reason", () => {
    expect(describeStopReason({ stopReason: "done" })).toBe("All tasks finished.");
    expect(describeStopReason({ stopReason: "max_iterations", maxIterations: 7 })).toBe("Stopped at the iteration cap (7).");
    expect(describeStopReason({ stopReason: "budget" })).toBe("Stopped at the budget cap.");
    expect(describeStopReason({ stopReason: "error" })).toBe("Failed.");
    expect(describeStopReason({})).toBe("");
    expect(summarizeLoop({ tasks: [], stopReason: "done" })).toBe("All tasks finished.");
  });
});

describe("loop iteration sessions in the inbox", () => {
  it("hides successful iteration sessions (they are reviewed through the loop item)", () => {
    const item = sessionToInboxItem(finishedSession({ cronJobId: "rate-limits", cronJobName: "Rate limits", loopRunId: "run-1", loopIteration: 2 }));
    expect(item).toBeNull();
  });

  it("still shows a failed iteration session, labelled with its loop and iteration", () => {
    // Validates: a crashed iteration is not swallowed by the loop summary; it
    // surfaces on its own so the human can open the session that failed.
    const failed = finishedSession({
      cronJobId: "rate-limits", cronJobName: "Rate limits", loopRunId: "run-1", loopIteration: 2,
      messages: [userMsg("go", 2_000), assistantMsg("boom", 2_100), resultMsg(true), statusMsg("idle")],
    });
    const item = sessionToInboxItem(failed)!;
    expect(item).not.toBeNull();
    expect(item.outcome).toBe("failed");
    expect(item.subtitle).toBe("Loop · Rate limits · iteration 2");
    const planning = sessionToInboxItem(finishedSession({ ...failed, loopIteration: 0 }))!;
    expect(planning.subtitle).toBe("Loop · Rate limits · planning");
  });

  it("buildInboxItems includes loop runs, applies reviews to them, and sorts by completion", () => {
    const loops: InboxLoopSource[] = [{ execution: loopRun({ completedAt: 10_000 }), jobName: "Rate limits" }];
    const items = buildInboxItems({
      sessions: [finishedSession()],
      loops,
      reviews: { "loop:20260902-1710-abc123": { status: "reviewed", at: 11_000 } },
    });
    expect(items.map((i) => i.id)).toEqual(["loop:20260902-1710-abc123", "session:sess-1234-abcd"]);
    expect(items[0].review).toBe("reviewed");
    expect(items[0].reviewedAt).toBe(11_000);
    expect(countInbox(items)).toEqual({ pending: 1, reviewed: 1, dismissed: 0 });
  });
});
