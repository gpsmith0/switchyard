/**
 * Automation features layered on the cron scheduler (docs/roadmap.md #2):
 * manual triggers, fresh worktree per run, budget caps, auto-PR, and run
 * tracking. The core scheduling behaviour is covered in cron-scheduler.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserIncomingMessage } from "./session-types.js";

// Mock homedir so cron-store writes to a temp directory
const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return { get: () => dir, set: (d: string) => { dir = d; } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

vi.mock("./session-names.js", () => ({ setName: vi.fn(), getName: vi.fn() }));

const gitMocks = vi.hoisted(() => ({
  getRepoInfo: vi.fn(),
  ensureWorktree: vi.fn(),
}));
vi.mock("./git-utils.js", () => gitMocks);

const prMocks = vi.hoisted(() => ({ createPullRequest: vi.fn() }));
vi.mock("./inbox-pr.js", () => prMocks);

let tempDir: string;
let cronStore: typeof import("./cron-store.js");
let CronSchedulerClass: typeof import("./cron-scheduler.js").CronScheduler;

// ─── Doubles ────────────────────────────────────────────────────────────────

interface LiveSession {
  state: { total_cost_usd: number; total_lines_added: number; total_lines_removed: number };
  messageHistory: BrowserIncomingMessage[];
}

function createMockLauncher() {
  const sessions = new Map<string, { sessionId: string; state: string; cwd: string; cronJobId?: string; cronJobName?: string }>();
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

function createTrackingBridge() {
  const live = new Map<string, LiveSession>();
  return {
    live,
    injectUserMessage: vi.fn(),
    interruptSession: vi.fn(),
    getSession: vi.fn((id: string) => live.get(id)),
  };
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

function createJob(overrides: Record<string, unknown> = {}) {
  return cronStore.createJob({
    name: "Nightly",
    prompt: "Do the thing",
    schedule: "0 2 * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/tmp/repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    ...overrides,
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cron-auto-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  cronStore = await import("./cron-store.js");
  CronSchedulerClass = (await import("./cron-scheduler.js")).CronScheduler;
  gitMocks.getRepoInfo.mockReturnValue({ repoRoot: "/tmp/repo", repoName: "repo", currentBranch: "main", defaultBranch: "main", isWorktree: false });
  gitMocks.ensureWorktree.mockImplementation((_root: string, branch: string) => ({
    worktreePath: `/tmp/worktrees/repo/${branch.replaceAll("/", "-")}`,
    branch,
    actualBranch: branch,
    isNew: true,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Store validation ───────────────────────────────────────────────────────

describe("automation fields in the store", () => {
  it("allows manual-trigger jobs without a schedule and rejects negative budgets", () => {
    // Validates: "Manual" automations are runnable via Run now without a cron
    // expression, and the budget cap must be a sane number.
    const job = createJob({ trigger: "manual", schedule: "" });
    expect(job.trigger).toBe("manual");
    expect(job.schedule).toBe("");
    expect(() => createJob({ name: "Bad", budgetUsd: -1 })).toThrow(/Budget/);
  });

  it("still requires a schedule for scheduled jobs", () => {
    expect(() => createJob({ name: "No sched", schedule: "" })).toThrow(/schedule/);
  });
});

// ─── Scheduling ─────────────────────────────────────────────────────────────

describe("manual trigger", () => {
  it("does not create a timer for manual jobs but still runs them on demand", async () => {
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ trigger: "manual", schedule: "" });

    scheduler.scheduleJob(job);
    expect(scheduler.getNextRunTime(job.id)).toBeNull();

    await scheduler.executeJob(job.id, { force: true });
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });
});

// ─── Worktrees ──────────────────────────────────────────────────────────────

describe("fresh worktree per run", () => {
  it("creates an auto/<job>/<stamp> branch worktree and launches there", async () => {
    // Validates: the session's cwd is the new worktree, the launcher receives
    // worktreeInfo, the tracker records the mapping, and the execution knows
    // its branch so a PR can be opened later.
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const tracker = { addMapping: vi.fn() };
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { worktreeTracker: tracker as any, trackPollMs: 10 });
    const job = createJob({ useWorktree: true });

    await scheduler.executeJob(job.id);

    expect(gitMocks.ensureWorktree).toHaveBeenCalledWith(
      "/tmp/repo",
      expect.stringMatching(/^auto\/nightly\/\d{8}-\d{4}$/),
      expect.objectContaining({ createBranch: true, baseBranch: "main" }),
    );
    const launchOpts = launcher.launch.mock.calls[0][0];
    expect(launchOpts.cwd).toMatch(/^\/tmp\/worktrees\/repo\/auto-nightly-/);
    expect(launchOpts.worktreeInfo).toMatchObject({ isWorktree: true, repoRoot: "/tmp/repo" });
    expect(tracker.addMapping).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "mock-session-1", repoRoot: "/tmp/repo" }));
    expect(scheduler.getExecutions(job.id)[0].branch).toMatch(/^auto\/nightly\//);
    scheduler.destroy();
  });

  it("fails the run cleanly when the folder is not a git repository", async () => {
    gitMocks.getRepoInfo.mockReturnValue(null);
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ useWorktree: true });

    await scheduler.executeJob(job.id);

    expect(launcher.launch).not.toHaveBeenCalled();
    const exec = scheduler.getExecutions(job.id)[0];
    expect(exec.error).toMatch(/git repository/);
    expect(cronStore.getJob(job.id)!.consecutiveFailures).toBe(1);
    scheduler.destroy();
  });
});

// ─── Run tracking, budget, auto-PR ──────────────────────────────────────────

describe("run tracking", () => {
  it("records cost and line stats when the turn finishes", async () => {
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();

    await scheduler.executeJob(job.id);
    const exec = scheduler.getExecutions(job.id)[0];
    expect(exec.completedAt).toBeUndefined();

    // Agent is still working…
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 0.2, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), statusMsg("running")],
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(exec.completedAt).toBeUndefined();
    expect(exec.costUsd).toBe(0.2);

    // …then finishes.
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 0.5, total_lines_added: 20, total_lines_removed: 4 },
      messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(exec.completedAt).toBeGreaterThan(0);
    expect(exec.costUsd).toBe(0.5);
    expect(exec.linesAdded).toBe(20);
    expect(exec.linesRemoved).toBe(4);
    expect(exec.success).toBe(true);
    expect(prMocks.createPullRequest).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it("interrupts the session once cost passes the budget cap and flags the run", async () => {
    // Validates: budgetUsd is enforced exactly once per run, and the record
    // shows budgetExceeded so the inbox / page can explain what happened.
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ budgetUsd: 1 });

    await scheduler.executeJob(job.id);
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 1.4, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), statusMsg("running")],
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(bridge.interruptSession).toHaveBeenCalledTimes(1);
    expect(bridge.interruptSession).toHaveBeenCalledWith("mock-session-1");

    // Cost keeps climbing while the agent winds down — no second interrupt.
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 1.6, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), statusMsg("running")],
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(bridge.interruptSession).toHaveBeenCalledTimes(1);

    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 1.6, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);
    const exec = scheduler.getExecutions(job.id)[0];
    expect(exec.budgetExceeded).toBe(true);
    expect(exec.completedAt).toBeGreaterThan(0);
    scheduler.destroy();
  });

  it("opens a PR when autoPr is on, the run ran in a worktree, and there are changes", async () => {
    prMocks.createPullRequest.mockReturnValue({ url: "https://github.com/o/r/pull/7", branch: "auto/nightly/x", created: true });
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob({ useWorktree: true, autoPr: true });

    await scheduler.executeJob(job.id);
    const cwd = launcher.launch.mock.calls[0][0].cwd as string;
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 0.3, total_lines_added: 5, total_lines_removed: 1 },
      messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);

    expect(prMocks.createPullRequest).toHaveBeenCalledWith(cwd, expect.objectContaining({ title: expect.stringContaining("Nightly") }));
    const exec = scheduler.getExecutions(job.id)[0];
    expect(exec.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(cronStore.getJob(job.id)!.lastPrUrl).toBe("https://github.com/o/r/pull/7");
    scheduler.destroy();
  });

  it("skips the PR when nothing changed, and records PR failures without failing the run", async () => {
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });

    // No changes → no PR attempt
    const quiet = createJob({ name: "Quiet", useWorktree: true, autoPr: true });
    await scheduler.executeJob(quiet.id);
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 0.1, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(prMocks.createPullRequest).not.toHaveBeenCalled();

    // gh fails → error recorded, run still counts as success
    prMocks.createPullRequest.mockImplementation(() => { throw new Error("gh not authenticated"); });
    const noisy = createJob({ name: "Noisy", useWorktree: true, autoPr: true });
    await scheduler.executeJob(noisy.id);
    bridge.live.set("mock-session-2", {
      state: { total_cost_usd: 0.1, total_lines_added: 3, total_lines_removed: 0 },
      messageHistory: [userMsg(), resultMsg(), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);
    const exec = scheduler.getExecutions(noisy.id)[0];
    expect(exec.success).toBe(true);
    expect(exec.error).toMatch(/PR failed: gh not authenticated/);
    scheduler.destroy();
  });

  it("marks the run failed when the agent's result is an error", async () => {
    const launcher = createMockLauncher();
    const bridge = createTrackingBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();
    await scheduler.executeJob(job.id);
    bridge.live.set("mock-session-1", {
      state: { total_cost_usd: 0.1, total_lines_added: 0, total_lines_removed: 0 },
      messageHistory: [userMsg(), resultMsg(true), statusMsg("idle")],
    });
    await vi.advanceTimersByTimeAsync(15);
    const exec = scheduler.getExecutions(job.id)[0];
    expect(exec.success).toBe(false);
    expect(exec.error).toMatch(/error/i);
    scheduler.destroy();
  });

  it("does not track runs when the bridge cannot report live state", async () => {
    // Validates: minimal bridges (older deployments, plain doubles) still
    // execute jobs; tracking is simply skipped instead of throwing.
    const launcher = createMockLauncher();
    const bridge = { injectUserMessage: vi.fn() };
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any, { trackPollMs: 10 });
    const job = createJob();
    await scheduler.executeJob(job.id);
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.getExecutions(job.id)[0].completedAt).toBeUndefined();
    scheduler.destroy();
  });
});
