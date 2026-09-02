import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as cronStore from "../cron-store.js";

export function registerCronRoutes(api: Hono, deps: RouteDeps): void {
  const { cronScheduler } = deps;

  api.get("/cron/jobs", (c) => {
    const jobs = cronStore.listJobs();
    const enriched = jobs.map((j) => ({
      ...j,
      nextRunAt: cronScheduler?.getNextRunTime(j.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/cron/jobs/:id", (c) => {
    const job = cronStore.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({
      ...job,
      nextRunAt: cronScheduler?.getNextRunTime(job.id)?.getTime() ?? null,
    });
  });

  api.post("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const job = cronStore.createJob({
        name: body.name || "",
        prompt: body.prompt || "",
        schedule: body.schedule || "",
        recurring: body.recurring ?? true,
        backendType: body.backendType || "claude",
        model: body.model || "",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        enabled: body.enabled ?? true,
        permissionMode: body.permissionMode || "bypassPermissions",
        codexInternetAccess: body.codexInternetAccess,
        trigger: body.trigger === "manual" ? "manual" : "schedule",
        useWorktree: body.useWorktree === true,
        autoPr: body.autoPr === true,
        budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : undefined,
      });
      if (job.enabled) cronScheduler?.scheduleJob(job);
      return c.json(job, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const allowed: Record<string, unknown> = {};
      for (const key of ["name", "prompt", "schedule", "recurring", "backendType", "model", "cwd", "envSlug", "enabled", "permissionMode", "codexInternetAccess", "trigger", "useWorktree", "autoPr", "budgetUsd"] as const) {
        if (key in body) allowed[key] = body[key];
      }
      const job = cronStore.updateJob(id, allowed);
      if (!job) return c.json({ error: "Job not found" }, 404);
      if (job.id !== id) cronScheduler?.stopJob(id);
      cronScheduler?.scheduleJob(job);
      return c.json(job);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/cron/jobs/:id", (c) => {
    const id = c.req.param("id");
    cronScheduler?.stopJob(id);
    const deleted = cronStore.deleteJob(id);
    if (!deleted) return c.json({ error: "Job not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/cron/jobs/:id/toggle", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    const updated = cronStore.updateJob(id, { enabled: !job.enabled });
    if (updated?.enabled) {
      cronScheduler?.scheduleJob(updated);
    } else {
      cronScheduler?.stopJob(id);
    }
    return c.json(updated);
  });

  api.post("/cron/jobs/:id/run", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    cronScheduler?.executeJobManually(id);
    return c.json({ ok: true, message: "Job triggered" });
  });

  api.get("/cron/executions", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const all = cronStore.listJobs().flatMap((j) => cronScheduler?.getExecutions(j.id) ?? []);
    all.sort((a, b) => b.startedAt - a.startedAt);
    return c.json(all.slice(0, limit));
  });

  api.get("/cron/jobs/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(cronScheduler?.getExecutions(id) ?? []);
  });
}
