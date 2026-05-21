# Skill-Invocation Telemetry — Developer Guide (SMI-5012)

Deep dive for developers extending or maintaining the telemetry pipeline. For the user-facing privacy notice, see `docs/privacy/skill-invocation-telemetry.md`.

**Implementation plan:** `docs/internal/implementation/skill-invoke-telemetry.md` — this file is in the private `docs/internal/` submodule; external contributors will not be able to follow the link, but internal developers can find it after running `git submodule update --init docs/internal`.

---

## Architecture

```
Claude Code hook (PreToolUse / PostToolUse)
  |
  v
~/.skillsmith/run/skill-start-<session>.json   (start-file written at PreToolUse)
  |
  v
PostToolUse hook reads start-file, computes duration_ms, emits payload
  |
  v
supabase/functions/events/index.ts             (ALLOWED_EVENTS allowlist enforced here)
  |
  +-- search_metrics table (Supabase Postgres)
  |
  +-- PostHog /i/v0/e/ (raw fetch, no posthog-node buffer)
```

Surface 2 (MCP tool calls) goes through `withTelemetry` HOF in `packages/mcp-server/src/`:

```
MCP dispatcher (e.g. get_skill)
  |
  v
withTelemetry(handler, 'skill_invoke')
  |
  v
Consent gate: reads user_telemetry_preferences via API key header
  |  (if disabled: skip; if enabled: continue)
  v
events edge function (same path as hook)
```

---

## Allowed events

The `ALLOWED_EVENTS` constant in `supabase/functions/events/index.ts` controls which event types the edge function accepts. Any event not in this set is rejected with HTTP 400.

```typescript
const ALLOWED_EVENTS = new Set([
  'skill_invoke',
  'skill_context_load',
  'skill_invoke_unparsed',
]);
```

- `skill_invoke` — a skill was fully loaded and executed
- `skill_context_load` — a `get_skill` MCP call retrieved skill context
- `skill_invoke_unparsed` — invocation detected but could not be attributed (quarantine; used for coverage diagnostics)

---

## Wire format

Full payload schema (all fields required unless noted):

```json
{
  "event": "skill_invoke",
  "anonymous_id": "<sha256 of UUID; annual rotation>",
  "metadata": {
    "skill_name": "linear",
    "skill_id": "smith-horn/linear",
    "source": "claude-code-hook",
    "framework": "claude-code",
    "session_id": "<framework session UUID>",
    "cwd_hash": "<sha256 of process cwd; workspace-cohort grouping>",
    "duration_ms": 1240,
    "tier": "team",
    "sdk_version": "0.7.2",
    "platform": "darwin",
    "is_subagent": false,
    "success": true
  }
}
```

Allowed enum values:

- `event` must be in `ALLOWED_EVENTS` (see above)
- `source` in `{ 'claude-code-hook', 'mcp-tool', 'cli', 'vscode-extension' }` for v1; `{ 'cursor-rule-beacon', 'agents-md-beacon', 'copilot-beacon' }` are v2
- `framework` in `{ 'claude-code', 'cursor', 'continue', 'cline', 'copilot', 'windsurf', 'codex', 'vscode', 'unknown' }`

**`cwd_hash` note (L1):** Groups invocations by anonymous project — enables "skills invoked across N distinct projects" cohort analysis without leaking file system paths. Used by `analytics_skill_top.framework_breakdown` extension in v2.

**Never captured:** `tool_input.args`, absolute paths, file paths, user identity beyond hashed `anonymous_id`, environment variables, file contents. These are enforced via the allowlist in the edge function, not via caller discipline.

---

## Consent gate flow

1. User visits `https://skillsmith.app/account/telemetry` (or runs `skillsmith telemetry enable`)
2. Web dashboard writes consent to `user_telemetry_preferences` table (keyed by `user_id`)
3. On each MCP request, the MCP server reads the preference via the API key header
4. `withTelemetry` HOF checks consent before emitting; if disabled, the handler executes normally but no event is sent
5. First-time MCP response for users without a preference includes `consent_required: true` + the privacy URL (`TELEMETRY_PRIVACY_URL = 'https://skillsmith.app/account/telemetry'`); no event is sent

**MCP-only users without an account:** Telemetry stays off permanently (default opt-out). The preference record is never created; `withTelemetry` short-circuits at the consent check.

**Environment override:** `SKILLSMITH_TELEMETRY_DISABLE=1` overrides all stored preferences and blocks all emissions. Checked in `withTelemetry` before the consent lookup.

---

## `withTelemetry` HOF

Location: `packages/mcp-server/src/telemetry/with-telemetry.ts`

Key design decisions (from plan-review):

- **Exported `Set<Function>` registry** (H3): the `withTelemetry` marker is an exported `Set` so arrow-const exports can be registered without function-object mutation
- **Per-request `framework` capture** (H4): `framework` is read inside `withTelemetry` on each call, not memoised at MCP session init — correct for HTTP transport where session context is not constant
- **Single HOF, no parallel definitions** (audit check): `audit:standards` Check 49 greps for a second `withTelemetry` definition; if found, CI fails

