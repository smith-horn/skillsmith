/**
 * A6 renderers — per-harness SessionStart / SessionEnd hook scripts.
 *
 * These are the artifacts that WRITE the agent-mediation marker file the server
 * reads (`telemetry/agent-marker.ts`). They honor that contract exactly:
 *  - one file per session at `~/.skillsmith/agent-markers/<session_id>.json`
 *    (override via `SKILLSMITH_AGENT_MARKER_DIR`, same knob the server reads);
 *  - atomic write (temp + rename), never a read-modify-write of a shared file;
 *  - required keys `session_id` (non-empty) + `started_at` (epoch-ms), snake_case;
 *  - `agent_session` true, `nudge_origin`/`trigger_id` set by the capped nudge;
 *  - SessionEnd deletes the session's own file (the server's 12h TTL only
 *    backstops a crash).
 *
 * Constraints: self-contained POSIX sh, no dependency on the skillsmith CLI (or
 * any project binary) being on PATH — `jq` is used when present and degraded to
 * a `sed` extraction otherwise. Every path exits 0: a hook must never fail the
 * user's session. The session id is sanitized to `[A-Za-z0-9._-]` so it is safe
 * as both a JSON value and a filename with zero escaping.
 *
 * Hooks are generated only for harnesses with a real SessionStart shell hook
 * ({@link HOOK_HARNESSES}); Hermes has none (spike verified absent) and Windsurf
 * has no hook system.
 */

import { AGENT_MARKER_SCHEMA_VERSION } from '../../telemetry/agent-marker.js'
import type { HarnessId } from './types.js'

/** Onboarding nudge line (job 9). Static — the hook has no CLI to count with. */
const NUDGE_TEXT =
  'The Skillsmith Agent is available. Ask it to audit your skills, check what is outdated, or vet a skill before you install it.'

/** Nudge cooldown: at most one onboarding nudge per ~20h so organic (non-nudged) sessions still occur. */
const NUDGE_COOLDOWN_SECONDS = 72000

/**
 * Shared session-id resolution block: prefer jq, fall back to a POSIX sed
 * match, then a generated id; finally sanitize to a filesystem- and JSON-safe
 * charset. Emitted into both hook scripts so extraction stays identical.
 */
function sessionIdBlock(): string {
  return [
    'input=$(cat 2>/dev/null || true)',
    'sid=""',
    'if command -v jq >/dev/null 2>&1; then',
    "  sid=$(printf '%s' \"$input\" | jq -r '.session_id // empty' 2>/dev/null || true)",
    'fi',
    'if [ -z "$sid" ]; then',
    '  sid=$(printf \'%s\' "$input" | sed -n \'s/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | head -n 1)',
    'fi',
    'if [ -z "$sid" ]; then',
    '  sid="unknown-$(date +%s 2>/dev/null || echo 0)-$$"',
    'fi',
    "sid=$(printf '%s' \"$sid\" | tr -c 'A-Za-z0-9._-' '_')",
  ].join('\n')
}

/** Common header + opt-out + marker-dir resolution. */
function commonHeader(kind: 'SessionStart' | 'SessionEnd', harness: HarnessId): string {
  return [
    '#!/bin/sh',
    `# Skillsmith Agent - ${kind} hook (${harness}). Generated; do not edit by hand.`,
    '# Writes/removes the agent-mediation marker file (SMI-5456). Self-contained',
    '# POSIX sh, no CLI dependency; every path exits 0 so it never fails a session.',
    // -u: fail fast on unset vars (caught defensively below, never propagates).
    // -C: noclobber - a plain `>` refuses to write through a pre-existing path
    // (including an attacker-planted symlink) at the temp-file names below,
    // which have a guessable $$-based name if SKILLSMITH_AGENT_MARKER_DIR is
    // ever pointed at a shared/multi-tenant directory. /dev/null and other
    // non-regular-file targets are exempt from noclobber, so the `2>/dev/null`
    // redirects throughout are unaffected.
    'set -uC',
    // HOME is the only variable this script reads without a shell-level
    // default; guard it explicitly so a stripped-down invocation environment
    // (HOME unset) cannot trip `set -u` and abort before reaching `exit 0`.
    'HOME="${HOME:-/tmp}"',
    // The disable branch must DRAIN stdin before exiting: every other path
    // reads stdin to EOF via `input=$(cat ...)`, and an exit while the harness
    // (or execFileSync in tests) is still writing the stdin payload races into
    // EPIPE on the writer's side. `/dev/null` is exempt from noclobber (-C).
    'if [ "${SKILLSMITH_AGENT_HOOK_DISABLE:-}" = "1" ]; then cat >/dev/null 2>&1 || true; exit 0; fi',
    'MARKER_DIR="${SKILLSMITH_AGENT_MARKER_DIR:-$HOME/.skillsmith/agent-markers}"',
  ].join('\n')
}

