/**
 * LoopRunner — a Ralph-style bounded loop for automations (docs/roadmap.md #3).
 *
 * A loop-enabled automation turns its prompt (the "brief") into a task list
 * and then works through it one task per iteration. Every iteration is a fresh
 * session with fresh context; the only state shared between iterations is the
 * repository (the run's worktree) and the Beads-style task file at
 * `.switchyard/tasks.json`.
 *
 *   planning session  →  writes .switchyard/tasks.json
 *   iteration 1..N    →  one pending task each, tests must pass, commit, stop
 *
 * The loop ends when no task is pending, when `maxIterations` work sessions
 * have run, or when the cumulative cost passes the automation's budget (the
 * running session is interrupted). Each iteration is recorded as a
 * `CronJobExecution`; the whole run is one parent record that the inbox and
 * the Kanban page read.
 *
 * Anti-slop levers baked into the prompts: one task per session, tests gate
 * "done", blocked is an allowed outcome, and a task that does not change
 * status after two attempts is marked blocked by the runner itself so the
 * loop cannot burn its budget re-trying the same thing.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { CronJob, CronJobExecution, LoopTask, LoopTaskStatus, LoopStopReason } from "./cron-types.js";
import { isTurnFinished, lastResult } from "./inbox.js";

export const TASKS_FILE = ".switchyard/tasks.json";
export const DEFAULT_MAX_ITERATIONS = 10;
export const MAX_ITERATIONS_LIMIT = 100;
/** A task attempted this many times in a row without a status change is marked blocked. */
export const NO_PROGRESS_ATTEMPTS = 2;

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_TURN_MS = 6 * 60 * 60 * 1000;

const TASK_STATUSES: LoopTaskStatus[] = ["pending", "in_progress", "done", "blocked"];

// ─── tasks.json ─────────────────────────────────────────────────────────────

export type ParsedTasks = { ok: true; tasks: LoopTask[] } | { ok: false; error: string };

/** Validate the raw contents of `.switchyard/tasks.json`. Lenient on optional text fields, strict on shape. */
export function parseTasksJson(raw: string): ParsedTasks {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  // Accept `{ "tasks": [...] }` as well as a bare array — planners do both.
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { tasks?: unknown }).tasks)) {
    data = (data as { tasks: unknown[] }).tasks;
  }
  if (!Array.isArray(data)) return { ok: false, error: "expected a JSON array of tasks" };
  if (data.length === 0) return { ok: false, error: "the task list is empty" };

  const tasks: LoopTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const t = data[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") return { ok: false, error: `task ${i + 1} is not an object` };
    const id = typeof t.id === "string" || typeof t.id === "number" ? String(t.id).trim() : "";
    if (!id) return { ok: false, error: `task ${i + 1} is missing an id` };
    if (seen.has(id)) return { ok: false, error: `task id "${id}" is used more than once` };
    seen.add(id);
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title) return { ok: false, error: `task "${id}" is missing a title` };
    const status = typeof t.status === "string" ? (t.status.trim() as LoopTaskStatus) : "pending";
    if (!TASK_STATUSES.includes(status)) {
      return { ok: false, error: `task "${id}" has unknown status "${status}" (expected ${TASK_STATUSES.join(" | ")})` };
    }
    tasks.push({
      id,
      title,
      description: typeof t.description === "string" ? t.description : "",
      status,
      notes: typeof t.notes === "string" ? t.notes : "",
    });
  }
  return { ok: true, tasks };
}

export function tasksFilePath(cwd: string): string {
  return join(cwd, TASKS_FILE);
}

