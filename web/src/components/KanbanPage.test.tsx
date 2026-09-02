// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "../types.js";
import type { LoopRunInfo, LoopTasksResponse } from "../api.js";

const mockApi = vi.hoisted(() => ({
  listLoopRuns: vi.fn(),
  getLoopTasks: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

type MockState = {
  currentSessionId: string | null;
  sessionTasks: Map<string, TaskItem[]>;
  sessionNames: Map<string, string>;
  sdkSessions: Array<{ sessionId: string; name?: string }>;
};

let mockState: MockState;

vi.mock("../store.js", () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

import { KanbanPage, parseKanbanHash, loopTaskToCard, describeLoopBoard } from "./KanbanPage.js";

function loopRun(overrides: Partial<LoopRunInfo> = {}): LoopRunInfo {
  return {
    sessionId: "sess-9", jobId: "rate-limits", jobName: "Rate limits", startedAt: Date.now() - 3_600_000, completedAt: Date.now() - 600_000,
    loopRunId: "run-1", loopRole: "loop", loopStatus: "stopped", stopReason: "max_iterations", iterationsUsed: 3, maxIterations: 3,
    tasksDone: 2, tasksTotal: 4, tasksBlocked: 1, ...overrides,
  };
}

function board(overrides: Partial<LoopTasksResponse> = {}): LoopTasksResponse {
  return {
    jobId: "rate-limits", jobName: "Rate limits", runId: "run-1", loopStatus: "stopped", stopReason: "max_iterations",
    iterationsUsed: 3, maxIterations: 3, startedAt: 1, completedAt: 2, sessionId: "sess-9", branch: "auto/rate-limits/x", cwd: "/wt",
    costUsd: 0.9, source: "file",
    tasks: [
      { id: "t1", title: "Add limiter", description: "Token bucket in lib/", status: "done", notes: "" },
      { id: "t2", title: "Wire router", description: "", status: "done", notes: "" },
      { id: "t3", title: "Per-key limits", description: "", status: "blocked", notes: "needs auth middleware" },
      { id: "t4", title: "Docs", description: "", status: "pending", notes: "" },
      { id: "t5", title: "Load test", description: "", status: "in_progress", notes: "" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listLoopRuns.mockResolvedValue([]);
  mockApi.getLoopTasks.mockResolvedValue(board());
  window.location.hash = "";
  mockState = {
    currentSessionId: null,
    sessionTasks: new Map(),
    sessionNames: new Map(),
    sdkSessions: [],
  };
});

describe("KanbanPage", () => {
  it("renders the empty board when no session is selected", () => {
    // Regression coverage: the store selector must not return a fresh Map during render,
    // which can trigger React's maximum update depth guard on the standalone route.
    render(<KanbanPage />);

    expect(screen.getByText("Task Board")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("shows current session tasks grouped by status", () => {
    mockState = {
      ...mockState,
      currentSessionId: "session-1",
      sessionNames: new Map([["session-1", "Demo Session"]]),
      sessionTasks: new Map([
        [
          "session-1",
          [
            { id: "a", subject: "Plan work", description: "Plan work", status: "pending" },
            { id: "b", subject: "Ship work", description: "Ship work", status: "in_progress" },
            { id: "c", subject: "Review work", description: "Review work", status: "completed" },
          ],
        ],
      ]),
    };

    render(<KanbanPage />);

    expect(screen.getByText("Tasks from session: Demo Session")).toBeInTheDocument();
    expect(screen.getByText("Plan work")).toBeInTheDocument();
    expect(screen.getByText("Ship work")).toBeInTheDocument();
    expect(screen.getByText("Review work")).toBeInTheDocument();
  });
});

// ─── Loop runs (docs/roadmap.md #3) ─────────────────────────────────────────

describe("loop board helpers", () => {
  it("parses the job/run selection out of the hash", () => {
    expect(parseKanbanHash("#/kanban")).toBeNull();
    expect(parseKanbanHash("#/kanban?job=rate-limits&run=run-1")).toEqual({ job: "rate-limits", run: "run-1" });
    expect(parseKanbanHash("#/kanban?job=rate-limits")).toBeNull();
    expect(parseKanbanHash("#/kanban?job=a%20b&run=r%2F1")).toEqual({ job: "a b", run: "r/1" });
  });

  it("maps task statuses onto the four columns", () => {
    // Validates: the loop's "done" / "blocked" statuses land in Done / Blocked
    // and notes travel with the card so a blocked reason is visible.
    expect(loopTaskToCard({ id: "a", title: "A", description: "d", status: "done", notes: "" }).status).toBe("completed");
    expect(loopTaskToCard({ id: "b", title: "B", description: "", status: "blocked", notes: "why" })).toMatchObject({ status: "blocked", notes: "why" });
    expect(loopTaskToCard({ id: "c", title: "C", description: "", status: "in_progress", notes: "" }).status).toBe("in_progress");
    expect(loopTaskToCard({ id: "d", title: "D", description: "", status: "pending", notes: "" }).status).toBe("pending");
  });

  it("describes the loop's state for the board header", () => {
    expect(describeLoopBoard(board({ loopStatus: "planning" }))).toBe("Planning the task list…");
    expect(describeLoopBoard(board({ loopStatus: "running", iterationsUsed: 1 }))).toBe("Running · 1/3 iterations");
    expect(describeLoopBoard(board({ loopStatus: "completed" }))).toBe("Finished · 3/3 iterations");
    expect(describeLoopBoard(board())).toBe("Stopped at the iteration cap · 3/3 iterations");
    expect(describeLoopBoard(board({ loopStatus: "stopped", stopReason: "budget" }))).toBe("Stopped at the budget cap · 3/3 iterations");
    expect(describeLoopBoard(board({ loopStatus: "failed", error: "no plan" }))).toBe("Failed · no plan");
  });
});

describe("KanbanPage with a loop run selected", () => {
  it("fetches the run's task file and shows To do / In progress / Done / Blocked", async () => {
    // Validates: #/kanban?job=…&run=… switches the page to the loop's task
    // list (read-only), with each task in the right column and blocked notes
    // shown on the card.
    window.location.hash = "#/kanban?job=rate-limits&run=run-1";
    mockApi.listLoopRuns.mockResolvedValue([loopRun()]);
    render(<KanbanPage />);

    await waitFor(() => expect(mockApi.getLoopTasks).toHaveBeenCalledWith("rate-limits", "run-1"));
    expect(await screen.findByText("Add limiter")).toBeInTheDocument();
    expect(screen.getByText("Task list of a loop run · Rate limits")).toBeInTheDocument();
    expect(screen.getByText("Stopped at the iteration cap · 3/3 iterations")).toBeInTheDocument();
    expect(screen.getByText("auto/rate-limits/x")).toBeInTheDocument();

    const column = (name: string) => document.querySelector(`[data-column="${name}"]`)!;
    expect(column("pending").textContent).toContain("Docs");
    expect(column("in_progress").textContent).toContain("Load test");
    expect(column("completed").textContent).toContain("Add limiter");
    expect(column("completed").textContent).toContain("Wire router");
    expect(column("blocked").textContent).toContain("Per-key limits");
    expect(column("blocked").textContent).toContain("needs auth middleware");
    expect(screen.getByText("2/5 complete")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("offers a picker of loop runs and switches the hash on selection", async () => {
    mockApi.listLoopRuns.mockResolvedValue([loopRun(), loopRun({ loopRunId: "run-2", completedAt: undefined, loopStatus: "running", jobName: "Rate limits" })]);
    render(<KanbanPage />);
    const select = await screen.findByLabelText("Loop run");
    expect(select).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /running/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /2\/4 tasks/ })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "rate-limits|run-2" } });
    expect(window.location.hash).toBe("#/kanban?job=rate-limits&run=run-2");
    expect(await screen.findByText("Task list of a loop run · Rate limits")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Loop run"), { target: { value: "" } });
    expect(window.location.hash).toBe("#/kanban");
    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
  });

  it("shows the snapshot notice and an error when the board cannot be loaded", async () => {
    window.location.hash = "#/kanban?job=rate-limits&run=run-1";
    mockApi.getLoopTasks.mockResolvedValueOnce(board({ source: "snapshot", fileError: "gone" }));
    const { unmount } = render(<KanbanPage />);
    expect(await screen.findByText("from the run's final snapshot")).toBeInTheDocument();
    unmount();

    mockApi.getLoopTasks.mockRejectedValueOnce(new Error("Loop run not found"));
    render(<KanbanPage />);
    expect(await screen.findByText("Loop run not found")).toBeInTheDocument();
  });
});
