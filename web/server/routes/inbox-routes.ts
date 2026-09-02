/**
 * Review Inbox routes.
 *
 *   GET    /inbox                 list reviewable items + counts
 *   POST   /inbox/:id/review      { status: "reviewed" | "dismissed" | "pending" }
 *   DELETE /inbox/:id/review      reopen (same as status "pending")
 *   POST   /inbox/:id/pr          push the session branch and open a GitHub PR
 *   POST   /inbox/:id/retry       re-run the cron job that produced a session
 */

import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as sessionNames from "../session-names.js";
import * as cronStore from "../cron-store.js";
import { listRaces } from "../race-store.js";
import { listRuns } from "../orchestrator-store.js";
import { buildInboxItems, countInbox, InboxReviewStore, type InboxLoopSource, type InboxSessionSource } from "../inbox.js";
import { createPullRequest } from "../inbox-pr.js";
import type { InboxItem, InboxReviewStatus } from "../inbox-types.js";

const REVIEW_STATUSES: InboxReviewStatus[] = ["pending", "reviewed", "dismissed"];

export function registerInboxRoutes(api: Hono, deps: RouteDeps, reviewStore: InboxReviewStore = new InboxReviewStore()): void {
  const { launcher, wsBridge, cronScheduler } = deps;

  function collectItems(): InboxItem[] {
    const names = sessionNames.getAllNames();
    const sessions: InboxSessionSource[] = launcher.listSessions().map((s) => {
      const live = wsBridge.getSession(s.sessionId);
      return {
        sessionId: s.sessionId,
        name: names[s.sessionId] ?? s.name,
        backendType: s.backendType,
        cwd: s.cwd,
        createdAt: s.createdAt,
        archived: s.archived,
        state: s.state,
        cronJobId: s.cronJobId,
        cronJobName: s.cronJobName,
        orchestrationRole: s.orchestrationRole,
        parentSessionId: s.parentSessionId,
        loopRunId: s.loopRunId,
        loopIteration: s.loopIteration,
        bridge: live?.state ?? null,
        messages: live?.messageHistory ?? [],
      };
    });
    // Loop runs (docs/roadmap.md #3): one item per finished loop, named after its automation.
    let loops: InboxLoopSource[] = [];
    if (cronScheduler && typeof cronScheduler.listLoopRuns === "function") {
      const jobNames = new Map(cronStore.listJobs().map((j) => [j.id, j.name] as const));
      loops = cronScheduler.listLoopRuns().map((execution) => ({ execution, jobName: jobNames.get(execution.jobId) }));
    }
    return buildInboxItems({
      sessions,
      races: listRaces(),
      runs: listRuns(),
      loops,
      reviews: reviewStore.getAll(),
    });
  }

  function findItem(id: string): InboxItem | undefined {
    return collectItems().find((item) => item.id === id);
  }

  api.get("/inbox", (c) => {
    const items = collectItems();
    return c.json({ items, counts: countInbox(items) });
  });

  api.post("/inbox/:id/review", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const status = body?.status as InboxReviewStatus | undefined;
    if (!status || !REVIEW_STATUSES.includes(status)) {
      return c.json({ error: `status must be one of ${REVIEW_STATUSES.join(", ")}` }, 400);
    }
    const record = reviewStore.set(id, status);
    return c.json({ ok: true, id, status, reviewedAt: record?.at });
  });

  api.delete("/inbox/:id/review", (c) => {
    const id = c.req.param("id");
    reviewStore.clear(id);
    return c.json({ ok: true, id, status: "pending" });
  });

  api.post("/inbox/:id/pr", async (c) => {
    const id = c.req.param("id");
    const item = findItem(id);
    if (!item) return c.json({ error: "Inbox item not found" }, 404);
    if (!item.sessionId) return c.json({ error: "This item has no session to open a PR from" }, 400);
    const cwd = item.cwd || launcher.getSession(item.sessionId)?.cwd;
    if (!cwd) return c.json({ error: "Session has no working directory" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : item.title;
    const prBody = typeof body?.body === "string" ? body.body : `${item.summary}\n\n---\nOpened from Switchyard session ${item.sessionId}.`;
    try {
      const result = createPullRequest(cwd, { title, body: prBody });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.post("/inbox/:id/retry", (c) => {
    const id = c.req.param("id");
    const item = findItem(id);
    if (!item) return c.json({ error: "Inbox item not found" }, 404);
    if (!item.cronJobId) return c.json({ error: "Only automation-spawned sessions and loop runs can be retried from the inbox" }, 400);
    if (!cronScheduler) return c.json({ error: "Cron scheduler is not available" }, 503);
    cronScheduler.executeJobManually(item.cronJobId);
    return c.json({ ok: true, cronJobId: item.cronJobId });
  });
}
