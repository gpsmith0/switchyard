import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent, type ReactNode } from "react";
import { useStore } from "../store.js";
import { api, type SessionFolder } from "../api.js";
import { connectSession, connectAllSessions, disconnectSession } from "../ws.js";
import { SessionItem } from "./SessionItem.js";
import { type SessionItem as SessionItemType } from "../utils/project-grouping.js";

/* ─── Time Grouping ─────────────────────────────────────────────── */

function getTimeGroup(createdAt: number): string {
  if (!createdAt) return "Older";
  const today = new Date();
  const sessionDate = new Date(createdAt);
  if (sessionDate.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sessionDate.toDateString() === yesterday.toDateString()) return "Yesterday";
  const diff = Date.now() - createdAt;
  const day = 86400000;
  if (diff < 7 * day) return "Previous 7 Days";
  return "Older";
}

const TIME_GROUP_ORDER = ["Today", "Yesterday", "Previous 7 Days", "Older"];

/* ─── Nav Item Types ───────────────────────────────────────────── */

interface NavItem {
  label: string;
  hash: string;
  icon: ReactNode;
}

/* ─── Nav Sections ─────────────────────────────────────────────── */


const NAV_TOOLS: NavItem[] = [
  {
    label: "Terminal",
    hash: "#/terminal",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z" />
      </svg>
    ),
  },
  {
    label: "Orchestrator",
    hash: "#/orchestrator",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1.5h-13V3zM1.5 6h13v1.5h-13V6zM1.5 9h13v1.5h-13V9zM1.5 12v1A1.5 1.5 0 003 14.5h10a1.5 1.5 0 001.5-1.5v-1h-13z" />
      </svg>
    ),
  },
  {
    label: "Races",
    hash: "#/races",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M3 2.5A1.5 1.5 0 014.5 1h1A1.5 1.5 0 017 2.5v1A1.5 1.5 0 015.5 5h-1A1.5 1.5 0 013 3.5v-1zM9 2.5A1.5 1.5 0 0110.5 1h1A1.5 1.5 0 0113 2.5v1A1.5 1.5 0 0111.5 5h-1A1.5 1.5 0 019 3.5v-1zM3 12.5A1.5 1.5 0 014.5 11h1A1.5 1.5 0 017 12.5v1A1.5 1.5 0 015.5 15h-1A1.5 1.5 0 013 13.5v-1zM9 12.5a1.5 1.5 0 011.5-1.5h1a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5h-1A1.5 1.5 0 019 13.5v-1zM5 6h1v1.5h4V6h1v4h-1V8.5H6V10H5V6z" />
      </svg>
    ),
  },
  {
    label: "Kanban",
    hash: "#/kanban",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1.5 2h4v12h-4V2zm.75.75v10.5h2.5V2.75h-2.5zM6 2h4v8H6V2zm.75.75v6.5h2.5v-6.5h-2.5zM10.5 2h4v10h-4V2zm.75.75v8.5h2.5v-8.5h-2.5z" />
      </svg>
    ),
  },
  {
    label: "Monitor",
    hash: "#/monitor",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h11A1.5 1.5 0 0115 3.5v6a1.5 1.5 0 01-1.5 1.5H10v1.5h1.5a.5.5 0 010 1h-7a.5.5 0 010-1H6V11H2.5A1.5 1.5 0 011 9.5v-6zM2.5 3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-6a.5.5 0 00-.5-.5h-11z" />
      </svg>
    ),
  },
];

