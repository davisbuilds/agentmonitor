# Design System — "Instrument Console"

The design language for the Svelte `/app/` surface. Tokens are defined in
`frontend/src/app.css` as a Tailwind v4 `@theme` block (they generate utilities **and**
expose CSS vars). This doc is the human-readable source of truth; `app.css` is the machine one.

New and migrated components must use the tokens below.

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
| `--color-antigravity` | `text-antigravity` | Provider identity only (Gemini violet). |

Rules: one primary accent per surface; status colors only encode status; provider hues only
identify a provider. Don't reintroduce `sky`/`purple`/`orange`/`yellow`/raw `gray-*` as text.
Verify any new text/surface pair clears AA (4.5:1 body, 3:1 large) before shipping.

Chart series share one categorical palette, `SERIES_COLORS` in
`frontend/src/lib/components/usage/model-colors.ts`: ten hues, validated on
**all** pairs against the dark chart surface, because a stacked day omits the
series it lacks and any two can end up touching. Charts name at most ten series
(Daily Usage by Model five, Skills ten) and fold the rest into Other, a dark
neutral that recedes toward the surface. Never cycle or generate an eleventh hue;
`tests/series-palette.test.ts` reruns every check on a palette change.

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
  uppercase pill on every row. Say nothing about the normal case: a list row omits a session's
  coverage when everything was captured (`SessionCoverage` variant `row`), and a header opens the
  breakdown from one dot + label (variant `detail`). Live status uses `StatusDot`.
- **One filter bar per tab.** A filtering tab renders `ui/FilterBar` directly under the command
  bar: scope first (sub-tabs or a search box), then Project and Agent, then the page's own
  filters, with Clear and actions at the end. It stays one row on desktop: `Select` caps its
  width (`max-w-48`, full value in the tooltip) instead of growing to its longest option, and
  less-used filters sit behind `MoreFilters`, whose button counts the ones set. Offer only
  filters the page's reads honor.
- **One spelling per model.** Render model IDs through `formatModelName`, with the raw ID in the
  tooltip; `tests/model-name-display.test.ts` keeps it in step with the server's
  `normalizeModelId`.
- **Quiet per-row actions.** An action repeated on every row (Pin) appears on hover or focus,
  and stays visible once it holds state (Pinned).
- **One daily bar chart.** A per-day series renders `ui/chart/DailyBarChart`: HTML bars that
  stretch to any width with labels at true size, round y ticks with faint gridlines, a few date
  labels (the ends aligned to the plot edges), a 2px gap between stacked segments, and a tooltip
  that hover and keyboard focus both open. Each day is a button named by its totals; clicking it
  narrows the page to that day. `PlotFrame` stays for small fixed-aspect SVG plots (Benchmarks).
- **Name every cost's window.** A cost figure says which period it covers ("Cost today",
  "Sep 16 – Oct 15"); an unlabeled total invites comparison with a different window elsewhere.
- **Constrain prose** to `max-w-[65ch]`; collapse stacked heading+subtitle+banner+pill into one
  heading plus a single `ⓘ` affordance (`InfoTip`, or `Panel`'s `info`). Write its text in plain
  words: no table names, integration modes or capability-contract vocabulary.

## Brand assets

The mark is a flat signal line that rises into a peak shaped like an A, with a
crossbar. Earlier activity reads as fainter, smaller spikes. It uses only the
canvas, surface, line, text, and accent tokens. The accent is the one hue, as in the app.

| File | Use |
| --- | --- |
| `docs/assets/amon-header.svg` | README header (880×240). Hand-edited vector; no external fonts, images, or scripts. |
| `frontend/public/favicon.svg` | Browser-tab icon. The source for the raster fallback. |
| `frontend/public/favicon.ico` | 16 px and 32 px PNG images rendered from `favicon.svg`, packed as one ICO. |

- **Colors are hex copies of `app.css` tokens.** SVG fill attributes get sRGB
  hex rather than `oklch()`. When a token changes, update the hex values here and
  in the asset comments. Check them against Chromium's own conversion of the
  token, for example by filling a canvas and reading the pixel back.
- **Keep the mark's geometry shared.** The header's A and the favicon's A use the
  same leg slope (8:17) and crossbar height. Change both together.
- **Keep words in Markdown.** The header carries only the wordmark and `amon`. Copy
  that explains the product belongs in the README, where it stays readable when
  GitHub scales the image to a phone's width. The wordmark sets `textLength` so
  that system font fallbacks cannot overflow it.
- **Rebuild the ICO after editing `favicon.svg`.** Render it at exactly 16×16 and
  32×32 with a transparent background, for example with Playwright's Chromium.
  Check the 16 px render at 8× zoom; the A's counter must stay open. Then pack both
  PNGs into `favicon.ico`.
- **Wiring.** `frontend/index.html` links `/favicon.ico` (`sizes="16x16 32x32"`) and
  `/favicon.svg` (`sizes="any"`). Vite copies `frontend/public/` into the build and prefixes these
  root-relative URLs with the `/app/` base. Browsers with SVG favicon support
  generally prefer the SVG; others use the ICO.

## Accessibility floor

Body/secondary ≥ 4.5:1, large/numeric ≥ 3:1; all controls keyboard-reachable with a visible
focus ring (`:focus-visible` is wired in `app.css` base). No feature removed on mobile — adapt
(stack / drawer / popover) rather than `hidden`.
