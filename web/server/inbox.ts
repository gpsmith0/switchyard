/**
 * Review Inbox — aggregates finished agent work into reviewable items and
 * persists the human's review decisions.
 *
 * `buildInboxItems` is a pure function over plain inputs so it can be unit
 * tested without the bridge or launcher. `InboxReviewStore` is the only
 * stateful piece: a small JSON map of item id → { status, at } under
 * `~/.switchyard/inbox.json`.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { BrowserIncomingMessage, SessionState } from "./session-types.js";
import type { PipelineRun } from "./orchestrator-types.js";
import type { CronJobExecution } from "./cron-types.js";
import type {
  InboxCounts,
  InboxItem,
  InboxOutcome,
  InboxReviewRecord,
  InboxReviewStatus,
} from "./inbox-types.js";

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** Everything the aggregator needs to know about one session. */
export interface InboxSessionSource {
  sessionId: string;
  name?: string;
  backendType?: string;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  /** Launcher process state */
  state?: "starting" | "connected" | "running" | "exited" | null;
  cronJobId?: string;
  cronJobName?: string;
  orchestrationRole?: "lead" | "subagent" | "race_entry";
  parentSessionId?: string;
  /** Loop run this session is one iteration of — surfaces through the loop item unless it failed */
  loopRunId?: string;
  loopIteration?: number;
  /** Bridge state (cost, lines, branch). Optional for sessions that never connected. */
  bridge?: Partial<SessionState> | null;
  /** Full browser-facing message history for this session. */
  messages: BrowserIncomingMessage[];
}

/** Shape of a race as exposed by the race controller's list API. */
export interface InboxRaceSource {
  raceId: string;
  prompt: string;
  repoRoot: string;
  baseBranch?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  winnerId?: string;
  entries: Array<{
    id?: string;
    sessionId?: string;
    backendType: string;
    status: string;
    metrics?: { costUsd?: number; linesAdded?: number; linesRemoved?: number; filesChanged?: number };
  }>;
}

/** A loop run's parent execution record plus the automation's display name. */
export interface InboxLoopSource {
  execution: CronJobExecution;
  jobName?: string;
}

export interface BuildInboxInput {
  sessions: InboxSessionSource[];
  races?: InboxRaceSource[];
  runs?: PipelineRun[];
  loops?: InboxLoopSource[];
  reviews?: Record<string, InboxReviewRecord>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SUMMARY_MAX = 400;

function trimSummary(text: string): string {
  const collapsed = text.replace(/[ \t]+\n/g, "\n").trim();
  if (collapsed.length <= SUMMARY_MAX) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX - 1).trimEnd() + "…";
}

/** Text of the assistant messages that follow the last user message. */
export function extractFinalTurnSummary(messages: BrowserIncomingMessage[]): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user_message") {
      lastUserIdx = i;
      break;
    }
  }
  const parts: string[] = [];
  for (const msg of messages.slice(lastUserIdx + 1)) {
    if (msg.type !== "assistant") continue;
    // Only top-level assistant text — subagent chatter carries a parent_tool_use_id.
    if (msg.parent_tool_use_id) continue;
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
    }
  }
  return trimSummary(parts.join("\n\n"));
}

function lastStatus(messages: BrowserIncomingMessage[]): "idle" | "running" | "compacting" | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "status_change") return m.status;
  }
  return null;
}

export function lastResult(messages: BrowserIncomingMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "result") return m.data;
  }
  return null;
}

function lastTimestamp(messages: BrowserIncomingMessage[], fallback: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { timestamp?: number };
    if (typeof m.timestamp === "number" && m.timestamp > 0) return m.timestamp;
  }
  return fallback;
}

function hasUserTurn(messages: BrowserIncomingMessage[]): boolean {
  return messages.some((m) => m.type === "user_message");
}

/**
 * True once the most recent user turn has produced a `result` and no later
 * status says the agent is still running. Shared by the inbox and the
 * automation run tracker so "finished" means the same thing everywhere.
 */
export function isTurnFinished(messages: BrowserIncomingMessage[]): boolean {
  const status = lastStatus(messages);
  if (status === "running" || status === "compacting") return false;
  return hasResultAfterLastUserMessage(messages);
}

function hasResultAfterLastUserMessage(messages: BrowserIncomingMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "result") return true;
    if (m.type === "user_message") return false;
  }
  return false;
}

function backendLabel(backend?: string): string {
  switch (backend) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "goose": return "Goose";
    case "aider": return "Aider";
    case "openhands": return "OpenHands";
    case "openclaw": return "OpenClaw";
    case "opencode": return "OpenCode";
    default: return backend ? backend : "Agent";
  }
}

function applyReview(item: InboxItem, reviews: Record<string, InboxReviewRecord>): InboxItem {
  const r = reviews[item.id];
  if (!r) return item;
  return { ...item, review: r.status, reviewedAt: r.at };
}

// ─── Aggregator ─────────────────────────────────────────────────────────────

