import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { api, type CronJobInfo, type CronJobExecution, type SwitchyardEnv } from "../api.js";
import { connectSession } from "../ws.js";
import { getModelsForBackend, getDefaultModel } from "../utils/backends.js";
import { SCHEDULE_PRESETS, describeTrigger, formatRelative } from "../utils/schedule.js";
import { FolderPicker } from "./FolderPicker.js";

/**
 * AutomationsPage — Codex-style automations (docs/roadmap.md #2).
 *
 * An automation is a prompt + project folder + backend with a trigger
 * (schedule, one-shot, or manual). Options: run each execution in a fresh
 * git worktree, open a PR when it finishes with changes, and cap the spend.
 * Finished runs land in the review inbox.
 *
 * Backed by the cron job store (`/api/cron/*`), so existing scheduled tasks
 * show up here unchanged.
 */

type Backend = "claude" | "codex";

export interface AutomationFormData {
  name: string;
  prompt: string;
  cwd: string;
  backendType: Backend;
  model: string;
  trigger: "schedule" | "manual";
  recurring: boolean;
  schedule: string;
  onceAt: string;
  useWorktree: boolean;
  autoPr: boolean;
  budgetUsd: string;
  permissionMode: string;
  envSlug: string;
}

const EMPTY_FORM: AutomationFormData = {
  name: "",
  prompt: "",
  cwd: "",
  backendType: "claude",
  model: getDefaultModel("claude"),
  trigger: "schedule",
  recurring: true,
  schedule: "0 8 * * *",
  onceAt: "",
  useWorktree: true,
  autoPr: false,
  budgetUsd: "",
  permissionMode: "bypassPermissions",
  envSlug: "",
};

const PERMISSION_MODES: Array<{ value: string; label: string }> = [
  { value: "bypassPermissions", label: "Agent · auto-approve everything" },
  { value: "acceptEdits", label: "Auto-edit · approve file edits" },
  { value: "default", label: "Ask · prompt for each tool" },
  { value: "plan", label: "Plan · no tool execution" },
];

function jobToForm(job: CronJobInfo): AutomationFormData {
  const backendType: Backend = job.backendType === "codex" ? "codex" : "claude";
  return {
    name: job.name,
    prompt: job.prompt,
    cwd: job.cwd,
    backendType,
    model: job.model || getDefaultModel(backendType),
    trigger: job.trigger === "manual" ? "manual" : "schedule",
    recurring: job.recurring,
    schedule: job.recurring ? job.schedule : "0 8 * * *",
    onceAt: job.recurring ? "" : toLocalInput(job.schedule),
    useWorktree: !!job.useWorktree,
    autoPr: !!job.autoPr,
    budgetUsd: job.budgetUsd != null ? String(job.budgetUsd) : "",
    permissionMode: job.permissionMode || "bypassPermissions",
    envSlug: job.envSlug || "",
  };
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Translate the form into the API payload. Exported for tests. */
export function formToPayload(form: AutomationFormData): Partial<CronJobInfo> {
  const manual = form.trigger === "manual";
  const budget = form.budgetUsd.trim() === "" ? undefined : Number(form.budgetUsd);
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    cwd: form.cwd.trim(),
    backendType: form.backendType,
    model: form.model,
    trigger: form.trigger,
    recurring: manual ? true : form.recurring,
    schedule: manual ? "" : form.recurring ? form.schedule.trim() : (form.onceAt ? new Date(form.onceAt).toISOString() : ""),
    useWorktree: form.useWorktree,
    autoPr: form.useWorktree && form.autoPr,
    budgetUsd: budget != null && Number.isFinite(budget) && budget > 0 ? budget : undefined,
    permissionMode: form.permissionMode,
    envSlug: form.envSlug || undefined,
    enabled: true,
  };
}

function folderName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

function backendLabel(b: string): string {
  return b === "codex" ? "Codex" : b === "claude" ? "Claude Code" : b;
}

function openSession(sessionId: string) {
  const store = useStore.getState();
  store.closeTerminal();
  store.setCurrentSession(sessionId);
  connectSession(sessionId);
  store.setActiveTab("chat");
  window.location.hash = "";
}

// ─── Styles (design.md) ─────────────────────────────────────────────────────

const pill = "h-8 px-3 rounded-full text-[13px] transition-colors duration-120 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const primaryBtn = `${pill} bg-cc-primary text-cc-bg hover:bg-cc-primary-hover font-medium`;
const outlineBtn = `${pill} border border-cc-border text-cc-fg hover:bg-cc-hover`;
const ghostBtn = `${pill} text-cc-muted hover:text-cc-fg hover:bg-cc-hover`;
const input = "w-full h-9 px-3 text-[13.5px] bg-cc-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-fg/40";
const label = "block text-[12px] font-medium text-cc-muted mb-1.5";

