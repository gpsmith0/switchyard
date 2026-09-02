import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { api, type LoopRunInfo, type LoopTask, type LoopTasksResponse } from "../api.js";
import type { TaskItem } from "../types.js";

/**
 * KanbanPage — read-only task board.
 *
 * Two sources:
 * - A loop run's `.switchyard/tasks.json` (docs/roadmap.md #3) when the hash
 *   carries `?job=<automation>&run=<loopRunId>`: To do / In progress / Done /
 *   Blocked, refreshed while the loop is still running.
 * - Otherwise the tasks agents created through TodoWrite / TaskCreate in the
 *   current session (or every session), as before.
 */

type Column = "pending" | "in_progress" | "completed" | "blocked";

const COLUMN_CONFIG: Record<Column, { label: string; emptyText: string; dotColor: string; headerColor: string }> = {
  pending: {
    label: "To Do",
    emptyText: "No pending tasks",
    dotColor: "bg-cc-muted/40",
    headerColor: "text-cc-muted",
  },
  in_progress: {
    label: "In Progress",
    emptyText: "Nothing in progress",
    dotColor: "bg-cc-primary animate-pulse",
    headerColor: "text-cc-primary",
  },
  completed: {
    label: "Done",
    emptyText: "Nothing completed yet",
    dotColor: "bg-cc-success",
    headerColor: "text-cc-success",
  },
  blocked: {
    label: "Blocked",
    emptyText: "Nothing blocked",
    dotColor: "bg-cc-warning",
    headerColor: "text-cc-warning",
  },
};

/** What a card needs, whichever source it came from. */
interface BoardCard {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  owner?: string;
  activeForm?: string;
  status: Column;
  /** TodoWrite tasks waiting on other tasks (rendered dimmed with a "blocked" tag) */
  dimmed?: boolean;
}

function todoToCard(task: TaskItem): BoardCard {
  return {
    id: task.id,
    title: task.subject,
    description: task.description,
    owner: task.owner,
    activeForm: task.activeForm,
    status: task.status === "completed" ? "completed" : task.status === "in_progress" ? "in_progress" : "pending",
    dimmed: !!task.blockedBy && task.blockedBy.length > 0,
  };
}

/** Map a loop task onto a board column. Exported for tests. */
export function loopTaskToCard(task: LoopTask): BoardCard {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    notes: task.notes,
    status: task.status === "done" ? "completed" : task.status === "blocked" ? "blocked" : task.status === "in_progress" ? "in_progress" : "pending",
  };
}

