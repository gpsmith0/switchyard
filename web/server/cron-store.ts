import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CronJob, CronJobCreateInput, CronLoopOptions } from "./cron-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const SWITCHYARD_DIR = join(homedir(), ".switchyard");
const CRON_DIR = join(SWITCHYARD_DIR, "cron");

function ensureDir(): void {
  mkdirSync(CRON_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(CRON_DIR, `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Normalise the loop option. Accepts `{ enabled, maxIterations }`, `null` /
 * `undefined` (loop off), and clamps the iteration cap to 1..100 (default 10).
 * Throws on shapes that are clearly wrong so the API returns a 400.
 */
export function normalizeLoopOptions(raw: unknown): CronLoopOptions | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object") throw new Error("loop must be an object like { enabled, maxIterations }");
  const obj = raw as { enabled?: unknown; maxIterations?: unknown };
  const enabled = obj.enabled === true;
  let maxIterations = 10;
  if (obj.maxIterations != null) {
    const n = typeof obj.maxIterations === "string" ? Number(obj.maxIterations) : obj.maxIterations;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
      throw new Error("Loop iterations must be a whole number of at least 1");
    }
    maxIterations = Math.min(100, Math.floor(n));
  }
  return { enabled, maxIterations };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listJobs(): CronJob[] {
  ensureDir();
  try {
    const files = readdirSync(CRON_DIR).filter((f) => f.endsWith(".json"));
    const jobs: CronJob[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(CRON_DIR, file), "utf-8");
        jobs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    jobs.sort((a, b) => a.name.localeCompare(b.name));
    return jobs;
  } catch {
    return [];
  }
}

export function getJob(id: string): CronJob | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as CronJob;
  } catch {
    return null;
  }
}

export function createJob(data: CronJobCreateInput): CronJob {
  if (!data.name || !data.name.trim()) throw new Error("Job name is required");
  if (!data.prompt || !data.prompt.trim()) throw new Error("Job prompt is required");
  const isManual = data.trigger === "manual";
  if (!isManual && (!data.schedule || !data.schedule.trim())) throw new Error("Job schedule is required");
  if (data.budgetUsd != null && (!Number.isFinite(data.budgetUsd) || data.budgetUsd < 0)) {
    throw new Error("Budget must be a non-negative number");
  }
  if (!data.cwd || !data.cwd.trim()) throw new Error("Job working directory is required");
  const loop = normalizeLoopOptions(data.loop);

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Job name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(id))) {
    throw new Error(`A job with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const job: CronJob = {
    ...data,
    id,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    schedule: (data.schedule ?? "").trim(),
    cwd: data.cwd.trim(),
    loop,
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    totalRuns: 0,
  };
  writeFileSync(filePath(id), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export function updateJob(
  id: string,
  updates: Partial<CronJob>,
): CronJob | null {
  ensureDir();
  const existing = getJob(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Job name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different job
  if (newId !== id && existsSync(filePath(newId))) {
    throw new Error(`A job with a similar name already exists ("${newId}")`);
  }

  const loop = "loop" in updates ? normalizeLoopOptions(updates.loop) : existing.loop;

  const job: CronJob = {
    ...existing,
    ...updates,
    loop,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    // Preserve immutable fields
    createdAt: existing.createdAt,
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      unlinkSync(filePath(id));
    } catch {
      /* ok */
    }
  }

  writeFileSync(filePath(newId), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export function deleteJob(id: string): boolean {
  ensureDir();
  if (!existsSync(filePath(id))) return false;
  try {
    unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}
