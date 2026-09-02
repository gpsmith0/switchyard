# Switchyard Design System — "Desktop Agent" direction

Switchyard's UI follows the look and feel of the ChatGPT / Codex desktop app for
macOS. The goal is a calm, neutral, native-feeling shell where the conversation
is the only thing with color, and every control looks like it could ship inside
a first-party Mac app.

Reference screens (Mobbin): ChatGPT web/desktop home, thread view, sidebar,
model picker. Codex desktop: thread timeline with collapsed "worked for" steps,
diff stats, and the composer's bottom chip row.

This file is the source of truth. `web/src/index.css` implements the tokens.
When adding UI, read this first and reuse the `cc-*` tokens; never introduce
raw hex in components.

---

## 1. Intent

| Question | Answer |
|---|---|
| Who | A developer running several coding agents at once, glancing between them all day. |
| Task | Read what the agent did, answer permission prompts, send the next instruction. |
| Feel | Quiet, native, monochrome. Like a Mac app, not a dashboard. |

Consequences: system font, near-white / near-black surfaces, one accent used
almost exclusively for the send button and active states, no gradients, no
colored left rails, no cards-inside-cards.

## 2. Layout

```
┌──────────────┬───────────────────────────────────────────────┬──────────────┐
│ Sidebar 260  │ TopBar 52 (transparent, no border)            │ Panel 280    │
│ #sidebar bg  │───────────────────────────────────────────────│ (optional)   │
│              │            Thread column max 768px            │              │
│ New session  │   user bubble (right, gray pill)              │              │
│ Search       │   assistant text (plain, no bubble)           │              │
│ Tools ▸      │   ▸ Worked for 1m 12s  (tool steps, muted)    │              │
│ Data ▸       │                                               │              │
│ Config ▸     │                                               │              │
│              │                                               │              │
│ Sessions     │                                               │              │
│  Today       │───────────────────────────────────────────────│              │
│   row        │   ╭──────────────── composer pill ─────────╮  │              │
│   row        │   │ + │ Ask anything…            🎤 (↑)   │  │              │
│ Settings     │   ╰────────────────────────────────────────╯  │              │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
```

- Sidebar: `260px`, same hue as canvas but one step darker (`cc-sidebar`).
  No border on desktop; a 1px `cc-border` only on the right edge.
- Thread column: `max-w-3xl` (768px) centered, `px-6`.
- Composer sits inside the column with `pb-4`; disclaimer line below it.
- TopBar is transparent with no bottom border. It carries: sidebar toggle,
  provider/model pill (like ChatGPT's "ChatGPT ⌄"), the session title,
  then on the right the view switcher (Log / Diff / Files), Share, ⋯, panel.

## 3. Color tokens

All colors are neutral grays. The only chromatic tokens are `success`,
`warning`, `error` and `link`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `cc-bg` | `#FFFFFF` | `#212121` | canvas |
| `cc-sidebar` | `#F9F9F9` | `#171717` | sidebar |
| `cc-card` | `#FFFFFF` | `#2F2F2F` | popovers, composer, panels |
| `cc-fg` | `#0D0D0D` | `#ECECEC` | primary text |
| `cc-muted` | `#6E6E6E` | `#9B9B9B` | secondary text, icons |
| `cc-user-bubble` | `#F4F4F4` | `#303030` | user message pill |
| `cc-hover` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.05)` | hover fill |
| `cc-active` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.09)` | selected fill |
| `cc-border` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.10)` | hairlines |
| `cc-primary` | `#0D0D0D` | `#ECECEC` | send button, active nav, focus |
| `cc-link` | `#0066CC` | `#66B2FF` | inline links only |
| `cc-success` | `#10A37F` | `#19C37D` | running dot, allow button |
| `cc-warning` | `#D97706` | `#F5A524` | pending permission |
| `cc-error` | `#DC2626` | `#F93A37` | deny, errors |
| `cc-code-bg` | `#0D0D0D` | `#171717` | code blocks |
| `cc-code-fg` | `#E5E5E5` | `#E5E5E5` | code text |

