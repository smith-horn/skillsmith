# Skill-Invocation Telemetry — Developer Guide (SMI-5012)

Deep dive for developers extending or maintaining the telemetry pipeline. For the user-facing privacy notice, see `docs/privacy/skill-invocation-telemetry.md`.

**Implementation plan:** `docs/internal/implementation/skill-invoke-telemetry.md` — this file is in the private `docs/internal/` submodule; external contributors will not be able to follow the link, but internal developers can find it after running `git submodule update --init docs/internal`.

---

## Architecture

```text
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

```text
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

## Surface coverage (v1)

All three in-process surfaces capture skill invocations via a `withTelemetry`
HOF that brands the wrapped handler so a per-tree coverage test can assert no
dispatcher ships unwrapped.

| Surface | Wrapper | `skill_id` form | Coverage test | Status |
|---------|---------|-----------------|---------------|--------|
| MCP tool dispatchers | `@skillsmith/core/telemetry` `withTelemetry` | bare tool name (`search`, `install_skill`) | `packages/mcp-server/src/tools/__meta__/telemetry-coverage.test.ts` (SMI-5018) | Captured |
| CLI command handlers (42 dispatchers) | `@skillsmith/core/telemetry` `withTelemetry` | bare action name (`search`, `config set`, `author init`) | `packages/cli/src/commands/__meta__/telemetry-coverage.test.ts` (SMI-5040 + SMI-5128/5129) | Captured |
| VS Code panel actions (4) | `packages/vscode-extension/src/services/telemetry-wrap.ts` (local; emits `vscode_skill_invoke` via `services/Telemetry.ts`) | CLI-aligned action name (`search`/`install`/`remove`/`create`) | `packages/vscode-extension/src/commands/__meta__/telemetry-coverage.test.ts` (SMI-5130) | Captured |
| Claude Code hook (PreToolUse/PostToolUse) | start-file + hook (not a HOF) | registry `author/name` (`smith-horn/linear`) | n/a | Captured |

### `skill_id` contract (surface-specific)

`skill_id` is **not** uniformly `author/name` — it is the natural identifier for each surface (see the matrix). Only the **Claude Code hook** captures a registry skill, so only it uses `author/name`. The tool surfaces emit the tool/command being invoked:

- **CLI + VS Code emit the same bare action name** (SMI-5143), so the *same* action correlates across surfaces, distinguished only by the `source` field — e.g. `{skill_id:'search', source:'cli'}` vs `{skill_id:'search', source:'vscode-extension'}`.
- **VS Code `uninstall` → `'remove'`**: the CLI's canonical command is `remove` (`uninstall` is an alias), so `'remove'` is the shared correlation key. The MCP tool stays `uninstall_skill` (distinct — MCP tool names are not normalized).
- Downstream analytics RPCs aggregate on `metadata.skill_name`, not `skill_id`, so this is forward-looking correlation (not a reporting dependency today).

**`vscode_skill_invoke` is the canonical VS Code invocation count.** Every panel action emits it (uniform). The granular `vscode_create_*` / `vscode_uninstall_*` events are *funnel detail* for those two flows — do **not** sum `vscode_*` to count invocations (that double-counts create/uninstall); count `vscode_skill_invoke` alone.

**Why VS Code uses a local wrapper (SMI-5130):** the extension is bundled
standalone via `esbuild --bundle` for the Marketplace. Importing the core HOF
would inline `posthog-node` + the full OpenTelemetry SDK into the bundle (OTel's
dynamic requires also break esbuild). The local wrapper mirrors the
`withTelemetry`/`isTelemetered` contract but emits through the extension's own
`track()`, which self-gates on `vscode.env.isTelemetryEnabled` +
`skillsmith.telemetry.enabled` + a configured `telemetryEndpoint`.

### `<command>.action.ts` sibling-split convention (SMI-5127+)

