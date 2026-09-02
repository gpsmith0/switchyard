# Switchyard roadmap

_Last updated 2026-09-02._

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

## Ranked backlog

1. **Review inbox.** One screen where every finished automation, race, or
   subagent run lands with a summary, diff, cost, and Approve / Open PR /
   Retry / Dismiss actions. Makes "agents work, I review" real.
   _Status: v1 shipped 2026-09-02 (`#/inbox`, `GET /api/inbox`). Next: land
   agent-bridge subagent results and Hermes cron results as items; add a
   per-item "Approve and merge" for worktree branches._
2. **Automations (Codex-style).** Merge Cron and Agents into one concept:
   prompt, repo, schedule or trigger, always a fresh worktree, result to the
   inbox and optionally a PR. Per-automation budget caps.
   _Status: v1 shipped 2026-09-02 (`#/automations`, built on the cron store):
   schedule / once / manual triggers, fresh worktree per run on
   `auto/<name>/<stamp>`, budget cap that interrupts the run, auto-PR via gh,
   run tracking with cost and line stats. Next: fold the webhook-triggered
   Agents page into the same list; per-automation model for Codex._
3. **Loop runner.** A Ralph-style mode: brief in, task list out, bounded
   iterations with fresh context, progress tracked in a writable Kanban, stop
   on done or budget. Then let the orchestrator fan out tasks in parallel
   worktrees with retries.
4. **Phone delivery.** Permission requests and results to Telegram or Slack
   with approve / deny replies. Preferred route: reuse Hermes Agent (already
   installed) or OpenClaw as the messaging gateway rather than finishing web
   push. Switchyard emits webhooks on `permission.requested` and
   `session.completed`; a Hermes bot can forward those to any channel and post
   the reply back through the REST API.
5. **Roles with their own memory.** Agent profiles as persistent "staff":
   persona, default model, own memory namespace, standing routines, weekly
   activity view.
6. **Post-run reflection.** After a session ends, a cheap model proposes a
   skill or memory update; one-click accept. Preferred route: hand the
   session transcript to Hermes's skill-creation loop and surface the proposed
   skill in the inbox for approval, instead of building a second learning loop.
7. **Sandbox UI.** Surface the Docker backend in session creation so
   autonomous runs can use bypass mode safely.
8. **Non-code agents through the bridge.** Research, writing, and support
   tasks over the existing `ask_*` MCP bridge, growing the coding console
   into a company console.

## Build-vs-reuse policy

Relying on existing tools is fine and preferred: Hermes Agent (installed),
OpenClaw, Paperclip, and similar can provide messaging, cron delivery, and
learning loops. Switchyard's job is the console: sessions, review, and
orchestration across whichever agents and gateways are plugged in.

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