export function sessionToInboxItem(s: InboxSessionSource): InboxItem | null {
  if (s.archived) return null;
  // Children of other work surface through their parent (race / pipeline / subagent).
  if (s.orchestrationRole === "subagent" || s.orchestrationRole === "race_entry" || s.parentSessionId) return null;
  if (!hasUserTurn(s.messages)) return null;
  // Still in flight — not reviewable yet. The launcher's persisted state can be
  // stale ("starting" for a process that already exited), so the message
  // history is the source of truth: a turn is finished once a `result`
  // arrived after the last user message and no later status says running.
  if (s.state === "running") return null;
  const status = lastStatus(s.messages);
  if (status === "running" || status === "compacting") return null;
  if (!hasResultAfterLastUserMessage(s.messages)) return null;

  const result = lastResult(s.messages);
  // Loop iterations are reviewed through their loop's item; only failures surface on their own.
  if (s.loopRunId && !result?.is_error) return null;
  const bridge = s.bridge ?? {};
  const linesAdded = bridge.total_lines_added ?? 0;
  const linesRemoved = bridge.total_lines_removed ?? 0;
  const outcome: InboxOutcome = result?.is_error ? "failed" : "completed";
  const origin = s.loopRunId
    ? `Loop · ${s.cronJobName ?? s.cronJobId ?? "automation"} · ${s.loopIteration === 0 ? "planning" : `iteration ${s.loopIteration ?? "?"}`}`
    : s.cronJobName ? `Cron · ${s.cronJobName}` : backendLabel(s.backendType ?? bridge.backend_type);

  return {
    id: `session:${s.sessionId}`,
    kind: "session",
    title: s.name || `Session ${s.sessionId.slice(0, 8)}`,
    subtitle: origin,
    summary: extractFinalTurnSummary(s.messages),
    cwd: bridge.cwd || s.cwd,
    branch: bridge.git_branch || "",
    isWorktree: !!bridge.is_worktree,
    backend: s.backendType ?? bridge.backend_type,
    sessionId: s.sessionId,
    cronJobId: s.cronJobId,
    completedAt: lastTimestamp(s.messages, s.createdAt),
    costUsd: bridge.total_cost_usd ?? 0,
    linesAdded,
    linesRemoved,
    outcome,
    hasChanges: linesAdded + linesRemoved > 0,
    review: "pending",
  };
}

export function raceToInboxItem(r: InboxRaceSource): InboxItem | null {
  if (r.status === "running") return null;
  const winner = r.winnerId ? r.entries.find((e) => e.id === r.winnerId || e.sessionId === r.winnerId) : undefined;
  const best = winner ?? r.entries.find((e) => e.status === "completed");
  const costUsd = r.entries.reduce((sum, e) => sum + (e.metrics?.costUsd ?? 0), 0);
  const outcome: InboxOutcome = r.status === "cancelled" ? "cancelled" : r.status === "failed" ? "failed" : "completed";
  const title = trimSummary(r.prompt).split("\n")[0].slice(0, 120) || `Race ${r.raceId.slice(0, 8)}`;
  return {
    id: `race:${r.raceId}`,
    kind: "race",
    title,
    subtitle: `Race · ${r.entries.map((e) => backendLabel(e.backendType)).join(", ")}`,
    summary: winner
      ? `Winner: ${backendLabel(winner.backendType)}`
      : best
      ? `${r.entries.filter((e) => e.status === "completed").length} of ${r.entries.length} entries completed. Pick a winner to merge.`
      : "No entry produced a usable result.",
    cwd: r.repoRoot,
    branch: r.baseBranch || "",
    isWorktree: true,
    sessionId: best?.sessionId,
    raceId: r.raceId,
    completedAt: r.completedAt ?? r.createdAt,
    costUsd,
    linesAdded: best?.metrics?.linesAdded ?? 0,
    linesRemoved: best?.metrics?.linesRemoved ?? 0,
    outcome,
    hasChanges: (best?.metrics?.filesChanged ?? 0) > 0,
    review: "pending",
  };
}

export function pipelineRunToInboxItem(run: PipelineRun): InboxItem | null {
  if (run.status === "pending" || run.status === "running") return null;
  const stages = run.stageResults;
  const lastWithSession = [...stages].reverse().find((s) => s.sessionId);
  const failed = stages.find((s) => s.status === "failed");
  const outcome: InboxOutcome = run.status === "cancelled" ? "cancelled" : run.status === "failed" ? "failed" : "completed";
  const lastSummary = [...stages].reverse().find((s) => s.outputSummary)?.outputSummary ?? "";
  return {
    id: `pipeline:${run.id}`,
    kind: "pipeline",
    title: run.pipelineName,
    subtitle: `Pipeline · ${stages.filter((s) => s.status === "completed").length}/${stages.length} stages`,
    summary: failed?.error ? trimSummary(`Failed: ${failed.error}`) : trimSummary(lastSummary),
    cwd: run.cwd,
    branch: "",
    isWorktree: false,
    sessionId: lastWithSession?.sessionId,
    runId: run.id,
    completedAt: run.completedAt ?? run.startedAt,
    costUsd: run.totalCostUsd,
    linesAdded: 0,
    linesRemoved: 0,
    outcome,
    hasChanges: false,
    review: "pending",
  };
}

