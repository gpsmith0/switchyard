import { Cron } from "croner";
import type { CronJob, CronJobExecution } from "./cron-types.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import * as cronStore from "./cron-store.js";
import * as envManager from "./env-manager.js";
import * as sessionNames from "./session-names.js";
import * as gitUtils from "./git-utils.js";
import { createPullRequest } from "./inbox-pr.js";
import { isTurnFinished, lastResult } from "./inbox.js";

/** Max consecutive failures before auto-disabling a job */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Max time to wait for CLI to connect (ms) */
const CLI_CONNECT_TIMEOUT_MS = 30_000;
/** Poll interval when waiting for CLI connection */
const CLI_CONNECT_POLL_MS = 500;
/** Poll interval while tracking a run to completion */
const DEFAULT_TRACK_POLL_MS = 5_000;
/** Give up tracking a run after this long */
const MAX_TRACK_MS = 6 * 60 * 60 * 1000;

export interface CronSchedulerOptions {
  /** Records worktree ↔ session mappings for automations that run in a fresh worktree */
  worktreeTracker?: WorktreeTracker;
  /** Poll interval for run tracking (tests lower this) */
  trackPollMs?: number;
}

/**
 * CronScheduler — runs automations (docs/roadmap.md #2).
 *
 * Every job is a prompt + repo + backend with a trigger (schedule, one-shot,
 * or manual). Optional automation features layered on the original cron job:
 *
 * - `useWorktree`: each run gets a fresh git worktree on `auto/<job>/<stamp>`
 * - `budgetUsd`: the run is interrupted once its cost passes the cap
 * - `autoPr`: when a run finishes with changes, push and open a GitHub PR
 *
 * Runs are tracked to completion by polling the bridge's message history, so
 * execution records carry cost, line stats, branch and PR URL. Finished runs
 * surface in the review inbox like any other session.
 */
export class CronScheduler {
  private timers = new Map<string, Cron>();
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  private worktreeTracker?: WorktreeTracker;
  private trackPollMs: number;
  private trackers = new Set<ReturnType<typeof setTimeout>>();
  /** In-memory execution history (last N per job) */
  private executions = new Map<string, CronJobExecution[]>();
  private static readonly MAX_EXECUTIONS_PER_JOB = 50;

  constructor(launcher: CliLauncher, wsBridge: WsBridge, options: CronSchedulerOptions = {}) {
    this.launcher = launcher;
    this.wsBridge = wsBridge;
    this.worktreeTracker = options.worktreeTracker;
    this.trackPollMs = options.trackPollMs ?? DEFAULT_TRACK_POLL_MS;
  }

  /** Start all enabled jobs from disk. Called once at server startup. */
  startAll(): void {
    const jobs = cronStore.listJobs();
    let started = 0;
    for (const job of jobs) {
      if (job.enabled) {
        this.scheduleJob(job);
        started++;
      }
    }
    if (started > 0) {
      console.log(`[cron-scheduler] Started ${started} cron job(s)`);
    }
  }

  /** Schedule (or reschedule) a single job. Manual-trigger jobs get no timer. */
  scheduleJob(job: CronJob): void {
    this.stopJob(job.id);

    if (!job.enabled) return;
    if (job.trigger === "manual" || !job.schedule?.trim()) return;

    try {
      if (job.recurring) {
        const cronTask = new Cron(job.schedule, {}, () => {
          this.executeJob(job.id).catch((err) => {
            console.error(`[cron-scheduler] Unhandled error in job "${job.name}":`, err);
          });
        });
        this.timers.set(job.id, cronTask);
        console.log(`[cron-scheduler] Scheduled "${job.name}" with cron "${job.schedule}"`);
      } else {
        // One-shot: schedule for the specified datetime
        const targetTime = new Date(job.schedule);
        if (targetTime.getTime() > Date.now()) {
          const cronTask = new Cron(targetTime, () => {
            this.executeJob(job.id)
              .then(() => {
                // Auto-disable after one-shot execution
                cronStore.updateJob(job.id, { enabled: false });
                this.timers.delete(job.id);
              })
              .catch((err) => {
                console.error(`[cron-scheduler] Unhandled error in one-shot job "${job.name}":`, err);
              });
          });
          this.timers.set(job.id, cronTask);
          console.log(`[cron-scheduler] Scheduled one-shot "${job.name}" at ${targetTime.toISOString()}`);
        } else {
          console.log(`[cron-scheduler] Skipping one-shot "${job.name}" — target time is in the past`);
        }
      }
    } catch (err) {
      console.error(`[cron-scheduler] Failed to schedule "${job.name}":`, err);
    }
  }