When wrapping a command handler pushes its source file over the 500-line
`audit:standards` gate, extract the action impl(s) + their `withTelemetry`
exports into a sibling `<command>.action.ts`; the original file keeps the
commander factory and imports the wrapped actions. Established for `sync`/`search`
(SMI-5127) and reused for `telemetry` (SMI-5128) and `author/init` (SMI-5129).
The coverage map keys the sibling base (e.g. `'sync.action'`,
`'telemetry.action'`, `'author/init.action'`). Keep the heavy logic and the
factory split one-directional (impl file imports the logic file) to avoid an
import cycle.

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
    "success": true,
    "agent_session": false,
    "nudge_origin": false,
    "trigger_id": null
  }
}
```

> The example above is a **`claude-code-hook`** payload, so its `skill_id` is the registry `author/name`. `skill_id` is **surface-specific** — see [`skill_id` contract](#skill_id-contract-surface-specific). For tool surfaces it is the tool/command name (`'search'`, `'config set'`), not `author/name`.

### Agent-mediation marker fields (SMI-5456)

Three net-new per-event fields distinguish agent-mediated invocations (the Wave-1 mediation gate). They are non-identifying — per-event booleans + one opaque id — so the annual ID-rotation policy is unaffected.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `agent_session` | boolean | `false` | The invocation is part of an agent-mediated session (the portable agent pack routed it). |
| `nudge_origin` | boolean | `false` | The invocation originated from a nudge (job-9 onboarding), not an organic ask. |
| `trigger_id` | string \| null | `null` | Paywall / nudge trigger id when the call is attributable to one. |

Allowed enum values:

- `event` must be in `ALLOWED_EVENTS` (see above)
- `source` in `{ 'claude-code-hook', 'mcp-tool', 'cli', 'vscode-extension' }` for v1; `{ 'cursor-rule-beacon', 'agents-md-beacon', 'copilot-beacon' }` are v2
- `framework` in `{ 'claude-code', 'cursor', 'continue', 'cline', 'copilot', 'windsurf', 'codex', 'vscode', 'opencode', 'hermes', 'unknown' }` (`opencode` + `hermes` added in SMI-5456 for the Tier-2 harnesses)

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

The SMI-5456 marker fields ride the same gate: they are attached to the `skill_invoke` event *inside* `withTelemetry`, so a suppressed gate emits nothing — no separate consent path exists for them (consent parity).

---

## Agent-mediation marker channel (SMI-5456)

The MCP server resolves the three marker fields per tool call from two channels. Code: `packages/core/src/telemetry/agent-marker.ts` (resolver + reader) and `packages/mcp-server/src/index.ts` (`CallToolRequestSchema` dispatch runs each call inside `runWithMarkerContext`, an `AsyncLocalStorage` scope — concurrency-safe under the parallel tool calls harnesses batch routinely, so one call's completion can never clear another in-flight call's marker).

**Precedence (per field): `_meta` wins → else the session marker file → else the neutral default.**

1. **MCP `_meta`** (spec-clean, wins when present). The server reads `agent_session` / `nudge_origin` / `trigger_id` off `request.params._meta` (a loose passthrough schema on SDK 1.29.0). Values are validated defensively — a wrong type or junk key is dropped. As of Wave 1 **no Tier-1 harness can inject `_meta` on a genuine agent tool call** (Step-0 spike: hooks only mutate `arguments`, the model has no `_meta` schema affordance), so this is forward-looking infrastructure that activates the day a harness ships native support.

2. **Session marker file** (PRIMARY channel for Wave 1). A harness `SessionStart` hook writes a JSON file under `~/.skillsmith/agent-markers/<session_id>.json`. The server treats the directory as **read-only** — it never writes, updates, or deletes files (hook cleanup at `SessionEnd` is the primary staleness control). The reader selects the freshest **non-expired** marker.

   ```json
   {
     "schema": 1,
     "session_id": "<harness session id>",
     "started_at": 1720000000000,
     "harness": "claude-code",
     "agent_session": true,
     "nudge_origin": false,
     "trigger_id": null
   }
   ```

   - `session_id` (string, required) + `started_at` (epoch-ms, required) — a file missing either is treated as corrupt and ignored.
   - `agent_session` defaults **true** for a valid marker (presence ⇒ agent session); set `false` to opt out.
   - `nudge_origin` defaults false; `trigger_id` defaults null.
   - **TTL = 12h** (`AGENT_MARKER_TTL_MS`), measured from `started_at`. Rationale: comfortably spans a long interactive working day so a live session is never expired mid-flight, while a marker left by a crashed session cannot mislabel invocations a day later. A missing / corrupt / expired file is simply "no marker" — never an error.
   - **Wave-1 correlation caveat:** the server cannot know its own harness session id, so it picks the most recently started live marker. Concurrent sessions on one machine may observe each other's marker — an accepted, documented imprecision (`_meta` is exact and wins). `SKILLSMITH_AGENT_MARKER_DIR` overrides the directory (test isolation; mirrors `SKILLSMITH_CACHE_DIR_OVERRIDE`).

3. **Neither** ⇒ `agent_session=false`, `nudge_origin=false`, `trigger_id=null`.

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
