---
version: alpha
name: "Apartment catalog: Minsk"
description: "Local apartment catalog with explainable purchase and renovation budgets"
colors:
  primary: "#17684d"
  background: "#f4f6f8"
  surface: "#ffffff"
  text: "#202c36"
  muted: "#74808d"
  border: "#e2e7ec"
  link: "#3269a7"
typography:
  sans:
    fontFamily: "Golos Text, Arial, sans-serif"
  data:
    fontFamily: "Golos Text, Arial, sans-serif"
rounded:
  DEFAULT: "5px"
  card: "7px"
spacing:
  detail-section: "24px"
  field-gap: "12px"
components:
  button:
    minHeight: "35px"
  ranking-action:
    minHeight: "42px"
---

# Design

## Source of truth
Active, 2026-11-10. Product surfaces: catalog, apartment detail and settings. Evidence: `web/src/styles.css`, `web/src/components/Detail.tsx`, `web/src/components/Settings.tsx`, personal-ranking design/specification and shared Zod contracts. Runtime CSS remains the token owner; this document mirrors it, not a generated theme. No rebrand is intended.

## Brand
A personal property comparison notebook: factual amounts, visible evidence and restrained forest-green emphasis. Trust comes from dates, sources, ranges and truthful unknowns. Avoid guaranteed savings, unverified renovation costs, decorative score badges and marketing language.

## Product goals
Explain purchase plus renovation and compare strict local alternatives. Preserve catalog order and notifications. New personal ranking remains a saved-result preview, with calculation launched separately. Success: the user can see unknown/stale data and save assumptions explicitly.

## Personas and jobs
A Russian-speaking buyer compares apartments in Minsk and nearby districts, revisits detail on desktop and phone, and adjusts renovation assumptions. This locale follows existing product content; no additional market or legal claims are inferred.

## Information architecture
Existing navigation remains catalog, favorites, searches, duplicates, collection status, settings. Apartment detail keeps its market assessment and gains a saved personal-ranking section. Settings has two independent forms: existing catalog preferences and personal-ranking assumptions.

## Design principles
Preserve established controls and density; disclose provenance before implying precision; separate viewing from calculation; preserve drafts on recoverable errors; use text plus color for states. The signature is a simple purchase/repair/total budget ledger, using a divider for the computed total.

## Visual language
Palette and typography mirror frontmatter and `web/src/styles.css` variables (`--green`, `--line`, `--muted`, `--blue`). Body uses Golos Text/Arial, data uses the same face with tabular numerals, and headings use restrained weight 600. New ranking text uses 14px with 1.6 line height, the score is 22px; no new fonts. White surfaces, thin separators, 5px controls and 7px cards match sibling screens. No motion is added. Lucide remains the icon owner.

## Components
The header and «Сбор» share one polling query for background jobs. The «Фоновые задачи» table shows running jobs and queued jobs in separate columns, preserves the last available counts on refresh errors, and keeps task names readable on mobile.

Reuse `.primary-button`, `.secondary-button`, `.settings-form`, `.settings-section`, `.detail-section` and `.table-scroll`. `PersonalRankingPanel` owns saved preview states; `PersonalRankingSettingsForm` owns explicit assumption editing. No new generic control library. Tables are read-only with captions and scoped headers. Budget entries use semantic definition lists.

Renovation settings support a dated, sourced USD/м² assumption with an explicit full/cosmetic scope. The existing field, radio, validation and save patterns own these controls. Matching USD assumptions precede BYN rates; reserve remains a separate percentage. Saved evidence identifies the rate, scope, source, date and reserve without implying an FX conversion or a labor/material split. Manual apartment budgets retain precedence.

The minimum comparable count uses the existing native numeric field and explicit-save flow. It accepts integers from 3 to 20, defaults to 5 for existing settings, and applies to personal-ranking previews only. A saved calculation displays its own threshold, including when stale; changing a draft never rewrites saved evidence. Copy notes that small samples produce less stable estimates.

## Accessibility
Target WCAG 2.2 AA for touched workflows: visible labels, keyboard-native controls, visible focus, error alerts and polite success status. Form validation uses inline messages and focuses the first invalid input; explicit save retains errors and draft data. Existing muted-color contrast outside this slice remains a legacy follow-up; no claim of a complete app accessibility audit.

## Responsive behavior
Reuse existing 760px mobile breakpoint. Budget entries stack and rate fields become one column below 500px. Actions wrap, amounts stay readable and no document-level horizontal overflow is allowed at 390px. Table scroll is local and scrollbar remains visible.

## Interaction states

The optional finished-repair zero-budget checkbox belongs to the existing ranking settings form and saves explicitly. The preview identifies zero renovation from this setting as a user rule, distinct from current photo approval. Unknown condition stays unknown; a manual apartment budget takes priority.
Saved preview: loading, retryable error, disabled, absent, stale, current, provisional and unknown-budget. Old evidence is labeled stale; opening a detail never computes or saves. Settings: loading, retryable failure, editing, validation error, pending save, saved. Saving one form leaves the other unchanged. Busy action dimensions remain stable; controls have native keyboard behavior.

## Content voice
Use Russian sentence case, concrete actions and familiar currency labels USD/BYN. Explain why a result is unavailable and how to recover. Ranges are estimates, not transaction prices or construction quotes. Use «предварительный», «неизвестно», «устарел» explicitly.

## Implementation constraints
React/TanStack Query, existing CSS, strict shared Zod schemas, Fastify and no new dependencies. Native radio/checkbox controls are canonical; date-only entry is typed ISO ГГГГ-ММ-ДД to avoid platform-calendar locale ambiguity. Existing native selects/time inputs remain platform-owned elsewhere. Screenshots and controlled browser tests must not mutate live catalog data.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | Existing settings-form styles and Zod contracts | Settings.tsx, PersonalRankingSettingsForm.tsx | explicit save, inline validation | tests/personalRankingBrowser.ts, tests/personalRankingApiIntegration.ts |
| Select/Listbox | Native platform select; radios for small fixed ranking choices | styles.css and settings controls | native | keyboard browser checks |
| Date | Typed ISO date in ranking; native time elsewhere | shared contracts and settings | typed, native | validation and browser checks |
| Scrollbar | Global styles.css baseline | styles.css | global normal and forced-colors | strict audit and narrow browser checks |
| Feedback | Inline status/alert within owning form | settings and ranking components | error, pending, success | controlled browser failure/retry |

## Open questions
- [ ] Owner: product. Accept shadow comparisons before stage 3, automatic enrichment or default sorting can be enabled.
- [ ] Owner: frontend. Audit legacy app-wide contrast and dialog focus management separately; this change does not establish full application conformance.
