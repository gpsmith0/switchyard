// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { InboxItem } from "../api.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  getInbox: vi.fn(),
  reviewInboxItem: vi.fn(),
  createInboxPr: vi.fn(),
  retryInboxItem: vi.fn(),
}));

vi.mock("../api.js", () => ({ api: mockApi }));

const mockConnectSession = vi.hoisted(() => vi.fn());
vi.mock("../ws.js", () => ({ connectSession: mockConnectSession }));

const mockStoreState = vi.hoisted(() => ({
  inboxPendingCount: 0,
  sessionNames: new Map<string, string>(),
  setInboxPendingCount: vi.fn((n: number) => { mockStoreState.inboxPendingCount = n; }),
  setCurrentSession: vi.fn(),
  setActiveTab: vi.fn(),
  closeTerminal: vi.fn(),
}));
vi.mock("../store.js", () => {
  const useStore = (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { InboxPage, InboxRow, formatRelativeTime, formatCost } from "./InboxPage.js";

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "session:abc",
    kind: "session",
    title: "Fix login bug",
    subtitle: "Cron · Nightly tests",
    summary: "Fixed the null check in auth.ts.",
    cwd: "/repo",
    branch: "fix/login",
    isWorktree: true,
    backend: "claude",
    sessionId: "abc",
    cronJobId: "nightly-tests",
    completedAt: Date.now() - 5 * 60_000,
    costUsd: 0.42,
    linesAdded: 12,
    linesRemoved: 3,
    outcome: "completed",
    hasChanges: true,
    review: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreState.inboxPendingCount = 0;
  mockStoreState.sessionNames = new Map();
  window.location.hash = "";
});

// ─── Helpers ────────────────────────────────────────────────────────────────

describe("inbox formatting helpers", () => {
  it("formats relative times in minutes, hours, and days", () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 10_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("formats cost with more precision under a cent and hides zero", () => {
    expect(formatCost(0)).toBe("");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

// ─── InboxPage ──────────────────────────────────────────────────────────────

describe("InboxPage", () => {
  it("shows the empty state when nothing needs review", async () => {
    mockApi.getInbox.mockResolvedValue({ items: [], counts: { pending: 0, reviewed: 0, dismissed: 0 } });
    render(<InboxPage embedded />);
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });

  it("renders pending items with title, origin, stats, and summary", async () => {
    // Validates: one row per item with the fields a reviewer needs at a glance.
    mockApi.getInbox.mockResolvedValue({ items: [item()], counts: { pending: 1, reviewed: 0, dismissed: 0 } });
    render(<InboxPage embedded />);
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("Cron · Nightly tests")).toBeInTheDocument();
    expect(screen.getByText("fix/login")).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
    expect(screen.getByText("Fixed the null check in auth.ts.")).toBeInTheDocument();
    // The page pushes the pending count into the store for the sidebar badge.
    expect(mockStoreState.setInboxPendingCount).toHaveBeenCalledWith(1);
  });

  it("prefers the browser-side session name over the server title and collapses blank lines in the summary", async () => {
    // Validates: auto-generated names only exist in the client store, so the
    // inbox must resolve them there; multi-paragraph summaries render without
    // an empty second line inside the two-line clamp.
    mockStoreState.sessionNames = new Map([["abc", "Radiant Iris"]]);
    mockApi.getInbox.mockResolvedValue({
      items: [item({ title: "Session abc", summary: "I'm ready.\n\nTest received." })],
      counts: { pending: 1, reviewed: 0, dismissed: 0 },
    });
    render(<InboxPage embedded />);
    expect(await screen.findByText("Radiant Iris")).toBeInTheDocument();
    expect(screen.queryByText("Session abc")).not.toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "I'm ready.\nTest received.")).toBeInTheDocument();
  });

  it("marks an item reviewed optimistically, calls the API, and moves it to the Reviewed tab", async () => {
    mockApi.getInbox.mockResolvedValue({ items: [item()], counts: { pending: 1, reviewed: 0, dismissed: 0 } });
    mockApi.reviewInboxItem.mockResolvedValue({ ok: true });
    render(<InboxPage embedded />);
    await screen.findByText("Fix login bug");

    fireEvent.click(screen.getByText("Mark reviewed"));
    expect(mockApi.reviewInboxItem).toHaveBeenCalledWith("session:abc", "reviewed");
    // Pending tab is now empty…
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
    // …and the item shows up under Reviewed with a Reopen action.
    fireEvent.click(screen.getByText("Reviewed"));
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("Reopen")).toBeInTheDocument();
    await waitFor(() => expect(mockStoreState.setInboxPendingCount).toHaveBeenLastCalledWith(0));
  });

  it("opens a session in the chat tab and in the diff tab", async () => {
    mockApi.getInbox.mockResolvedValue({ items: [item()], counts: { pending: 1, reviewed: 0, dismissed: 0 } });
    render(<InboxPage embedded />);
    await screen.findByText("Fix login bug");

    fireEvent.click(screen.getByText("Open"));
    expect(mockStoreState.setCurrentSession).toHaveBeenCalledWith("abc");
    expect(mockConnectSession).toHaveBeenCalledWith("abc");
    expect(mockStoreState.setActiveTab).toHaveBeenCalledWith("chat");

    fireEvent.click(screen.getByText("Diff"));
    expect(mockStoreState.setActiveTab).toHaveBeenCalledWith("diff");
  });

  it("opens a PR through the API and surfaces server errors inline", async () => {
    mockApi.getInbox.mockResolvedValue({ items: [item()], counts: { pending: 1, reviewed: 0, dismissed: 0 } });
    mockApi.createInboxPr.mockRejectedValueOnce(new Error("gh pr create failed: not authenticated"));
    render(<InboxPage embedded />);
    await screen.findByText("Fix login bug");

    fireEvent.click(screen.getByText("Open PR"));
    expect(mockApi.createInboxPr).toHaveBeenCalledWith("session:abc");
    expect(await screen.findByText("gh pr create failed: not authenticated")).toBeInTheDocument();
  });

  it("retries cron-spawned sessions and hides Retry otherwise", async () => {
    mockApi.getInbox.mockResolvedValue({
      items: [item(), item({ id: "session:def", sessionId: "def", title: "Manual run", cronJobId: undefined })],
      counts: { pending: 2, reviewed: 0, dismissed: 0 },
    });
    mockApi.retryInboxItem.mockResolvedValue({ ok: true, cronJobId: "nightly-tests" });
    render(<InboxPage embedded />);
    await screen.findByText("Manual run");

    // Only the cron-spawned row offers Retry.
    expect(screen.getAllByText("Retry")).toHaveLength(1);
    fireEvent.click(screen.getByText("Retry"));
    expect(mockApi.retryInboxItem).toHaveBeenCalledWith("session:abc");
    expect(await screen.findByText(/Re-run started/)).toBeInTheDocument();
  });

  it("navigates to the race and orchestrator pages for non-session items", async () => {
    mockApi.getInbox.mockResolvedValue({
      items: [
        item({ id: "race:r1", kind: "race", raceId: "r1", title: "Race prompt", cronJobId: undefined, branch: "", hasChanges: false }),
        item({ id: "pipeline:p1", kind: "pipeline", runId: "p1", title: "Ship feature", cronJobId: undefined, branch: "", hasChanges: false, sessionId: undefined }),
      ],
      counts: { pending: 2, reviewed: 0, dismissed: 0 },
    });
    render(<InboxPage embedded />);
    await screen.findByText("Race prompt");

    fireEvent.click(screen.getByText("Race prompt"));
    expect(window.location.hash).toBe("#/races/r1");
    fireEvent.click(screen.getByText("Ship feature"));
    expect(window.location.hash).toBe("#/orchestrator");
  });
});

// ─── InboxRow ───────────────────────────────────────────────────────────────

describe("InboxRow", () => {
  it("shows a Failed label and dims reviewed rows", () => {
    const onReview = vi.fn();
    const { container } = render(
      <ul>
        <InboxRow item={item({ outcome: "failed", review: "reviewed" })} onReview={onReview} onOpenPr={async () => {}} onRetry={async () => {}} />
      </ul>,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(container.querySelector("li")?.className).toContain("opacity-70");
    fireEvent.click(screen.getByText("Reopen"));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: "session:abc" }), "pending");
  });
});