const NAV_DATA: NavItem[] = [
  {
    label: "Environments",
    hash: "#/environments",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
      </svg>
    ),
  },
  {
    label: "Scheduled",
    hash: "#/scheduled",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
      </svg>
    ),
  },
  {
    label: "Gallery",
    hash: "#/gallery",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1H2V3zm0 2.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7zM4 7v3h3V7H4zm5 0v1h3V7H9zm3 2.5H9V11h3V9.5z" />
      </svg>
    ),
  },
  {
    label: "Webhooks",
    hash: "#/webhooks",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M5.5 1a.5.5 0 01.5.5v2a2.5 2.5 0 005 0v-2a.5.5 0 011 0v2a3.5 3.5 0 01-3 3.465V8.5h2a.5.5 0 010 1H9v2.035A3.5 3.5 0 0112 15a.5.5 0 010-1 2.5 2.5 0 01-2.5-2.5V9.5h-3v2A2.5 2.5 0 014 14a.5.5 0 010 1 3.5 3.5 0 003-3.465V9.5H5a.5.5 0 010-1h2V6.965A3.5 3.5 0 014 3.5v-2a.5.5 0 01.5-.5 .5.5 0 01.5.5v2a2.5 2.5 0 005 0v-2a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Recordings",
    hash: "#/hub",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

const NAV_CONFIG: NavItem[] = [
  {
    label: "Adapters",
    hash: "#/adapters",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M2 4a2 2 0 012-2h1.5a.5.5 0 010 1H4a1 1 0 00-1 1v2.5a.5.5 0 01-1 0V4zm0 8a2 2 0 002 2h1.5a.5.5 0 000-1H4a1 1 0 01-1-1V9.5a.5.5 0 00-1 0V12zm12-8a2 2 0 00-2-2h-1.5a.5.5 0 000 1H12a1 1 0 011 1v2.5a.5.5 0 001 0V4zm0 8a2 2 0 01-2 2h-1.5a.5.5 0 010-1H12a1 1 0 001-1V9.5a.5.5 0 011 0V12zM6 8a2 2 0 114 0 2 2 0 01-4 0z" />
      </svg>
    ),
  },
  {
    label: "Commands",
    hash: "#/commands",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M6.646 5.646a.5.5 0 01.708 0l2.5 2.5a.5.5 0 010 .708l-2.5 2.5a.5.5 0 01-.708-.708L8.793 8.5H1.5a.5.5 0 010-1h7.293L6.646 5.354a.5.5 0 010-.708zM12.5 2a.5.5 0 01.5.5v11a.5.5 0 01-1 0v-11a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Agents",
    hash: "#/agents",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H3z" />
      </svg>
    ),
  },
  {
    label: "Prompts",
    hash: "#/prompts",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 5h6M5 8h6M5 11h4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Skills",
    hash: "#/skills",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 001.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 00-1.828 1.829l-.645 1.936a.361.361 0 01-.686 0l-.645-1.937a2.89 2.89 0 00-1.828-1.828l-1.937-.645a.361.361 0 010-.686l1.937-.645a2.89 2.89 0 001.828-1.829l.645-1.936zM3.794 1.148a.217.217 0 01.412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 010 .412l-1.162.387A1.734 1.734 0 004.593 5.69l-.387 1.162a.217.217 0 01-.412 0L3.407 5.69a1.734 1.734 0 00-1.097-1.097l-1.162-.387a.217.217 0 010-.412l1.162-.387A1.734 1.734 0 003.407 2.31l.387-1.162z" />
      </svg>
    ),
  },
  {
    label: "Integrations",
    hash: "#/integrations",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M4.5 2a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2zM11.5 9a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2zM7.5 4.5a.5.5 0 01.5.5v2.5h1a.5.5 0 010 1H8V11a.5.5 0 01-1 0V8.5H5.5a.5.5 0 010-1H7V5a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: "Memory",
    hash: "#/memory",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1H3zm2 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h4a.5.5 0 010 1H5a.5.5 0 010-1z" />
      </svg>
    ),
  },
  {
    label: "Router",
    hash: "#/router",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    label: "Collective",
    hash: "#/collective",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 0a8 8 0 110 16A8 8 0 018 0zM4.5 7.5a.5.5 0 000 1h7a.5.5 0 000-1h-7zM4 5.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zm4.5 5a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
      </svg>
    ),
  },
  {
    label: "ClawHub",
    hash: "#/clawhub",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.5 4.5a1 1 0 11-2 0 1 1 0 012 0zM8 13a5 5 0 01-4.33-2.5.5.5 0 01.87-.5A4 4 0 008 12a4 4 0 003.46-2 .5.5 0 01.87.5A5 5 0 018 13zm-3.5-8.5a1 1 0 110 2 1 1 0 010-2z" />
      </svg>
    ),
  },
];

const INITIAL_SESSIONS_SHOWN = 5;