  /** Stop a job's timer. */
  stopJob(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      timer.stop();
      this.timers.delete(jobId);
    }
  }

  /** Execute a job: create a session, send the prompt, track the result. */
  async executeJob(jobId: string, opts?: { force?: boolean }): Promise<void> {
    const job = cronStore.getJob(jobId);
    if (!job) return;
    if (!job.enabled && !opts?.force) return;

    // Overlap prevention: skip if previous execution is still running
    if (job.lastSessionId && this.launcher.isAlive(job.lastSessionId)) {
      console.log(`[cron-scheduler] Skipping "${job.name}" — previous execution still running (${job.lastSessionId})`);
      return;
    }

    console.log(`[cron-scheduler] Executing job "${job.name}" (${jobId})`);

    const execution: CronJobExecution = {
      sessionId: "",
      jobId,
      startedAt: Date.now(),
    };

    try {
      // Resolve environment variables
      let envVars: Record<string, string> | undefined;
      if (job.envSlug) {
        const env = envManager.getEnv(job.envSlug);
        if (env) envVars = env.variables;
      }

      // Fresh worktree per run (automation option)
      let cwd = job.cwd;
      let worktreeInfo: NonNullable<Parameters<CliLauncher["launch"]>[0]>["worktreeInfo"];
      if (job.useWorktree) {
        const repoInfo = gitUtils.getRepoInfo(job.cwd);
        if (!repoInfo) throw new Error(`"Run in a fresh worktree" needs a git repository at ${job.cwd}`);
        const branchName = `auto/${job.id}/${runStamp()}`;
        const wt = gitUtils.ensureWorktree(repoInfo.repoRoot, branchName, {
          baseBranch: repoInfo.defaultBranch || repoInfo.currentBranch,
          createBranch: true,
        });
        cwd = wt.worktreePath;
        worktreeInfo = {
          isWorktree: true,
          repoRoot: repoInfo.repoRoot,
          branch: wt.branch,
          actualBranch: wt.actualBranch,
          worktreePath: wt.worktreePath,
        };
        execution.branch = wt.actualBranch || wt.branch;
      }

      // Launch the session via CliLauncher
      // For Codex, explicitly set sandbox and internet access for full autonomy
      const sessionInfo = this.launcher.launch({
        model: job.model,
        permissionMode: job.permissionMode,
        cwd,
        env: envVars,
        backendType: job.backendType,
        worktreeInfo,
        codexInternetAccess: job.backendType === "codex" ? (job.codexInternetAccess ?? true) : undefined,
        codexSandbox: job.backendType === "codex"
          ? (job.permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write")
          : undefined,
      });

      execution.sessionId = sessionInfo.sessionId;

      if (worktreeInfo) {
        this.worktreeTracker?.addMapping({
          sessionId: sessionInfo.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      // Tag the session as cron-originated
      sessionInfo.cronJobId = jobId;
      sessionInfo.cronJobName = job.name;

      // Set the session name
      const runLabel = `⏰ ${job.name}`;
      sessionNames.setName(sessionInfo.sessionId, runLabel);

      // Wait for CLI to connect, then send the prompt
      await this.waitForCLIConnection(sessionInfo.sessionId);

      // Send the prompt with cron prefix for traceability
      const fullPrompt = `[cron:${job.id} ${job.name}]\n\n${job.prompt}`;
      this.wsBridge.injectUserMessage(sessionInfo.sessionId, fullPrompt);

      // Update job tracking
      cronStore.updateJob(jobId, {
        lastRunAt: Date.now(),
        lastSessionId: sessionInfo.sessionId,
        totalRuns: job.totalRuns + 1,
        consecutiveFailures: 0,
      });

      execution.success = true;
      this.addExecution(jobId, execution);
      this.trackExecution(job, execution, cwd);

    } catch (err) {
      console.error(`[cron-scheduler] Job "${job.name}" failed:`, err);
      execution.error = err instanceof Error ? err.message : String(err);
      execution.completedAt = Date.now();
      this.addExecution(jobId, execution);

      const failures = job.consecutiveFailures + 1;
      const updates: Partial<CronJob> = {
        consecutiveFailures: failures,
        lastRunAt: Date.now(),
      };

      // Auto-disable after too many failures
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        updates.enabled = false;
        this.stopJob(jobId);
        console.warn(`[cron-scheduler] Job "${job.name}" disabled after ${failures} consecutive failures`);
      }

      cronStore.updateJob(jobId, updates);
    }
  }

  /** Manual trigger (run now regardless of schedule, bypasses enabled check). */
  executeJobManually(jobId: string): void {
    this.executeJob(jobId, { force: true }).catch((err) => {
      console.error(`[cron-scheduler] Manual execution of job "${jobId}" failed:`, err);
    });
  }

  /**
   * Follow a run until its turn finishes: enforce the budget cap, then record
   * cost / line stats and optionally open a PR. Skipped when the bridge cannot
   * report live session state (older bridges, minimal test doubles).
   */
  private trackExecution(job: CronJob, execution: CronJobExecution, cwd: string): void {
    const bridge = this.wsBridge as Partial<WsBridge>;
    if (typeof bridge.getSession !== "function") return;
    const deadline = Date.now() + MAX_TRACK_MS;

    const tick = () => {
      this.trackers.delete(timer);
      const live = bridge.getSession!(execution.sessionId);
      const state = live?.state;
      const messages = live?.messageHistory ?? [];
      const cost = state?.total_cost_usd ?? 0;
      execution.costUsd = cost;

      // Budget cap: interrupt once, then keep polling until the agent stops.
      if (job.budgetUsd != null && job.budgetUsd > 0 && cost > job.budgetUsd && !execution.budgetExceeded) {
        execution.budgetExceeded = true;
        console.warn(`[cron-scheduler] "${job.name}" exceeded budget ($${cost.toFixed(2)} > $${job.budgetUsd.toFixed(2)}), interrupting`);
        bridge.interruptSession?.(execution.sessionId);
      }

      const launcherState = this.launcher.getSession(execution.sessionId)?.state;
      const finished = launcherState === "exited" || (messages.length > 0 && isTurnFinished(messages));
      if (!finished) {
        if (Date.now() < deadline) schedule();
        return;
      }

      execution.completedAt = Date.now();
      execution.linesAdded = state?.total_lines_added ?? 0;
      execution.linesRemoved = state?.total_lines_removed ?? 0;
      const result = lastResult(messages);
      if (result?.is_error) {
        execution.success = false;
        execution.error = execution.error ?? "Agent reported an error";
      }

      const changed = execution.linesAdded + execution.linesRemoved > 0;
      if (job.autoPr && changed && execution.branch) {
        try {
          const pr = createPullRequest(cwd, {
            title: `${job.name} · ${new Date(execution.startedAt).toLocaleDateString()}`,
            body: `Automated run of **${job.name}** (${job.id}).\n\nSession: ${execution.sessionId}\n\n_Opened by Switchyard._`,
          });
          execution.prUrl = pr.url;
          cronStore.updateJob(job.id, { lastPrUrl: pr.url });
        } catch (err) {
          execution.error = `PR failed: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[cron-scheduler] Auto-PR for "${job.name}" failed:`, err);
        }
      }
    };

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(tick, this.trackPollMs);
      (timer as { unref?: () => void }).unref?.();
      this.trackers.add(timer);
    };
    schedule();
  }

  /** Wait for CLI to be connected (poll up to timeout). */
  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        return;
      }
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }

    throw new Error(`CLI process did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }

  /** Get next run time for a job. */
  getNextRunTime(jobId: string): Date | null {
    const timer = this.timers.get(jobId);
    if (!timer) return null;
    return timer.nextRun() || null;
  }

  /** Get recent executions for a job. */
  getExecutions(jobId: string): CronJobExecution[] {
    return this.executions.get(jobId) || [];
  }

  private addExecution(jobId: string, execution: CronJobExecution): void {
    if (!this.executions.has(jobId)) {
      this.executions.set(jobId, []);
    }
    const list = this.executions.get(jobId)!;
    list.push(execution);
    if (list.length > CronScheduler.MAX_EXECUTIONS_PER_JOB) {
      list.splice(0, list.length - CronScheduler.MAX_EXECUTIONS_PER_JOB);
    }
  }

  /** Stop all timers (for graceful shutdown). */
  destroy(): void {
    for (const timer of this.timers.values()) {
      timer.stop();
    }
    this.timers.clear();
    for (const t of this.trackers) clearTimeout(t);
    this.trackers.clear();
    this.executions.clear();
  }
}

/** Compact UTC stamp for worktree branch names, e.g. 20260902-1642 */
function runStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
