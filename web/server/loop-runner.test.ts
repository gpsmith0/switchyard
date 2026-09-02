/**
 * Loop runner (docs/roadmap.md #3): task-file parsing, the prompts, and the
 * bounded loop itself — planning, one task per fresh session, stop on done /
 * iteration cap / budget, the no-progress guard, and failure reporting.
 *
 * The launcher and bridge are plain doubles (same shape as
 * cron-automations.test.ts). A fake "agent" reacts to injected prompts by
 * editing `.switchyard/tasks.json` in a temp worktree and marking the session
 * finished, so the whole loop runs under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { CronJob, CronJobExecution, LoopTask } from "./cron-types.js";
import {
  LoopRunner,
  TASKS_FILE,
  NO_PROGRESS_ATTEMPTS,
  parseTasksJson,
  readTasksFile,
  writeTasksFile,
  prepareTasksDir,
  buildPlanningPrompt,
  buildTaskPrompt,
  pickNextTask,
  countTasks,
  clampMaxIterations,
  tasksFilePath,
} from "./loop-runner.js";

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

function finished(cost: number, lines: [number, number] = [0, 0], isError = false): LiveSession {
  return {
    state: { total_cost_usd: cost, total_lines_added: lines[0], total_lines_removed: lines[1] },
    messageHistory: [userMsg(), resultMsg(isError), statusMsg("idle")],
  };
}

function task(id: string, title: string, status: LoopTask["status"] = "pending", notes = ""): LoopTask {
  return { id, title, description: `Do ${title}`, status, notes };
}

/** A fake agent: called with (sessionId, prompt, iteration) whenever a prompt is injected. */
type Agent = (sessionId: string, prompt: string, iteration: number) => LiveSession | void;

function createHarness(agent: Agent) {
  const processes = new Map<string, { state: string }>();
  const live = new Map<string, LiveSession>();
  const launches: Array<{ label: string; iteration: number; taskId?: string }> = [];
  let n = 0;
  let currentIteration = 0;
  const launcher = { getSession: vi.fn((id: string) => processes.get(id)) };
  const bridge = {
    getSession: vi.fn((id: string) => live.get(id)),
    interruptSession: vi.fn(),
    injectUserMessage: vi.fn((id: string, prompt: string) => {
      const result = agent(id, prompt, currentIteration);
      if (result) live.set(id, result);
    }),
  };
  const launchSession = vi.fn(async (req: { label: string; iteration: number; taskId?: string }) => {
    const id = `sess-${++n}`;
    processes.set(id, { state: "connected" });
    launches.push({ label: req.label, iteration: req.iteration, taskId: req.taskId });
    currentIteration = req.iteration;
    return id;
  });
  const iterations: CronJobExecution[] = [];
  return { launcher, bridge, launchSession, launches, iterations, live, processes, onIteration: (e: CronJobExecution) => iterations.push(e) };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "rate-limits",
    name: "Rate limits",
    prompt: "Add rate limiting to the public API with tests",
    schedule: "",
    recurring: true,
    backendType: "claude",
    model: "claude-haiku-4-5-20251001",
    cwd: "/tmp/repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    trigger: "manual",
    useWorktree: true,
    loop: { enabled: true, maxIterations: 5 },
    createdAt: 1,
    updatedAt: 1,
    consecutiveFailures: 0,
    totalRuns: 0,
    ...overrides,
  };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "loop-runner-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});

/** Run a loop to completion under fake timers. */
async function runLoop(h: ReturnType<typeof createHarness>, j: CronJob, opts: { pollMs?: number } = {}) {
  const runner = new LoopRunner({ launcher: h.launcher as any, bridge: h.bridge as any, pollMs: opts.pollMs ?? 10 });
  const parent: CronJobExecution = { sessionId: "", jobId: j.id, startedAt: Date.now(), branch: "auto/rate-limits/x" };
  const done = runner.run({ job: j, cwd, loopRunId: "run-1", parent, launchSession: h.launchSession as any, onIteration: h.onIteration });
  // Each iteration needs one poll tick; 5s of fake time is plenty for any test here.
  await vi.advanceTimersByTimeAsync(5_000);
  const result = await done;
  runner.destroy();
  return result;
}

