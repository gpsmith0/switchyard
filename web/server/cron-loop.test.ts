/**
 * Loop-enabled automations through the scheduler (docs/roadmap.md #3).
 *
 * Covers the store's `loop` option, dispatch from `executeJob` into the loop
 * runner, the parent + nested iteration records, overlap prevention while a
 * loop is between iterations, the single end-of-loop PR, failure counting,
 * and that non-loop automations are untouched. Same doubles and fake-timer
 * approach as cron-automations.test.ts; the loop itself is covered in
 * loop-runner.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { LoopTask } from "./cron-types.js";

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return { get: () => dir, set: (d: string) => { dir = d; } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

const nameMocks = vi.hoisted(() => ({ setName: vi.fn(), getName: vi.fn() }));
vi.mock("./session-names.js", () => nameMocks);

const gitMocks = vi.hoisted(() => ({
  getRepoInfo: vi.fn(),
  ensureWorktree: vi.fn(),
}));
vi.mock("./git-utils.js", () => gitMocks);

const prMocks = vi.hoisted(() => ({ createPullRequest: vi.fn() }));
vi.mock("./inbox-pr.js", () => prMocks);

let tempDir: string;
let worktree: string;
let cronStore: typeof import("./cron-store.js");
let CronSchedulerClass: typeof import("./cron-scheduler.js").CronScheduler;
let loopRunner: typeof import("./loop-runner.js");

// ─── Doubles ────────────────────────────────────────────────────────────────

interface LiveSession {
  state: { total_cost_usd: number; total_lines_added: number; total_lines_removed: number };
  messageHistory: BrowserIncomingMessage[];
}

function userMsg(): BrowserIncomingMessage {
  return { type: "user_message", content: "go", timestamp: 1 } as BrowserIncomingMessage;
}
function resultMsg(isError = false): BrowserIncomingMessage {
  return { type: "result", data: { is_error: isError } } as unknown as BrowserIncomingMessage;
}
function statusMsg(status: "idle" | "running"): BrowserIncomingMessage {
  return { type: "status_change", status } as BrowserIncomingMessage;
}
function finished(cost: number, lines: [number, number] = [0, 0]): LiveSession {
  return {
    state: { total_cost_usd: cost, total_lines_added: lines[0], total_lines_removed: lines[1] },
    messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
  };
}
function task(id: string, title: string, status: LoopTask["status"] = "pending"): LoopTask {
  return { id, title, description: "", status, notes: "" };
}

function createMockLauncher() {
  const sessions = new Map<string, Record<string, unknown> & { sessionId: string; state: string }>();
  let n = 0;
  return {
    launch: vi.fn((options: Record<string, unknown>) => {
      const sessionId = `mock-session-${++n}`;
      const info = { sessionId, state: "connected", cwd: (options.cwd as string) || "/tmp", createdAt: Date.now() };
      sessions.set(sessionId, info);
      return info;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    isAlive: vi.fn((id: string) => {
      const s = sessions.get(id);
      return !!s && s.state !== "exited";
    }),
    sessions,
  };
}

/**
 * Bridge double whose injectUserMessage plays the agent: planning writes the
 * task list, each work iteration marks the task named in its prompt done.
 */
function createLoopBridge(opts: { plan?: LoopTask[] | null; iterationCost?: number; lines?: [number, number]; doTask?: boolean } = {}) {
  const live = new Map<string, LiveSession>();
  const plan = opts.plan === undefined ? [task("t1", "First"), task("t2", "Second")] : opts.plan;
  const bridge = {
    live,
    interruptSession: vi.fn(),
    getSession: vi.fn((id: string) => live.get(id)),
    injectUserMessage: vi.fn((id: string, prompt: string) => {
      if (prompt.includes("· planning]")) {
        if (plan) loopRunner.writeTasksFile(worktree, plan);
        live.set(id, finished(0.1));
        return;
      }
      if (prompt.startsWith("[cron:")) {
        live.set(id, finished(0.2, [3, 1]));
        return;
      }
      const current = loopRunner.readTasksFile(worktree);
      if (current.ok && opts.doTask !== false) {
        const mine = current.tasks.find((t) => prompt.includes(`Your task: ${t.id} —`));
        if (mine) mine.status = "done";
        loopRunner.writeTasksFile(worktree, current.tasks);
      }
      live.set(id, finished(opts.iterationCost ?? 0.25, opts.lines ?? [10, 2]));
    }),
  };
  return bridge;
}

