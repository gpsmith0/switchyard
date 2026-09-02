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