/** Human-readable reason a loop stopped, for the inbox and run history. */
export function describeStopReason(exec: Pick<CronJobExecution, "stopReason" | "maxIterations" | "error">): string {
  switch (exec.stopReason) {
    case "done": return "All tasks finished.";
    case "max_iterations": return `Stopped at the iteration cap (${exec.maxIterations ?? "?"}).`;
    case "budget": return "Stopped at the budget cap.";
    case "error": return exec.error ? `Failed: ${exec.error}` : "Failed.";
    default: return "";
  }
}

/** Inbox summary for a loop: done and blocked tasks plus why the loop stopped. */
export function summarizeLoop(exec: Pick<CronJobExecution, "tasks" | "stopReason" | "maxIterations" | "error">): string {
  const tasks = exec.tasks ?? [];
  const lines: string[] = [];
  const done = tasks.filter((t) => t.status === "done");
  const blocked = tasks.filter((t) => t.status === "blocked");
  const left = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (done.length) lines.push(`Done: ${done.map((t) => t.title).join("; ")}`);
  if (blocked.length) lines.push(`Blocked: ${blocked.map((t) => (t.notes.trim() ? `${t.title} (${t.notes.trim()})` : t.title)).join("; ")}`);
  if (left.length) lines.push(`Not started: ${left.map((t) => t.title).join("; ")}`);
  const reason = describeStopReason(exec);
  if (reason) lines.push(reason);
  return lines.join("\n");
}

/** One inbox item per finished loop run. Open goes to the last session; the board link uses loopRunId. */
export function loopRunToInboxItem(src: InboxLoopSource): InboxItem | null {
  const e = src.execution;
  if (e.loopRole !== "loop" || !e.loopRunId) return null;
  if (e.completedAt == null) return null;
  const linesAdded = e.linesAdded ?? 0;
  const linesRemoved = e.linesRemoved ?? 0;
  const outcome: InboxOutcome = e.loopStatus === "failed" ? "failed" : "completed";
  return {
    id: `loop:${e.loopRunId}`,
    kind: "loop",
    title: src.jobName || e.jobId,
    subtitle: `Loop · ${e.tasksDone ?? 0}/${e.tasksTotal ?? 0} tasks`,
    summary: trimSummary(summarizeLoop(e)),
    cwd: e.cwd ?? "",
    branch: e.branch ?? "",
    isWorktree: !!e.branch,
    sessionId: e.sessionId || undefined,
    cronJobId: e.jobId,
    loopRunId: e.loopRunId,
    completedAt: e.completedAt,
    costUsd: e.costUsd ?? 0,
    linesAdded,
    linesRemoved,
    outcome,
    hasChanges: linesAdded + linesRemoved > 0,
    review: "pending",
  };
}

export function buildInboxItems(input: BuildInboxInput): InboxItem[] {
  const reviews = input.reviews ?? {};
  const items: InboxItem[] = [];
  for (const s of input.sessions) {
    const item = sessionToInboxItem(s);
    if (item) items.push(item);
  }
  for (const r of input.races ?? []) {
    const item = raceToInboxItem(r);
    if (item) items.push(item);
  }
  for (const run of input.runs ?? []) {
    const item = pipelineRunToInboxItem(run);
    if (item) items.push(item);
  }
  for (const loop of input.loops ?? []) {
    const item = loopRunToInboxItem(loop);
    if (item) items.push(item);
  }
  return items
    .map((item) => applyReview(item, reviews))
    .sort((a, b) => b.completedAt - a.completedAt);
}

export function countInbox(items: InboxItem[]): InboxCounts {
  const counts: InboxCounts = { pending: 0, reviewed: 0, dismissed: 0 };
  for (const item of items) counts[item.review]++;
  return counts;
}

// ─── Review store ───────────────────────────────────────────────────────────

const DEFAULT_PATH = join(homedir(), ".switchyard", "inbox.json");

export class InboxReviewStore {
  private reviews: Record<string, InboxReviewRecord> = {};
  private loaded = false;

  constructor(private readonly path: string = DEFAULT_PATH) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      if (raw && typeof raw === "object") this.reviews = raw as Record<string, InboxReviewRecord>;
    } catch {
      this.reviews = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.reviews, null, 2), "utf-8");
  }

  getAll(): Record<string, InboxReviewRecord> {
    this.load();
    return { ...this.reviews };
  }

  set(itemId: string, status: InboxReviewStatus): InboxReviewRecord | null {
    this.load();
    if (status === "pending") {
      delete this.reviews[itemId];
      this.save();
      return null;
    }
    const record: InboxReviewRecord = { status, at: Date.now() };
    this.reviews[itemId] = record;
    this.save();
    return record;
  }

  clear(itemId: string): void {
    this.set(itemId, "pending");
  }
}
