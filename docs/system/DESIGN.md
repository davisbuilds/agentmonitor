# Design System — "Instrument Console"

The design language for the Svelte `/app/` surface. Tokens are defined in
`frontend/src/app.css` as a Tailwind v4 `@theme` block (they generate utilities **and**
expose CSS vars). This doc is the human-readable source of truth; `app.css` is the machine one.

Rollout is phased — see `docs/plans/2026-05-25-svelte-ui-redesign-implementation.md`. Until a
component is migrated it may still use raw `gray-*`/`blue-*` utilities; new and migrated code
must use the tokens below.

## Principle

A calm, near-monochrome cockpit you glance at. **Structure is carried by hairlines, tint, and
type weight — almost never by boxes.** **Color is signal, not decoration:** the canvas is quiet
so a red quota bar or an errored agent is the thing your eye catches. One interactive accent;
everything else neutral or status.

## Color

OKLCH, cool-tinted. Generated utilities: `bg-*`, `text-*`, `border-*`, etc.

| Token | Utility example | Role |
| :-- | :-- | :-- |
| `--color-canvas` | `bg-canvas` | Page background (never `#000`). |
| `--color-surface` | `bg-surface` | Panels, controls. |
| `--color-surface-2` | `bg-surface-2` | Raised / hover / active. |
| `--color-line` | `border-line` | Hairline borders (default structure). |
| `--color-line-strong` | `border-line-strong` | Emphasized border / hover. |
| `--color-text` | `text-text` | Primary text (~16:1). |
| `--color-text-muted` | `text-text-muted` | Secondary text (~6:1). **Replaces `gray-500/600/700`.** |
| `--color-text-faint` | `text-text-faint` | Meta floor (~3.5:1) — large/numeric only. |
| `--color-accent` | `text-accent` `bg-accent` | The **one** interactive/brand hue. |
| `--color-accent-strong` | `bg-accent-strong` | Accent hover / pressed. |
| `--color-ok` | `bg-ok` | Healthy / added (retires the green↔emerald split). |
| `--color-warn` | `bg-warn` | Caution. |
| `--color-danger` | `bg-danger` | Error / over-threshold / removed. |
| `--color-claude` | `text-claude` | Provider identity only (warm amber). |
| `--color-codex` | `text-codex` | Provider identity only (neutral). |

Rules: one primary accent per surface; status colors only encode status; provider hues only
identify a provider. Don't reintroduce `sky`/`purple`/`orange`/`yellow`/raw `gray-*` as text.
Verify any new text/surface pair clears AA (4.5:1 body, 3:1 large) before shipping.

## Typography

| Role | Family | Utility |
| :-- | :-- | :-- |
| UI / prose / headings | **Mona Sans** (variable, OFL) | `font-sans` (default on `<body>`) |
| Numerals / IDs / cost / tokens / code / streams | **Geist Mono** (variable, OFL) | `font-mono` |

Mono is for alignment, not costume — pair it with `tabular-nums` (or the `.tabular` helper) for
numeric columns. Don't set the whole UI in mono.

**Scale** (1.25 ratio; **12.5px is the hard floor** for real content):

| Utility | Size | Use |
| :-- | :-- | :-- |
| `text-display` | 30 / 600 | Page-level hero numbers. |
| `text-h1` | 24 / 600 | Page title. |
| `text-h2` | 19 / 600 | Section heading. |
| `text-h3` | 16 / 600 | Panel / card heading. |
| `text-body` | 14 | Body (default). |
| `text-meta` | 12.5 | Captions, metadata, labels. |

No `text-[10px]`/`text-[11px]`. Reserve uppercase + `tracking-wide` for short labels only.

## Space

Rhythm is a **usage convention**, not extra tokens — three deliberate steps so grouping reads:

- **Tight (8px)** within a group — `gap-2`, `p-2`.
- **Between groups (16px)** — `gap-4`, `p-4`.
- **Between sections (32px)** — `gap-8`.

Don't make every gap 16px (the old `space-y-4`-everywhere mistake); don't sprinkle arbitrary gaps.

## Radius

Two only: `rounded-sm` (`--radius-sm`, 6px) for controls/chips/bars, `rounded-lg`
(`--radius-lg`, 10px) for panels. `rounded-full` only for dots and true pills. Don't use
`rounded`/`rounded-md`/`rounded-xl`/`rounded-2xl`.

## Elevation & Motion

Borders carry structure — **shadow (`shadow-overlay`) is reserved for genuinely floating layers**
(command palette, popovers, inspector). No decorative glows.

Animate `transform`/`opacity` only. Default duration 140ms, `ease-out`
(`cubic-bezier(0.22, 1, 0.36, 1)`). No bounce/elastic, no layout-property transitions.

## Layout language

- **Panels, not cards-per-thing.** Default container is a hairline-bordered `bg-surface` panel
  with a quiet header — not a box around every metric. (Avoid `everything-in-cards` / `nested-cards`.)
- **Bento weighting over uniform grids.** Promote the 2–3 metrics that matter; collapse the rest
  into a compact strip. (Avoid `identical-card-grids`.)
- **Tables breathe.** Row padding ~`py-2.5`, hairline row separators, sticky headers,
  right-aligned `font-mono tabular` numerics.
- **Demote loud chips.** Status/capability indicators are a tinted dot + label, not a colored
  uppercase pill on every row.
- **Constrain prose** to `max-w-[65ch]`; collapse stacked heading+subtitle+banner+pill into one
  heading plus a single `ⓘ` affordance.

## Accessibility floor

Body/secondary ≥ 4.5:1, large/numeric ≥ 3:1; all controls keyboard-reachable with a visible
focus ring (`:focus-visible` is wired in `app.css` base). No feature removed on mobile — adapt
(stack / drawer / popover) rather than `hidden`.