/* ─── Component ─────────────────────────────────────────────────── */

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("cc-collapsed-nav-sections");
      return saved ? new Set(JSON.parse(saved)) : new Set(["Tools", "Data", "Config"]);
    } catch {
      return new Set(["Tools", "Data", "Config"]);
    }
  });
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const completedSubagentSessions = useStore((s) => s.completedSubagentSessions);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse);

  /* Folder state (kept for logic compatibility) */
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("cc-collapsed-folders");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  /* ─── Poll for SDK sessions on mount ───────────────────────────── */
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          connectAllSessions(list);
          const store = useStore.getState();
          for (const s of list) {
            if (
              s.name &&
              (!store.sessionNames.has(s.sessionId) ||
                /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(store.sessionNames.get(s.sessionId)!))
            ) {
              const currentStoreName = store.sessionNames.get(s.sessionId);
              const hadRandomName =
                !!currentStoreName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentStoreName);
              if (currentStoreName !== s.name) {
                store.setSessionName(s.sessionId, s.name);
                if (hadRandomName) {
                  store.markRecentlyRenamed(s.sessionId);
                }
              }
            }
          }
        }
      } catch {
        // server not ready
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  /* Load folders on mount */
  useEffect(() => {
    api.listFolders().then(setFolders).catch(() => {});
  }, []);

  /* Keyboard shortcut for search (Ctrl+K) */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  function toggleSectionCollapse(section: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      localStorage.setItem("cc-collapsed-nav-sections", JSON.stringify([...next]));
      return next;
    });
  }

  function toggleFolderCollapse(folderId: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      localStorage.setItem("cc-collapsed-folders", JSON.stringify([...next]));
      return next;
    });
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      const folder = await api.createFolder(newFolderName.trim());
      setFolders((prev) => [...prev, folder]);
      setNewFolderName("");
      setShowNewFolder(false);
    } catch {}
  }

  async function handleDeleteFolder(folderId: string) {
    try {
      await api.deleteFolder(folderId);
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
    } catch {}
  }

  async function handleMoveToFolder(sessionId: string, folderId: string) {
    try {
      await api.addSessionToFolder(folderId, sessionId);
      const updated = await api.listFolders();
      setFolders(updated);
    } catch {}
  }

  async function handleRemoveFromFolder(sessionId: string) {
    try {
      await api.removeSessionFromFolder(sessionId);
      const updated = await api.listFolders();
      setFolders(updated);
    } catch {}
  }

  /* Hash change listener */
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /* ─── Session handlers ─────────────────────────────────────────── */

  function handleSelectSession(sessionId: string) {
    useStore.getState().closeTerminal();
    window.location.hash = "";
    if (currentSessionId === sessionId) return;
    setCurrentSession(sessionId);
    connectSession(sessionId);
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    useStore.getState().closeTerminal();
    window.location.hash = "";
    useStore.getState().newSession();
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  /* Focus edit input when entering edit mode */
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      useStore.getState().setSessionName(editingSessionId, editingName.trim());
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  function handleStartRename(id: string, currentName: string) {
    setEditingSessionId(id);
    setEditingName(currentName);
  }

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        disconnectSession(sessionId);
        await api.deleteSession(sessionId);
      } catch {
        // best-effort
      }
      removeSession(sessionId);
    },
    [removeSession]
  );

  const handleArchiveSession = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
      const bridgeState = sessions.get(sessionId);
      const isWorktree = bridgeState?.is_worktree || sdkInfo?.isWorktree || false;
      if (isWorktree) {
        setConfirmArchiveId(sessionId);
        return;
      }
      doArchive(sessionId);
    },
    [sdkSessions, sessions]
  );

  const doArchive = useCallback(async (sessionId: string, force?: boolean) => {
    try {
      disconnectSession(sessionId);
      await api.archiveSession(sessionId, force ? { force: true } : undefined);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      useStore.getState().newSession();
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  const confirmArchive = useCallback(() => {
    if (confirmArchiveId) {
      doArchive(confirmArchiveId, true);
      setConfirmArchiveId(null);
    }
  }, [confirmArchiveId, doArchive]);

  const cancelArchive = useCallback(() => {
    setConfirmArchiveId(null);
  }, []);

  const handleUnarchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  /* ─── Build combined session list ──────────────────────────────── */

  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const allSessionList: SessionItemType[] = Array.from(allSessionIds)
    .map((id) => {
      const bridgeState = sessions.get(id);
      const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
      return {
        id,
        model: bridgeState?.model || sdkInfo?.model || "",
        cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
        gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
        isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
        gitAhead: bridgeState?.git_ahead || sdkInfo?.gitAhead || 0,
        gitBehind: bridgeState?.git_behind || sdkInfo?.gitBehind || 0,
        linesAdded: bridgeState?.total_lines_added || sdkInfo?.totalLinesAdded || 0,
        linesRemoved: bridgeState?.total_lines_removed || sdkInfo?.totalLinesRemoved || 0,
        isConnected: cliConnected.get(id) ?? false,
        status: sessionStatus.get(id) ?? null,
        sdkState: sdkInfo?.state ?? null,
        createdAt: sdkInfo?.createdAt ?? 0,
        archived: sdkInfo?.archived ?? false,
        backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
        repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
        permCount: pendingPermissions.get(id)?.size ?? 0,
        cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
        cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
        parentSessionId: bridgeState?.parent_session_id || sdkInfo?.parentSessionId,
        orchestrationRole: bridgeState?.orchestration_role || sdkInfo?.orchestrationRole,
        subagentTerminalStatus: completedSubagentSessions.get(id),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((s) => !s.archived);
  const archivedSessions = allSessionList.filter((s) => s.archived);
  /* ─── Search filtering ─────────────────────────────────────────── */

  const filteredActiveSessions = useMemo(() => {
    if (!searchQuery.trim()) return activeSessions;
    const q = searchQuery.toLowerCase();
    return activeSessions.filter((s) => {
      const name = sessionNames?.get(s.id) || s.id;
      return name.toLowerCase().includes(q);
    });
  }, [activeSessions, searchQuery, sessionNames]);

  /* ─── Time-grouped sessions ────────────────────────────────────── */

  const folderSessionIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const f of folders) {
      for (const sid of f.sessionIds) ids.add(sid);
    }
    return ids;
  }, [folders]);

  const timeGrouped = useMemo(() => {
    const ungrouped = filteredActiveSessions.filter((s) => !folderSessionIdSet.has(s.id));
    const groups: Record<string, SessionItemType[]> = {};
    for (const s of ungrouped) {
      const group = getTimeGroup(s.createdAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(s);
    }
    return TIME_GROUP_ORDER.filter((g) => groups[g]?.length).map((g) => ({
      label: g,
      sessions: groups[g],
    }));
  }, [filteredActiveSessions, folderSessionIdSet]);

  const filteredFolderSessions = useMemo(() => {
    return folders
      .map((folder) => {
        const folderSids = new Set(folder.sessionIds);
        const matched = filteredActiveSessions.filter((s) => folderSids.has(s.id));
        return { folder, sessions: matched };
      })
      .filter((f) => f.sessions.length > 0);
  }, [folders, filteredActiveSessions]);

  /* ─── Flatten all visible sessions for "show more" logic ──────── */

  const allVisibleSessions = useMemo(() => {
    const list: SessionItemType[] = [];
    for (const { sessions: fSessions } of filteredFolderSessions) {
      list.push(...fSessions);
    }
    for (const { sessions: gSessions } of timeGrouped) {
      list.push(...gSessions);
    }
    return list;
  }, [filteredFolderSessions, timeGrouped]);

  const totalSessionCount = allVisibleSessions.length;
  const shouldTruncate = !searchQuery && !sessionsExpanded && totalSessionCount > INITIAL_SESSIONS_SHOWN;

  /* Build a truncated view: take first N sessions across all groups */
  const truncatedTimeGrouped = useMemo(() => {
    if (!shouldTruncate) return timeGrouped;
    let remaining = INITIAL_SESSIONS_SHOWN;
    /* Subtract folder sessions first */
    for (const { sessions: fSessions } of filteredFolderSessions) {
      remaining -= fSessions.length;
    }
    if (remaining <= 0) return [];
    return timeGrouped
      .map(({ label, sessions: gSessions }) => {
        if (remaining <= 0) return null;
        const sliced = gSessions.slice(0, remaining);
        remaining -= sliced.length;
        return { label, sessions: sliced };
      })
      .filter(Boolean) as { label: string; sessions: SessionItemType[] }[];
  }, [shouldTruncate, timeGrouped, filteredFolderSessions]);

  /* ─── Shared SessionItem props ─────────────────────────────────── */

  const sessionItemProps = {
    onSelect: handleSelectSession,
    onStartRename: handleStartRename,
    onArchive: handleArchiveSession,
    onUnarchive: handleUnarchiveSession,
    onDelete: handleDeleteSession,
    onClearRecentlyRenamed: clearRecentlyRenamed,
    editingSessionId,
    editingName,
    setEditingName,
    onConfirmRename: confirmRename,
    onCancelRename: cancelRename,
    editInputRef,
  };

  /* ─── Navigation helper ────────────────────────────────────────── */

  function navigateTo(hashTarget: string) {
    useStore.getState().closeTerminal();
    window.location.hash = hashTarget;
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function isNavItemActive(item: NavItem): boolean {
    if (item.hash === "#/integrations") return hash.startsWith("#/integrations");
    return hash === item.hash;
  }

  /* ─── Shared row style (design.md §6 Sidebar) ────────────────── */

  const navRow =
    "w-full flex items-center gap-2.5 rounded-lg px-2 h-9 text-[14px] transition-colors duration-120 cursor-pointer";

  /* ─── Render nav section ─────────────────────────────────────── */

  function renderNavSection(title: string, items: NavItem[]) {
    const isCollapsed = collapsedSections.has(title);
    const hasActive = items.some(isNavItemActive);
    return (
      <div>
        <button
          onClick={() => toggleSectionCollapse(title)}
          aria-expanded={!isCollapsed}
          className={`${navRow} ${hasActive && isCollapsed ? "text-cc-fg" : "text-cc-fg/80"} hover:bg-cc-hover hover:text-cc-fg`}
        >
          <span className="w-5 h-5 flex items-center justify-center shrink-0 text-cc-muted">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
              <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="flex-1 text-left">{title}</span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`w-3.5 h-3.5 text-cc-muted transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {!isCollapsed && (
          <div className="ml-4 pl-2.5 border-l border-cc-border my-0.5 space-y-px">
            {items.map((item) => {
              const active = isNavItemActive(item);
              return (
                <button
                  key={item.hash}
                  onClick={() => navigateTo(item.hash)}
                  className={`${navRow} h-8 text-[13.5px] ${
                    active ? "bg-cc-active text-cc-fg" : "text-cc-fg/80 hover:bg-cc-hover hover:text-cc-fg"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="w-5 h-5 flex items-center justify-center shrink-0 text-cc-muted">
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /* ─── Render ───────────────────────────────────────────────────── */

  return (
    <aside className="w-[260px] h-full flex flex-col bg-cc-sidebar border-r border-cc-border/60" role="navigation">
      {/* ── Header: logo + collapse ─────────────────────────────── */}
      <div className="flex items-center justify-between pl-3 pr-2 pt-2.5 pb-1">
        <button
          onClick={handleNewSession}
          className="flex items-center gap-2 h-8 px-1.5 rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
          title="Home"
        >
          <img src="/logo.svg" alt="" className="w-5 h-5" />
          <span className="text-[14px] font-semibold text-cc-fg tracking-tight">Switchyard</span>
        </button>
        <button
          onClick={() => useStore.getState().setSidebarOpen(false)}
          aria-label="Close sidebar"
          className="w-8 h-8 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
            <path d="M8 3.5v13" />
          </svg>
        </button>
      </div>

      {/* ── Primary actions ─────────────────────────────────────── */}
      <div className="px-2 pt-1">
        <button
          onClick={handleNewSession}
          className={`${navRow} text-cc-fg hover:bg-cc-hover`}
          title="New Session"
        >
          <span className="w-5 h-5 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
              <path d="M13.5 3.5l3 3L8 15H5v-3l8.5-8.5z" strokeLinejoin="round" />
              <path d="M11.5 5.5l3 3" />
            </svg>
          </span>
          New session
        </button>

        <div role="search">
          <button
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setSearchQuery("");
              else requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            className={`${navRow} ${searchOpen ? "text-cc-fg" : "text-cc-fg/80 hover:text-cc-fg"} hover:bg-cc-hover`}
            aria-expanded={searchOpen}
          >
            <span className="w-5 h-5 flex items-center justify-center shrink-0">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
                <circle cx="9" cy="9" r="5.5" />
                <path d="M13.5 13.5L17 17" strokeLinecap="round" />
              </svg>
            </span>
            <span className="flex-1 text-left">Search sessions</span>
            <kbd className="text-[11px] text-cc-muted font-sans-ui select-none">⌘K</kbd>
          </button>
          {searchOpen && (
            <div className="relative mt-1 mb-1 px-1">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchOpen(false);
                  }
                }}
                className="w-full h-8 px-3 pr-7 text-[13px] rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-fg/30 transition-colors"
                aria-label="Search sessions"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-cc-muted hover:text-cc-fg cursor-pointer"
                  aria-label="Clear search"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="my-2 mx-2 h-px bg-cc-border/70" />

        {/* Expandable groups, like ChatGPT's "Projects" */}
        {renderNavSection("Tools", NAV_TOOLS)}
        {renderNavSection("Data", NAV_DATA)}
        {renderNavSection("Config", NAV_CONFIG)}
      </div>

      {/* ── Sessions ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 pt-3 pb-2">
        {confirmArchiveId && (
          <div className="mx-1 mb-2 p-3 rounded-xl bg-cc-card border border-cc-border shadow-panel">
            <p className="text-[13px] text-cc-fg leading-snug">
              Archiving will <strong>delete the worktree</strong> and any uncommitted changes.
            </p>
            <div className="flex gap-2 mt-2.5">
              <button
                onClick={cancelArchive}
                className="px-3 h-8 text-[13px] font-medium rounded-full border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmArchive}
                className="px-3 h-8 text-[13px] font-medium rounded-full bg-cc-error text-white hover:opacity-90 transition-opacity cursor-pointer"
              >
                Archive
              </button>
            </div>
          </div>
        )}

        <div className="px-2 pb-1 flex items-center justify-between">
          <span className="text-[12px] font-medium text-cc-muted">Sessions</span>
          {totalSessionCount > 0 && (
            <span className="text-[12px] text-cc-muted tabular-nums">{totalSessionCount}</span>
          )}
        </div>

        {activeSessions.length === 0 && archivedSessions.length === 0 ? (
          <div className="px-2 py-6">
            <p className="text-[13px] text-cc-muted leading-relaxed">
              No sessions yet. Start one with <strong className="font-medium text-cc-fg">New session</strong>.
            </p>
          </div>
        ) : (
          <>
            {/* ── User-defined folders (collapsible) ─────────────── */}
            {filteredFolderSessions.map(({ folder, sessions: fSessions }) => {
              const isCollapsed = collapsedFolders.has(folder.id);
              return (
                <div key={folder.id} className="mb-1">
                  <div className="flex items-center group">
                    <button
                      onClick={() => toggleFolderCollapse(folder.id)}
                      className="flex-1 flex items-center gap-1.5 rounded-lg px-2 h-7 text-[12px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className={`w-2.5 h-2.5 transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
                      >
                        <path d="M6 3l5 5-5 5V3z" />
                      </svg>
                      <span className="truncate">{folder.name}</span>
                      <span className="ml-auto tabular-nums">{fSessions.length}</span>
                    </button>
                    <button
                      onClick={() => handleDeleteFolder(folder.id)}
                      className="opacity-0 group-hover:opacity-100 px-1 rounded-md text-cc-muted hover:text-cc-error transition-all cursor-pointer"
                      title="Delete folder"
                    >
                      <svg viewBox="0 0 16 16" className="w-3 h-3">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                      </svg>
                    </button>
                  </div>
                  {!isCollapsed &&
                    fSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={s.id === currentSessionId}
                        sessionName={sessionNames?.get(s.id)}
                        permCount={pendingPermissions.get(s.id)?.size ?? 0}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        {...sessionItemProps}
                      />
                    ))}
                </div>
              );
            })}

            {/* New folder inline input */}
            {showNewFolder && (
              <div className="flex items-center gap-1 px-2 py-1 mb-1">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                    if (e.key === "Escape") setShowNewFolder(false);
                  }}
                  placeholder="Folder name"
                  className="flex-1 h-7 px-2 text-[13px] rounded-lg border border-cc-border bg-cc-bg text-cc-fg focus:outline-none focus:border-cc-fg/30 transition-colors"
                  autoFocus
                />
                <button
                  onClick={handleCreateFolder}
                  className="text-[13px] text-cc-fg hover:text-cc-muted cursor-pointer px-1"
                >
                  +
                </button>
              </div>
            )}

            {(folders.length > 0 || showNewFolder) && (
              <button
                onClick={() => setShowNewFolder(!showNewFolder)}
                className="w-full flex items-center gap-1.5 px-2 h-7 mb-1 text-[12px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                </svg>
                <span>New folder</span>
              </button>
            )}

            {/* ── Time-grouped sessions (truncated) ──────────────── */}
            {(shouldTruncate ? truncatedTimeGrouped : timeGrouped).map(({ label, sessions: groupSessions }, gi) => (
              <div key={label} className={gi === 0 && filteredFolderSessions.length === 0 ? "" : "mt-3"}>
                <div className="px-2 pb-1">
                  <span className="text-[12px] font-medium text-cc-muted">{label}</span>
                </div>
                {groupSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={s.id === currentSessionId}
                    sessionName={sessionNames?.get(s.id)}
                    permCount={pendingPermissions.get(s.id)?.size ?? 0}
                    isRecentlyRenamed={recentlyRenamed.has(s.id)}
                    {...sessionItemProps}
                  />
                ))}
              </div>
            ))}

            {/* Show more / Show less toggle */}
            {totalSessionCount > INITIAL_SESSIONS_SHOWN && !searchQuery && (
              <button
                onClick={() => setSessionsExpanded(!sessionsExpanded)}
                className="w-full flex items-center gap-2.5 px-2.5 h-8 mt-1 rounded-lg text-[13px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${sessionsExpanded ? "rotate-180" : ""}`}
                >
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {sessionsExpanded
                  ? "Show less"
                  : `Show ${totalSessionCount - INITIAL_SESSIONS_SHOWN} more`}
              </button>
            )}

            {searchQuery && filteredActiveSessions.length === 0 && (
              <p className="px-2 py-4 text-[13px] text-cc-muted">
                No sessions matching "{searchQuery}"
              </p>
            )}

            {/* ── Archived sessions (collapsible) ────────────────── */}
            {archivedSessions.length > 0 && (
              <div className="mt-3">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className="w-full flex items-center gap-1.5 rounded-lg px-2 h-7 text-[12px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-2.5 h-2.5 transition-transform duration-150 ${showArchived ? "rotate-90" : ""}`}
                  >
                    <path d="M6 3l5 5-5 5V3z" />
                  </svg>
                  Archived
                  <span className="ml-auto tabular-nums">{archivedSessions.length}</span>
                </button>
                {showArchived && (
                  <div className="mt-0.5">
                    {archivedSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        isArchived
                        sessionName={sessionNames.get(s.id)}
                        permCount={pendingPermissions.get(s.id)?.size ?? 0}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        {...sessionItemProps}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Footer: account-style row → Settings ─────────────────── */}
      <div className="px-2 py-2 border-t border-cc-border/60">
        <button
          onClick={() => {
            if (hash === "#/settings") {
              window.location.hash = "";
            } else {
              navigateTo("#/settings");
            }
          }}
          className={`w-full flex items-center gap-2.5 rounded-lg px-2 h-11 text-left transition-colors duration-120 cursor-pointer ${
            hash === "#/settings" ? "bg-cc-active" : "hover:bg-cc-hover"
          }`}
          aria-current={hash === "#/settings" ? "page" : undefined}
        >
          <span className="w-7 h-7 rounded-full bg-cc-fg text-cc-bg flex items-center justify-center text-[12px] font-semibold shrink-0">
            C
          </span>
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="text-[13px] font-medium text-cc-fg truncate">Switchyard</span>
            <span className="text-[12px] text-cc-muted">Settings</span>
          </span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 text-cc-muted ml-auto shrink-0">
            <circle cx="10" cy="10" r="2.5" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