function createJob(overrides: Record<string, unknown> = {}) {
  return cronStore.createJob({
    name: "Rate limits",
    prompt: "Add rate limiting with tests",
    schedule: "",
    trigger: "manual",
    recurring: true,
    backendType: "claude",
    model: "claude-haiku-4-5-20251001",
    cwd: "/tmp/repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    useWorktree: true,
    loop: { enabled: true, maxIterations: 5 },
    ...overrides,
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cron-loop-"));
  worktree = join(tempDir, "worktree");
  mkdirSync(worktree, { recursive: true });
  mockHomedir.set(tempDir);
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  cronStore = await import("./cron-store.js");
  loopRunner = await import("./loop-runner.js");
  CronSchedulerClass = (await import("./cron-scheduler.js")).CronScheduler;
  gitMocks.getRepoInfo.mockReturnValue({ repoRoot: "/tmp/repo", repoName: "repo", currentBranch: "main", defaultBranch: "main", isWorktree: false });
  gitMocks.ensureWorktree.mockImplementation((_root: string, branch: string) => ({
    worktreePath: worktree,
    branch,
    actualBranch: branch,
    isNew: true,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Store ──────────────────────────────────────────────────────────────────

describe("loop option in the store", () => {
  it("normalises the loop option on create and update", () => {
    // Validates: enabled flag + iteration cap persist; a missing cap defaults
    // to 10; caps are clamped to 100; updates replace the option; updates that
    // do not mention `loop` keep it.
    const job = createJob();
    expect(job.loop).toEqual({ enabled: true, maxIterations: 5 });
    expect(createJob({ name: "Default cap", loop: { enabled: true } }).loop).toEqual({ enabled: true, maxIterations: 10 });
    expect(createJob({ name: "Clamped", loop: { enabled: true, maxIterations: 999 } }).loop).toEqual({ enabled: true, maxIterations: 100 });
    expect(createJob({ name: "Plain", loop: undefined }).loop).toBeUndefined();

    const updated = cronStore.updateJob(job.id, { loop: { enabled: false, maxIterations: 3 } });
    expect(updated?.loop).toEqual({ enabled: false, maxIterations: 3 });
    expect(cronStore.updateJob(job.id, { prompt: "new" })?.loop).toEqual({ enabled: false, maxIterations: 3 });
    expect(cronStore.updateJob(job.id, { loop: null as unknown as undefined })?.loop).toBeUndefined();
  });

  it("rejects an iteration cap below 1 or a non-object", () => {
    expect(() => createJob({ name: "Zero", loop: { enabled: true, maxIterations: 0 } })).toThrow(/at least 1/);
    expect(() => createJob({ name: "Text", loop: { enabled: true, maxIterations: "many" } })).toThrow(/at least 1/);
    expect(() => createJob({ name: "Str", loop: "yes" })).toThrow(/loop must be an object/);
  });
});

// ─── Scheduler dispatch ─────────────────────────────────────────────────────

describe("loop runs through the scheduler", () => {
  it("leaves non-loop automations exactly as before, even with loop.enabled false", async () => {
    // Validates: one session, one execution record without loop fields, the
    // classic [cron:…] prompt, and tracking via the existing poller.
    const launcher = createMockLauncher();
    const bridge = createLoopBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ loop: { enabled: false, maxIterations: 4 } });

    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(50);

    expect(launcher.launch).toHaveBeenCalledTimes(1);
    const execs = scheduler.getExecutions(job.id);
    expect(execs).toHaveLength(1);
    expect(execs[0].loopRole).toBeUndefined();
    expect(execs[0].loopRunId).toBeUndefined();
    expect(execs[0].completedAt).toBeGreaterThan(0);
    expect(execs[0].costUsd).toBe(0.2);
    expect(bridge.injectUserMessage.mock.calls[0][1]).toMatch(/^\[cron:rate-limits Rate limits\]/);
    expect(scheduler.listLoopRuns()).toEqual([]);
    scheduler.destroy();
  });

  it("runs a loop: parent record first, then planning and task iterations nested by loopRunId", async () => {
    const launcher = createMockLauncher();
    const bridge = createLoopBridge();
    const tracker = { addMapping: vi.fn() };
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10, worktreeTracker: tracker as any });
    const job = createJob();

    await scheduler.executeJob(job.id);

    // executeJob returns as soon as the loop is kicked off.
    const parent = scheduler.getExecutions(job.id)[0];
    expect(parent.loopRole).toBe("loop");
    expect(parent.loopStatus).toBe("planning");
    expect(parent.maxIterations).toBe(5);
    expect(parent.branch).toMatch(/^auto\/rate-limits\//);
    expect(parent.cwd).toBe(worktree);
    expect(scheduler.getActiveLoop(job.id)).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_000);
    await scheduler.getActiveLoop(job.id);

    expect(parent.loopStatus).toBe("completed");
    expect(parent.stopReason).toBe("done");
    expect(parent.iterationsUsed).toBe(2);
    expect(parent.tasksDone).toBe(2);
    expect(parent.tasksTotal).toBe(2);
    expect(parent.costUsd).toBeCloseTo(0.6);
    expect(parent.linesAdded).toBe(20);
    expect(parent.sessionId).toBe("mock-session-3");
    expect(parent.completedAt).toBeGreaterThan(0);

    // Three sessions, all in the same worktree, tagged with the loop run and iteration.
    expect(launcher.launch).toHaveBeenCalledTimes(3);
    expect(launcher.launch.mock.calls.every((c) => c[0].cwd === worktree)).toBe(true);
    expect(tracker.addMapping).toHaveBeenCalledTimes(3);
    const infos = [1, 2, 3].map((i) => launcher.sessions.get(`mock-session-${i}`)!);
    expect(infos.map((s) => [s.cronJobId, s.loopRunId, s.loopIteration])).toEqual([
      ["rate-limits", parent.loopRunId, 0],
      ["rate-limits", parent.loopRunId, 1],
      ["rate-limits", parent.loopRunId, 2],
    ]);
    expect(nameMocks.setName.mock.calls.map((c) => c[1])).toEqual([
      "⏰ Rate limits · plan",
      "⏰ Rate limits · 1/5 First",
      "⏰ Rate limits · 2/5 Second",
    ]);

    // Execution history: parent + 3 iterations sharing its loopRunId.
    const execs = scheduler.getExecutions(job.id);
    expect(execs.map((e) => e.loopRole)).toEqual(["loop", "planning", "task", "task"]);
    expect(execs.every((e) => e.loopRunId === parent.loopRunId)).toBe(true);
    expect(execs[2]).toMatchObject({ iteration: 1, taskId: "t1", taskTitle: "First", success: true, sessionId: "mock-session-2" });
    expect(scheduler.listLoopRuns()).toEqual([parent]);
    expect(scheduler.getLoopRun(job.id, parent.loopRunId!)).toBe(parent);

    // Job bookkeeping: one run counted, last session recorded, failures reset.
    const stored = cronStore.getJob(job.id)!;
    expect(stored.totalRuns).toBe(1);
    expect(stored.lastSessionId).toBe("mock-session-3");
    expect(stored.consecutiveFailures).toBe(0);
    expect(scheduler.getActiveLoop(job.id)).toBeUndefined();
    scheduler.destroy();
  });

  it("does not start a second run while a loop is between iterations", async () => {
    // Validates: the launcher-based overlap check would miss a loop whose last
    // session already exited, so the scheduler tracks active loops itself.
    const launcher = createMockLauncher();
    const bridge = createLoopBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();

    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(5);
    // Simulate the planning process having exited between iterations.
    for (const s of launcher.sessions.values()) s.state = "exited";
    await scheduler.executeJob(job.id, { force: true });
    expect(scheduler.getExecutions(job.id).filter((e) => e.loopRole === "loop")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await scheduler.getActiveLoop(job.id);
    // Loop finished and its last process exited → a new run may start.
    for (const s of launcher.sessions.values()) s.state = "exited";
    await scheduler.executeJob(job.id, { force: true });
    expect(scheduler.getExecutions(job.id).filter((e) => e.loopRole === "loop")).toHaveLength(2);
    scheduler.destroy();
  });

  it("opens one PR for the worktree branch at the end, not one per iteration", async () => {
    prMocks.createPullRequest.mockReturnValue({ url: "https://github.com/o/r/pull/12", branch: "auto/rate-limits/x", created: true });
    const launcher = createMockLauncher();
    const bridge = createLoopBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ autoPr: true });

    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(2_000);
    const parent = await scheduler.getActiveLoop(job.id) ?? scheduler.getExecutions(job.id)[0];

    expect(prMocks.createPullRequest).toHaveBeenCalledTimes(1);
    expect(prMocks.createPullRequest).toHaveBeenCalledWith(worktree, expect.objectContaining({
      title: expect.stringContaining("Rate limits"),
      body: expect.stringContaining("Done: First; Second"),
    }));
    expect(parent.prUrl).toBe("https://github.com/o/r/pull/12");
    expect(cronStore.getJob(job.id)!.lastPrUrl).toBe("https://github.com/o/r/pull/12");
    scheduler.destroy();
  });

  it("skips the PR when the loop changed nothing and records a PR failure without failing the run", async () => {
    const launcher = createMockLauncher();
    const quiet = createLoopBridge({ lines: [0, 0] });
    const scheduler = new CronSchedulerClass(launcher as any, quiet as any, { trackPollMs: 10 });
    const job = createJob({ autoPr: true });
    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prMocks.createPullRequest).not.toHaveBeenCalled();

    prMocks.createPullRequest.mockImplementation(() => { throw new Error("gh not authenticated"); });
    const noisy = createLoopBridge();
    const scheduler2 = new CronSchedulerClass(launcher as any, noisy as any, { trackPollMs: 10 });
    const job2 = createJob({ name: "Noisy", autoPr: true });
    await scheduler2.executeJob(job2.id);
    await vi.advanceTimersByTimeAsync(2_000);
    const parent = scheduler2.getExecutions(job2.id)[0];
    expect(parent.loopStatus).toBe("completed");
    expect(parent.success).toBe(true);
    expect(parent.error).toMatch(/PR failed: gh not authenticated/);
    scheduler.destroy();
    scheduler2.destroy();
  });

  it("counts a failed loop (no task file from planning) as a job failure", async () => {
    const launcher = createMockLauncher();
    const bridge = createLoopBridge({ plan: null });
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();

    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(2_000);
    const parent = scheduler.getExecutions(job.id)[0];
    expect(parent.loopStatus).toBe("failed");
    expect(parent.error).toMatch(/Planning did not produce a valid/);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(cronStore.getJob(job.id)!.consecutiveFailures).toBe(1);
    scheduler.destroy();
  });

  it("enforces the budget across iterations and stops the loop", async () => {
    const launcher = createMockLauncher();
    const bridge = createLoopBridge({ iterationCost: 0.8 });
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ budgetUsd: 0.5 });

    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(2_000);
    const parent = scheduler.getExecutions(job.id)[0];
    expect(bridge.interruptSession).toHaveBeenCalledTimes(1);
    expect(parent.stopReason).toBe("budget");
    expect(parent.budgetExceeded).toBe(true);
    expect(parent.iterationsUsed).toBe(1);
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    scheduler.destroy();
  });

  it("fails cleanly before launching anything when the worktree cannot be created", async () => {
    gitMocks.getRepoInfo.mockReturnValue(null);
    const launcher = createMockLauncher();
    const bridge = createLoopBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();
    await scheduler.executeJob(job.id);
    expect(launcher.launch).not.toHaveBeenCalled();
    expect(scheduler.getExecutions(job.id)[0].error).toMatch(/git repository/);
    expect(scheduler.listLoopRuns()).toEqual([]);
    scheduler.destroy();
  });
});
