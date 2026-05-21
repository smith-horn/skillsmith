# Skill-Invocation Telemetry — Privacy Notice

**Last updated:** 2026-05-19
**Applies to:** Skillsmith CLI v0.7+, Skillsmith MCP Server v0.7+, Claude Code hook

---

## Summary

Skill-invocation telemetry is **opt-in**. Nothing is sent until you explicitly enable it. The data collected is anonymous — there is no way for Skillsmith to link an event back to you as an individual. You can disable telemetry and rotate your anonymous ID at any time.

- Opt-in required before any data is sent
- No personal information is ever captured
- Your anonymous ID rotates automatically every year
- You can disable telemetry instantly with a single command or environment variable

---

## What is captured

When telemetry is enabled, each skill invocation sends a single JSON event. The complete set of fields is:

| Field | Example | Purpose |
|-------|---------|---------|
| `event` | `skill_invoke` | Event type discriminator |
| `anonymous_id` | `sha256-hash` | SHA-256 of a randomly generated UUID; not reversible to identity |
| `skill_name` | `linear` | Name of the invoked skill |
| `skill_id` | `smith-horn/linear` | Fully qualified skill ID |
| `source` | `claude-code-hook` | Which surface triggered the event |
| `framework` | `claude-code` | Agent framework where the skill was invoked |
| `session_id` | `<framework-uuid>` | Session UUID supplied by the agent framework |
| `cwd_hash` | `sha256-hash` | SHA-256 of the current working directory; groups invocations by anonymous project without revealing the path |
| `duration_ms` | `1240` | How long the skill invocation took in milliseconds |
| `tier` | `team` | Your Skillsmith subscription tier |
| `sdk_version` | `0.7.2` | Version of the Skillsmith SDK that emitted the event |
| `platform` | `darwin` | Operating system platform reported by Node.js |
| `is_subagent` | `false` | Whether the invocation came from a subagent context |
| `success` | `true` | Whether the skill invocation completed without error |

Three event types are emitted:

- `skill_invoke` — a skill was loaded and executed successfully
- `skill_context_load` — a skill's context was loaded (e.g., for a `get_skill` MCP call)
- `skill_invoke_unparsed` — a skill invocation was detected but could not be fully attributed (quarantine bucket; used for coverage diagnostics)

---

## What is NEVER captured

The following are explicitly excluded from all telemetry payloads and are never transmitted:

- `tool_input.args` — the arguments you passed to a skill or tool call
- Absolute paths — your local file system paths
- File paths — any path to a file on your machine
- User identity beyond the hashed `anonymous_id` — your name, email, IP address, or account details
- Environment variables — values from your shell environment
- File contents — contents of any file on your machine

These exclusions are enforced by an allowlist in the `events` edge function. Any field not in the allowlist above is stripped before the event is stored or forwarded to PostHog.

---

## Where data is stored

Telemetry events are written to Skillsmith's Supabase database (US region) and forwarded to PostHog for aggregated analytics.

**v1 data residency:** All telemetry is processed in the United States. EU customers can opt in, but data crosses the Atlantic. EU-region processing is planned for v2.

---

## How to enable telemetry

**CLI:**

```bash
skillsmith telemetry enable
```

**Web dashboard:** Visit [https://skillsmith.app/account/telemetry](https://skillsmith.app/account/telemetry) and toggle telemetry on.

**MCP-only users without a Skillsmith account:** Telemetry stays off by default. First-time MCP calls return a `consent_required: true` field with a link to the consent page above. Open the link, sign in or create a free account, and enable telemetry there.

---

## How to disable telemetry

Any of the following stops all telemetry immediately:

**CLI:**

```bash
skillsmith telemetry disable
```

**Environment variable panic switch** (overrides all settings, takes effect immediately):

```bash
export SKILLSMITH_TELEMETRY_DISABLE=1
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) to make it permanent.

**Web dashboard:** Visit [https://skillsmith.app/account/telemetry](https://skillsmith.app/account/telemetry) and toggle telemetry off.

---

## Anonymous ID

Your anonymous ID is a SHA-256 hash of a randomly generated UUID stored locally in `~/.skillsmith/config.json`. It is not linked to your name, email address, or Skillsmith account.

**Automatic rotation:** Your anonymous ID rotates automatically once per year. During the one-week overlap window, both the old and new IDs are accepted so no events are lost.

**Manual rotation:**

```bash
skillsmith telemetry reset-id
```

This generates a new random UUID immediately. Any historical events under the old ID become permanently unlinked from future events.

---

## What Skillsmith does with telemetry data

Telemetry data is used to:

- Rank skills by invocation frequency (not just install count)
- Help team admins understand which skills their team uses most
- Detect skills that are installed but never invoked (stale skill detection)
- Improve Skillsmith's recommendation engine

Telemetry data is **not** sold or shared with third parties outside of Skillsmith's infrastructure providers (Supabase, PostHog).

---

## Team and Enterprise considerations

**Team tier:** Admins can recommend that team members enable telemetry. Enabling remains optional for each individual.

**Enterprise tier (v2):** Enterprise admins will be able to require telemetry for members of their organization. This capability requires a signed Data Processing Addendum. Enterprise required-mode is deferred to v2.

Enterprise data processing addendum: contact support@smithhorn.ca

---

## Contact

Questions about this notice or telemetry data: support@smithhorn.ca

Consent settings: [https://skillsmith.app/account/telemetry](https://skillsmith.app/account/telemetry)
