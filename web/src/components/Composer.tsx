import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { api } from "../api.js";
import { CLAUDE_MODES, CODEX_MODES } from "../utils/backends.js";
import type { ModeOption } from "../utils/backends.js";
import type { Prompt } from "../types.js";
import { useSpeechToText } from "../hooks/useSpeechToText.js";

let idCounter = 0;
const EMPTY_QUEUE: string[] = [];

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

interface CommandItem {
  name: string;
  type: "command" | "skill";
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuIndex, setAtMenuIndex] = useState(0);
  const [allPrompts, setAllPrompts] = useState<Prompt[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionData = useStore((s) => s.sessions.get(sessionId));
  const previousMode = useStore((s) => s.previousPermissionMode.get(sessionId) || "acceptEdits");

  // Voice input
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setText((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(" ");
      return prev + (needsSpace ? " " : "") + transcript;
    });
    // Auto-resize textarea
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, []);
  const { isSupported: speechSupported, isListening, interimText, toggle: toggleVoice, stop: stopVoice } = useSpeechToText(handleVoiceTranscript);

  const myRole = useStore((s) => s.myRole.get(sessionId) ?? "spectator");
  const isSpectator = myRole === "spectator";
  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = sessionData?.permissionMode || "acceptEdits";
  const isPlan = currentMode === "plan";
  const isCodex = sessionData?.backend_type === "codex";
  const modes: ModeOption[] = isCodex ? CODEX_MODES : CLAUDE_MODES;
  const modeLabel = modes.find((m) => m.value === currentMode)?.label?.toLowerCase() || currentMode;

  // Build command list from session data
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    if (sessionData?.slash_commands) {
      for (const cmd of sessionData.slash_commands) {
        cmds.push({ name: cmd, type: "command" });
      }
    }
    if (sessionData?.skills) {
      for (const skill of sessionData.skills) {
        cmds.push({ name: skill, type: "skill" });
      }
    }
    return cmds;
  }, [sessionData?.slash_commands, sessionData?.skills]);

  // Filter commands based on what the user typed after /
  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen) return [];
    // Extract the slash query: text starts with / and we match the part after /
    const match = text.match(/^\/(\S*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    if (query === "") return allCommands;
    return allCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [text, slashMenuOpen, allCommands]);

  // Open/close menu based on text
  useEffect(() => {
    const shouldOpen = text.startsWith("/") && /^\/\S*$/.test(text) && allCommands.length > 0;
    if (shouldOpen && !slashMenuOpen) {
      setSlashMenuOpen(true);
      setSlashMenuIndex(0);
    } else if (!shouldOpen && slashMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [text, allCommands.length, slashMenuOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, slashMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    const items = menuRef.current.querySelectorAll("[data-cmd-index]");
    const selected = items[slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [slashMenuIndex, slashMenuOpen]);

  const selectCommand = useCallback((cmd: CommandItem) => {
    setText(`/${cmd.name} `);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  }, []);

  // @-mention prompt insertion
  // Extract query after @ in the text (matches last @ followed by word chars)
  const atQuery = useMemo(() => {
    const match = text.match(/@(\w*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const filteredPrompts = useMemo(() => {
    if (!atMenuOpen) return [];
    if (atQuery === null) return [];
    if (atQuery === "") return allPrompts;
    return allPrompts.filter(
      (p) =>
        p.name.toLowerCase().includes(atQuery) ||
        p.content.toLowerCase().includes(atQuery),
    );
  }, [atMenuOpen, atQuery, allPrompts]);

  // Clear cached prompts when session cwd changes
  const sessionCwd = sessionData?.cwd;
  useEffect(() => { setAllPrompts([]); }, [sessionCwd]);

  // Load prompts once when @ is typed; open/close menu
  useEffect(() => {
    const hasAt = atQuery !== null;
    if (hasAt && !atMenuOpen) {
      setAtMenuOpen(true);
      setAtMenuIndex(0);
      api.listPrompts(sessionCwd ? { cwd: sessionCwd } : undefined).then(setAllPrompts).catch(() => {});
    } else if (!hasAt && atMenuOpen) {
      setAtMenuOpen(false);
    }
  }, [atQuery, atMenuOpen, sessionCwd]);

  // Keep @-menu index in bounds
  useEffect(() => {
    if (atMenuIndex >= filteredPrompts.length) {
      setAtMenuIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [filteredPrompts.length, atMenuIndex]);

  const selectPrompt = useCallback((prompt: Prompt) => {
    // Replace the @query with the prompt content
    const newText = text.replace(/@\w*$/, prompt.content);
    setText(newText);
    setAtMenuOpen(false);
    textareaRef.current?.focus();
    // Resize textarea
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [text]);

  function sendMessageDirectly(msg: string, imgs?: ImageAttachment[]) {
    sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      images: imgs && imgs.length > 0 ? imgs.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    useStore.getState().appendMessage(sessionId, {
      id: `user-${Date.now()}-${++idCounter}`,
      role: "user",
      content: msg,
      images: imgs && imgs.length > 0 ? imgs.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      timestamp: Date.now(),
    });
  }

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected || isSpectator) return;

    const sessionSt = useStore.getState().sessionStatus.get(sessionId);
    const agentIsRunning = sessionSt === "running";

    if (agentIsRunning) {
      // Queue the message for later
      useStore.getState().enqueueMessage(sessionId, msg);
      useStore.getState().appendMessage(sessionId, {
        id: `user-queued-${Date.now()}-${++idCounter}`,
        role: "system",
        content: `Queued: "${msg.length > 60 ? msg.slice(0, 60) + "\u2026" : msg}"`,
        timestamp: Date.now(),
      });
    } else {
      sendMessageDirectly(msg, images);
    }

    setText("");
    setImages([]);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    if (isListening) stopVoice();

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // @-mention menu navigation
    if (atMenuOpen && filteredPrompts.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtMenuIndex((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtMenuIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectPrompt(filteredPrompts[atMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectPrompt(filteredPrompts[atMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtMenuOpen(false);
        return;
      }
    }

    // Slash menu navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    // Ctrl+Shift+M or Cmd+Shift+M to toggle voice input
    if (e.key === "m" && e.shiftKey && (e.ctrlKey || e.metaKey) && speechSupported) {
      e.preventDefault();
      toggleVoice();
      return;
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function handleInterrupt() {
    if (isSpectator) return;
    sendToSession(sessionId, { type: "interrupt" });
  }

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

  const [showModeMenu, setShowModeMenu] = useState(false);

  function toggleMode() {
    if (!isConnected || isCodex || isSpectator) return;
    const store = useStore.getState();
    if (!isPlan) {
      store.setPreviousPermissionMode(sessionId, currentMode);
      sendToSession(sessionId, { type: "set_permission_mode", mode: "plan" });
      store.updateSession(sessionId, { permissionMode: "plan" });
    } else {
      const restoreMode = previousMode || "acceptEdits";
      sendToSession(sessionId, { type: "set_permission_mode", mode: restoreMode });
      store.updateSession(sessionId, { permissionMode: restoreMode });
    }
  }

  function switchMode(mode: string) {
    if (!isConnected || isSpectator) return;
    const store = useStore.getState();
    sendToSession(sessionId, { type: "set_permission_mode", mode });
    store.updateSession(sessionId, { permissionMode: mode });
    setShowModeMenu(false);
  }

  const modeDotColors: Record<string, string> = {
    bypassPermissions: "bg-green-400",
    acceptEdits: "bg-blue-400",
    default: "bg-amber-400",
    plan: "bg-purple-400",
  };

  const modeLabels: Record<string, string> = {
    bypassPermissions: "Agent",
    acceptEdits: "Auto-edit",
    default: "Ask",
    plan: "Plan",
  };

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const queuedMessages = useStore((s) => s.messageQueue.get(sessionId)) ?? EMPTY_QUEUE;
  const canSend = text.trim().length > 0 && isConnected && !isSpectator;

  // Auto-send queued messages when agent transitions to idle
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isRunning;

    if (wasRunning && !isRunning && isConnected && !isSpectator) {
      // Agent just became idle -- send next queued message
      const nextMsg = useStore.getState().dequeueMessage(sessionId);
      if (nextMsg) {
        // Small delay to let the UI settle
        setTimeout(() => sendMessageDirectly(nextMsg), 300);
      }
    }
  }, [isRunning, isConnected, isSpectator, sessionId]);

  // Drag & drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    if (newImages.length > 0) {
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  const placeholderText = isSpectator
    ? "Spectators cannot send messages"
    : !isConnected
    ? "Waiting for connection..."
    : isRunning
    ? "Send follow-up (will queue)..."
    : "Send a message... (/ for commands)";

  const roundIcon = (enabled: boolean) =>
    `flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-120 ${
      enabled ? "text-cc-fg hover:bg-cc-hover cursor-pointer" : "text-cc-muted/50 cursor-not-allowed"
    }`;
  const chip =
    "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12.5px] transition-colors duration-120 select-none";

  return (
    <div
      className="shrink-0 px-4 pb-3 pt-1 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-cc-bg/80 border-2 border-dashed border-cc-fg/30 rounded-[28px] backdrop-blur-sm pointer-events-none">
          <div className="flex items-center gap-2 text-cc-fg text-[13px] font-medium">
            Drop images here
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto">
        {/* Queued messages */}
        {queuedMessages.length > 0 && (
          <div className="flex items-center gap-2 mb-2 px-2 text-[12.5px] text-cc-muted">
            <span>{queuedMessages.length} message{queuedMessages.length > 1 ? "s" : ""} queued</span>
            <span className="text-cc-muted/40">·</span>
            <button
              onClick={() => useStore.getState().clearQueue(sessionId)}
              className="hover:text-cc-fg transition-colors cursor-pointer"
            >
              Clear
            </button>
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
        />

        {/* Composer pill (design.md §6 Composer) */}
        <div className="relative bg-cc-card rounded-[28px] shadow-composer overflow-visible">
          {/* @-mention prompt menu */}
          {atMenuOpen && filteredPrompts.length > 0 && (
            <div className="absolute left-0 right-0 bottom-full mb-2 max-h-[260px] overflow-y-auto rounded-2xl bg-cc-card shadow-float z-20 p-1 animate-slide-up">
              {filteredPrompts.map((prompt, i) => (
                <button
                  key={prompt.id}
                  onClick={() => selectPrompt(prompt)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-3 transition-colors cursor-pointer rounded-xl ${
                    i === atMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover"
                  }`}
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-cc-hover text-cc-muted shrink-0 text-[12px] font-semibold">
                    @
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[13.5px] font-medium text-cc-fg">{prompt.name}</span>
                    <span className="ml-2 text-[12px] text-cc-muted capitalize">{prompt.scope}</span>
                    <p className="text-[12px] text-cc-muted truncate mt-0.5">{prompt.content.slice(0, 60)}{prompt.content.length > 60 ? "…" : ""}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Slash command menu */}
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div
              ref={menuRef}
              className="absolute left-0 right-0 bottom-full mb-2 max-h-[260px] overflow-y-auto rounded-2xl bg-cc-card shadow-float z-20 p-1 animate-slide-up"
            >
              {filteredCommands.map((cmd, i) => (
                <button
                  key={`${cmd.type}-${cmd.name}`}
                  data-cmd-index={i}
                  onClick={() => selectCommand(cmd)}
                  className={`w-full px-3 h-9 text-left flex items-center gap-3 transition-colors cursor-pointer rounded-xl ${
                    i === slashMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover"
                  }`}
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-cc-hover text-cc-muted shrink-0">
                    {cmd.type === "skill" ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M5 12L10 4" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                  <div className="flex-1 min-w-0 flex items-center justify-between">
                    <div>
                      <span className="text-[13.5px] font-medium text-cc-fg">/{cmd.name}</span>
                      <span className="ml-2 text-[12px] text-cc-muted">{cmd.type}</span>
                    </div>
                    <span className="text-[11px] text-cc-muted px-1.5 py-0.5 rounded-md bg-cc-hover">
                      {cmd.type === "skill" ? "skill" : "cmd"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Image attachment chips */}
          {images.length > 0 && (
            <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt={img.name}
                    className="w-14 h-14 rounded-xl object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-fg text-cc-bg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-panel"
                    aria-label={`Remove ${img.name}`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="w-2.5 h-2.5">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholderText}
            disabled={!isConnected || isSpectator}
            rows={1}
            className="w-full px-5 pt-4 pb-1 text-[15px] bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted disabled:opacity-50"
            style={{ minHeight: "44px", maxHeight: "200px" }}
          />

          {/* Voice input interim text */}
          {isListening && (
            <div className="flex items-center gap-2 px-5 pb-1 text-[12.5px] text-cc-muted animate-pulse">
              <span className="w-2 h-2 rounded-full bg-cc-error shrink-0" />
              <span>{interimText || "Listening…"}</span>
            </div>
          )}

          {/* Bottom bar */}
          <div className="flex items-center gap-1 pl-2.5 pr-2.5 pb-2.5 pt-1">
            {/* Attach */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected || isSpectator}
              className={roundIcon(isConnected && !isSpectator)}
              title="Attach image"
              aria-label="Attach image"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-5 h-5">
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
            </button>

            {/* Mode chip */}
            <div className="relative">
              <button
                onClick={() => {
                  if (isCodex || isSpectator || !isConnected) return;
                  setShowModeMenu(!showModeMenu);
                }}
                disabled={!isConnected || isCodex || isSpectator}
                className={`${chip} ${
                  !isConnected || isCodex || isSpectator
                    ? "text-cc-muted/60 cursor-not-allowed"
                    : "text-cc-fg hover:bg-cc-hover cursor-pointer"
                }`}
                title={isCodex ? "Mode is fixed for Codex sessions" : "Switch permission mode (Shift+Tab)"}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${modeDotColors[currentMode] || "bg-cc-muted"}`} />
                <span>{modeLabels[currentMode] || modeLabel}</span>
                {!isCodex && (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 text-cc-muted">
                    <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>

              {showModeMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowModeMenu(false)} />
                  <div className="absolute left-0 bottom-full mb-2 w-56 rounded-2xl bg-cc-card shadow-float z-20 p-1 animate-slide-up">
                    {[
                      { value: "bypassPermissions", label: "Agent", desc: "Auto-approve all tools", dot: "bg-green-400" },
                      { value: "acceptEdits", label: "Auto-edit", desc: "Auto-approve file edits", dot: "bg-blue-400" },
                      { value: "default", label: "Ask", desc: "Prompt for each tool", dot: "bg-amber-400" },
                      { value: "plan", label: "Plan", desc: "No tool execution", dot: "bg-purple-400" },
                    ].map((m) => (
                      <button
                        key={m.value}
                        onClick={() => switchMode(m.value)}
                        className="w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2.5 rounded-xl"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] text-cc-fg">{m.label}</div>
                          <div className="text-[12px] text-cc-muted">{m.desc}</div>
                        </div>
                        {currentMode === m.value && (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-cc-fg shrink-0">
                            <path d="M3 8.5l3.5 3.5 6.5-7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Branch chip */}
            {sessionData?.git_branch && (
              <div className={`${chip} text-cc-muted hidden sm:flex`} title={sessionData.git_branch}>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0 opacity-70">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate max-w-[140px]">{sessionData.git_branch}</span>
                {sessionData.is_worktree && (
                  <span className="text-[10px] border border-cc-border px-1 rounded leading-[14px]">wt</span>
                )}
                {((sessionData.git_ahead || 0) > 0 || (sessionData.git_behind || 0) > 0) && (
                  <span className="flex items-center gap-0.5 tabular-nums">
                    {(sessionData.git_ahead || 0) > 0 && <span className="text-cc-success">{sessionData.git_ahead}&#8593;</span>}
                    {(sessionData.git_behind || 0) > 0 && (
                      <button
                        className="text-cc-warning hover:underline cursor-pointer"
                        title="Pull latest changes"
                        onClick={() => {
                          const cwd = sessionData.repo_root || sessionData.cwd;
                          if (!cwd) return;
                          api.gitPull(cwd).then((r) => {
                            useStore.getState().updateSession(sessionId, {
                              git_ahead: r.git_ahead,
                              git_behind: r.git_behind,
                            });
                            if (!r.success) console.warn("[git pull]", r.output);
                          }).catch((e) => console.error("[git pull]", e));
                        }}
                      >
                        {sessionData.git_behind}&#8595;
                      </button>
                    )}
                  </span>
                )}
                {((sessionData.total_lines_added || 0) > 0 || (sessionData.total_lines_removed || 0) > 0) && (
                  <span className="flex items-center gap-1 shrink-0 tabular-nums">
                    <span className="text-cc-success">+{sessionData.total_lines_added || 0}</span>
                    <span className="text-cc-error">-{sessionData.total_lines_removed || 0}</span>
                  </span>
                )}
              </div>
            )}

            <div className="flex-1" />

            {/* Right: mic + send/stop */}
            {speechSupported && (
              <button
                onClick={toggleVoice}
                disabled={!isConnected || isSpectator}
                className={`${roundIcon(isConnected && !isSpectator)} ${isListening ? "text-cc-error" : ""}`}
                title="Voice input (Ctrl+Shift+M)"
                aria-label="Voice input"
                aria-pressed={isListening}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-[18px] h-[18px]">
                  <rect x="7" y="2.5" width="6" height="10" rx="3" />
                  <path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5" strokeLinecap="round" />
                </svg>
              </button>
            )}

            {isRunning ? (
              <button
                onClick={handleInterrupt}
                disabled={isSpectator}
                className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                  isSpectator
                    ? "bg-cc-hover text-cc-muted/50 cursor-not-allowed"
                    : "bg-cc-primary text-cc-bg hover:bg-cc-primary-hover cursor-pointer"
                }`}
                title={isSpectator ? "Spectators cannot interrupt" : "Stop generation"}
                aria-label="Stop generation"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-120 ${
                  canSend
                    ? "bg-cc-primary text-cc-bg hover:bg-cc-primary-hover cursor-pointer"
                    : "bg-cc-fg/15 text-cc-bg cursor-not-allowed"
                }`}
                title="Send message (Enter)"
                aria-label="Send message"
              >
                <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4">
                  <path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-[12px] text-cc-muted mt-2 select-none">
          {isRunning ? "Working… messages sent now are queued." : "Agents can make mistakes. Review changes before you merge."}
        </p>
      </div>
    </div>
  );
}