/** Read and validate the task file for a run. Missing file → error. */
export function readTasksFile(cwd: string): ParsedTasks {
  const path = tasksFilePath(cwd);
  if (!existsSync(path)) return { ok: false, error: `${TASKS_FILE} was not written` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, error: `could not read ${TASKS_FILE}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseTasksJson(raw);
}

export function writeTasksFile(cwd: string, tasks: LoopTask[]): void {
  const path = tasksFilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tasks, null, 2) + "\n", "utf-8");
}

/**
 * Prepare `.switchyard/` for a run: the directory exists, it is git-ignored
 * (so iteration commits never include the task file), and any stale task
 * file from a previous run in the same folder is removed before planning.
 */
export function prepareTasksDir(cwd: string): void {
  const dir = dirname(tasksFilePath(cwd));
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf-8");
  const path = tasksFilePath(cwd);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

export function countTasks(tasks: LoopTask[]): { done: number; total: number; blocked: number; pending: number } {
  let done = 0, blocked = 0, pending = 0;
  for (const t of tasks) {
    if (t.status === "done") done++;
    else if (t.status === "blocked") blocked++;
    else pending++;
  }
  return { done, total: tasks.length, blocked, pending };
}

/** Next task to work on: the first task that is not done or blocked, in file order. */
export function pickNextTask(tasks: LoopTask[]): LoopTask | undefined {
  return tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending");
}

// ─── Prompts ────────────────────────────────────────────────────────────────

type JobPromptInfo = Pick<CronJob, "id" | "name" | "prompt">;

export function buildPlanningPrompt(job: JobPromptInfo): string {
  return [
    `[loop:${job.id} ${job.name} · planning]`,
    "",
    "You are the planning step of an automated, bounded loop. Other agents with fresh context will execute the plan one task per session, so every task must be small, self-contained, ordered, and verifiable on its own.",
    "",
    "Brief:",
    job.prompt.trim(),
    "",
    `Write the plan to \`${TASKS_FILE}\` (relative to the repository root; the directory already exists) and change nothing else.`,
    "Format: a JSON array of objects with exactly these keys:",
    '  id           short unique string, e.g. "t1"',
    "  title        one line, imperative",
    "  description  what to do and how to verify it (which tests to run or add)",
    '  status       always "pending"',
    '  notes        empty string ""',
    "",
    "Rules:",
    "1. Read the codebase first so the tasks reference real files and conventions.",
    "2. 2 to 10 tasks, each finishable in one focused session, ordered by dependency.",
    "3. Include the tests the brief asks for as part of the task that adds the behaviour, not as an afterthought.",
    "4. Do not implement anything and do not commit. Only write the task file.",
    "5. Stop as soon as the file is written.",
  ].join("\n");
}

