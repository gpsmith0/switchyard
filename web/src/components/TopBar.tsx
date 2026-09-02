import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import type { SessionRole, PresenceViewer } from "../types.js";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { ProviderSwitcher } from "./ProviderSwitcher.js";

// Stable empty references to avoid infinite re-renders from Zustand selectors
// (Object.is([], []) is false, so returning new [] on every selector call triggers re-renders)
const EMPTY_VIEWERS: PresenceViewer[] = [];

export function TopBar() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const isSessionView =
    hash !== "#/settings" &&
    hash !== "#/terminal" &&
    hash !== "#/environments" &&
    hash !== "#/gallery" &&
    hash !== "#/webhooks" &&
    hash !== "#/adapters";

  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const completedSubagentSessions = useStore((s) => s.completedSubagentSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);

  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  const changedFilesCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const cwd =
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd;
    const files = s.changedFiles.get(currentSessionId);
    if (!files) return 0;
    if (!cwd) return files.size;
    const prefix = `${cwd}/`;
    return [...files].filter((fp) => fp === cwd || fp.startsWith(prefix)).length;
  });

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd ||
      null
    );
  });

  const totalCost = useStore((s) => {
    if (!currentSessionId) return 0;
    return s.sessions.get(currentSessionId)?.total_cost_usd ?? 0;
  });

  const myRole = useStore((s) => {
    if (!currentSessionId) return null;
    return s.myRole.get(currentSessionId) ?? null;
  });
  const isSpectator = myRole === "spectator";

  const viewers = useStore((s) => {
    if (!currentSessionId) return EMPTY_VIEWERS;
    return s.sessionViewers.get(currentSessionId) ?? EMPTY_VIEWERS;
  });

  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const currentSession = useStore((s) => currentSessionId ? s.sessions.get(currentSessionId) : undefined);
  const currentSdkSession = currentSessionId
    ? sdkSessions.find((s) => s.sessionId === currentSessionId)
    : undefined;
  const isSubagent =
    currentSession?.orchestration_role === "subagent" ||
    !!currentSession?.parent_session_id ||
    currentSdkSession?.orchestrationRole === "subagent" ||
    !!currentSdkSession?.parentSessionId;
  const terminalSubagentStatus = currentSessionId ? completedSubagentSessions.get(currentSessionId) : undefined;
  const isCompletedSubagent = !!terminalSubagentStatus || (isSubagent && !isConnected && currentSdkSession?.state === "exited");
  const sessionName = currentSessionId
    ? (sessionNames?.get(currentSessionId) ||
      sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
      `Session ${currentSessionId.slice(0, 8)}`)
    : null;

  // Focus the name input when entering edit mode
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  // ---- Handlers ----

  async function handleFork() {
    if (!currentSessionId || forking) return;
    setForking(true);
    try {
      const result = await api.forkSession(currentSessionId);
      if (result.sessionId) {
        useStore.getState().setCurrentSession(result.sessionId);
        const { connectSession } = await import("../ws.js");
        connectSession(result.sessionId);
        // Refresh sessions list
        const list = await api.listSessions();
        useStore.getState().setSdkSessions(list);
      }
    } catch (err) {
      console.error("[TopBar] Failed to fork session:", err);
    } finally {
      setForking(false);
    }
  }

  async function handleShare(role: SessionRole) {
    if (!currentSessionId || shareCopied) return;
    try {
      const { url } = await api.createInviteLink(currentSessionId, role);
      // Try clipboard API first, fall back to execCommand, then prompt
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Clipboard API fails on non-HTTPS -- try legacy fallback
        try {
          const textarea = document.createElement("textarea");
          textarea.value = url;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          copied = document.execCommand("copy");
          document.body.removeChild(textarea);
        } catch {
          /* fallback also failed */
        }
      }
      if (copied) {
        setShareCopied(true);
        setShareMenuOpen(false);
        setOverflowOpen(false);
        setTimeout(() => setShareCopied(false), 2000);
      } else {
        // Last resort: show the URL in a prompt so user can manually copy
        setShareMenuOpen(false);
        setOverflowOpen(false);
        window.prompt("Copy this invite link:", url);
      }
    } catch (err) {
      console.error("[TopBar] Failed to create invite link:", err);
    }
  }

  function handleNameClick() {
    if (isSpectator || !currentSessionId) return;
    setNameInput(sessionName || "");
    setEditingName(true);
  }

  async function handleNameSubmit() {
    setEditingName(false);
    const trimmed = nameInput.trim();
    if (!currentSessionId || !trimmed || trimmed === sessionName) return;
    try {
      await api.renameSession(currentSessionId, trimmed);
      useStore.getState().setSessionName(currentSessionId, trimmed);
    } catch (err) {
      console.error("[TopBar] Failed to rename session:", err);
    }
  }

  function handleCopySessionId() {
    if (!currentSessionId) return;
    navigator.clipboard.writeText(currentSessionId).catch(() => {
      window.prompt("Session ID:", currentSessionId);
    });
    setOverflowOpen(false);
  }

  const iconBtn =
    "flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors duration-120 cursor-pointer";
  const menuItem =
    "w-full text-left px-3 h-9 text-[13px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2.5 rounded-lg";

  return (
    <header className="shrink-0 flex items-center justify-between pl-2 pr-3 h-[52px] bg-cc-bg">
      {/* ---- Left: sidebar toggle + provider/model pill + session name ---- */}
      <div className="flex items-center gap-1 min-w-0">
        {!isSpectator && (
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
            aria-pressed={sidebarOpen}
            className={iconBtn}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
              <path d="M8 3.5v13" />
            </svg>
          </button>
        )}

        {isSpectator && (
          <span className="px-2.5 h-7 inline-flex items-center rounded-full text-[12px] font-medium bg-cc-hover text-cc-muted">
            Spectator
          </span>
        )}

        {/* Provider + model, rendered like ChatGPT's "ChatGPT ⌄" pill */}
        {currentSessionId && isSessionView && !isSpectator && (
          <div className="flex items-center gap-0.5 rounded-lg px-1 h-8 hover:bg-cc-hover transition-colors">
            <ProviderSwitcher sessionId={currentSessionId} />
            <span className="text-cc-muted/40 text-[12px] select-none">/</span>
            <ModelSwitcher sessionId={currentSessionId} />
          </div>
        )}

        {/* Session name + status */}
        {currentSessionId && (
          <div className="flex items-center gap-2 min-w-0 pl-1">
            {editingName ? (
              <input
                ref={nameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={handleNameSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleNameSubmit();
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="text-[14px] font-medium text-cc-fg bg-transparent border-b border-cc-fg/40 outline-none max-w-[12rem] sm:max-w-[20rem]"
              />
            ) : (
              <span
                onClick={handleNameClick}
                className={`text-[14px] font-medium text-cc-fg max-w-[10rem] sm:max-w-[20rem] truncate ${
                  !isSpectator ? "cursor-text hover:text-cc-muted transition-colors" : ""
                }`}
                title={sessionName || undefined}
              >
                {sessionName}
              </span>
            )}

            {status === "running" && (
              <span className="flex items-center gap-1.5 text-[12px] text-cc-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-cc-success animate-breathing" />
                Working
              </span>
            )}
            {status === "compacting" && (
              <span className="text-[12px] text-cc-warning animate-pulse">Compacting</span>
            )}
            {isCompletedSubagent && (
              <span className="text-[12px] text-cc-muted">{terminalSubagentStatus ?? "completed"}</span>
            )}
            {!isConnected && !isSpectator && !isCompletedSubagent && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[12px] text-cc-warning hover:underline cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* ---- Right: tabs + actions ---- */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-1.5">
          {/* Presence avatars */}
          {viewers.length > 1 && (
            <div className="flex items-center -space-x-1.5 mr-1" title={`${viewers.length} viewers`}>
              {viewers.slice(0, 3).map((v) => (
                <span
                  key={v.id}
                  className={`w-6 h-6 rounded-full ring-2 ring-cc-bg flex items-center justify-center text-[10px] font-semibold ${
                    v.role === "owner" ? "bg-cc-fg text-cc-bg" : "bg-cc-active text-cc-muted"
                  }`}
                  title={`${v.name} (${v.role})`}
                >
                  {v.name.charAt(0).toUpperCase()}
                </span>
              ))}
              {viewers.length > 3 && (
                <span className="text-[11px] text-cc-muted pl-2.5">+{viewers.length - 3}</span>
              )}
            </div>
          )}

          {/* View switcher */}
          <div className="flex items-center bg-cc-hover rounded-full p-0.5">
            {([
              ["chat", "Log", 0],
              ["diff", "Diff", changedFilesCount],
              ["files", "Files", 0],
            ] as const).map(([tab, label, count]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                aria-pressed={activeTab === tab}
                className={`text-[13px] px-3 h-7 rounded-full transition-colors duration-120 cursor-pointer flex items-center gap-1.5 ${
                  activeTab === tab
                    ? "text-cc-fg bg-cc-card shadow-panel"
                    : "text-cc-muted hover:text-cc-fg"
                }`}
              >
                {label}
                {count > 0 && (
                  <span className="text-[11px] text-cc-muted tabular-nums">{count}</span>
                )}
              </button>
            ))}
          </div>

          {/* Cost */}
          {totalCost > 0 && (
            <span
              className="hidden sm:inline text-[12px] text-cc-muted tabular-nums px-1"
              title={`Session cost: $${totalCost.toFixed(4)}`}
            >
              ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
            </span>
          )}

          {/* Share */}
          {!isSpectator && (
            <div className="relative">
              <button
                onClick={() => { setShareMenuOpen(!shareMenuOpen); setOverflowOpen(false); }}
                className="flex items-center gap-1.5 h-8 px-3 rounded-full border border-cc-border text-[13px] font-medium text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                aria-label="Share session"
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M10 12.5v-9M6.5 7L10 3.5 13.5 7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 10.5v4a2 2 0 002 2h8a2 2 0 002-2v-4" strokeLinecap="round" />
                </svg>
                <span className="hidden sm:inline">{shareCopied ? "Copied" : "Share"}</span>
              </button>
              {shareMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShareMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1.5 z-50 bg-cc-card border border-cc-border rounded-xl shadow-float p-1 min-w-[220px] animate-slide-down">
                    <div className="px-3 pt-2 pb-1 text-[12px] text-cc-muted">Copy an invite link</div>
                    <button onClick={() => handleShare("collaborator")} className={menuItem}>
                      <span className="flex flex-col leading-tight">
                        <span>Collaborator</span>
                        <span className="text-[12px] text-cc-muted">Can approve and send</span>
                      </span>
                    </button>
                    <button onClick={() => handleShare("spectator")} className={menuItem}>
                      <span className="flex flex-col leading-tight">
                        <span>Spectator</span>
                        <span className="text-[12px] text-cc-muted">Watch only</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Overflow menu */}
          {!isSpectator && (
            <div className="relative" ref={overflowRef}>
              <button
                onClick={() => { setOverflowOpen(!overflowOpen); setShareMenuOpen(false); }}
                aria-label="More actions"
                className={iconBtn}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]">
                  <circle cx="4.5" cy="10" r="1.5" />
                  <circle cx="10" cy="10" r="1.5" />
                  <circle cx="15.5" cy="10" r="1.5" />
                </svg>
              </button>
              {overflowOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setOverflowOpen(false)} />
                  <div className="absolute right-0 top-full mt-1.5 z-50 bg-cc-card border border-cc-border rounded-xl shadow-float p-1 min-w-[200px] animate-slide-down">
                    {cwd && (
                      <button
                        onClick={() => { handleFork(); setOverflowOpen(false); }}
                        disabled={forking}
                        className={`${menuItem} disabled:opacity-40`}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-muted shrink-0">
                          <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
                        </svg>
                        {forking ? "Forking…" : "Fork session"}
                      </button>
                    )}
                    {cwd && (
                      <button
                        onClick={() => { setClaudeMdOpen(true); setOverflowOpen(false); }}
                        className={menuItem}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-muted shrink-0">
                          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
                        </svg>
                        Edit CLAUDE.md
                      </button>
                    )}
                    <button
                      onClick={() => {
                        window.location.hash = currentSessionId
                          ? `#/gallery?session=${encodeURIComponent(currentSessionId)}`
                          : "#/gallery";
                        setOverflowOpen(false);
                      }}
                      className={menuItem}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-muted shrink-0">
                        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1H2V3zm0 2.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7zM4 7v3h3V7H4zm5 0v1h3V7H9zm3 2.5H9V11h3V9.5z" />
                      </svg>
                      View in gallery
                    </button>
                    <div className="my-1 h-px bg-cc-border" />
                    <button onClick={handleCopySessionId} className={`${menuItem} text-cc-muted hover:text-cc-fg`}>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0">
                        <path d="M5.75 1a.75.75 0 00-.75.75v1.5a.75.75 0 001.5 0V2.5h5v9h-.75a.75.75 0 000 1.5h1.5a.75.75 0 00.75-.75v-10.5A.75.75 0 0012.25 1h-6.5zM3.75 4a.75.75 0 00-.75.75v10.5a.75.75 0 00.75.75h6.5a.75.75 0 00.75-.75V4.75a.75.75 0 00-.75-.75h-6.5zM4.5 5.5h5v9h-5v-9z" />
                      </svg>
                      Copy session ID
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Task panel toggle */}
          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            aria-label="Toggle session panel"
            aria-pressed={taskPanelOpen}
            className={`${iconBtn} ${taskPanelOpen ? "text-cc-fg bg-cc-active" : ""}`}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
              <path d="M12 3.5v13" />
            </svg>
          </button>
        </div>
      )}

      {/* CLAUDE.md editor modal */}
      {cwd && (
        <ClaudeMdEditor
          cwd={cwd}
          open={claudeMdOpen}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </header>
  );
}
