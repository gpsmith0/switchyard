/**
 * Review Inbox types.
 *
 * The inbox is the one place where finished agent work lands for a human to
 * look at: completed sessions (including cron- and agent-spawned ones), races,
 * and orchestrator pipeline runs. Items are derived on demand from the
 * existing stores; only the review state (reviewed / dismissed) is persisted.
 */

export type InboxItemKind = "session" | "race" | "pipeline";

export type InboxReviewStatus = "pending" | "reviewed" | "dismissed";

export type InboxOutcome = "completed" | "failed" | "cancelled";

export interface InboxItem {
  /** Stable id: `session:<sessionId>` | `race:<raceId>` | `pipeline:<runId>` */
  id: string;
  kind: InboxItemKind;
  /** Primary label — session name, race prompt, pipeline name */
  title: string;
  /** Origin line — e.g. "Cron · Nightly tests", "Codex", "Race · 3 backends" */
  subtitle: string;
  /** Last assistant text for the final turn, trimmed */
  summary: string;
  cwd: string;
  branch: string;
  isWorktree: boolean;
  backend?: string;
  /** Session to open for "Open" / "Diff" (winner for races, last stage for pipelines) */
  sessionId?: string;
  raceId?: string;
  runId?: string;
  /** Cron job that produced this session, if any (enables Retry) */
  cronJobId?: string;
  completedAt: number;
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  outcome: InboxOutcome;
  hasChanges: boolean;
  review: InboxReviewStatus;
  reviewedAt?: number;
}

export interface InboxCounts {
  pending: number;
  reviewed: number;
  dismissed: number;
}

export interface InboxResponse {
  items: InboxItem[];
  counts: InboxCounts;
}

export interface InboxReviewRecord {
  status: Exclude<InboxReviewStatus, "pending">;
  at: number;
}