### Adding a new MCP dispatcher

1. Wrap the handler with `withTelemetry`:

```typescript
import { withTelemetry } from '../telemetry/with-telemetry.js';

export const myNewTool = withTelemetry(
  async (params, context) => { /* handler */ },
  'skill_invoke'
);
```

2. Update `DISPATCHER_MAP` in `packages/mcp-server/src/telemetry/telemetry-coverage.test.ts`:

```typescript
const DISPATCHER_MAP: Record<string, string> = {
  // ... existing entries ...
  my_new_tool: 'packages/mcp-server/src/tools/my-new-tool.ts',
};
```

CI will fail if a dispatcher is present in the tool list but absent from `DISPATCHER_MAP`. This is the coverage snapshot enforced by `audit:standards` Check 49.

---

## Hook contract (Claude Code)

The Claude Code hook is installed via `.claude/settings.json` under `Skill` matcher entries. It only fires when `SKILLSMITH_TELEMETRY_DOGFOOD=1` is set (or in production after the v1 full rollout).

**PreToolUse:** Writes a start-file to `~/.skillsmith/run/skill-start-<session_id>.json`:

```json
{ "skill_name": "...", "skill_id": "...", "session_id": "...", "started_at": 1234567890 }
```

**PostToolUse:** Reads the start-file, computes `duration_ms`, deletes the start-file, then POSTs the full payload to the `events` edge function.

**Malformed stdin:** If `jq` cannot parse stdin (e.g., framework sends unexpected shape), the hook exits 0 — no event is emitted and the skill invocation is not blocked.

**Run file location:** `~/.skillsmith/run/` — portable across reboots and respects user home-directory policies (per M8; NOT `/tmp/skillsmith-*`).

---

## Annual ID rotation

- Anonymous IDs rotate automatically once per year
- A one-week overlap window accepts both old and new IDs so no events are lost during the transition
- Rotation policy and the manifest schema are defined in `packages/core/src/telemetry/id-rotation.ts`
- Manual immediate rotation: `skillsmith telemetry reset-id`
- After reset, events under the old ID are permanently unlinked from future events (no re-linkage possible by design)

---

## `audit:standards` Check 49

Added in Wave 4 Step 4. Greps that previously lived in plan-review commentary are now re-executed on every PR:

- Assert `trackSkill*` event names exist in `packages/core/src/telemetry/posthog.ts` `SkillsmithEventType` union
- Assert `ALLOWED_EVENTS` in `supabase/functions/events/index.ts` includes all three telemetry event types
- Assert no parallel `withTelemetry` definition outside `with-telemetry.ts` (single source of truth)
- Assert `/tmp/skillsmith-` is not used anywhere (run files must live in `~/.skillsmith/run/`)

---

## PR history

This feature landed in four stacked PRs (branched sequentially per SMI-2597):

| PR | Wave | Contents |
|----|------|----------|
| PR-1 | W1 | Cloud foundations: migration, `user_telemetry_preferences`, `events` edge function, `search_metrics` extension |
| PR-2 | W2 | In-process wire: `withTelemetry` HOF, consent gate, PostHog raw-fetch |
| PR-3 | W3 | Hook + CLI: Claude Code settings hook, `skillsmith telemetry` commands |
| PR-4 | W4 | Smoke + dogfood + docs (this PR) |

Links will be added here once PRs are merged.

---

## Known gaps (v2 follow-ups)

| Gap | Tracking |
|-----|---------|
| CLI native invocation capture (non-MCP commands) | SMI-5040 |
| VS Code panel action capture (non-MCP surface) | SMI-5040 |
| EU data residency (PostHog EU project + Supabase EU replica) | U10 carry-over |
| DPA addendum text in privacy notice | U11 carry-over |
| AsyncLocalStorage multi-tenancy for `withTelemetry` in concurrent sessions | PR-2 wire-in deferred |
| Cursor `.mdc` / Copilot `.agents.md` beacons | v2 Surface 5-8 per plan Wave 5 |

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No events appear in PostHog | Verify `SKILLSMITH_TELEMETRY_DISABLE=1` is not set; run `skillsmith telemetry status` |
| `consent_required: true` always returned | User has no `user_telemetry_preferences` row; visit `https://skillsmith.app/account/telemetry` |
| Hook writes start-file but PostToolUse does not emit | Check `~/.skillsmith/run/` for orphaned start files; `jq` parse error exits 0 silently |
| `skill_invoke_unparsed` events only | Attribution heuristic failed; check `source` field — likely a framework not yet in the surface matrix |
| `ALLOWED_EVENTS` CI check failing | A new event type was added to a dispatcher but not added to the `ALLOWED_EVENTS` set in the edge function |