function TaskCard({ card }: { card: BoardCard }) {
  return (
    <div
      className={`p-3 rounded-lg border transition-colors ${
        card.dimmed
          ? "border-cc-border/50 bg-cc-hover/30 opacity-60"
          : "border-cc-border bg-cc-card hover:border-cc-muted/20"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-cc-fg leading-tight">
            {card.title}
          </p>
          {card.description && card.description !== card.title && (
            <p className="text-[10px] text-cc-muted mt-1 line-clamp-2 leading-relaxed">
              {card.description}
            </p>
          )}
          {card.notes && (
            <p className="text-[10px] text-cc-fg/80 mt-1 line-clamp-3 leading-relaxed whitespace-pre-line">
              {card.notes}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {card.owner && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
            {card.owner}
          </span>
        )}
        {card.activeForm && card.status === "in_progress" && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
            {card.activeForm}
          </span>
        )}
        {card.dimmed && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-warning">
            blocked
          </span>
        )}
        <span className="text-[9px] font-mono-code text-cc-muted/40 ml-auto">
          #{card.id}
        </span>
      </div>
    </div>
  );
}

function KanbanColumn({ column, cards }: { column: Column; cards: BoardCard[] }) {
  const config = COLUMN_CONFIG[column];

  return (
    <div className="flex-1 min-w-[220px] max-w-[400px]" data-column={column}>
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 pb-3 border-b border-cc-border">
        <div className={`w-2 h-2 rounded-full ${config.dotColor}`} />
        <span className={`text-[12px] font-semibold ${config.headerColor}`}>
          {config.label}
        </span>
        <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums ml-auto">
          {cards.length}
        </span>
      </div>

      {/* Cards */}
      <div className="space-y-2 pt-3 min-h-[100px]">
        {cards.length === 0 ? (
          <div className="text-[11px] text-cc-muted/40 italic text-center py-6">
            {config.emptyText}
          </div>
        ) : (
          cards.map((card) => <TaskCard key={card.id} card={card} />)
        )}
      </div>
    </div>
  );
}

function ProgressLine({ done, total, inProgress }: { done: number; total: number; inProgress: number }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-4 text-[11px] font-mono-code">
      <span className="text-cc-muted">{done}/{total} complete</span>
      {inProgress > 0 && <span className="text-cc-primary">{inProgress} in progress</span>}
      <div className="flex-1 h-1 rounded-full bg-cc-hover overflow-hidden max-w-[200px]">
        <div className="h-full rounded-full bg-cc-success transition-all duration-500" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    </div>
  );
}

// ─── Hash params ────────────────────────────────────────────────────────────

/** `#/kanban?job=<id>&run=<loopRunId>` → selected loop run, if any. Exported for tests. */
export function parseKanbanHash(hash: string): { job: string; run: string } | null {
  const q = hash.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  const job = params.get("job");
  const run = params.get("run");
  return job && run ? { job, run } : null;
}

function useKanbanSelection(): { job: string; run: string } | null {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return useMemo(() => parseKanbanHash(hash), [hash]);
}

// ─── Loop board ─────────────────────────────────────────────────────────────

const LOOP_POLL_MS = 10_000;

/** Status line for the selected loop run. Exported for tests. */
export function describeLoopBoard(data: LoopTasksResponse): string {
  const iterations = `${data.iterationsUsed}/${data.maxIterations} iterations`;
  switch (data.loopStatus) {
    case "planning": return "Planning the task list…";
    case "running": return `Running · ${iterations}`;
    case "completed": return `Finished · ${iterations}`;
    case "stopped":
      return data.stopReason === "budget" ? `Stopped at the budget cap · ${iterations}` : `Stopped at the iteration cap · ${iterations}`;
    case "failed": return data.error ? `Failed · ${data.error}` : "Failed";
    default: return "";
  }
}

function LoopBoard({ jobId, runId }: { jobId: string; runId: string }) {
  const [data, setData] = useState<LoopTasksResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.getLoopTasks(jobId, runId);
      setData(res);
      setError("");
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the task board");
      return null;
    }
  }, [jobId, runId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const res = await load();
      if (!active) return;
      // Keep polling while the loop is still working.
      if (res && (res.loopStatus === "planning" || res.loopStatus === "running")) {
        timer = setTimeout(tick, LOOP_POLL_MS);
      }
    };
    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const grouped = useMemo(() => {
    const cols: Record<Column, BoardCard[]> = { pending: [], in_progress: [], completed: [], blocked: [] };
    for (const t of data?.tasks ?? []) {
      const card = loopTaskToCard(t);
      cols[card.status].push(card);
    }
    return cols;
  }, [data]);

  if (error) return <p className="text-[13px] text-cc-error">{error}</p>;
  if (!data) return <p className="text-[13px] text-cc-muted">Loading…</p>;

  const total = data.tasks.length;
  return (
    <>
      <div className="flex items-center gap-3 flex-wrap text-[12.5px] text-cc-muted">
        <span className="text-cc-fg">{describeLoopBoard(data)}</span>
        {data.branch && (
          <>
            <span className="text-cc-muted/40">·</span>
            <span className="font-mono-code truncate max-w-[220px]">{data.branch}</span>
          </>
        )}
        {data.costUsd > 0 && (
          <>
            <span className="text-cc-muted/40">·</span>
            <span className="tabular-nums">${data.costUsd < 0.01 ? data.costUsd.toFixed(4) : data.costUsd.toFixed(2)}</span>
          </>
        )}
        {data.source === "snapshot" && (
          <>
            <span className="text-cc-muted/40">·</span>
            <span title={data.fileError}>from the run's final snapshot</span>
          </>
        )}
      </div>

      {total === 0 ? (
        <div className="text-center py-16 border border-dashed border-cc-border rounded-lg">
          <p className="text-[13px] text-cc-muted">No tasks yet</p>
          <p className="text-[11px] text-cc-muted/60 mt-1">The planning session has not written .switchyard/tasks.json yet</p>
        </div>
      ) : (
        <>
          <ProgressLine done={grouped.completed.length} total={total} inProgress={grouped.in_progress.length} />
          <div className="flex gap-4 overflow-x-auto pb-4">
            <KanbanColumn column="pending" cards={grouped.pending} />
            <KanbanColumn column="in_progress" cards={grouped.in_progress} />
            <KanbanColumn column="completed" cards={grouped.completed} />
            <KanbanColumn column="blocked" cards={grouped.blocked} />
          </div>
        </>
      )}
    </>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

const EMPTY_RUNS: LoopRunInfo[] = [];

export function KanbanPage() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessionTasks = useStore((s) => s.sessionTasks);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const selection = useKanbanSelection();
  const [loopRuns, setLoopRuns] = useState<LoopRunInfo[]>(EMPTY_RUNS);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api.listLoopRuns()
        // Keep the same (empty) reference when nothing changed so an empty
        // board does not re-render just because the poll came back.
        .then((runs) => { if (active) setLoopRuns((prev) => (prev.length === 0 && runs.length === 0 ? prev : runs)); })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Aggregate all tasks across sessions or show for current session
  const { grouped, totalCount, sessionId } = useMemo(() => {
    const pending: BoardCard[] = [];
    const in_progress: BoardCard[] = [];
    const completed: BoardCard[] = [];

    // If there's a current session, show that session's tasks
    // Otherwise, aggregate all
    const sessionsToShow = currentSessionId
      ? [[currentSessionId, sessionTasks.get(currentSessionId) || []] as const]
      : Array.from(sessionTasks.entries());

    for (const [, tasks] of sessionsToShow) {
      for (const task of tasks) {
        const card = todoToCard(task);
        if (card.status === "completed") completed.push(card);
        else if (card.status === "in_progress") in_progress.push(card);
        else pending.push(card);
      }
    }

    return {
      grouped: { pending, in_progress, completed },
      totalCount: pending.length + in_progress.length + completed.length,
      sessionId: currentSessionId,
    };
  }, [sessionTasks, currentSessionId]);

  const sessionName = sessionId
    ? sessionNames.get(sessionId) || sdkSessions.find((s) => s.sessionId === sessionId)?.name || sessionId.slice(0, 8)
    : null;

  const selectedValue = selection ? `${selection.job}|${selection.run}` : "";
  const selectedInList = !selection || loopRuns.some((r) => r.jobId === selection.job && r.loopRunId === selection.run);

  function selectRun(value: string) {
    if (!value) {
      window.location.hash = "#/kanban";
      return;
    }
    const [job, run] = value.split("|");
    window.location.hash = `#/kanban?job=${encodeURIComponent(job)}&run=${encodeURIComponent(run)}`;
  }

  const subtitle = selection
    ? `Task list of a loop run · ${loopRuns.find((r) => r.jobId === selection.job && r.loopRunId === selection.run)?.jobName ?? selection.job}`
    : sessionName
    ? `Tasks from session: ${sessionName}`
    : "Tasks extracted from agent tool calls (TodoWrite, TaskCreate)";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[16px] font-semibold text-cc-fg">Task Board</h1>
            <p className="text-[12px] text-cc-muted mt-0.5">{subtitle}</p>
          </div>
          {(loopRuns.length > 0 || selection) && (
            <select
              aria-label="Loop run"
              className="h-8 px-3 text-[12.5px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg cursor-pointer max-w-[320px]"
              value={selectedValue}
              onChange={(e) => selectRun(e.target.value)}
            >
              <option value="">Session tasks</option>
              {!selectedInList && selection && (
                <option value={selectedValue}>{selection.job} · {selection.run}</option>
              )}
              {loopRuns.map((r) => (
                <option key={`${r.jobId}|${r.loopRunId}`} value={`${r.jobId}|${r.loopRunId}`}>
                  {r.jobName} · {new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {r.completedAt == null ? " · running" : ` · ${r.tasksDone ?? 0}/${r.tasksTotal ?? 0} tasks`}
                </option>
              ))}
            </select>
          )}
        </div>

        {selection ? (
          <LoopBoard jobId={selection.job} runId={selection.run} />
        ) : totalCount === 0 ? (
          <div className="text-center py-16 border border-dashed border-cc-border rounded-lg">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-8 h-8 mx-auto text-cc-muted/20 mb-3">
              <path d="M1.5 3.25a2.25 2.25 0 013-2.122V1A2.5 2.5 0 017 3.5H3.25a.75.75 0 010-1.5h3.06A1 1 0 005.5 1.5h-1a.75.75 0 01-.75-.75.75.75 0 00-1.5 0v.5h-.5a.25.25 0 00-.25.25zm13 0v.5a.25.25 0 01-.25.25H8V1h.75a.75.75 0 01.75.75.75.75 0 001.5 0h-1a1 1 0 00-.81.5h3.06a.75.75 0 010 1.5H9A2.5 2.5 0 0111.5 1v.128a2.25 2.25 0 013 2.122zM1.5 5v8.25c0 .966.784 1.75 1.75 1.75h9.5A1.75 1.75 0 0014.5 13.25V5h-13z" />
            </svg>
            <p className="text-[13px] text-cc-muted">No tasks yet</p>
            <p className="text-[11px] text-cc-muted/60 mt-1">
              Tasks appear here when agents use TodoWrite or TaskCreate tools, or pick a loop run above
            </p>
          </div>
        ) : (
          <>
            <ProgressLine done={grouped.completed.length} total={totalCount} inProgress={grouped.in_progress.length} />

            {/* Kanban columns */}
            <div className="flex gap-4 overflow-x-auto pb-4">
              <KanbanColumn column="pending" cards={grouped.pending} />
              <KanbanColumn column="in_progress" cards={grouped.in_progress} />
              <KanbanColumn column="completed" cards={grouped.completed} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
