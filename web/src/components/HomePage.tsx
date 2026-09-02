import { useState, useRef, useEffect, useMemo } from "react";
import { useStore } from "../store.js";
import { api, type SwitchyardEnv, type GitRepoInfo, type GitBranchInfo, type BackendInfo } from "../api.js";
import { connectSession, waitForConnection, sendToSession, disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";
import { getModelsForBackend, getModesForBackend, getDefaultModel, getDefaultMode } from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { EnvManager } from "./EnvManager.js";
import { LinearSection } from "./LinearSection.js";
import { FolderPicker } from "./FolderPicker.js";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let idCounter = 0;



export function HomePage() {
  const [text, setText] = useState("");
  const [backend, setBackend] = useState<BackendType>(() =>
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  );
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [model, setModel] = useState(() => getDefaultModel(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [mode, setMode] = useState(() => getDefaultMode(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [cwd, setCwd] = useState(() => getRecentDirs()[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [codexInternetAccess, setCodexInternetAccess] = useState(() =>
    localStorage.getItem("cc-codex-internet-access") === "1",
  );
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<"low" | "medium" | "high">(() =>
    (localStorage.getItem("cc-codex-reasoning-effort") as "low" | "medium" | "high") || "medium",
  );

  const MODELS = getModelsForBackend(backend);
  const MODES = getModesForBackend(backend);

  // Environment state
  const [envs, setEnvs] = useState<SwitchyardEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => localStorage.getItem("cc-selected-env") || "");
  const [showEnvManager, setShowEnvManager] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Options disclosure
  const [showOptions, setShowOptions] = useState(false);

  // Folder picker
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Worktree state
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);

  // Branch freshness check state
  const [pullPrompt, setPullPrompt] = useState<{ behind: number; branchName: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");


  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  // Dynamic slash commands — fetched from CLI (server handles session lookup or temp spin-up)
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const slashFetched = useRef(false);
  useEffect(() => {
    if (slashFetched.current) return;
    slashFetched.current = true;
    api.getSlashCommands().then((r) => {
      if (r.commands.length > 0) setSlashCommands(r.commands);
    }).catch(() => {});
  }, []);

  const slashFiltered = useMemo(() => {
    if (!slashOpen) return [];
    const match = text.match(/^\/(\S*)$/);
    if (!match) return [];
    const q = match[1].toLowerCase();
    if (q === "") return slashCommands;
    return slashCommands.filter((c) => c.toLowerCase().includes(q));
  }, [text, slashOpen, slashCommands]);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const currentSessionId = useStore((s) => s.currentSessionId);

  // Auto-focus textarea (desktop only -- on mobile it triggers the keyboard immediately)
  useEffect(() => {
    const isDesktop = globalThis.matchMedia("(min-width: 640px)").matches;
    if (isDesktop) {
      textareaRef.current?.focus();
    }
  }, []);

  // Load server home/cwd and available backends on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    api.getBackends().then(setBackends).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When backend changes, reset model and mode to defaults
  function switchBackend(newBackend: BackendType) {
    setBackend(newBackend);
    localStorage.setItem("cc-backend", newBackend);
    setModel(getDefaultModel(newBackend));
    setMode(getDefaultMode(newBackend));
  }

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Detect git repo when cwd changes
  useEffect(() => {
    if (!cwd) {
      setGitRepoInfo(null);
      return;
    }
    api.getRepoInfo(cwd).then((info) => {
      setGitRepoInfo(info);
      setUseWorktree(false);
      setWorktreeBranch(info.currentBranch);
      setIsNewBranch(false);
      api.listBranches(info.repoRoot).then(setBranches).catch(() => setBranches([]));
    }).catch(() => {
      setGitRepoInfo(null);
    });
  }, [cwd]);

  // Fetch branches when git repo changes
  useEffect(() => {
    if (gitRepoInfo) {
      api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
    }
  }, [gitRepoInfo]);


  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
    // Open slash menu if text starts with /
    setSlashOpen(val.match(/^\/\S*$/) !== null);
    setSlashIndex(0);
  }

  function selectSlashCommand(cmd: string) {
    setText(`/${cmd} `);
    setSlashOpen(false);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Slash menu keyboard navigation
    if (slashOpen && slashFiltered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSlashCommand(slashFiltered[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const currentModes = getModesForBackend(backend);
      const currentIndex = currentModes.findIndex((m) => m.value === mode);
      const nextIndex = (currentIndex + 1) % currentModes.length;
      setMode(currentModes[nextIndex].value);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg || sending) return;

    setSending(true);
    setError("");
    setPullError("");

    // Branch freshness check: warn if behind remote
    // Only offer pull when the effective branch is the currently checked-out branch,
    // since git pull operates on the checked-out branch
    if (gitRepoInfo) {
      const effectiveBranch = useWorktree ? worktreeBranch : gitRepoInfo.currentBranch;
      if (effectiveBranch && effectiveBranch === gitRepoInfo.currentBranch) {
        const branchInfo = branches.find(b => b.name === effectiveBranch && !b.isRemote);
        if (branchInfo && branchInfo.behind > 0) {
          setPullPrompt({ behind: branchInfo.behind, branchName: effectiveBranch });
          return; // Pause -- user must choose pull/skip/cancel
        }
      }
    }

    await doCreateSession(msg);
  }

  async function doCreateSession(msg: string) {
    if (!msg) {
      setSending(false);
      return;
    }

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      const branchName = worktreeBranch.trim() || undefined;
      const baseOpts = {
        ...(backend === "codex" ? {} : { model }),
        permissionMode: mode,
        cwd: cwd || undefined,
        envSlug: selectedEnv || undefined,
        branch: branchName,
        createBranch: branchName && isNewBranch ? true : undefined,
        useWorktree: useWorktree || undefined,
        backend,
        codexInternetAccess: backend === "codex" ? codexInternetAccess : undefined,
        codexReasoningEffort: backend === "codex" ? codexReasoningEffort : undefined,
      };

      const result = await api.createSession(baseOpts);
      const sessionId = result.sessionId;

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (cwd) addRecentDir(cwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session
      setCurrentSession(sessionId);
      connectSession(sessionId);

      // Wait for WebSocket connection
      await waitForConnection(sessionId);

      // Send message
      sendToSession(sessionId, {
        type: "user_message",
        content: msg,
        session_id: sessionId,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      });

      // Add user message to store
      useStore.getState().appendMessage(sessionId, {
        id: `user-${Date.now()}-${++idCounter}`,
        role: "user",
        content: msg,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
        timestamp: Date.now(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSending(false);
    }
  }

  async function handlePullAndContinue() {
    if (!pullPrompt) return;
    setPulling(true);
    setPullError("");

    try {
      const pullCwd = cwd || gitRepoInfo?.repoRoot;
      if (!pullCwd) throw new Error("No working directory");

      const result = await api.gitPull(pullCwd);
      if (!result.success) {
        setPullError(result.output || "Pull failed");
        setPulling(false);
        setSending(false);
        return;
      }

      // Refresh branch data after successful pull
      if (gitRepoInfo) {
        api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => {});
      }

      setPullPrompt(null);
      setPulling(false);
      await doCreateSession(text.trim());
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : "Unknown error");
      setPulling(false);
    }
  }

  function handleSkipPull() {
    const msg = text.trim();
    setPullPrompt(null);
    setPullError("");
    doCreateSession(msg);
  }

  function handleCancelPull() {
    setPullPrompt(null);
    setPullError("");
    setSending(false);
  }

  const canSend = text.trim().length > 0 && !sending;

  const chip =
    "flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] transition-colors duration-120 cursor-pointer select-none";

  return (
    <div className="flex-1 h-full flex items-start justify-center px-3 sm:px-4 pt-[14vh] sm:pt-[22vh] overflow-y-auto">
      <div className="w-full max-w-[720px]">
        {/* Greeting */}
        <h1 className="text-[28px] font-medium text-cc-fg text-center tracking-[-0.01em] text-balance mb-6">
          What are you working on?
        </h1>

        {/* Linear Integration (only shown when connected + git repo detected) */}
        {gitRepoInfo && (
          <div className="mb-4">
            <LinearSection
              cwd={cwd}
              repoRoot={gitRepoInfo.repoRoot}
              onBranchFromIssue={(branch) => {
                setWorktreeBranch(branch);
                setIsNewBranch(true);
                setUseWorktree(true);
              }}
            />
          </div>
        )}

        {/* Composer pill (design.md §6 Home) */}
        <div className="relative bg-cc-card rounded-[28px] shadow-composer">
          {/* Image thumbnails */}
          {images.length > 0 && (
            <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
              {images.map((img, imgIdx) => (
                <div key={img.name} className="relative group">
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt={img.name}
                    className="w-14 h-14 rounded-xl object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                  />
                  <button
                    onClick={() => removeImage(imgIdx)}
                    aria-label={`Remove ${img.name}`}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-fg text-cc-bg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-panel"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
            aria-label="Upload images"
          />

          {/* Slash command autocomplete */}
          {slashOpen && slashFiltered.length > 0 && (
            <ul className="absolute left-0 right-0 bottom-full mb-2 max-h-56 overflow-y-auto rounded-2xl bg-cc-card shadow-float p-1 list-none m-0 z-20 animate-slide-up" aria-label="Slash commands">
              {slashFiltered.map((cmd, i) => (
                <li key={cmd}>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); selectSlashCommand(cmd); }}
                    aria-pressed={i === slashIndex}
                    className={`w-full text-left px-3 h-9 rounded-xl text-[13.5px] font-mono-code cursor-pointer transition-colors ${
                      i === slashIndex ? "bg-cc-hover text-cc-fg" : "text-cc-fg hover:bg-cc-hover"
                    }`}
                  >
                    /{cmd}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Describe a task…"
            rows={2}
            aria-label="Task description"
            className="w-full px-5 pt-4 pb-1 text-[15px] bg-transparent resize-none focus:outline-none text-cc-fg placeholder:text-cc-muted"
            style={{ minHeight: "64px", maxHeight: "300px" }}
          />

          {/* Bottom bar */}
          <div className="flex items-center gap-1 pl-2.5 pr-2.5 pb-2.5 pt-1 flex-wrap">
            {/* Attach */}
            <button
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload image"
              className="flex items-center justify-center w-8 h-8 rounded-full text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-5 h-5">
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
            </button>

            {/* Working directory chip */}
            <button
              id="cwd-picker"
              onClick={() => setShowFolderPicker(true)}
              className={`${chip} h-7 text-cc-fg hover:bg-cc-hover max-w-[220px]`}
              title={cwd || "Select folder"}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-muted shrink-0">
                <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{dirLabel}</span>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 text-cc-muted shrink-0">
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showFolderPicker && (
              <FolderPicker
                initialPath={cwd || ""}
                onSelect={(path) => { setCwd(path); }}
                onClose={() => setShowFolderPicker(false)}
              />
            )}

            {/* Branch summary chip (read-only; full picker in Options) */}
            {gitRepoInfo && (
              <span className={`${chip} h-7 text-cc-muted cursor-default hidden sm:flex`} title="Branch — change under Options">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 opacity-70">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate max-w-[140px]">{worktreeBranch || gitRepoInfo.currentBranch}</span>
                {useWorktree && <span className="text-[10px] border border-cc-border px-1 rounded leading-[14px]">wt</span>}
              </span>
            )}

            {/* Options toggle */}
            <button
              onClick={() => setShowOptions(!showOptions)}
              aria-expanded={showOptions}
              aria-controls="options-panel"
              className={`${chip} h-7 ${showOptions ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:bg-cc-hover hover:text-cc-fg"}`}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
                <circle cx="7" cy="6" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="13" cy="10" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              Options
            </button>

            <div className="flex-1" />

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-120 ${
                canSend
                  ? "bg-cc-primary hover:bg-cc-primary-hover text-cc-bg cursor-pointer"
                  : "bg-cc-fg/15 text-cc-bg cursor-not-allowed"
              }`}
            >
              {sending ? (
                <span className="w-4 h-4 border-2 border-cc-bg/30 border-t-cc-bg rounded-full animate-spin" />
              ) : (
                <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4">
                  <path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Backend chips — like ChatGPT's suggestion chips under the composer */}
        {backends.length > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4 flex-wrap" role="radiogroup" aria-label="Backend">
            {backends.map((b) => {
              const selected = backend === b.id;
              return (
                <button
                  key={b.id}
                  onClick={() => b.available && switchBackend(b.id as BackendType)}
                  disabled={!b.available}
                  role="radio"
                  aria-checked={selected}
                  title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                  className={`${chip} border ${
                    !b.available
                      ? "border-transparent text-cc-muted/40 cursor-not-allowed"
                      : selected
                      ? "border-cc-fg bg-cc-fg text-cc-bg"
                      : "border-cc-border text-cc-fg hover:bg-cc-hover"
                  }`}
                >
                  {b.name}
                </button>
              );
            })}
          </div>
        )}

        {/* Options panel (collapsed by default) */}
        {showOptions && (
          <div id="options-panel" className="mt-4 p-4 bg-cc-card rounded-2xl border border-cc-border">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {backend === "codex" ? (
                <div>
                  <div className="block text-[12px] font-medium text-cc-muted mb-1.5">Model</div>
                  <div className="w-full h-9 px-3 flex items-center text-[13px] bg-cc-bg border border-cc-border rounded-lg text-cc-muted">
                    Codex default
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="model-select">Model</label>
                  <select
                    id="model-select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full h-9 px-3 text-[13px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-fg/40 cursor-pointer"
                  >
                    {MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Mode selector */}
              <div>
                <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="mode-select">Permission mode</label>
                <select
                  id="mode-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="w-full h-9 px-3 text-[13px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-fg/40 cursor-pointer"
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* Environment selector */}
              <div>
                <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="env-select">Environment</label>
                <div className="flex gap-1">
                  <select
                    id="env-select"
                    value={selectedEnv}
                    onChange={(e) => {
                      setSelectedEnv(e.target.value);
                      localStorage.setItem("cc-selected-env", e.target.value);
                    }}
                    onFocus={() => { api.listEnvs().then(setEnvs).catch(() => {}); }}
                    className="flex-1 min-w-0 h-9 px-3 text-[13px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-fg/40 cursor-pointer"
                  >
                    <option value="">No environment</option>
                    {envs.map((env) => (
                      <option key={env.slug} value={env.slug}>{env.name} ({Object.keys(env.variables).length} vars)</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setShowEnvManager(true)}
                    aria-label="Manage environments"
                    className="h-9 px-3 text-[13px] text-cc-muted hover:text-cc-fg bg-cc-bg border border-cc-border rounded-lg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                      <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z" />
                      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.843 1.843 0 01-2.739 1.049c-1.547-.966-3.317.803-2.35 2.35a1.843 1.843 0 01-1.049 2.74c-1.79.526-1.79 3.064 0 3.59a1.843 1.843 0 011.049 2.74c-.966 1.547.803 3.317 2.35 2.35a1.843 1.843 0 012.74 1.049c.526 1.79 3.064 1.79 3.59 0a1.843 1.843 0 012.74-1.049c1.547.966 3.317-.803 2.35-2.35a1.843 1.843 0 011.049-2.74c1.79-.526 1.79-3.064 0-3.59a1.843 1.843 0 01-1.049-2.74c.966-1.547-.803-3.317-2.35-2.35a1.843 1.843 0 01-2.74-1.049zM8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492z" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Branch picker */}
              {gitRepoInfo && (
                <div className="relative" ref={branchDropdownRef}>
                  <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="branch-picker">Branch</label>
                  <button
                    id="branch-picker"
                    onClick={() => {
                      if (!showBranchDropdown && gitRepoInfo) {
                        api.gitFetch(gitRepoInfo.repoRoot)
                          .catch(() => {})
                          .finally(() => {
                            api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
                          });
                      }
                      setShowBranchDropdown(!showBranchDropdown);
                      setBranchFilter("");
                    }}
                    className="w-full h-9 flex items-center gap-1.5 px-3 text-[13px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer text-left"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted shrink-0">
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    </svg>
                    <span className="truncate font-mono-code">{worktreeBranch || gitRepoInfo.currentBranch}</span>
                  </button>
                  {showBranchDropdown && (
                    <div className="absolute left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-cc-card border border-cc-border rounded-xl shadow-float z-10 overflow-hidden">
                      {/* Search/filter input */}
                      <div className="px-2 py-2 border-b border-cc-border">
                        <input
                          type="text"
                          value={branchFilter}
                          onChange={(e) => setBranchFilter(e.target.value)}
                          placeholder="Filter or create branch..."
                          className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setShowBranchDropdown(false);
                            }
                          }}
                        />
                      </div>
                      {/* Branch list */}
                      <div className="max-h-[240px] overflow-y-auto py-1">
                        {(() => {
                          const filter = branchFilter.toLowerCase().trim();
                          const localBranches = branches.filter((b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                          const remoteBranches = branches.filter((b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                          const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                          const hasResults = localBranches.length > 0 || remoteBranches.length > 0;

                          return (
                            <>
                              {/* Local branches */}
                              {localBranches.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">Local</div>
                                  {localBranches.map((b) => (
                                    <button
                                      key={b.name}
                                      onClick={() => {
                                        setWorktreeBranch(b.name);
                                        setIsNewBranch(false);
                                        setShowBranchDropdown(false);
                                      }}
                                      className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                        b.name === worktreeBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                      }`}
                                    >
                                      <span className="truncate font-mono-code">{b.name}</span>
                                      <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                        {b.ahead > 0 && (
                                          <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>
                                        )}
                                        {b.behind > 0 && (
                                          <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>
                                        )}
                                        {b.isCurrent && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">current</span>
                                        )}
                                        {b.worktreePath && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">wt</span>
                                        )}
                                      </span>
                                    </button>
                                  ))}
                                </>
                              )}
                              {/* Remote branches */}
                              {remoteBranches.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">Remote</div>
                                  {remoteBranches.map((b) => (
                                    <button
                                      key={`remote-${b.name}`}
                                      onClick={() => {
                                        setWorktreeBranch(b.name);
                                        setIsNewBranch(false);
                                        setShowBranchDropdown(false);
                                      }}
                                      className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                        b.name === worktreeBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                      }`}
                                    >
                                      <span className="truncate font-mono-code">{b.name}</span>
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">remote</span>
                                    </button>
                                  ))}
                                </>
                              )}
                              {/* No results */}
                              {!hasResults && filter && (
                                <div className="px-3 py-2 text-xs text-cc-muted text-center">No matching branches</div>
                              )}
                              {/* Create new branch option */}
                              {filter && !exactMatch && (
                                <div className="border-t border-cc-border mt-1 pt-1">
                                  <button
                                    onClick={() => {
                                      setWorktreeBranch(branchFilter.trim());
                                      setIsNewBranch(true);
                                      setShowBranchDropdown(false);
                                    }}
                                    className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                                  >
                                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                                      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                                    </svg>
                                    <span>Create <span className="font-mono-code font-medium">{branchFilter.trim()}</span></span>
                                  </button>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Worktree toggle */}
              {gitRepoInfo && (
                <div>
                  <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="worktree-toggle">Worktree</label>
                  <button
                    id="worktree-toggle"
                    onClick={() => setUseWorktree(!useWorktree)}
                    className={`w-full h-9 flex items-center gap-1.5 px-3 text-[13px] rounded-lg border transition-colors cursor-pointer ${
                      useWorktree
                        ? "bg-cc-fg border-cc-fg text-cc-bg font-medium"
                        : "bg-cc-bg border-cc-border text-cc-fg hover:bg-cc-hover"
                    }`}
                    title="Create an isolated worktree for this session"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-70">
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                    </svg>
                    {useWorktree ? "Enabled" : "Disabled"}
                  </button>
                </div>
              )}


              {/* Codex: internet access */}
              {backend === "codex" && (
                <div>
                  <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="internet-toggle">Internet access</label>
                  <button
                    id="internet-toggle"
                    onClick={() => {
                      const next = !codexInternetAccess;
                      setCodexInternetAccess(next);
                      localStorage.setItem("cc-codex-internet-access", next ? "1" : "0");
                    }}
                    className={`w-full h-9 flex items-center gap-1.5 px-3 text-[13px] rounded-lg border transition-colors cursor-pointer ${
                      codexInternetAccess
                        ? "bg-cc-fg border-cc-fg text-cc-bg font-medium"
                        : "bg-cc-bg border-cc-border text-cc-fg hover:bg-cc-hover"
                    }`}
                    title="Allow Codex internet/network access for this session"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-70">
                      <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5c.8 0 1.55.22 2.2.61-.39.54-.72 1.21-.95 1.98H6.75c-.23-.77-.56-1.44-.95-1.98A4.47 4.47 0 018 3.5zm-3.2 1.3c.3.4.57.86.78 1.37H3.83c.24-.53.57-1.01.97-1.37zm-.97 2.87h2.15c.07.44.12.9.12 1.38 0 .48-.05.94-.12 1.38H3.83A4.56 4.56 0 013.5 9c0-.47.12-.92.33-1.33zm2.03 4.08c.39-.54.72-1.21.95-1.98h2.38c.23.77.56 1.44.95 1.98A4.47 4.47 0 018 12.5c-.8 0-1.55-.22-2.2-.61zm4.34-1.37c.07-.44.12-.9.12-1.38 0-.48-.05-.94-.12-1.38h2.15c.21.41.33.86.33 1.33 0 .47-.12.92-.33 1.33H10.2zm1.37-3.58h-1.75c-.21-.51-.48-.97-.78-1.37.4.36.73.84.97 1.37z" />
                    </svg>
                    {codexInternetAccess ? "Enabled" : "Disabled"}
                  </button>
                </div>
              )}

              {/* Codex: reasoning effort */}
              {backend === "codex" && (
                <div>
                  <label className="block text-[12px] font-medium text-cc-muted mb-1.5" htmlFor="reasoning-effort">Reasoning effort</label>
                  <div id="reasoning-effort" className="flex rounded-lg border border-cc-border overflow-hidden">
                    {(["low", "medium", "high"] as const).map((level) => (
                      <button
                        key={level}
                        onClick={() => {
                          setCodexReasoningEffort(level);
                          localStorage.setItem("cc-codex-reasoning-effort", level);
                        }}
                        className={`flex-1 h-8 text-[13px] transition-colors cursor-pointer ${
                          codexReasoningEffort === level
                            ? "bg-cc-fg text-cc-bg font-medium"
                            : "bg-cc-bg text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                        }`}
                      >
                        {level.charAt(0).toUpperCase() + level.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Branch behind remote warning */}
        {pullPrompt && (
          <div className="mt-3 p-4 rounded-2xl bg-cc-card border border-cc-border">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-cc-fg leading-snug">
                  <span className="font-mono-code font-medium">{pullPrompt.branchName}</span> is{" "}
                  <span className="font-semibold text-amber-500">{pullPrompt.behind} commit{pullPrompt.behind === 1 ? "" : "s"} behind</span>{" "}
                  remote. Pull before starting?
                </p>
                {pullError && (
                  <div className="mt-2 px-2 py-1.5 rounded-md bg-cc-error/10 border border-cc-error/20 text-[11px] text-cc-error font-mono-code whitespace-pre-wrap">
                    {pullError}
                  </div>
                )}
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={handleCancelPull}
                    disabled={pulling}
                    className="px-3.5 h-8 text-[13px] font-medium rounded-full border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSkipPull}
                    disabled={pulling}
                    className="px-3.5 h-8 text-[13px] font-medium rounded-full border border-cc-border text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Continue anyway
                  </button>
                  <button
                    onClick={handlePullAndContinue}
                    disabled={pulling}
                    className="px-3.5 h-8 text-[13px] font-medium rounded-full bg-cc-primary text-cc-bg hover:bg-cc-primary-hover transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    {pulling ? (
                      <>
                        <span className="w-3 h-3 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />{" "}
                        Pulling...
                      </>
                    ) : (
                      "Pull and continue"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center gap-2 px-4 py-3 rounded-2xl bg-cc-card border border-cc-error/30">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-cc-error">{error}</p>
          </div>
        )}
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager
          onClose={() => {
            setShowEnvManager(false);
            api.listEnvs().then(setEnvs).catch(() => {});
          }}
        />
      )}

      {/* Container session creation progress overlay */}
      <SessionLaunchOverlay
        onRetry={() => {
          useStore.getState().setCreationError(null);
          useStore.getState().setSessionCreating(false);
          setSending(false);
        }}
        onCancel={() => {
          useStore.getState().setCreationError(null);
          useStore.getState().setSessionCreating(false);
          setSending(false);
        }}
      />
    </div>
  );
}
