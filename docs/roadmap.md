# Switchyard roadmap

_Last updated 2026-09-02 (evening)._

Switchyard's goal is a single desktop-style console for AI coding agents
(Claude Code, Codex, and friends) that lets one person run agents that do the
prompting for them: schedule work, fan it out, review the results, and keep
what the agents learn. This document records where the product stands and
what to build next, ranked by value toward that goal.

## Where Switchyard stands

### Core session UX (mature)

- Sessions in any folder with Claude Code, Codex, Goose, Aider, OpenHands,
  OpenClaw, or OpenCode, optionally on a branch or isolated git worktree.
- Mid-session model and provider switching, follow-up message queueing,
  fork at any message, invite links with owner / collaborator / spectator roles.
- Diff panel with inline editing, file tree with Monaco editor, PTY terminal,
  session rail with cost, context usage, Claude usage limits, GitHub PR status.

### Multi-agent

- **Agent bridge:** every lead session gets an MCP server with `ask_codex`,
  `ask_claude`, `ask_goose`, `ask_aider`, `ask_openhands`; subagent permission
  prompts surface to the parent.
- **Races:** one prompt across several backends in separate worktrees with a
  side-by-side comparison and a "merge winner" action; cheapest-first cascade.
- **Orchestrator:** multi-stage pipelines, one session per stage, context
  forwarded. Sequential only, no retries or branching.
- **Task Router / Collective Mind:** route work to the best live session from
  learned history; watch agents share context and deliberate.

### Automation

- Cron jobs (recurring or one-shot sessions), named Agents with prompt
  templates and schedule or webhook triggers, outbound HMAC-signed webhooks,
  keepalive that relaunches crashed agents.

### Knowledge and memory

- Semantic memory v2: namespaces (global / repo / session / agent), decay and
  reinforcement, pinning, LLM consolidation, automatic prompt enrichment.
- Prompt library; viewer for Claude Code skills and commands.

### Ops

- Environment profiles, community adapters from npm, optional password auth,
  protocol recording with replay and public replay links, session gallery,
  protocol monitor, Docker container backend, service mode, macOS app.

### Known gaps

- Push notifications are scaffolded (service worker only); nothing subscribes
  or sends.
- Containerized sessions exist server-side with no creation UI.
- Kanban and Collective Mind are read-only views.
- Integrations page only has Linear.
- Runtime model / mode switching is unsupported for Goose, OpenCode, OpenClaw.

## What the field is doing (Sep 2026)

- **Codex app:** background Automations on a schedule in a dedicated worktree
  that land as reviewable results; skills, plugins, computer use; planned
  cloud jobs on triggers such as "on GitHub push".
- **Claude Code:** cloud Routines (prompt + repos + connectors + schedule)
  that run with the laptop off; per-session worktrees by default; drag-and-drop
  panes and an integrated editor in the desktop app.
- **Hermes Agent:** a closed learning loop where the agent writes and improves
  its own skills after tasks; cron with delivery to any chat app; Bot Mode
  where named bots each have their own model, memory, skills, and routines.
- **OpenClaw:** 50+ messaging channels, a cron-triggered loop that wakes to
  evaluate its task list, a "Task Brain" control panel.
- **Orchestration patterns:** the Ralph loop (fresh context each iteration,
  bounded tasks, progress in a file) and Gas Town (20 to 30 parallel agents
  with worker roles over a git-backed task tracker).
- **Solo-founder lesson:** triage. Hand agents formulaic, low-damage recurring
  work first; keep judgment calls; structured workflows beat fully autonomous
  agents.

## Layers: what runs where

Three tools, three jobs. Keep the split and the integration surface stays
small (Switchyard's REST API + webhooks).

| Layer | Tool | Owns |
|---|---|---|
| Talk to me | **Hermes Agent** (installed) | phone delivery, cron with chat delivery, personal memory, self-improving skills, named bots |
| Decide what to work on | **Paperclip** (MIT) | org chart, roles, goals, budgets, heartbeats; any runtime that accepts a heartbeat is "hired" |
| Do and review the code work | **Switchyard** | sessions, worktrees, diffs, permissions, races, automations, the review inbox, playbooks |

Rule of thumb: Hermes talks to you, Paperclip decides, Switchyard executes
and gates quality. Grok Bot is the closed, $300/month version of Hermes +
Paperclip; watch it, don't depend on it.

Not building in Switchyard: roles-with-memory, post-run reflection / skill
learning, non-code agents. Those are Hermes and Paperclip features; integrate
instead.

## Anti-slop levers

Quality comes from small verified steps, not from agents running overnight.

- Every loop iteration ends with passing tests or is marked failed.
- Each playbook step has a definition-of-done checklist the agent must satisfy.
- A human gate between playbook steps (the inbox).
- Budget and iteration caps on every automation.
- Race the risky steps and pick the better attempt instead of fixing a bad one.

## Ranked backlog

1. **Review inbox.** _Shipped 2026-09-02_ (`#/inbox`).
2. **Automations.** _Shipped 2026-09-02_ (`#/automations`): schedule / once /
   manual, fresh worktree per run, budget cap, auto-PR, run tracking.
3. **Loop runner** (next). Give an automation a brief; it plans a task list,
   works one task per iteration in a fresh session with fresh context, and
   stops on done, iteration cap, or budget. Each iteration lands in the inbox;
   the task list is visible on the Kanban page (read-only in v1). Pattern:
   the Ralph loop + a Beads-style task file. Prompt: `docs/prompts/loop-runner.md`.
4. **Hermes hookup** (one afternoon). Forward `permission.requested` and
   `session.completed` webhooks to a Hermes bot that posts to your phone and
   replies through the REST API. A small Hermes skill wrapping
   `POST /api/cron/jobs/:id/run` and `GET /api/inbox`.
5. **Playbooks.** Turn the orchestrator into "chain automations with a human
   checkpoint between each." First real playbook: New product = scaffold →
   MVP loop → deploy → landing page → Stripe → launch posts. Using it on an
   actual side project is the acceptance test for the whole product.
6. **Sandbox UI.** Surface the Docker backend in session creation so
   autonomous runs can use bypass mode safely.
7. **Paperclip adapter**, only if more than three or four standing agents are
   wanted: a Paperclip heartbeat creates a Switchyard automation per task.

Fun test: take the smallest app idea, run it through 3 to 5, count the prompts
you had to write. Under ten means it's working.

## Sources

- https://openai.com/index/introducing-the-codex-app/
- https://www.verdent.ai/guides/codex-app-first-impressions-2026
- https://www.mindstudio.ai/blog/code-with-claude-2026-new-agent-features
- https://www.eigent.ai/blog/claude-code-desktop-redesign
- https://hermes-agent.nousresearch.com/docs/
- https://www.marktechpost.com/2026/08/17/nous-research-hermes-bot-mode/
- https://docs.openclaw.ai/
- https://www.contextstudios.ai/blog/the-complete-openclaw-guide-how-we-run-an-ai-agent-in-production-2026
- https://linearb.io/blog/ralph-loop-agentic-engineering-geoffrey-huntley
- https://www.heise.de/en/background/Full-Control-Gas-Town-Orchestrates-Ten-or-More-Coding-Agents-11178824.html
- https://addyosmani.com/blog/code-agent-orchestra/
- https://aibusiness.vc/solo/one-person-company-ai-agents-limits-2026
- https://fi.co/insight/your-first-ten-hires-are-ai-agents-the-solo-founder-s-guide-to-building-an-ai-native-startup-in-2026