export function buildTaskPrompt(
  job: JobPromptInfo,
  tasks: LoopTask[],
  task: LoopTask,
  iteration: number,
  maxIterations: number,
): string {
  const lines = [
    `[loop:${job.id} ${job.name} · iteration ${iteration}/${maxIterations}]`,
    "",
    `You are one iteration of a bounded loop. Previous iterations ran with fresh context; the only shared state is the repository and \`${TASKS_FILE}\`. Do not rely on anything you cannot see in the repo.`,
    "",
    "Brief:",
    job.prompt.trim(),
    "",
    `Task list (\`${TASKS_FILE}\`):`,
    "```json",
    JSON.stringify(tasks, null, 2),
    "```",
    "",
    `Your task: ${task.id} — ${task.title}`,
  ];
  if (task.description.trim()) lines.push(task.description.trim());
  if (task.notes.trim()) lines.push("", `Notes from earlier iterations: ${task.notes.trim()}`);
  lines.push(
    "",
    "Rules:",
    "1. Do only this task. Do not start other tasks, even if they look easy.",
    `2. Set this task's status to "in_progress" in ${TASKS_FILE} when you start.`,
    '3. Run the project\'s tests (and type checks, if the project has them) before you finish. Do not mark the task "done" unless they pass.',
    '4. If you cannot finish, set status "blocked" and say why in notes. Never leave it "in_progress".',
    `5. Update ${TASKS_FILE}: only this task's status and notes. Keep every other task unchanged.`,
    '6. Commit your code changes with a conventional commit message (for example "feat(scope): add …"). Do not commit the .switchyard directory.',
    "7. Stop when the task is done or blocked. Do not summarise the whole project or plan further work.",
  );
  return lines.join("\n");
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface LoopLaunchRequest {
  /** Session label shown in the sidebar */
  label: string;
  loopRunId: string;
  /** 0 = planning, 1.. = work iteration */
  iteration: number;
  taskId?: string;
}

export interface LoopRunnerDeps {
  /** Only `getSession(id)?.state` is needed to notice exited processes. */
  launcher: Pick<CliLauncher, "getSession">;
  /** Live session state, prompt injection and interrupts. */
  bridge: Pick<WsBridge, "getSession" | "injectUserMessage" | "interruptSession">;
  /** Poll interval while waiting for a turn to finish (tests lower this). */
  pollMs?: number;
  /** Give up on a single iteration after this long. */
  maxTurnMs?: number;
}

export interface LoopRunRequest {
  job: CronJob;
  /** Directory every iteration runs in (the run's worktree). */
  cwd: string;
  loopRunId: string;
  /** Parent record created by the caller; mutated as the loop progresses. */
  parent: CronJobExecution;
  /** Launch a fresh session in `cwd` and resolve once its CLI is connected. */
  launchSession: (req: LoopLaunchRequest) => Promise<string>;
  /** Called once per iteration as soon as it is created (the object keeps being updated). */
  onIteration: (execution: CronJobExecution) => void;
}

interface TurnStats {
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  isError: boolean;
  timedOut: boolean;
}

export function clampMaxIterations(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_ITERATIONS;
  return Math.min(MAX_ITERATIONS_LIMIT, Math.max(1, n));
}

export class LoopRunner {
  private readonly launcher: LoopRunnerDeps["launcher"];
  private readonly bridge: LoopRunnerDeps["bridge"];
  private readonly pollMs: number;
  private readonly maxTurnMs: number;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  constructor(deps: LoopRunnerDeps) {
    this.launcher = deps.launcher;
    this.bridge = deps.bridge;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxTurnMs = deps.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
  }

  /** Run a whole loop. Resolves with the (mutated) parent record; never rejects. */
  async run(req: LoopRunRequest): Promise<CronJobExecution> {
    const { job, cwd, loopRunId, parent } = req;
    const maxIterations = clampMaxIterations(job.loop?.maxIterations);
    const budget = job.budgetUsd != null && job.budgetUsd > 0 ? job.budgetUsd : undefined;

    parent.loopRunId = loopRunId;
    parent.loopRole = "loop";
    parent.loopStatus = "planning";
    parent.iterationsUsed = 0;
    parent.maxIterations = maxIterations;
    parent.cwd = cwd;
    parent.costUsd = parent.costUsd ?? 0;
    parent.linesAdded = 0;
    parent.linesRemoved = 0;

    let stopReason: LoopStopReason;
    try {
      prepareTasksDir(cwd);

      // ── Planning ──
      const planning = await this.runIteration(req, {
        label: `⏰ ${job.name} · plan`,
        iteration: 0,
        role: "planning",
        prompt: buildPlanningPrompt(job),
        budget,
      });
      const planned = readTasksFile(cwd);
      if (!planned.ok) {
        const detail = planning.error ? `${planned.error}; planning session: ${planning.error}` : planned.error;
        throw new Error(`Planning did not produce a valid ${TASKS_FILE}: ${detail}`);
      }
      this.snapshot(parent, planned.tasks);
      parent.loopStatus = "running";

      // ── Work iterations ──
      const attempts = new Map<string, number>();
      for (;;) {
        if (this.destroyed) throw new Error("Loop runner shut down");
        const current = readTasksFile(cwd);
        if (!current.ok) throw new Error(`${TASKS_FILE} is no longer valid: ${current.error}`);
        this.snapshot(parent, current.tasks);

        const next = pickNextTask(current.tasks);
        if (!next) { stopReason = "done"; break; }
        if (parent.budgetExceeded || (budget != null && (parent.costUsd ?? 0) >= budget)) { stopReason = "budget"; break; }
        if ((parent.iterationsUsed ?? 0) >= maxIterations) { stopReason = "max_iterations"; break; }

        const iteration: number = (parent.iterationsUsed ?? 0) + 1;
        parent.iterationsUsed = iteration;
        const statusBefore = next.status;
        const exec = await this.runIteration(req, {
          label: `⏰ ${job.name} · ${iteration}/${maxIterations} ${next.title}`,
          iteration,
          role: "task",
          taskId: next.id,
          taskTitle: next.title,
          prompt: buildTaskPrompt(job, current.tasks, next, iteration, maxIterations),
          budget,
        });
        if (exec.error && !exec.sessionId) {
          // The session never started (launch failure) — nothing the loop can do about it.
          throw new Error(exec.error);
        }

        // No-progress guard: same task, same status after two attempts → blocked.
        const after = readTasksFile(cwd);
        if (!after.ok) throw new Error(`${TASKS_FILE} is no longer valid after iteration ${iteration}: ${after.error}`);
        const updated = after.tasks.find((t) => t.id === next.id);
        if (updated && updated.status === statusBefore) {
          const n = (attempts.get(next.id) ?? 0) + 1;
          attempts.set(next.id, n);
          if (n >= NO_PROGRESS_ATTEMPTS) {
            updated.status = "blocked";
            const note = `Switchyard: no progress after ${n} iterations; marked blocked.`;
            updated.notes = updated.notes.trim() ? `${updated.notes.trim()} ${note}` : note;
            writeTasksFile(cwd, after.tasks);
            console.warn(`[loop-runner] "${job.name}" task ${next.id} made no progress after ${n} iterations; marking blocked`);
          }
        } else {
          attempts.delete(next.id);
        }
      }
    } catch (err) {
      stopReason = "error";
      parent.error = err instanceof Error ? err.message : String(err);
      console.error(`[loop-runner] "${job.name}" failed:`, parent.error);
    }

    // ── Wrap up ──
    const final = readTasksFile(cwd);
    if (final.ok) this.snapshot(parent, final.tasks);
    parent.stopReason = stopReason;
    parent.loopStatus = stopReason === "error" ? "failed" : stopReason === "done" ? "completed" : "stopped";
    parent.success = stopReason !== "error";
    parent.completedAt = Date.now();
    return parent;
  }

  /** Cancel timers so a shutting-down server does not keep polling. */
  destroy(): void {
    this.destroyed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private snapshot(parent: CronJobExecution, tasks: LoopTask[]): void {
    const counts = countTasks(tasks);
    parent.tasks = tasks.map((t) => ({ ...t }));
    parent.tasksDone = counts.done;
    parent.tasksTotal = counts.total;
    parent.tasksBlocked = counts.blocked;
  }

  private async runIteration(
    req: LoopRunRequest,
    opts: {
      label: string;
      iteration: number;
      role: "planning" | "task";
      taskId?: string;
      taskTitle?: string;
      prompt: string;
      budget?: number;
    },
  ): Promise<CronJobExecution> {
    const { job, loopRunId, parent } = req;
    const exec: CronJobExecution = {
      sessionId: "",
      jobId: job.id,
      startedAt: Date.now(),
      loopRunId,
      loopRole: opts.role,
      iteration: opts.iteration,
      taskId: opts.taskId,
      taskTitle: opts.taskTitle,
      branch: parent.branch,
      cwd: req.cwd,
    };
    req.onIteration(exec);

    const costBefore = parent.costUsd ?? 0;
    try {
      const sessionId = await req.launchSession({ label: opts.label, loopRunId, iteration: opts.iteration, taskId: opts.taskId });
      exec.sessionId = sessionId;
      parent.sessionId = sessionId;
      this.bridge.injectUserMessage(sessionId, opts.prompt);

      const stats = await this.waitForTurn(sessionId, (cost) => {
        exec.costUsd = cost;
        parent.costUsd = costBefore + cost;
        if (opts.budget != null && parent.costUsd > opts.budget && !exec.budgetExceeded) {
          exec.budgetExceeded = true;
          parent.budgetExceeded = true;
          console.warn(`[loop-runner] "${job.name}" exceeded budget ($${parent.costUsd.toFixed(2)} > $${opts.budget.toFixed(2)}), interrupting iteration ${opts.iteration}`);
          this.bridge.interruptSession(sessionId);
        }
      });

      exec.costUsd = stats.costUsd;
      parent.costUsd = costBefore + stats.costUsd;
      exec.linesAdded = stats.linesAdded;
      exec.linesRemoved = stats.linesRemoved;
      parent.linesAdded = (parent.linesAdded ?? 0) + stats.linesAdded;
      parent.linesRemoved = (parent.linesRemoved ?? 0) + stats.linesRemoved;
      if (stats.timedOut) {
        exec.success = false;
        exec.error = "Iteration timed out";
      } else if (stats.isError) {
        exec.success = false;
        exec.error = "Agent reported an error";
      } else {
        exec.success = true;
      }
    } catch (err) {
      exec.success = false;
      exec.error = err instanceof Error ? err.message : String(err);
    }
    exec.completedAt = Date.now();
    return exec;
  }

  /** Resolve once the session's turn is finished (or its process exited), polling like the automation tracker. */
  private waitForTurn(sessionId: string, onTick: (costUsd: number) => void): Promise<TurnStats> {
    return new Promise((resolve) => {
      const deadline = Date.now() + this.maxTurnMs;
      const tick = () => {
        this.timers.delete(timer);
        const live = this.bridge.getSession(sessionId);
        const state = live?.state;
        const messages = live?.messageHistory ?? [];
        const cost = state?.total_cost_usd ?? 0;
        onTick(cost);

        const processState = this.launcher.getSession(sessionId)?.state;
        const finished = processState === "exited" || (messages.length > 0 && isTurnFinished(messages));
        if (!finished && !this.destroyed && Date.now() < deadline) {
          schedule();
          return;
        }
        resolve({
          costUsd: cost,
          linesAdded: state?.total_lines_added ?? 0,
          linesRemoved: state?.total_lines_removed ?? 0,
          isError: !!lastResult(messages)?.is_error,
          timedOut: !finished,
        });
      };
      let timer: ReturnType<typeof setTimeout>;
      const schedule = () => {
        timer = setTimeout(tick, this.pollMs);
        (timer as { unref?: () => void }).unref?.();
        this.timers.add(timer);
      };
      schedule();
    });
  }
}
