// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CronJobInfo, CronJobExecution } from "../api.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  listEnvs: vi.fn(),
  createCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  toggleCronJob: vi.fn(),
  runCronJob: vi.fn(),
  getCronJobExecutions: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

const mockConnectSession = vi.hoisted(() => vi.fn());
vi.mock("../ws.js", () => ({ connectSession: mockConnectSession }));

const mockStoreState = vi.hoisted(() => ({
  setCurrentSession: vi.fn(),
  setActiveTab: vi.fn(),
  closeTerminal: vi.fn(),
}));
vi.mock("../store.js", () => {
  const useStore = (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

// FolderPicker touches the filesystem API; keep it inert here.
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (p: string) => void; onClose: () => void }) => (
    <button onClick={() => { onSelect("/Users/me/project"); onClose(); }}>mock-pick-folder</button>
  ),
}));

import { AutomationsPage, formToPayload, groupRuns, describeLoopRun, type AutomationFormData } from "./AutomationsPage.js";

function job(overrides: Partial<CronJobInfo> = {}): CronJobInfo {
  return {
    id: "nightly-tests",
    name: "Nightly tests",
    prompt: "Run the suite",
    schedule: "0 2 * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/Users/me/project",
    enabled: true,
    permissionMode: "bypassPermissions",
    useWorktree: true,
    autoPr: true,
    budgetUsd: 2,
    createdAt: 1,
    updatedAt: 1,
    consecutiveFailures: 0,
    totalRuns: 3,
    nextRunAt: Date.now() + 3 * 3_600_000,
    ...overrides,
  };
}

function run(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    sessionId: "sess-1",
    jobId: "nightly-tests",
    startedAt: Date.now() - 3_600_000,
    completedAt: Date.now() - 3_500_000,
    success: true,
    costUsd: 0.42,
    branch: "auto/nightly-tests/20260902-0200",
    linesAdded: 12,
    linesRemoved: 3,
    prUrl: "https://github.com/o/r/pull/9",
    ...overrides,
  };
}

const baseForm: AutomationFormData = {
  name: "Nightly tests",
  prompt: "Run the suite",
  cwd: "/Users/me/project",
  backendType: "claude",
  model: "claude-sonnet-4-5-20250929",
  trigger: "schedule",
  recurring: true,
  schedule: "0 2 * * *",
  onceAt: "",
  useWorktree: true,
  autoPr: true,
  budgetUsd: "2",
  permissionMode: "bypassPermissions",
  envSlug: "",
  loop: false,
  maxIterations: "10",
};

/** A finished loop run (parent) with planning + task iterations, chronological like the API. */
function loopRuns(): CronJobExecution[] {
  const start = Date.now() - 2 * 3_600_000;
  return [
    {
      sessionId: "sess-l3", jobId: "nightly-tests", startedAt: start, completedAt: start + 30 * 60_000, success: true,
      costUsd: 1.5, branch: "auto/nightly-tests/20260902-1500", linesAdded: 80, linesRemoved: 4, prUrl: "https://github.com/o/r/pull/11",
      loopRunId: "run-1", loopRole: "loop", loopStatus: "stopped", stopReason: "max_iterations",
      iterationsUsed: 3, maxIterations: 3, tasksDone: 2, tasksTotal: 3, tasksBlocked: 0,
    },
    { sessionId: "sess-l0", jobId: "nightly-tests", startedAt: start, completedAt: start + 60_000, success: true, costUsd: 0.1, loopRunId: "run-1", loopRole: "planning", iteration: 0 },
    { sessionId: "sess-l1", jobId: "nightly-tests", startedAt: start + 60_000, completedAt: start + 600_000, success: true, costUsd: 0.5, linesAdded: 40, loopRunId: "run-1", loopRole: "task", iteration: 1, taskId: "t1", taskTitle: "First task" },
    { sessionId: "sess-l2", jobId: "nightly-tests", startedAt: start + 600_000, completedAt: start + 900_000, success: false, error: "Agent reported an error", costUsd: 0.4, loopRunId: "run-1", loopRole: "task", iteration: 2, taskId: "t2", taskTitle: "Second task" },
    { sessionId: "sess-l3", jobId: "nightly-tests", startedAt: start + 900_000, completedAt: start + 1_800_000, success: true, costUsd: 0.5, linesAdded: 40, linesRemoved: 4, loopRunId: "run-1", loopRole: "task", iteration: 3, taskId: "t3", taskTitle: "Third task" },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listEnvs.mockResolvedValue([]);
  mockApi.getCronJobExecutions.mockResolvedValue([]);
  window.location.hash = "";
});

