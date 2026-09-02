/**
 * Open a GitHub pull request for a session's working tree using the `gh` CLI.
 *
 * Pushes the current branch to `origin` (setting upstream) and then creates
 * the PR. If a PR already exists for the branch, its URL is returned instead.
 */

import { execFileSync } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";

export interface CreatePullRequestOptions {
  title: string;
  body?: string;
}

export interface CreatePullRequestResult {
  url: string;
  branch: string;
  created: boolean;
}

function run(bin: string, args: string[], cwd: string): string {
  return execFileSync(bin, args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

export function createPullRequest(cwd: string, opts: CreatePullRequestOptions): CreatePullRequestResult {
  const gh = resolveBinary("gh");
  if (!gh) throw new Error("GitHub CLI (gh) is not installed or not on PATH");

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch || branch === "HEAD") throw new Error("Session is in a detached HEAD state; check out a branch first");

  let defaultBranch = "";
  try {
    defaultBranch = run(gh, ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd);
  } catch {
    // Not a GitHub repo or not authenticated — gh pr create will report the real error below.
  }
  if (defaultBranch && branch === defaultBranch) {
    throw new Error(`Session is on the default branch (${branch}); move the work to a feature branch first`);
  }

  // If a PR already exists for this branch, return it rather than failing.
  try {
    const existing = run(gh, ["pr", "view", branch, "--json", "url", "-q", ".url"], cwd);
    if (existing.startsWith("http")) return { url: existing, branch, created: false };
  } catch {
    // No PR yet.
  }

  try {
    run("git", ["push", "-u", "origin", branch], cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git push failed: ${msg.split("\n").slice(-3).join(" ").trim()}`);
  }

  const args = ["pr", "create", "--head", branch, "--title", opts.title];
  args.push("--body", opts.body && opts.body.trim() ? opts.body : opts.title);
  let output: string;
  try {
    output = run(gh, args, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh pr create failed: ${msg.split("\n").slice(-3).join(" ").trim()}`);
  }
  const url = output.split(/\s+/).find((token) => token.startsWith("http")) ?? "";
  if (!url) throw new Error(`gh pr create did not return a URL: ${output}`);
  return { url, branch, created: true };
}
