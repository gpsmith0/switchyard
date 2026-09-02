// ─── Cron Job Types ────────────────────────────────────────────────────────

export interface CronJob {
  /** Unique slug-based ID (derived from name) */
  id: string;
  /** Human-readable job name */
  name: string;
  /** The prompt to send when the job fires */
  prompt: string;
  /** Cron expression (e.g. "0 8 * * *") or ISO datetime string for one-shot */
  schedule: string;
  /** true = recurring cron, false = one-shot at a specific time */
  recurring: boolean;
  /** Backend to use */
  backendType: "claude" | "codex";
  /** Model to use (e.g. "claude-sonnet-4-5-20250929") */
  model: string;
  /** Working directory for the session */
  cwd: string;
  /** Optional environment slug (references ~/.switchyard/envs/) */
  envSlug?: string;
  /** Whether the job is currently enabled */
  enabled: boolean;
  /** Permission mode — defaults to "bypassPermissions" for autonomy */
  permissionMode: string;
  /** Codex-only: enable internet access */
  codexInternetAccess?: boolean;

  // ── Automation options (docs/roadmap.md #2) ──
  /** "schedule" runs on the cron/one-shot schedule; "manual" only runs via Run now / the API */
  trigger?: "schedule" | "manual";
  /** Run every execution in a fresh git worktree on its own branch */
  useWorktree?: boolean;
  /** After a run finishes with changes, push the branch and open a GitHub PR */
  autoPr?: boolean;
  /** Interrupt the run once its cost exceeds this many USD */
  budgetUsd?: number;
  /** URL of the most recent PR opened by this automation */
  lastPrUrl?: string;
  /**
   * Loop runner (docs/roadmap.md #3): plan the prompt as a task list, then run
   * one task per iteration in a fresh session until every task is done, the
   * iteration cap is hit, or the budget is exhausted.
   */
  loop?: CronLoopOptions;

  // ── Tracking ──
  createdAt: number;
  updatedAt: number;
  /** Last time this job was triggered */
  lastRunAt?: number;
  /** Session ID of the last execution */
  lastSessionId?: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Total number of runs */
  totalRuns: number;
}

export interface CronLoopOptions {
  enabled: boolean;
  /** Upper bound on work iterations (planning is not counted). Default 10. */
  maxIterations: number;
}

export type LoopTaskStatus = "pending" | "in_progress" | "done" | "blocked";

/** One entry of `.switchyard/tasks.json` — the loop's Beads-style task file. */
export interface LoopTask {
  id: string;
  title: string;
  description: string;
  status: LoopTaskStatus;
  notes: string;
}

export type LoopStatus = "planning" | "running" | "completed" | "stopped" | "failed";

export type LoopStopReason = "done" | "max_iterations" | "budget" | "error";

export interface CronJobExecution {
  /** The session ID created for this execution (for loops: the most recent session) */
  sessionId: string;
  /** The job ID that triggered this */
  jobId: string;
  /** When the execution started */
  startedAt: number;
  /** When the execution completed (result received) */
  completedAt?: number;
  /** Whether the execution succeeded */
  success?: boolean;
  /** Error message if it failed */
  error?: string;
  /** Cost in USD */
  costUsd?: number;
  /** Worktree branch the run executed on (when useWorktree) */
  branch?: string;
  /** Lines added/removed reported by the bridge at completion */
  linesAdded?: number;
  linesRemoved?: number;
  /** PR opened for this run (when autoPr) */
  prUrl?: string;
  /** True when the run was interrupted for exceeding budgetUsd */
  budgetExceeded?: boolean;

  // ── Loop runner (docs/roadmap.md #3) ──
  /** Shared by the loop's parent record and each of its iterations */
  loopRunId?: string;
  /** "loop" = parent record for the whole run; "planning" / "task" = one iteration */
  loopRole?: "loop" | "planning" | "task";
  /** Iteration number: 0 for planning, 1..maxIterations for work */
  iteration?: number;
  /** Task the iteration worked on */
  taskId?: string;
  taskTitle?: string;
  /** Directory the run executed in (worktree path when useWorktree) */
  cwd?: string;
  // Parent record only:
  loopStatus?: LoopStatus;
  stopReason?: LoopStopReason;
  iterationsUsed?: number;
  maxIterations?: number;
  tasksDone?: number;
  tasksTotal?: number;
  tasksBlocked?: number;
  /** Final snapshot of `.switchyard/tasks.json` (kept so the board survives worktree cleanup) */
  tasks?: LoopTask[];
}

/** Input for creating a cron job (without auto-generated fields) */
export type CronJobCreateInput = Omit<
  CronJob,
  "id" | "createdAt" | "updatedAt" | "consecutiveFailures" | "totalRuns" | "lastRunAt" | "lastSessionId"
>;