// ─── formToPayload ──────────────────────────────────────────────────────────

describe("formToPayload", () => {
  it("maps a scheduled automation with worktree, PR and budget", () => {
    // Validates: the API receives the automation options with the right types
    // (budget as a number, autoPr only when useWorktree is on).
    expect(formToPayload(baseForm)).toMatchObject({
      name: "Nightly tests",
      trigger: "schedule",
      recurring: true,
      schedule: "0 2 * * *",
      useWorktree: true,
      autoPr: true,
      budgetUsd: 2,
      enabled: true,
    });
  });

  it("clears the schedule for manual automations and drops autoPr without a worktree", () => {
    expect(formToPayload({ ...baseForm, trigger: "manual", useWorktree: false, budgetUsd: "" })).toMatchObject({
      trigger: "manual",
      schedule: "",
      useWorktree: false,
      autoPr: false,
      budgetUsd: undefined,
    });
  });

  it("converts a one-shot local datetime to ISO", () => {
    const payload = formToPayload({ ...baseForm, recurring: false, onceAt: "2030-01-02T09:30" });
    expect(payload.recurring).toBe(false);
    expect(payload.schedule).toBe(new Date("2030-01-02T09:30").toISOString());
  });

  it("sends the loop option with a sane iteration cap", () => {
    // Validates (docs/roadmap.md #3): the checkbox maps to loop.enabled, the
    // cap is a whole number in 1..100, and junk input falls back to 10.
    expect(formToPayload(baseForm).loop).toEqual({ enabled: false, maxIterations: 10 });
    expect(formToPayload({ ...baseForm, loop: true, maxIterations: "3" }).loop).toEqual({ enabled: true, maxIterations: 3 });
    expect(formToPayload({ ...baseForm, loop: true, maxIterations: "2.9" }).loop).toEqual({ enabled: true, maxIterations: 2 });
    expect(formToPayload({ ...baseForm, loop: true, maxIterations: "500" }).loop).toEqual({ enabled: true, maxIterations: 100 });
    expect(formToPayload({ ...baseForm, loop: true, maxIterations: "abc" }).loop).toEqual({ enabled: true, maxIterations: 10 });
    expect(formToPayload({ ...baseForm, loop: true, maxIterations: "0" }).loop).toEqual({ enabled: true, maxIterations: 10 });
  });
});

// ─── Loop run history helpers ───────────────────────────────────────────────

describe("groupRuns", () => {
  it("nests iterations under their loop parent and orders runs newest first", () => {
    // Validates: the API's chronological list becomes one group per run; a
    // plain run has no iterations; an iteration whose parent was evicted from
    // history still shows as its own row rather than disappearing.
    const plain = run({ sessionId: "sess-old", startedAt: Date.now() - 5 * 3_600_000 });
    const orphan: CronJobExecution = { sessionId: "sess-o", jobId: "nightly-tests", startedAt: Date.now() - 60_000, loopRunId: "run-gone", loopRole: "task", iteration: 4 };
    const groups = groupRuns([plain, ...loopRuns(), orphan]);
    expect(groups.map((g) => g.run.sessionId)).toEqual(["sess-o", "sess-l3", "sess-old"]);
    expect(groups[1].iterations.map((i) => i.iteration)).toEqual([0, 1, 2, 3]);
    expect(groups[0].iterations).toEqual([]);
    expect(groups[2].iterations).toEqual([]);
  });

  it("describes a loop run in every phase", () => {
    const [parent] = loopRuns();
    expect(describeLoopRun(parent)).toBe("Loop · 2/3 tasks · 3 iterations · stopped at cap");
    expect(describeLoopRun({ ...parent, completedAt: undefined, loopStatus: "planning" })).toBe("Loop · planning");
    expect(describeLoopRun({ ...parent, completedAt: undefined, loopStatus: "running", iterationsUsed: 2 })).toBe("Loop · iteration 2/3 · 2/3 tasks");
    expect(describeLoopRun({ ...parent, stopReason: "budget", tasksBlocked: 1 })).toBe("Loop · 2/3 tasks · 3 iterations · 1 blocked · stopped at budget");
    expect(describeLoopRun({ ...parent, stopReason: "done", iterationsUsed: 1 })).toBe("Loop · 2/3 tasks · 1 iteration");
  });
});