/** Render the SessionStart hook for a harness (writes the marker + capped nudge). */
export function renderSessionStartHook(harness: HarnessId): string {
  const lines = [
    commonHeader('SessionStart', harness),
    'NUDGE_STATE="${SKILLSMITH_AGENT_NUDGE_STATE:-$HOME/.skillsmith/agent-nudge.state}"',
    `NUDGE_COOLDOWN_SECONDS=${NUDGE_COOLDOWN_SECONDS}`,
    `HARNESS="${harness}"`,
    `SCHEMA=${AGENT_MARKER_SCHEMA_VERSION}`,
    '',
    sessionIdBlock(),
    '',
    'now_s=$(date +%s 2>/dev/null || echo 0)',
    'started_ms=$(( now_s * 1000 ))',
    '',
    '# Nudge eligibility, capped by a cooldown stamp. A rare concurrent',
    '# double-nudge across simultaneous sessions is acceptable (documented).',
    'show_nudge=1',
    'if [ -f "$NUDGE_STATE" ]; then',
    '  last=$(cat "$NUDGE_STATE" 2>/dev/null || echo 0)',
    '  case "$last" in ""|*[!0-9]*) last=0 ;; esac',
    '  if [ $(( now_s - last )) -lt "$NUDGE_COOLDOWN_SECONDS" ]; then show_nudge=0; fi',
    'fi',
    '',
    'if [ "$show_nudge" -eq 1 ]; then',
    '  nudge_origin=true',
    '  trigger_id=\'"onboarding.session_start"\'',
    'else',
    '  nudge_origin=false',
    '  trigger_id=null',
    'fi',
    '',
    'mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0',
    'tmp="$MARKER_DIR/.$$.$now_s.tmp"',
    'printf \'{"schema":%s,"session_id":"%s","started_at":%s,"harness":"%s","agent_session":true,"nudge_origin":%s,"trigger_id":%s}\\n\' \\',
    '  "$SCHEMA" "$sid" "$started_ms" "$HARNESS" "$nudge_origin" "$trigger_id" > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }',
    'mv -f "$tmp" "$MARKER_DIR/$sid.json" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }',
    '',
    'if [ "$show_nudge" -eq 1 ]; then',
    '  nudge_tmp="$NUDGE_STATE.$$.tmp"',
    '  mkdir -p "$(dirname "$NUDGE_STATE")" 2>/dev/null || true',
    '  printf \'%s\' "$now_s" > "$nudge_tmp" 2>/dev/null && mv -f "$nudge_tmp" "$NUDGE_STATE" 2>/dev/null || rm -f "$nudge_tmp" 2>/dev/null',
    `  echo "${NUDGE_TEXT}"`,
    'fi',
    '',
    'exit 0',
    '',
  ]
  return lines.join('\n')
}

/** Render the SessionEnd hook for a harness (deletes this session's marker). */
export function renderSessionEndHook(harness: HarnessId): string {
  const lines = [
    commonHeader('SessionEnd', harness),
    '',
    sessionIdBlock(),
    '',
    'rm -f "$MARKER_DIR/$sid.json" 2>/dev/null',
    'exit 0',
    '',
  ]
  return lines.join('\n')
}
