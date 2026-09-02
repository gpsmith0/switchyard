import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { api, type InboxItem, type InboxReviewStatus } from "../api.js";
import { connectSession } from "../ws.js";

/**
 * InboxPage — the review inbox (docs/roadmap.md #1).
 *
 * Every finished session, race, pipeline run, and loop run lands here as one
 * row with the final summary, diff stats, cost, and actions: Open, Diff,
 * Open PR, Board (loop runs), Retry (automation-spawned work), Mark reviewed,
 * Dismiss. Rows follow the
 * ChatGPT-style list treatment from design.md: no cards inside cards, hairline
 * separators, hover fill, actions on the right.
 */

type Tab = "pending" | "reviewed" | "all";

const EMPTY_ITEMS: InboxItem[] = [];

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function openSession(sessionId: string, tab: "chat" | "diff") {
  const store = useStore.getState();
  store.closeTerminal();
  store.setCurrentSession(sessionId);
  connectSession(sessionId);
  store.setActiveTab(tab);
  window.location.hash = "";
}

function KindIcon({ kind, outcome }: { kind: InboxItem["kind"]; outcome: InboxItem["outcome"] }) {
  const cls = `w-4 h-4 ${outcome === "failed" ? "text-cc-error" : "text-cc-muted"}`;
  if (kind === "race") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 2v12M3 2h9l-2 3 2 3H3" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "pipeline") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" />
        <path d="M4.5 8h2M9.5 8h2" />
      </svg>
    );
  }
  if (kind === "loop") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls} data-testid="loop-icon">
        <path d="M13 8a5 5 0 01-8.6 3.5M3 8a5 5 0 018.6-3.5" strokeLinecap="round" />
        <path d="M11.5 2v2.5H14M4.5 14v-2.5H2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M14 10a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1h10a1 1 0 011 1v7z" strokeLinejoin="round" />
    </svg>
  );
}

const actionBtn =
  "h-7 px-2.5 rounded-full text-[12.5px] transition-colors duration-120 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const ghostBtn = `${actionBtn} text-cc-muted hover:text-cc-fg hover:bg-cc-hover`;
const outlineBtn = `${actionBtn} border border-cc-border text-cc-fg hover:bg-cc-hover`;
const primaryBtn = `${actionBtn} bg-cc-primary text-cc-bg hover:bg-cc-primary-hover`;

export interface InboxRowProps {
  item: InboxItem;
  onReview: (item: InboxItem, status: InboxReviewStatus) => void;
  onOpenPr: (item: InboxItem) => Promise<void>;
  onRetry: (item: InboxItem) => Promise<void>;
  now?: number;
}