// ─── Page ───────────────────────────────────────────────────────────────────

describe("AutomationsPage", () => {
  it("shows the empty state with a create button", async () => {
    mockApi.listCronJobs.mockResolvedValue([]);
    render(<AutomationsPage embedded />);
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(screen.getByText("Create your first automation")).toBeInTheDocument();
  });

  it("renders rows with trigger, folder, agent and option badges", async () => {
    mockApi.listCronJobs.mockResolvedValue([job()]);
    render(<AutomationsPage embedded />);
    expect(await screen.findByText("Nightly tests")).toBeInTheDocument();
    expect(screen.getByText("Daily at 2am")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Auto PR")).toBeInTheDocument();
    expect(screen.getByText("Cap $2")).toBeInTheDocument();
    expect(screen.getByText(/^Next in 2h|^Next in 3h/)).toBeInTheDocument();
  });

  it("toggles, runs, and expands runs with PR link and session open", async () => {
    mockApi.listCronJobs.mockResolvedValue([job()]);
    mockApi.toggleCronJob.mockResolvedValue(job({ enabled: false }));
    mockApi.runCronJob.mockResolvedValue({ ok: true });
    mockApi.getCronJobExecutions.mockResolvedValue([run(), run({ sessionId: "sess-2", success: false, error: "gh failed", completedAt: Date.now(), prUrl: undefined, linesAdded: 0, linesRemoved: 0 })]);
    render(<AutomationsPage embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByRole("switch", { name: /Pause Nightly tests/ }));
    expect(mockApi.toggleCronJob).toHaveBeenCalledWith("nightly-tests");

    fireEvent.click(screen.getByText("Run now"));
    expect(mockApi.runCronJob).toHaveBeenCalledWith("nightly-tests");

    // Run now auto-expands the runs list
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("gh failed")).toBeInTheDocument();
    expect(screen.getByText("PR")).toHaveAttribute("href", "https://github.com/o/r/pull/9");
    expect(screen.getByText("+12")).toBeInTheDocument();

    // Runs list newest first, so the last "Open session" belongs to sess-1.
    const openButtons = screen.getAllByText("Open session");
    expect(openButtons).toHaveLength(2);
    fireEvent.click(openButtons[openButtons.length - 1]);
    expect(mockStoreState.setCurrentSession).toHaveBeenCalledWith("sess-1");
    expect(mockConnectSession).toHaveBeenCalledWith("sess-1");
  });

  it("shows the loop badge and nests iterations under a loop run in the history", async () => {
    // Validates the roadmap #3 UI: "Loop · N iterations" on the row; the
    // expanded history shows the loop's summary line with a Board link and
    // the planning / task iterations underneath, including a failed one.
    mockApi.listCronJobs.mockResolvedValue([job({ loop: { enabled: true, maxIterations: 3 }, budgetUsd: undefined, autoPr: false })]);
    mockApi.getCronJobExecutions.mockResolvedValue(loopRuns());
    render(<AutomationsPage embedded />);
    await screen.findByText("Nightly tests");
    expect(screen.getByText("Loop · 3 iterations")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show runs for Nightly tests"));
    expect(await screen.findByText("Loop · 2/3 tasks · 3 iterations · stopped at cap")).toBeInTheDocument();
    expect(screen.getByText("Board")).toHaveAttribute("href", "#/kanban?job=nightly-tests&run=run-1");
    expect(screen.getByText("PR")).toHaveAttribute("href", "https://github.com/o/r/pull/11");

    const nested = screen.getByLabelText(/Iterations of the/);
    expect(nested.querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("#0")).toBeInTheDocument();
    expect(screen.getByText("First task")).toBeInTheDocument();
    expect(screen.getByText("Second task")).toBeInTheDocument();
    expect(screen.getByText("Agent reported an error")).toBeInTheDocument();
    expect(screen.getByText("Third task")).toBeInTheDocument();

    // Parent + 4 iterations each open their own session; the parent opens the last one.
    const openButtons = screen.getAllByText("Open session");
    expect(openButtons).toHaveLength(5);
    fireEvent.click(openButtons[0]);
    expect(mockStoreState.setCurrentSession).toHaveBeenCalledWith("sess-l3");
  });

  it("creates a loop automation with an iteration cap from the form", async () => {
    mockApi.listCronJobs.mockResolvedValue([]);
    mockApi.createCronJob.mockResolvedValue(job());
    render(<AutomationsPage embedded />);
    await screen.findByText("No automations yet");

    fireEvent.click(screen.getByText("New automation"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rate limits" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Add rate limiting with tests" } });
    fireEvent.click(screen.getByLabelText("Pick project folder"));
    fireEvent.click(screen.getByText("mock-pick-folder"));
    fireEvent.click(screen.getByText("Manual"));
    expect(screen.queryByLabelText("Max iterations")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Run as a loop/));
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "3" } });
    fireEvent.click(screen.getByText("Save automation"));

    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledTimes(1));
    expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({
      name: "Rate limits",
      trigger: "manual",
      loop: { enabled: true, maxIterations: 3 },
    }));
  });

  it("creates an automation from the form with the expected payload", async () => {
    // Validates: the full create flow — name, prompt, folder picker, preset
    // schedule chip, options — produces one createCronJob call.
    mockApi.listCronJobs.mockResolvedValue([]);
    mockApi.createCronJob.mockResolvedValue(job());
    render(<AutomationsPage embedded />);
    await screen.findByText("No automations yet");

    fireEvent.click(screen.getByText("New automation"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly deps" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Bump dependencies and run tests" } });
    fireEvent.click(screen.getByLabelText("Pick project folder"));
    fireEvent.click(screen.getByText("mock-pick-folder"));
    fireEvent.click(screen.getByText("Mondays at 9am"));
    fireEvent.click(screen.getByLabelText(/Open a pull request when done/));
    fireEvent.change(screen.getByLabelText("Budget cap"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Save automation"));

    await waitFor(() => expect(mockApi.createCronJob).toHaveBeenCalledTimes(1));
    expect(mockApi.createCronJob).toHaveBeenCalledWith(expect.objectContaining({
      name: "Weekly deps",
      prompt: "Bump dependencies and run tests",
      cwd: "/Users/me/project",
      schedule: "0 9 * * 1",
      trigger: "schedule",
      useWorktree: true,
      autoPr: true,
      budgetUsd: 5,
    }));
  });

  it("validates required fields before saving", async () => {
    mockApi.listCronJobs.mockResolvedValue([]);
    render(<AutomationsPage embedded />);
    await screen.findByText("No automations yet");
    fireEvent.click(screen.getByText("New automation"));
    fireEvent.click(screen.getByText("Save automation"));
    expect(await screen.findByText("Give the automation a name.")).toBeInTheDocument();
    expect(mockApi.createCronJob).not.toHaveBeenCalled();
  });

  it("edits an existing automation and deletes with confirmation", async () => {
    mockApi.listCronJobs.mockResolvedValue([job()]);
    mockApi.updateCronJob.mockResolvedValue(job({ name: "Nightly tests v2" }));
    mockApi.deleteCronJob.mockResolvedValue({ ok: true });
    render(<AutomationsPage embedded />);
    await screen.findByText("Nightly tests");

    fireEvent.click(screen.getByLabelText("More actions for Nightly tests"));
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByLabelText("Name")).toHaveValue("Nightly tests");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly tests v2" } });
    fireEvent.click(screen.getByText("Save automation"));
    await waitFor(() => expect(mockApi.updateCronJob).toHaveBeenCalledWith("nightly-tests", expect.objectContaining({ name: "Nightly tests v2" })));

    fireEvent.click(screen.getByLabelText("More actions for Nightly tests"));
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText(/Delete “Nightly tests”\?/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Delete").at(-1)!);
    await waitFor(() => expect(mockApi.deleteCronJob).toHaveBeenCalledWith("nightly-tests"));
  });
});
