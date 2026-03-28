# Code Review: SMI-3672 — Skill Content Rendering

**Date:** 2026-03-27
**Branch:** `feat/smi-3672-skill-content-rendering`
**Commit reviewed:** `e0b26c80`
**Reviewer:** Governance skill

---

## Summary

Adds SKILL.md content retrieval and rendering across the stack: `get_skill` MCP tool now
returns raw content via API (`include_content` param) or local DB (`raw_content` column),
VSCode detail panel renders markdown as sanitized HTML via `marked` + `sanitize-html`, and
a new CLI `info` command shows metadata + content.

---

## Checks Run

- `npm run typecheck` — PASS
- `npm run lint` — PASS (0 errors, 0 warnings)
- `npm run format:check` — PASS
- `npm test` — PASS (265 test files, 6753 tests)
- `npm run audit:standards` — PASS with warnings (pre-existing, unrelated to this PR)
- Manual file analysis of all 16 changed source files

---

## Findings

### Critical

None.

### Major

**[FIXED] Dead UI: `expandContentBtn` had no JS handler (skill-panel-html.ts, skill-panel-types.ts, SkillDetailPanel.ts)**

The truncated-content notice in `getContentHtml` rendered a `<button id="expandContentBtn">Show full content</button>` element, but:
- `getScript()` in `skill-panel-html.ts` had no `addEventListener` for `#expandContentBtn`
- `SkillPanelMessage` in `skill-panel-types.ts` only typed `'install' | 'openRepository'`
- `_handleMessage` in `SkillDetailPanel.ts` had no `expandContent` case

Clicking the button did nothing. Fixed by:
1. Adding `'expandContent'` to `SkillPanelMessage.command`
2. Adding `expandBtn.addEventListener` in `getScript()` that posts `{ command: 'expandContent' }`
3. Adding `expandContent` case in `_handleMessage` that sets `_showFullContent = true` and calls `_update()`
4. Adding `_showFullContent` instance variable (reset to `false` on new skill load)
5. Threading `showFullContent: boolean` parameter through `getSkillDetailHtml` → `getContentHtml`
6. Adding test coverage for the `showFullContent=true` path

**Fix commit:** `0f0b0ce0`

### Minor

None.

---

## Issues Fixed

**1 (commits: 0f0b0ce0)**

---

## Positive Observations

- XSS prevention is thorough: `sanitize-html` with explicit allowlists, `escapeHtml` on all user-controlled fields in the webview, `allowedSchemes: ['https', 'http']` blocks `javascript:` URLs. Tests verify script/iframe/event-handler stripping.
- Security tests are comprehensive for the new rendering path (11 test cases in `skill-panel-content.test.ts`).
- Content truncation at 10KB is a sensible default to avoid memory pressure in the webview.
- All new files are well under the 500-line limit.
- Type safety is clean throughout — no unjustified `any`, strict mode compliant.
- The `raw_content` column access in both `get-skill.ts` and `info.ts` is correctly wrapped in `try/catch` to handle pre-migration databases gracefully.
- `getContentHtml` is correctly extracted from `skill-panel-html.ts` into a companion file to stay under the 500-line limit.

---

## Status

PASS (1 major issue fixed in-place)