// ─── Rows ───────────────────────────────────────────────────────────────────

function Toggle({ on, onChange, label: aria }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={aria}
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors duration-120 cursor-pointer ${on ? "bg-cc-fg" : "bg-cc-fg/20"}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-cc-bg transition-transform duration-120 ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

function RunRow({ run }: { run: CronJobExecution }) {
  const status = run.completedAt == null
    ? run.error ? "failed" : "running"
    : run.success === false ? "failed" : "done";
  const dot = status === "running" ? "bg-cc-success animate-breathing" : status === "failed" ? "bg-cc-error" : "bg-cc-muted/50";
  return (
    <li className="flex items-center gap-3 py-1.5 text-[12.5px]">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <span className="text-cc-muted tabular-nums w-20 shrink-0">{formatRelative(run.startedAt)}</span>
      <span className="text-cc-fg">
        {status === "running" ? "Running" : status === "failed" ? (run.error || "Failed") : "Finished"}
        {run.budgetExceeded && <span className="text-cc-warning"> · stopped at budget</span>}
      </span>
      {(run.linesAdded || run.linesRemoved) ? (
        <span className="tabular-nums text-cc-muted"><span className="text-cc-success">+{run.linesAdded ?? 0}</span> <span className="text-cc-error">-{run.linesRemoved ?? 0}</span></span>
      ) : null}
      {run.costUsd ? <span className="text-cc-muted tabular-nums">${run.costUsd < 0.01 ? run.costUsd.toFixed(4) : run.costUsd.toFixed(2)}</span> : null}
      {run.branch && <span className="font-mono-code text-cc-muted truncate max-w-[180px]">{run.branch}</span>}
      <span className="flex-1" />
      {run.prUrl && (
        <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="text-cc-link hover:underline">PR</a>
      )}
      {run.sessionId && (
        <button onClick={() => openSession(run.sessionId)} className="text-cc-muted hover:text-cc-fg cursor-pointer">Open session</button>
      )}
    </li>
  );
}

export interface AutomationRowProps {
  job: CronJobInfo;
  onToggle: (job: CronJobInfo) => void;
  onRun: (job: CronJobInfo) => Promise<void>;
  onEdit: (job: CronJobInfo) => void;
  onDelete: (job: CronJobInfo) => void;
  loadRuns?: (job: CronJobInfo) => Promise<CronJobExecution[]>;
}

export function AutomationRow({ job, onToggle, onRun, onEdit, onDelete, loadRuns }: AutomationRowProps) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<CronJobExecution[] | null>(null);
  const [running, setRunning] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!open || !loadRuns) return;
    let active = true;
    loadRuns(job).then((r) => { if (active) setRuns(r.slice().reverse()); }).catch(() => { if (active) setRuns([]); });
    return () => { active = false; };
  }, [open, job, loadRuns]);

  async function handleRun() {
    setRunning(true);
    try {
      await onRun(job);
      setOpen(true);
      setRuns(null);
    } finally {
      setTimeout(() => setRunning(false), 1500);
    }
  }

  const lastFailed = job.consecutiveFailures > 0;
  const statusText = !job.enabled
    ? "Paused"
    : job.trigger === "manual"
    ? job.lastRunAt ? `Ran ${formatRelative(job.lastRunAt)}` : "Never run"
    : job.nextRunAt
    ? `Next ${formatRelative(job.nextRunAt)}`
    : job.lastRunAt ? `Ran ${formatRelative(job.lastRunAt)}` : "Scheduled";

  return (
    <li className="rounded-xl hover:bg-cc-hover transition-colors duration-120" data-automation-id={job.id}>
      <div className="flex items-center gap-3 px-3 sm:px-4 py-3">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} runs for ${job.name}`}
          className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer shrink-0"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`w-3 h-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[14px] font-medium truncate ${job.enabled ? "text-cc-fg" : "text-cc-muted"}`}>{job.name}</span>
            {lastFailed && <span className="text-[12px] text-cc-error shrink-0">{job.consecutiveFailures} failed</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[12.5px] text-cc-muted mt-0.5 flex-wrap">
            <span>{describeTrigger(job)}</span>
            <span className="text-cc-muted/40">·</span>
            <span className="truncate" title={job.cwd}>{folderName(job.cwd)}</span>
            <span className="text-cc-muted/40">·</span>
            <span>{backendLabel(job.backendType)}</span>
            {job.useWorktree && <span className="text-[11px] border border-cc-border px-1.5 rounded-full leading-[18px]">Worktree</span>}
            {job.autoPr && <span className="text-[11px] border border-cc-border px-1.5 rounded-full leading-[18px]">Auto PR</span>}
            {job.budgetUsd != null && job.budgetUsd > 0 && <span className="text-[11px] border border-cc-border px-1.5 rounded-full leading-[18px] tabular-nums">Cap ${job.budgetUsd}</span>}
          </div>
        </div>

        <span className="text-[12.5px] text-cc-muted tabular-nums shrink-0 hidden sm:inline">{statusText}</span>
        <Toggle on={job.enabled} onChange={() => onToggle(job)} label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`} />
        <button onClick={handleRun} disabled={running} className={`${outlineBtn} h-7 shrink-0`}>
          {running ? "Started" : "Run now"}
        </button>
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen(!menuOpen)} aria-label={`More actions for ${job.name}`} className="w-7 h-7 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 bg-cc-card border border-cc-border rounded-xl shadow-float p-1 min-w-[140px] animate-slide-down">
                <button onClick={() => { setMenuOpen(false); onEdit(job); }} className="w-full text-left px-3 h-8 text-[13px] text-cc-fg hover:bg-cc-hover rounded-lg cursor-pointer">Edit</button>
                <button onClick={() => { setMenuOpen(false); onDelete(job); }} className="w-full text-left px-3 h-8 text-[13px] text-cc-error hover:bg-cc-hover rounded-lg cursor-pointer">Delete</button>
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="px-4 sm:px-5 pb-3 ml-9">
          {runs === null ? (
            <p className="text-[12.5px] text-cc-muted py-1.5">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="text-[12.5px] text-cc-muted py-1.5">No runs yet. Use Run now to try it.</p>
          ) : (
            <ul className="divide-y divide-cc-border/60">
              {runs.slice(0, 10).map((r, i) => <RunRow key={`${r.sessionId || i}-${r.startedAt}`} run={r} />)}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Form ───────────────────────────────────────────────────────────────────

export function AutomationForm({
  initial,
  envs,
  title,
  onSubmit,
  onCancel,
}: {
  initial: AutomationFormData;
  envs: SwitchyardEnv[];
  title: string;
  onSubmit: (form: AutomationFormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AutomationFormData>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showFolder, setShowFolder] = useState(false);
  const models = getModelsForBackend(form.backendType);

  function update(patch: Partial<AutomationFormData>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  async function handleSubmit() {
    setError("");
    if (!form.name.trim()) return setError("Give the automation a name.");
    if (!form.prompt.trim()) return setError("Write the prompt the agent should run.");
    if (!form.cwd.trim()) return setError("Pick a project folder.");
    if (form.trigger === "schedule" && form.recurring && !form.schedule.trim()) return setError("Pick a schedule.");
    if (form.trigger === "schedule" && !form.recurring && !form.onceAt) return setError("Pick a date and time.");
    setSaving(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const segment = (active: boolean) =>
    `h-7 px-3 rounded-full text-[13px] transition-colors duration-120 cursor-pointer ${active ? "bg-cc-card text-cc-fg shadow-panel" : "text-cc-muted hover:text-cc-fg"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 bg-black/30" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-xl max-h-full overflow-y-auto bg-cc-card rounded-2xl shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-[17px] font-medium text-cc-fg">{title}</h2>
          <p className="text-[12.5px] text-cc-muted mt-0.5">Runs in the background. Results land in the Inbox.</p>
        </div>

        <div className="px-5 pb-5 space-y-4">
          <div>
            <label className={label} htmlFor="auto-name">Name</label>
            <input id="auto-name" className={input} value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="Nightly test sweep" />
          </div>

          <div>
            <label className={label} htmlFor="auto-prompt">Prompt</label>
            <textarea
              id="auto-prompt"
              className={`${input} h-auto min-h-[120px] py-2 resize-y font-sans-ui leading-[1.5]`}
              value={form.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              placeholder="Run the test suite. Fix any flaky tests you find and leave the rest untouched."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className={label}>Project folder</span>
              <button onClick={() => setShowFolder(true)} className={`${input} flex items-center gap-2 text-left cursor-pointer hover:bg-cc-hover`} aria-label="Pick project folder">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-muted shrink-0">
                  <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" strokeLinejoin="round" />
                </svg>
                <span className={`truncate ${form.cwd ? "" : "text-cc-muted"}`}>{form.cwd ? folderName(form.cwd) : "Choose…"}</span>
              </button>
              {showFolder && (
                <FolderPicker initialPath={form.cwd || ""} onSelect={(path) => update({ cwd: path })} onClose={() => setShowFolder(false)} />
              )}
            </div>
            <div>
              <label className={label} htmlFor="auto-backend">Agent</label>
              <div className="flex gap-2">
                <select
                  id="auto-backend"
                  className={`${input} cursor-pointer`}
                  value={form.backendType}
                  onChange={(e) => {
                    const b = e.target.value as Backend;
                    update({ backendType: b, model: getDefaultModel(b) });
                  }}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                {form.backendType === "claude" && (
                  <select id="auto-model" aria-label="Model" className={`${input} cursor-pointer`} value={form.model} onChange={(e) => update({ model: e.target.value })}>
                    {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                )}
              </div>
            </div>
          </div>

          <div>
            <span className={label}>Trigger</span>
            <div className="flex items-center gap-1 bg-cc-hover rounded-full p-0.5 w-fit">
              <button className={segment(form.trigger === "schedule" && form.recurring)} onClick={() => update({ trigger: "schedule", recurring: true })} aria-pressed={form.trigger === "schedule" && form.recurring}>Schedule</button>
              <button className={segment(form.trigger === "schedule" && !form.recurring)} onClick={() => update({ trigger: "schedule", recurring: false })} aria-pressed={form.trigger === "schedule" && !form.recurring}>Once</button>
              <button className={segment(form.trigger === "manual")} onClick={() => update({ trigger: "manual" })} aria-pressed={form.trigger === "manual"}>Manual</button>
            </div>
            {form.trigger === "schedule" && form.recurring && (
              <div className="mt-2.5">
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => update({ schedule: p.value })}
                      className={`h-7 px-2.5 rounded-full text-[12.5px] border transition-colors duration-120 cursor-pointer ${form.schedule === p.value ? "border-cc-fg bg-cc-fg text-cc-bg" : "border-cc-border text-cc-fg hover:bg-cc-hover"}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input aria-label="Cron expression" className={`${input} font-mono-code`} value={form.schedule} onChange={(e) => update({ schedule: e.target.value })} placeholder="0 8 * * *" />
              </div>
            )}
            {form.trigger === "schedule" && !form.recurring && (
              <input type="datetime-local" aria-label="Run at" className={`${input} mt-2.5`} value={form.onceAt} onChange={(e) => update({ onceAt: e.target.value })} />
            )}
            {form.trigger === "manual" && (
              <p className="text-[12.5px] text-cc-muted mt-2">Runs only when you press Run now or call the API.</p>
            )}
          </div>

          <div className="space-y-2.5">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-cc-fg" checked={form.useWorktree} onChange={(e) => update({ useWorktree: e.target.checked, autoPr: e.target.checked ? form.autoPr : false })} />
              <span className="text-[13.5px] text-cc-fg">Run in a fresh worktree<span className="block text-[12px] text-cc-muted">Each run gets its own branch, so it never touches your checkout.</span></span>
            </label>
            <label className={`flex items-start gap-2.5 ${form.useWorktree ? "cursor-pointer" : "opacity-50"}`}>
              <input type="checkbox" className="mt-0.5 accent-cc-fg" checked={form.autoPr} disabled={!form.useWorktree} onChange={(e) => update({ autoPr: e.target.checked })} />
              <span className="text-[13.5px] text-cc-fg">Open a pull request when done<span className="block text-[12px] text-cc-muted">Pushes the branch and opens a PR with gh if the run changed files.</span></span>
            </label>
            <div className="flex items-center gap-3">
              <label className="text-[13.5px] text-cc-fg shrink-0 whitespace-nowrap" htmlFor="auto-budget">Budget cap</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-cc-muted">$</span>
                <input id="auto-budget" type="number" min="0" step="0.5" className={`${input} w-28 pl-6`} value={form.budgetUsd} onChange={(e) => update({ budgetUsd: e.target.value })} placeholder="none" />
              </div>
              <span className="text-[12px] text-cc-muted">Interrupts the run once it costs more than this.</span>
            </div>
          </div>

          <details className="group">
            <summary className="text-[13px] text-cc-muted hover:text-cc-fg cursor-pointer select-none">Advanced</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <div>
                <label className={label} htmlFor="auto-mode">Permission mode</label>
                <select id="auto-mode" className={`${input} cursor-pointer`} value={form.permissionMode} onChange={(e) => update({ permissionMode: e.target.value })}>
                  {PERMISSION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="auto-env">Environment</label>
                <select id="auto-env" className={`${input} cursor-pointer`} value={form.envSlug} onChange={(e) => update({ envSlug: e.target.value })}>
                  <option value="">None</option>
                  {envs.map((env) => <option key={env.slug} value={env.slug}>{env.name}</option>)}
                </select>
              </div>
            </div>
          </details>

          {error && <p className="text-[13px] text-cc-error">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onCancel} className={ghostBtn}>Cancel</button>
            <button onClick={handleSubmit} disabled={saving} className={primaryBtn}>{saving ? "Saving…" : "Save automation"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function AutomationsPage({ embedded }: { embedded?: boolean }) {
  const [jobs, setJobs] = useState<CronJobInfo[]>([]);
  const [envs, setEnvs] = useState<SwitchyardEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CronJobInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CronJobInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listCronJobs());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.listEnvs().then(setEnvs).catch(() => {});
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const sorted = useMemo(
    () => jobs.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    [jobs],
  );

  const handleToggle = useCallback(async (job: CronJobInfo) => {
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, enabled: !j.enabled } : j)));
    try {
      await api.toggleCronJob(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
    refresh();
  }, [refresh]);

  const handleRun = useCallback(async (job: CronJobInfo) => {
    try {
      await api.runCronJob(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
    setTimeout(refresh, 1500);
  }, [refresh]);

  const handleDelete = useCallback(async (job: CronJobInfo) => {
    setConfirmDelete(null);
    try {
      await api.deleteCronJob(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
    refresh();
  }, [refresh]);

  const loadRuns = useCallback((job: CronJobInfo) => api.getCronJobExecutions(job.id), []);

  async function handleCreate(form: AutomationFormData) {
    await api.createCronJob(formToPayload(form));
    setCreating(false);
    refresh();
  }

  async function handleEdit(form: AutomationFormData) {
    if (!editing) return;
    await api.updateCronJob(editing.id, formToPayload(form));
    setEditing(null);
    refresh();
  }

  return (
    <div className={embedded ? "px-4 sm:px-6 py-6 max-w-3xl mx-auto" : "p-6 max-w-3xl mx-auto"}>
      <div className="flex items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-[22px] font-medium text-cc-fg tracking-[-0.01em]">Automations</h1>
          <p className="text-[13px] text-cc-muted mt-0.5">
            Prompts that run on a schedule or on demand, in their own worktree. Results land in the{" "}
            <a href="#/inbox" className="text-cc-link hover:underline">Inbox</a>.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className={primaryBtn}>New automation</button>
      </div>

      {error && <p className="text-[13px] text-cc-error mb-3">{error}</p>}

      {loading ? (
        <p className="text-[13px] text-cc-muted px-4 py-10 text-center">Loading…</p>
      ) : sorted.length === 0 ? (
        <div className="px-4 py-14 text-center rounded-2xl border border-dashed border-cc-border">
          <p className="text-[15px] font-medium text-cc-fg">No automations yet</p>
          <p className="text-[13px] text-cc-muted mt-1 max-w-sm mx-auto text-pretty">
            Try a nightly test sweep, a weekly dependency bump, or a morning summary of open PRs. Each run is a normal session you can open and review.
          </p>
          <button onClick={() => setCreating(true)} className={`${outlineBtn} mt-4`}>Create your first automation</button>
        </div>
      ) : (
        <ul className="divide-y divide-cc-border/60 -mx-1">
          {sorted.map((job) => (
            <AutomationRow
              key={job.id}
              job={job}
              onToggle={handleToggle}
              onRun={handleRun}
              onEdit={setEditing}
              onDelete={setConfirmDelete}
              loadRuns={loadRuns}
            />
          ))}
        </ul>
      )}

      {creating && (
        <AutomationForm initial={EMPTY_FORM} envs={envs} title="New automation" onSubmit={handleCreate} onCancel={() => setCreating(false)} />
      )}
      {editing && (
        <AutomationForm initial={jobToForm(editing)} envs={envs} title={`Edit ${editing.name}`} onSubmit={handleEdit} onCancel={() => setEditing(null)} />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30" onClick={() => setConfirmDelete(null)} role="dialog" aria-modal="true" aria-label="Delete automation">
          <div className="w-full max-w-sm bg-cc-card rounded-2xl shadow-float p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[15px] font-medium text-cc-fg">Delete “{confirmDelete.name}”?</p>
            <p className="text-[13px] text-cc-muted mt-1">Past runs stay in your sessions. This only removes the automation.</p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirmDelete(null)} className={ghostBtn}>Cancel</button>
              <button onClick={() => handleDelete(confirmDelete)} className={`${pill} bg-cc-error text-white hover:opacity-90 font-medium`}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
