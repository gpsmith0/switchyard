import type { RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

interface SessionItemProps {
  session: SessionItemType;
  isActive: boolean;
  isArchived?: boolean;
  sessionName: string | undefined;
  permCount: number;
  isRecentlyRenamed: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onUnarchive: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClearRecentlyRenamed: (id: string) => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: RefObject<HTMLInputElement | null>;
}

/** Abbreviate model name for badge display */
function modelBadge(model: string | undefined, backendType: string): string {
  if (!model) return backendType === "codex" ? "Codex" : "Claude";
  // Common Claude models
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  // Codex models
  if (model.includes("codex")) return "Codex";
  // Fallback: capitalize backend
  if (backendType === "codex") return "Codex";
  if (backendType === "goose") return "Goose";
  if (backendType === "aider") return "Aider";
  if (backendType === "openhands") return "OpenHands";
  return "Claude";
}

/**
 * SessionItem — a sidebar row in the ChatGPT style (design.md §6):
 * one line of 14px text, no status rail. A small dot before the name only
 * while the agent is running (green) or waiting on a permission (amber).
 * The branch is a second muted line; git stats reveal on hover.
 */
export function SessionItem({
  session: s,
  isActive,
  isArchived: archived,
  sessionName,
  permCount,
  isRecentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
}: SessionItemProps) {
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isRunning = s.status === "running";
  const isCompacting = s.status === "compacting";
  const isEditing = editingSessionId === s.id;
  const isSubagent = s.orchestrationRole === "subagent" || !!s.parentSessionId;
  const isCompletedSubagent = !!s.subagentTerminalStatus || (isSubagent && !s.isConnected && s.sdkState === "exited");

  // Status dot — only shown when something needs attention or is in flight
  const showDot = !archived && (permCount > 0 || isRunning || isCompacting);
  const dotColor = permCount > 0
    ? "bg-cc-warning"
    : isCompacting
    ? "bg-cc-warning"
    : "bg-cc-success";
  const showPulse = !archived && (permCount > 0 || (isRunning && s.isConnected));

  const hasGitStats = s.gitAhead > 0 || s.gitBehind > 0 || s.linesAdded > 0 || s.linesRemoved > 0;

  return (
    <div className={`relative group ${archived ? "opacity-50" : ""}`}>
      <button
        onClick={() => onSelect(s.id)}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartRename(s.id, label);
        }}
        title={`${label} · ${modelBadge(s.model, s.backendType)}`}
        className={`w-full pl-2.5 pr-8 py-1.5 ${archived ? "pr-14" : ""} text-left rounded-lg transition-colors duration-120 cursor-pointer ${
          isActive ? "bg-cc-active" : "hover:bg-cc-hover"
        }`}
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          {/* Row 1: status dot + name */}
          <div className="flex items-center gap-2 min-w-0">
            {showDot && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor} ${
                  showPulse ? "animate-[pulse-dot_1.5s_ease-in-out_infinite]" : ""
                }`}
              />
            )}
            {isEditing ? (
              <input
                ref={editInputRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onConfirmRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancelRename();
                  }
                  e.stopPropagation();
                }}
                onBlur={onConfirmRename}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className="text-[14px] flex-1 min-w-0 text-cc-fg bg-cc-bg border border-cc-border rounded-md px-1.5 py-0.5 outline-none focus:border-cc-fg/40"
              />
            ) : (
              <>
                <span
                  className={`text-[14px] truncate text-cc-fg leading-snug ${
                    isRecentlyRenamed ? "animate-name-appear" : ""
                  }`}
                  onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
                >
                  {label}
                </span>
                <span className="text-[11px] text-cc-muted shrink-0">
                  {modelBadge(s.model, s.backendType).toLowerCase()}
                </span>
                {s.cronJobId && (
                  <span className="text-[11px] text-cc-muted shrink-0">Cron</span>
                )}
                {isCompletedSubagent && (
                  <span
                    className="text-[11px] text-cc-muted shrink-0"
                    title="Subagent reached a terminal state and is offline"
                  >
                    {s.subagentTerminalStatus ?? "completed"}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Row 2: branch */}
          {s.gitBranch && (
            <div className="flex items-center gap-1 text-[12px] text-cc-muted leading-tight truncate">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
              <span className="truncate">{s.gitBranch}</span>
              {s.isWorktree && (
                <span className="text-[10px] border border-cc-border text-cc-muted px-1 rounded shrink-0 leading-[14px]">wt</span>
              )}
              {/* Git stats — hover-revealed on desktop, always visible on mobile */}
              {hasGitStats && (
                <span className="flex items-center gap-1.5 ml-1 tabular-nums opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  {s.gitAhead > 0 && <span className="text-cc-success">{s.gitAhead}&#8593;</span>}
                  {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                  {s.linesAdded > 0 && <span className="text-cc-success">+{s.linesAdded}</span>}
                  {s.linesRemoved > 0 && <span className="text-cc-error">-{s.linesRemoved}</span>}
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Permission badge */}
      {!archived && permCount > 0 && (
        <span className="absolute right-8 sm:right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-semibold leading-none px-1 sm:group-hover:opacity-0 transition-opacity pointer-events-none tabular-nums">
          {permCount}
        </span>
      )}

      {/* Action buttons — always visible on mobile, hover-revealed on desktop */}
      {archived ? (
        <>
          <button
            onClick={(e) => onUnarchive(e, s.id)}
            className="absolute right-8 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-active text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
            title="Restore session"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M8 10V3M5 5l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 13h10" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={(e) => onDelete(e, s.id)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-active text-cc-muted hover:text-cc-error transition-all cursor-pointer"
            title="Delete permanently"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </>
      ) : (
        <button
          onClick={(e) => onArchive(e, s.id)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-active text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
          title="Archive session"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 3h10v2H3zM4 5v7a1 1 0 001 1h6a1 1 0 001-1V5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.5 8h3" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
