/**
 * Cron / automation routes: the `loop` option on create and update, and the
 * loop-run endpoints used by the Kanban page (docs/roadmap.md #3):
 *
 *   GET /cron/loops                         parent records + automation name
 *   GET /cron/jobs/:id/loops/:runId/tasks   .switchyard/tasks.json from the
 *                                           run's worktree, else the snapshot
 *
 * The cron store writes to a temp home directory; the scheduler is a double
 * that only knows the loop-run accessors the routes call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CronJobExecution } from "../cron-types.js";

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return { get: () => dir, set: (d: string) => { dir = d; } };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

let tempDir: string;
let app: Hono;
let cronStore: typeof import("../cron-store.js");
let runs: CronJobExecution[];

const scheduler = {
  getNextRunTime: vi.fn(() => null),
  scheduleJob: vi.fn(),
  stopJob: vi.fn(),
  executeJobManually: vi.fn(),
  getExecutions: vi.fn((jobId: string) => runs.filter((r) => r.jobId === jobId)),
  listLoopRuns: vi.fn(() => runs.filter((r) => r.loopRole === "loop")),
  getLoopRun: vi.fn((jobId: string, runId: string) => runs.find((r) => r.jobId === jobId && r.loopRole === "loop" && r.loopRunId === runId)),
};

function parentRun(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    sessionId: "sess-9",
    jobId: "rate-limits",
    startedAt: 1_000,
    completedAt: 2_000,
    success: true,
    costUsd: 0.7,
    branch: "auto/rate-limits/x",
    cwd: join(tempDir, "wt"),
    loopRunId: "run-1",
    loopRole: "loop",
    loopStatus: "completed",
    stopReason: "done",
    iterationsUsed: 2,
    maxIterations: 5,
    tasksDone: 2,
    tasksTotal: 2,
    tasksBlocked: 0,
    tasks: [
      { id: "t1", title: "Snapshot one", description: "", status: "done", notes: "" },
      { id: "t2", title: "Snapshot two", description: "", status: "done", notes: "" },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cron-routes-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  vi.clearAllMocks();
  cronStore = await import("../cron-store.js");
  const { registerCronRoutes } = await import("./cron-routes.js");
  app = new Hono();
  registerCronRoutes(app, { cronScheduler: scheduler } as never);
  runs = [];
  cronStore.createJob({
    name: "Rate limits",
    prompt: "Add rate limiting",
    schedule: "",
    trigger: "manual",
    recurring: true,
    backendType: "claude",
    model: "m",
    cwd: "/tmp/repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    loop: { enabled: true, maxIterations: 5 },
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loop option on create and update", () => {
  it("persists loop on create and returns 400 for a bad cap", async () => {
    const res = await app.request("/cron/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "Looped", prompt: "p", cwd: "/tmp/repo", trigger: "manual", loop: { enabled: true, maxIterations: 3 } }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).loop).toEqual({ enabled: true, maxIterations: 3 });

    const bad = await app.request("/cron/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "Bad", prompt: "p", cwd: "/tmp/repo", trigger: "manual", loop: { enabled: true, maxIterations: 0 } }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/at least 1/);
  });

  it("updates loop through PUT and leaves it alone when the body omits it", async () => {
    const res = await app.request("/cron/jobs/rate-limits", { method: "PUT", body: JSON.stringify({ loop: { enabled: false, maxIterations: 2 } }) });
    expect((await res.json()).loop).toEqual({ enabled: false, maxIterations: 2 });
    const res2 = await app.request("/cron/jobs/rate-limits", { method: "PUT", body: JSON.stringify({ prompt: "changed" }) });
    expect((await res2.json()).loop).toEqual({ enabled: false, maxIterations: 2 });
  });
});

describe("GET /cron/loops", () => {
  it("lists loop parents with the automation's display name", async () => {
    runs = [parentRun(), { sessionId: "s", jobId: "rate-limits", startedAt: 1_100, loopRunId: "run-1", loopRole: "task", iteration: 1 }];
    const res = await app.request("/cron/loops");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ loopRunId: "run-1", jobName: "Rate limits", tasksDone: 2 });
  });

  it("returns an empty list without a scheduler", async () => {
    const { registerCronRoutes } = await import("./cron-routes.js");
    const bare = new Hono();
    registerCronRoutes(bare, {} as never);
    expect(await (await bare.request("/cron/loops")).json()).toEqual([]);
  });
});

describe("GET /cron/jobs/:id/loops/:runId/tasks", () => {
  it("reads the live task file from the run's worktree", async () => {
    // Validates: while the loop is running (or the worktree still exists) the
    // board reflects the file the agents edit, not the last snapshot.
    runs = [parentRun({ loopStatus: "running", completedAt: undefined })];
    mkdirSync(join(tempDir, "wt", ".switchyard"), { recursive: true });
    writeFileSync(join(tempDir, "wt", ".switchyard", "tasks.json"), JSON.stringify([
      { id: "t1", title: "Live one", status: "done" },
      { id: "t2", title: "Live two", status: "in_progress", notes: "halfway" },
    ]));
    const res = await app.request("/cron/jobs/rate-limits/loops/run-1/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("file");
    expect(body.jobName).toBe("Rate limits");
    expect(body.loopStatus).toBe("running");
    expect(body.maxIterations).toBe(5);
    expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(["Live one", "Live two"]);
    expect(body.tasks[1]).toMatchObject({ status: "in_progress", notes: "halfway", description: "" });
  });

  it("falls back to the execution's snapshot when the file is missing or invalid", async () => {
    runs = [parentRun()];
    const res = await app.request("/cron/jobs/rate-limits/loops/run-1/tasks");
    const body = await res.json();
    expect(body.source).toBe("snapshot");
    expect(body.fileError).toMatch(/was not written/);
    expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(["Snapshot one", "Snapshot two"]);
    expect(body).toMatchObject({ stopReason: "done", iterationsUsed: 2, sessionId: "sess-9", branch: "auto/rate-limits/x", costUsd: 0.7 });
  });

  it("404s for unknown runs", async () => {
    const res = await app.request("/cron/jobs/rate-limits/loops/nope/tasks");
    expect(res.status).toBe(404);
  });
});