Distribution: ~90% `bg`/`sidebar`/`card`, ~8% `muted`/`border`, ~2% accent.

## 4. Typography

- Family: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
  Inter, Helvetica, Arial, sans-serif`. Mono: `"SF Mono", Menlo, "Geist Mono",
  monospace` (the bundled Geist Mono file is the web fallback).
- Base UI size `14px`. Chat text `15px / 1.65`. Sidebar rows `14px`.
  Tool step rows `13px`. Captions `12px`. Hero heading `28px / 500 / -0.01em`.
- Hierarchy comes from weight and color, not size: `fg 500` for titles,
  `fg 400` for body, `muted 400` for meta.
- Numbers are `tabular-nums`.

## 5. Shape and depth

- Depth strategy: **borders + one soft shadow on floating surfaces**. No
  layered shadows on static content, no shadows in dark mode (use `cc-border`).
- Radius scale: `6px` icon buttons · `8px` menu items · `12px` menus and
  cards · `24px` user bubble · `28px` composer pill · `9999px` chips.
- Composer shadow (light): `0 0 0 1px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.06)`.
- Popovers: `cc-card` + `cc-border` + `shadow-float`.

## 6. Component rules

**Sidebar**
- Header: logo + collapse button. Below: `New session`, `Search sessions`
  as icon rows. Then the three expandable groups `Tools`, `Data`, `Config`
  (closed by default, chevron on the right, like ChatGPT's *Projects*).
- Session rows: one line of `14px` text, no status rail. A 6px dot before
  the name only while running (green) or waiting on a permission (amber).
  Branch shown as a second `12px` muted line. Hover reveals the archive icon.
- Footer: a "user" row (avatar circle, `Switchyard`, `Settings`).

**TopBar**
- 52px tall, transparent. Provider + model rendered as a single text pill
  with a chevron. View switcher is a segmented pill. Share is a rounded-full
  outline button with a label on ≥ sm screens.

**Messages**
- User: right-aligned pill, `max-w-[70%]`, `cc-user-bubble`, `rounded-3xl`,
  `px-5 py-2.5`, `15px`.
- Assistant: plain text, no container, no left rail. Markdown headings
  `600`, code blocks dark with a language header, links in `cc-link`.
- Action row (copy, fork) appears under the message on hover, `12px` icons.
- Thinking: a muted "Thought for …" disclosure row, italic body when opened.

**Tool steps (Codex style)**
- Each tool call is a single row: chevron · icon · verb label (`fg`, 500)
  · preview (`muted`). No border, no card. Hover fills with `cc-hover`.
- Consecutive same-tool calls collapse into one row with a count.
- Expanded detail sits in a `cc-hover` rounded box, `12px` mono.

**Composer**
- One pill: `rounded-[28px]`, `cc-card`, composer shadow. Textarea on top;
  bottom bar has `+` (attach), the permission-mode chip, the branch chip on
  the left; mic (when supported) and a round `cc-primary` send button on the
  right. While running the send button becomes a stop button (square).
- Below the pill a centered `12px` muted line: "Agents can make mistakes.
  Review changes before you merge."

**Home**
- Heading "What are you working on?" centered, then the same composer pill.
  Backend choices are rounded-full chips under the pill (like ChatGPT's
  suggestion chips). Working-directory chip lives in the pill's bottom bar.
  Advanced settings stay behind the `Options` chip.

**Permission banner**
- A single `cc-card` with `cc-border`, `rounded-2xl`. Allow = filled
  `cc-primary` button; Deny = outline. No colored gradients.

## 7. Motion

- Hover/active transitions `120ms` on `background-color`, `color`, `opacity`.
- Menus enter with `slide-down` 120ms from `scale(.98)`; nothing longer
  than 200ms. Respect `prefers-reduced-motion`.

## 8. Don'ts

- No colored left accent rails, no gradient icon tiles, no uppercase-tracked
  section labels bigger than `11px`.
- No mono font for UI labels (mono is for code and paths only).
- No borders around assistant text or tool rows.
- No new hex values in components; add a token here first.
