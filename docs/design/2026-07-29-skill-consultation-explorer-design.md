# Skill Consultation Explorer

Date: 2026-07-29
Status: Approved

## Problem

Skill consultation telemetry has outgrown the Analytics Overview. A normal
multi-harness slice can contain more than one hundred skill rows, so rendering
the complete evidence ledger inline pushes the remaining overview panels far
below the fold. Collapsing each row does not solve the page-level hierarchy.

## Direction

Treat Overview as an index and a dedicated Skills sub-view as the evidence
ledger.

The Overview panel remains bounded and glanceable:

- summarize each selected harness;
- show at most six skill rows, distributed across harnesses when more than one
  harness is selected;
- rank the preview by consultation volume;
- keep preview rows non-expandable;
- provide one prominent route into the complete explorer.

The Skills sub-view owns detailed inspection:

- retain the shared date, project, and agent filters;
- add local harness, skill-name, signal, and sort controls;
- preserve separate harness lanes when detection semantics are not directly
  comparable;
- keep skill rows expandable for version, project, coverage, and exposure
  evidence;
- render an initial result tranche and progressively reveal more rows.

## Interaction Contract

- `#analytics?view=skills` is the canonical explorer route.
- The Overview action switches to that route without losing shared filters.
- Explorer harness, name, signal, and sort choices ride the same hash so the
  inspected evidence slice is linkable.
- Harness choices are derived from returned data rather than hard-coded.
- Signal filters describe observed evidence without assigning outcome value:
  first read, rehydrated, presented without first read, and unclassified.
- Empty filtered results explain that the local explorer filters produced no
  matches and offer a reset.
- A shared agent filter that selects one harness does not leave misleading
  cross-harness comparison controls or messaging behind.

## Visual Thesis

The panel is an instrument register, not a card collection. Hairlines, compact
numeric columns, provider dots, and restrained type carry the hierarchy. The
Overview preview reads as a short index; the explorer reads as a filterable
ledger. No nested card grid, decorative color, or floating overlay is added.

## Verification

- Route-state tests cover the new Skills view.
- Built-runtime E2E proves the Overview is bounded, navigation preserves the
  shared slice, explorer filters alter visible evidence, and expandable detail
  remains keyboard-accessible.
- Frontend type checking, production build, lint, and the full test suite pass.
- Desktop and narrow layouts are inspected against the live built surface.