// ─── tasks.json ─────────────────────────────────────────────────────────────

describe("parseTasksJson", () => {
  it("accepts a bare array or a { tasks } wrapper and fills optional text fields", () => {
    // Validates: the planner may write either shape; description/notes default
    // to "" and a numeric id is stringified so downstream code can rely on strings.
    const bare = parseTasksJson(JSON.stringify([{ id: 1, title: "A", status: "pending" }]));
    expect(bare.ok && bare.tasks).toEqual([{ id: "1", title: "A", description: "", status: "pending", notes: "" }]);
    const wrapped = parseTasksJson(JSON.stringify({ tasks: [{ id: "t1", title: "B" }] }));
    expect(wrapped.ok && wrapped.tasks[0]).toMatchObject({ id: "t1", title: "B", status: "pending" });
  });

  it("rejects malformed files with a specific reason", () => {
    // Validates: every failure mode names what is wrong so the run's error is actionable.
    expect(parseTasksJson("{not json")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseTasksJson('{"foo": 1}')).toMatchObject({ ok: false, error: expect.stringMatching(/array/) });
    expect(parseTasksJson("[]")).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(parseTasksJson('[{"title": "x"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/missing an id/) });
    expect(parseTasksJson('[{"id": "a", "title": "x"}, {"id": "a", "title": "y"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/more than once/) });
    expect(parseTasksJson('[{"id": "a"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/missing a title/) });
    expect(parseTasksJson('[{"id": "a", "title": "x", "status": "doing"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/unknown status "doing"/) });
    expect(parseTasksJson("[1]")).toMatchObject({ ok: false, error: expect.stringMatching(/not an object/) });
  });
});

describe("task file helpers", () => {
  it("reads, writes, and reports a missing file", () => {
    expect(readTasksFile(cwd)).toMatchObject({ ok: false, error: expect.stringContaining(TASKS_FILE) });
    writeTasksFile(cwd, [task("t1", "One")]);
    const read = readTasksFile(cwd);
    expect(read.ok && read.tasks[0].title).toBe("One");
  });

  it("prepareTasksDir git-ignores the directory and drops a stale task file", () => {
    // Validates: iteration commits never pick up .switchyard/, and a loop that
    // runs in a plain folder (no worktree) does not read last week's plan.
    writeTasksFile(cwd, [task("old", "Stale")]);
    prepareTasksDir(cwd);
    expect(readFileSync(join(cwd, ".switchyard", ".gitignore"), "utf-8")).toBe("*\n");
    expect(existsSync(tasksFilePath(cwd))).toBe(false);
  });

  it("pickNextTask prefers a task left in progress, then the first pending, in file order", () => {
    const tasks = [task("a", "A", "done"), task("b", "B"), task("c", "C", "in_progress"), task("d", "D", "blocked")];
    expect(pickNextTask(tasks)?.id).toBe("c");
    tasks[2].status = "done";
    expect(pickNextTask(tasks)?.id).toBe("b");
    tasks[1].status = "blocked";
    expect(pickNextTask(tasks)).toBeUndefined();
    expect(countTasks(tasks)).toEqual({ done: 2, total: 4, blocked: 2, pending: 0 });
  });

  it("clamps the iteration cap to 1..100 with a default of 10", () => {
    expect(clampMaxIterations(undefined)).toBe(10);
    expect(clampMaxIterations(0)).toBe(1);
    expect(clampMaxIterations(3.7)).toBe(3);
    expect(clampMaxIterations(500)).toBe(100);
    expect(clampMaxIterations(Number.NaN)).toBe(10);
  });
});

// ─── Prompts ────────────────────────────────────────────────────────────────

describe("prompts", () => {
  it("planning prompt carries the brief, the file path, and the write-only rule", () => {
    const p = buildPlanningPrompt(job());
    expect(p).toContain("[loop:rate-limits Rate limits · planning]");
    expect(p).toContain("Add rate limiting to the public API with tests");
    expect(p).toContain(TASKS_FILE);
    expect(p).toContain('status       always "pending"');
    expect(p).toMatch(/Do not implement anything/);
  });

  it("task prompt carries the brief, the full list, the one task, and the anti-slop rules", () => {
    // Validates: fresh-context iterations get everything they need in one
    // message and are told to do one task, gate "done" on tests, and commit.
    const tasks = [task("t1", "Token bucket", "done"), task("t2", "Wire limiter", "pending", "see t1")];
    const p = buildTaskPrompt(job(), tasks, tasks[1], 2, 5);
    expect(p).toContain("[loop:rate-limits Rate limits · iteration 2/5]");
    expect(p).toContain("Add rate limiting to the public API with tests");
    expect(p).toContain('"id": "t1"');
    expect(p).toContain("Your task: t2 — Wire limiter");
    expect(p).toContain("Do Wire limiter");
    expect(p).toContain("Notes from earlier iterations: see t1");
    expect(p).toMatch(/Do only this task/);
    expect(p).toMatch(/Do not mark the task "done" unless they pass/);
    expect(p).toMatch(/Commit your code changes/);
    expect(p).toMatch(/Do not commit the \.switchyard directory/);
  });
});

// ─── The loop ───────────────────────────────────────────────────────────────

describe("LoopRunner.run", () => {
  it("plans, runs one fresh session per task in order, and finishes when nothing is pending", async () => {
    // Validates the happy path: planning writes two tasks; each work iteration
    // marks its task done; the parent aggregates cost/lines, records the last
    // session, and ends with stopReason "done".
    const h = createHarness((_id, prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "Token bucket"), task("t2", "Wire limiter")]);
        return finished(0.1);
      }
      const current = readTasksFile(cwd);
      if (!current.ok) throw new Error(current.error);
      const mine = current.tasks.find((t) => prompt.includes(`Your task: ${t.id} —`))!;
      mine.status = "done";
      writeTasksFile(cwd, current.tasks);
      return finished(0.25, [10, 2]);
    });
    const parent = await runLoop(h, job());

    expect(parent.loopStatus).toBe("completed");
    expect(parent.stopReason).toBe("done");
    expect(parent.success).toBe(true);
    expect(parent.iterationsUsed).toBe(2);
    expect(parent.maxIterations).toBe(5);
    expect(parent.tasksDone).toBe(2);
    expect(parent.tasksTotal).toBe(2);
    expect(parent.tasksBlocked).toBe(0);
    expect(parent.costUsd).toBeCloseTo(0.6);
    expect(parent.linesAdded).toBe(20);
    expect(parent.linesRemoved).toBe(4);
    expect(parent.sessionId).toBe("sess-3");
    expect(parent.cwd).toBe(cwd);
    expect(parent.completedAt).toBeGreaterThan(0);
    expect(parent.tasks?.map((t) => t.status)).toEqual(["done", "done"]);

    // Iteration records: planning + two tasks, each with its own session.
    expect(h.iterations.map((e) => [e.loopRole, e.iteration, e.taskId, e.sessionId, e.success])).toEqual([
      ["planning", 0, undefined, "sess-1", true],
      ["task", 1, "t1", "sess-2", true],
      ["task", 2, "t2", "sess-3", true],
    ]);
    expect(h.iterations.every((e) => e.loopRunId === "run-1" && e.completedAt)).toBe(true);
    expect(h.launches.map((l) => l.label)).toEqual(["⏰ Rate limits · plan", "⏰ Rate limits · 1/5 Token bucket", "⏰ Rate limits · 2/5 Wire limiter"]);

    // Prompts: planning, then one per task naming that task only.
    const prompts = h.bridge.injectUserMessage.mock.calls.map((c) => c[1] as string);
    expect(prompts[0]).toContain("· planning]");
    expect(prompts[1]).toContain("Your task: t1 — Token bucket");
    expect(prompts[2]).toContain("Your task: t2 — Wire limiter");
    expect(h.bridge.interruptSession).not.toHaveBeenCalled();
  });

  it("fails the run with a clear error when planning does not write a valid task file", async () => {
    // Validates: no work iteration is launched, and the error names the file
    // and the parse problem so the user can see what the planner did wrong.
    const h = createHarness(() => finished(0.05));
    const parent = await runLoop(h, job());
    expect(parent.loopStatus).toBe("failed");
    expect(parent.stopReason).toBe("error");
    expect(parent.success).toBe(false);
    expect(parent.error).toMatch(/Planning did not produce a valid \.switchyard\/tasks\.json: \.switchyard\/tasks\.json was not written/);
    expect(h.launchSession).toHaveBeenCalledTimes(1);
    expect(parent.costUsd).toBeCloseTo(0.05);

    const bad = createHarness(() => {
      mkdirSync(join(cwd, ".switchyard"), { recursive: true });
      writeFileSync(tasksFilePath(cwd), "[{", "utf-8");
      return finished(0.05);
    });
    const parent2 = await runLoop(bad, job());
    expect(parent2.error).toMatch(/not valid JSON/);
  });

  it("stops at the iteration cap and reports the tasks still open", async () => {
    const h = createHarness((_id, prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A"), task("t2", "B"), task("t3", "C")]);
        return finished(0.1);
      }
      const current = readTasksFile(cwd);
      if (!current.ok) throw new Error(current.error);
      current.tasks.find((t) => prompt.includes(`Your task: ${t.id} —`))!.status = "done";
      writeTasksFile(cwd, current.tasks);
      return finished(0.2);
    });
    const parent = await runLoop(h, job({ loop: { enabled: true, maxIterations: 2 } }));
    expect(parent.loopStatus).toBe("stopped");
    expect(parent.stopReason).toBe("max_iterations");
    expect(parent.success).toBe(true);
    expect(parent.iterationsUsed).toBe(2);
    expect(parent.tasksDone).toBe(2);
    expect(parent.tasksTotal).toBe(3);
    expect(h.launchSession).toHaveBeenCalledTimes(3);
  });

  it("interrupts the running session once cumulative cost passes the budget and stops the loop", async () => {
    // Validates: budgetUsd applies to the whole loop (planning + iterations),
    // the current session is interrupted exactly once, and no further
    // iteration starts even though tasks remain.
    const h = createHarness((_id, _prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A"), task("t2", "B")]);
        return finished(0.3);
      }
      const current = readTasksFile(cwd);
      if (!current.ok) throw new Error(current.error);
      current.tasks[0].status = "done";
      writeTasksFile(cwd, current.tasks);
      return finished(0.9);
    });
    const parent = await runLoop(h, job({ budgetUsd: 1 }));
    expect(h.bridge.interruptSession).toHaveBeenCalledTimes(1);
    expect(h.bridge.interruptSession).toHaveBeenCalledWith("sess-2");
    expect(parent.budgetExceeded).toBe(true);
    expect(parent.stopReason).toBe("budget");
    expect(parent.loopStatus).toBe("stopped");
    expect(parent.costUsd).toBeCloseTo(1.2);
    expect(parent.iterationsUsed).toBe(1);
    expect(h.iterations[1].budgetExceeded).toBe(true);
    expect(h.launchSession).toHaveBeenCalledTimes(2);
  });

  it("does not start a work iteration when planning alone already used the budget", async () => {
    const h = createHarness((_id, _prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A")]);
        return finished(0.5);
      }
      return finished(0.1);
    });
    const parent = await runLoop(h, job({ budgetUsd: 0.5 }));
    expect(parent.stopReason).toBe("budget");
    expect(h.launchSession).toHaveBeenCalledTimes(1);
  });

  it("marks a task blocked after repeated attempts with no status change (no-progress guard)", async () => {
    // Validates the anti-slop lever: an agent that keeps ending without
    // touching the task file cannot spin until the cap; after
    // NO_PROGRESS_ATTEMPTS the runner blocks the task itself and moves on.
    const h = createHarness((_id, _prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "Stuck"), task("t2", "Fine")]);
        return finished(0.1);
      }
      const current = readTasksFile(cwd);
      if (!current.ok) throw new Error(current.error);
      const t2 = current.tasks.find((t) => t.id === "t2")!;
      if (_prompt.includes("Your task: t2")) t2.status = "done";
      writeTasksFile(cwd, current.tasks);
      return finished(0.1);
    });
    const parent = await runLoop(h, job({ loop: { enabled: true, maxIterations: 10 } }));
    expect(parent.stopReason).toBe("done");
    expect(parent.iterationsUsed).toBe(NO_PROGRESS_ATTEMPTS + 1);
    const stuck = parent.tasks!.find((t) => t.id === "t1")!;
    expect(stuck.status).toBe("blocked");
    expect(stuck.notes).toMatch(/no progress after 2 iterations/);
    expect(parent.tasksBlocked).toBe(1);
    expect(parent.tasksDone).toBe(1);
    const attempted = h.iterations.filter((e) => e.loopRole === "task").map((e) => e.taskId);
    expect(attempted).toEqual(["t1", "t1", "t2"]);
  });

  it("keeps going after an iteration whose agent reported an error, recording it on that iteration", async () => {
    const h = createHarness((_id, prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A"), task("t2", "B")]);
        return finished(0.1);
      }
      const current = readTasksFile(cwd);
      if (!current.ok) throw new Error(current.error);
      current.tasks.find((t) => prompt.includes(`Your task: ${t.id} —`))!.status = "done";
      writeTasksFile(cwd, current.tasks);
      return finished(0.1, [1, 0], iteration === 1);
    });
    const parent = await runLoop(h, job());
    expect(parent.stopReason).toBe("done");
    expect(h.iterations[1].success).toBe(false);
    expect(h.iterations[1].error).toMatch(/error/i);
    expect(h.iterations[2].success).toBe(true);
    expect(parent.success).toBe(true);
  });

  it("fails when the task file becomes invalid mid-run or a session cannot be launched", async () => {
    const corrupt = createHarness((_id, _prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A")]);
        return finished(0.1);
      }
      writeFileSync(tasksFilePath(cwd), "nope", "utf-8");
      return finished(0.1);
    });
    const parent = await runLoop(corrupt, job());
    expect(parent.loopStatus).toBe("failed");
    expect(parent.error).toMatch(/no longer valid after iteration 1/);

    const h = createHarness(() => finished(0.1));
    h.launchSession.mockRejectedValueOnce(new Error("CLI process did not connect within 30s"));
    const parent2 = await runLoop(h, job());
    expect(parent2.loopStatus).toBe("failed");
    expect(parent2.error).toMatch(/Planning did not produce.*planning session: CLI process did not connect/);
    expect(h.iterations[0].error).toMatch(/did not connect/);
  });

  it("treats an exited process as a finished turn", async () => {
    // Validates: a CLI that crashes mid-iteration does not hang the loop —
    // the launcher's "exited" state ends the wait like a result would.
    const h = createHarness((id, _prompt, iteration) => {
      if (iteration === 0) {
        writeTasksFile(cwd, [task("t1", "A")]);
        return finished(0.1);
      }
      h.processes.set(id, { state: "exited" });
      h.live.set(id, { state: { total_cost_usd: 0.02, total_lines_added: 0, total_lines_removed: 0 }, messageHistory: [userMsg(), statusMsg("running")] });
    });
    const parent = await runLoop(h, job({ loop: { enabled: true, maxIterations: 1 } }));
    expect(parent.stopReason).toBe("max_iterations");
    expect(h.iterations[1].completedAt).toBeGreaterThan(0);
    expect(h.iterations[1].success).toBe(true);
  });

  it("destroy() stops polling", async () => {
    const h = createHarness(() => undefined);
    const runner = new LoopRunner({ launcher: h.launcher as any, bridge: h.bridge as any, pollMs: 10 });
    const parent: CronJobExecution = { sessionId: "", jobId: "rate-limits", startedAt: Date.now() };
    void runner.run({ job: job(), cwd, loopRunId: "run-x", parent, launchSession: h.launchSession as any, onIteration: h.onIteration });
    await vi.advanceTimersByTimeAsync(35);
    const polls = h.bridge.getSession.mock.calls.length;
    expect(polls).toBeGreaterThan(0);
    runner.destroy();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.bridge.getSession.mock.calls.length).toBe(polls);
  });
});
