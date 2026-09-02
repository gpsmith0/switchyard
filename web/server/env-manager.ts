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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SwitchyardEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const SWITCHYARD_DIR = join(homedir(), ".switchyard");
const ENVS_DIR = join(SWITCHYARD_DIR, "envs");

function ensureDir(): void {
  mkdirSync(ENVS_DIR, { recursive: true });
}

function filePath(slug: string): string {
  return join(ENVS_DIR, `${slug}.json`);
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

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listEnvs(): SwitchyardEnv[] {
  ensureDir();
  try {
    const files = readdirSync(ENVS_DIR).filter((f) => f.endsWith(".json"));
    const envs: SwitchyardEnv[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(ENVS_DIR, file), "utf-8");
        envs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    envs.sort((a, b) => a.name.localeCompare(b.name));
    return envs;
  } catch {
    return [];
  }
}

export function getEnv(slug: string): SwitchyardEnv | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(slug), "utf-8");
    return JSON.parse(raw) as SwitchyardEnv;
  } catch {
    return null;
  }
}

export function createEnv(
  name: string,
  variables: Record<string, string> = {},
): SwitchyardEnv {
  if (!name || !name.trim()) throw new Error("Environment name is required");
  const slug = slugify(name.trim());
  if (!slug) throw new Error("Environment name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(slug))) {
    throw new Error(`An environment with a similar name already exists ("${slug}")`);
  }

  const now = Date.now();
  const env: SwitchyardEnv = {
    name: name.trim(),
    slug,
    variables,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(filePath(slug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

export function updateEnv(
  slug: string,
  updates: { name?: string; variables?: Record<string, string> },
): SwitchyardEnv | null {
  ensureDir();
  const existing = getEnv(slug);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newSlug = slugify(newName);
  if (!newSlug) throw new Error("Environment name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different env
  if (newSlug !== slug && existsSync(filePath(newSlug))) {
    throw new Error(`An environment with a similar name already exists ("${newSlug}")`);
  }

  const env: SwitchyardEnv = {
    name: newName,
    slug: newSlug,
    variables: updates.variables ?? existing.variables,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  // If slug changed, delete old file
  if (newSlug !== slug) {
    try { unlinkSync(filePath(slug)); } catch { /* ok */ }
  }

  writeFileSync(filePath(newSlug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

export function deleteEnv(slug: string): boolean {
  ensureDir();
  if (!existsSync(filePath(slug))) return false;
  try {
    unlinkSync(filePath(slug));
    return true;
  } catch {
    return false;
  }
}