// ─── Loop runs (docs/roadmap.md #3) ─────────────────────────────────────────

describe("InboxRow for a loop run", () => {
  const loopItem = (): InboxItem => item({
    id: "loop:run-1",
    kind: "loop",
    title: "Rate limits",
    subtitle: "Loop · 5/7 tasks",
    summary: "Done: Add limiter; Wire router\nBlocked: Per-key limits (needs auth)\nStopped at the iteration cap (6).",
    sessionId: "sess-last",
    cronJobId: "rate-limits",
    loopRunId: "run-1",
    branch: "auto/rate-limits/20260902-1710",
    isWorktree: true,
    hasChanges: true,
  });

  it("shows the task tally, opens the last session, links to the board, and keeps PR / Retry", () => {
    // Validates: one row per loop with "Loop · done/total tasks", Open → last
    // session, Board → #/kanban?job=…&run=…, Open PR because the worktree
    // branch has changes, Retry because it came from an automation.
    render(<ul><InboxRow item={loopItem()} onReview={() => {}} onOpenPr={async () => {}} onRetry={async () => {}} /></ul>);
    expect(screen.getByText("Loop · 5/7 tasks")).toBeInTheDocument();
    expect(screen.getByTestId("loop-icon")).toBeInTheDocument();
    expect(screen.getByText(/Done: Add limiter/)).toBeInTheDocument();
    expect(screen.getByText("Board")).toHaveAttribute("href", "#/kanban?job=rate-limits&run=run-1");
    expect(screen.getByText("Open PR")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Open"));
    expect(mockStoreState.setCurrentSession).toHaveBeenCalledWith("sess-last");
    expect(mockConnectSession).toHaveBeenCalledWith("sess-last");
    expect(mockStoreState.setActiveTab).toHaveBeenCalledWith("chat");

    fireEvent.click(screen.getByText("Diff"));
    expect(mockStoreState.setActiveTab).toHaveBeenCalledWith("diff");
  });

  it("hides Open PR when the loop changed nothing", () => {
    render(<ul><InboxRow item={loopItem()} onReview={() => {}} onOpenPr={async () => {}} onRetry={async () => {}} /></ul>);
    expect(screen.getByText("Open PR")).toBeInTheDocument();
    render(<ul><InboxRow item={{ ...loopItem(), id: "loop:run-2", hasChanges: false, linesAdded: 0, linesRemoved: 0 }} onReview={() => {}} onOpenPr={async () => {}} onRetry={async () => {}} /></ul>);
    expect(screen.getAllByText("Open PR")).toHaveLength(1);
    expect(screen.getAllByText("Board")).toHaveLength(2);
  });
});