export function InboxRow({ item, onReview, onOpenPr, onRetry, now }: InboxRowProps) {
  const [busy, setBusy] = useState<"pr" | "retry" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; href?: string } | null>(null);

  async function handlePr() {
    setBusy("pr");
    setNotice(null);
    try {
      await onOpenPr(item);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry() {
    setBusy("retry");
    setNotice(null);
    try {
      await onRetry(item);
      setNotice({ kind: "ok", text: "Re-run started. It will land here when it finishes." });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const boardHref = item.kind === "loop" && item.cronJobId && item.loopRunId
    ? `#/kanban?job=${encodeURIComponent(item.cronJobId)}&run=${encodeURIComponent(item.loopRunId)}`
    : null;

  function handleOpen() {
    if (item.kind === "race" && item.raceId) {
      window.location.hash = `#/races/${encodeURIComponent(item.raceId)}`;
      return;
    }
    if (item.kind === "pipeline") {
      window.location.hash = "#/orchestrator";
      return;
    }
    if (item.sessionId) openSession(item.sessionId, "chat");
  }

  const isPending = item.review === "pending";
  const cost = formatCost(item.costUsd);

  return (
    <li className={`group px-3 sm:px-4 py-3.5 rounded-xl hover:bg-cc-hover transition-colors duration-120 ${!isPending ? "opacity-70" : ""}`} data-inbox-id={item.id}>
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-full bg-cc-user-bubble flex items-center justify-center shrink-0 mt-0.5">
          <KindIcon kind={item.kind} outcome={item.outcome} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <button onClick={handleOpen} className="text-[14px] font-medium text-cc-fg truncate text-left hover:underline underline-offset-2 cursor-pointer">
              {item.title}
            </button>
            {item.outcome === "failed" && <span className="text-[12px] text-cc-error shrink-0">Failed</span>}
            {item.outcome === "cancelled" && <span className="text-[12px] text-cc-muted shrink-0">Cancelled</span>}
            <span className="text-[12px] text-cc-muted ml-auto shrink-0 tabular-nums">{formatRelativeTime(item.completedAt, now)}</span>
          </div>

          <div className="flex items-center gap-1.5 text-[12.5px] text-cc-muted mt-0.5 min-w-0 flex-wrap">
            <span className="truncate">{item.subtitle}</span>
            {item.branch && (
              <>
                <span className="text-cc-muted/40">·</span>
                <span className="font-mono-code truncate max-w-[200px]">{item.branch}</span>
                {item.isWorktree && <span className="text-[10px] border border-cc-border px-1 rounded leading-[14px]">wt</span>}
              </>
            )}
            {(item.linesAdded > 0 || item.linesRemoved > 0) && (
              <>
                <span className="text-cc-muted/40">·</span>
                <span className="tabular-nums">
                  <span className="text-cc-success">+{item.linesAdded}</span>{" "}
                  <span className="text-cc-error">-{item.linesRemoved}</span>
                </span>
              </>
            )}
            {cost && (
              <>
                <span className="text-cc-muted/40">·</span>
                <span className="tabular-nums">{cost}</span>
              </>
            )}
          </div>

          {item.summary && (
            <p className="text-[13.5px] text-cc-fg/85 mt-1.5 leading-[1.55] line-clamp-2 text-pretty whitespace-pre-line">
              {item.summary.replace(/\n{2,}/g, "\n")}
            </p>
          )}

          {notice && (
            <p className={`text-[12.5px] mt-1.5 ${notice.kind === "error" ? "text-cc-error" : "text-cc-muted"}`}>
              {notice.href ? (
                <a href={notice.href} target="_blank" rel="noopener noreferrer" className="text-cc-link hover:underline">{notice.text}</a>
              ) : notice.text}
            </p>
          )}

          <div className="flex items-center gap-1 mt-2.5 flex-wrap">
            {item.sessionId && (item.kind === "session" || item.kind === "loop") && (
              <button onClick={() => openSession(item.sessionId!, "chat")} className={outlineBtn}>Open</button>
            )}
            {item.kind !== "session" && item.kind !== "loop" && (
              <button onClick={handleOpen} className={outlineBtn}>Open</button>
            )}
            {boardHref && (
              <a href={boardHref} className={`${outlineBtn} inline-flex items-center`}>Board</a>
            )}
            {item.sessionId && item.hasChanges && (
              <button onClick={() => openSession(item.sessionId!, "diff")} className={outlineBtn}>Diff</button>
            )}
            {(item.kind === "session" || item.kind === "loop") && item.hasChanges && item.branch && (
              <button onClick={handlePr} disabled={busy !== null} className={primaryBtn}>
                {busy === "pr" ? "Opening PR…" : "Open PR"}
              </button>
            )}
            {item.cronJobId && (
              <button onClick={handleRetry} disabled={busy !== null} className={ghostBtn}>
                {busy === "retry" ? "Starting…" : "Retry"}
              </button>
            )}
            <span className="flex-1" />
            {isPending ? (
              <>
                <button onClick={() => onReview(item, "reviewed")} className={ghostBtn} title="Mark reviewed">
                  Mark reviewed
                </button>
                <button onClick={() => onReview(item, "dismissed")} className={ghostBtn} title="Dismiss">
                  Dismiss
                </button>
              </>
            ) : (
              <button onClick={() => onReview(item, "pending")} className={ghostBtn}>
                Reopen
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function InboxPage({ embedded }: { embedded?: boolean }) {
  const [rawItems, setItems] = useState<InboxItem[]>(EMPTY_ITEMS);
  const sessionNames = useStore((s) => s.sessionNames);
  // The server only knows names set through the API; auto-generated names live
  // in the browser store, so resolve session titles client-side when possible.
  const items = useMemo(
    () => rawItems.map((i) => {
      const local = i.kind === "session" && i.sessionId ? sessionNames?.get(i.sessionId) : undefined;
      return local && local !== i.title ? { ...i, title: local } : i;
    }),
    [rawItems, sessionNames],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("pending");
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await api.getInbox();
      setItems(res.items);
      useStore.getState().setInboxPendingCount(res.counts.pending);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox");
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const counts = useMemo(() => {
    let pending = 0, reviewed = 0, dismissed = 0;
    for (const i of items) {
      if (i.review === "pending") pending++;
      else if (i.review === "reviewed") reviewed++;
      else dismissed++;
    }
    return { pending, reviewed, dismissed };
  }, [items]);

  const visible = useMemo(() => {
    if (tab === "pending") return items.filter((i) => i.review === "pending");
    if (tab === "reviewed") return items.filter((i) => i.review === "reviewed");
    return items;
  }, [items, tab]);

  const handleReview = useCallback(async (item: InboxItem, status: InboxReviewStatus) => {
    // Optimistic update, then confirm with the server.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, review: status, reviewedAt: status === "pending" ? undefined : Date.now() } : i)));
    try {
      await api.reviewInboxItem(item.id, status);
      const pending = useStore.getState().inboxPendingCount + (status === "pending" ? 1 : item.review === "pending" ? -1 : 0);
      useStore.getState().setInboxPendingCount(Math.max(0, pending));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update item");
      refresh();
    }
  }, [refresh]);

  const handleOpenPr = useCallback(async (item: InboxItem) => {
    const res = await api.createInboxPr(item.id);
    window.open(res.url, "_blank", "noopener");
  }, []);

  const handleRetry = useCallback(async (item: InboxItem) => {
    await api.retryInboxItem(item.id);
  }, []);

  const tabs: Array<[Tab, string, number]> = [
    ["pending", "Needs review", counts.pending],
    ["reviewed", "Reviewed", counts.reviewed],
    ["all", "All", items.length],
  ];

  return (
    <div className={embedded ? "px-4 sm:px-6 py-6 max-w-3xl mx-auto" : "p-6 max-w-3xl mx-auto"}>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <h1 className="text-[22px] font-medium text-cc-fg tracking-[-0.01em]">Inbox</h1>
          <p className="text-[13px] text-cc-muted mt-0.5">
            Finished sessions, races, pipelines, and loop runs waiting for your review.
          </p>
        </div>
        <button onClick={refresh} className={ghostBtn} aria-label="Refresh inbox">
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-1 mb-3">
        <div className="flex items-center bg-cc-hover rounded-full p-0.5">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`text-[13px] px-3 h-7 rounded-full transition-colors duration-120 cursor-pointer flex items-center gap-1.5 ${
                tab === key ? "text-cc-fg bg-cc-card shadow-panel" : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              {label}
              {count > 0 && <span className="text-[11px] text-cc-muted tabular-nums">{count}</span>}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-[13px] text-cc-error mb-3">{error}</p>
      )}

      {loading ? (
        <p className="text-[13px] text-cc-muted px-4 py-10 text-center">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="px-4 py-14 text-center">
          <p className="text-[15px] font-medium text-cc-fg">
            {tab === "pending" ? "Nothing to review" : "Nothing here yet"}
          </p>
          <p className="text-[13px] text-cc-muted mt-1">
            {tab === "pending"
              ? "Finished sessions, races, and pipeline runs will land here."
              : "Items you mark as reviewed or dismiss will show up in this list."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-cc-border/60 -mx-1">
          {visible.map((item) => (
            <InboxRow key={item.id} item={item} now={now} onReview={handleReview} onOpenPr={handleOpenPr} onRetry={handleRetry} />
          ))}
        </ul>
      )}
    </div>
  );
}
