/**
 * SMI-5393 (umbrella SMI-5382): view-model for the /account/skills inventory page.
 *
 * Transforms `get_user_inventory()` RPC rows into {@link DeviceView} objects that
 * the Astro page renders. All display logic lives here; the .astro template
 * handles layout only — this module owns no HTML.
 */

// ─── RPC row shape ────────────────────────────────────────────────────────────

/** Raw row returned by the `get_user_inventory()` PostgREST RPC (snake_case columns). */
export interface InventoryRow {
  device_id: string
  device_label: string | null
  hostname_display: string | null
  platform: string | null
  device_last_seen: string
  device_state: 'fresh' | 'stale'
  harness: string | null
  skill_id: string | null
  version: string | null
  present: boolean | null
  pinned: boolean | null
  registry_hash: string | null
  skill_state:
    | 'current'
    | 'drifted'
    | 'missing'
    | 'pinned'
    | 'unknown'
    | 'local'
    | 'source-identified'
    | null
  /** Skill author. Registry-verified for matched states; self-asserted for source-identified. */
  author: string | null
  /** Repository URL. Registry-verified for matched states; self-asserted for source-identified. */
  repository: string | null
  /** License identifier from the registry or the skill's own front-matter. */
  license: string | null
}

// ─── View model types ─────────────────────────────────────────────────────────

/**
 * Possible lifecycle states for a skill entry on a device.
 *
 * Terminal states emitted by the RPC: current | drifted | missing | pinned | unknown |
 * local | source-identified.
 * Display-only (never emitted by the RPC): pending — shown while resolution is underway.
 */
export type SkillState =
  | 'current'
  | 'drifted'
  | 'missing'
  | 'pinned'
  | 'unknown'
  | 'local'
  | 'source-identified'
  | 'pending'

/** A single resolved skill entry on a device. */
export interface SkillView {
  /** Harness identifier (e.g. "zed", "cursor"). Empty string when not reported. */
  harness: string
  /** Registry skill ID. */
  skillId: string
  version: string | null
  /** Whether the skill file is present on disk in the latest sync. */
  present: boolean
  /** Whether the skill is pinned; drift checks are suppressed for pinned skills. */
  pinned: boolean
  state: SkillState
  /**
   * Skill author. For registry-matched states this is registry-verified.
   * For `source-identified` this is self-asserted from the skill's own front-matter.
   */
  author: string | null
  /**
   * Repository URL. Registry-verified for current/drifted/missing/pinned.
   * Self-asserted (unverified) for `source-identified`.
   */
  repository: string | null
  /** License identifier from the registry or the skill's front-matter. */
  license: string | null
}

/** A device row, expanded with its resolved skill list. */
export interface DeviceView {
  deviceId: string
  label: string | null
  hostnameDisplay: string | null
  platform: string | null
  /** ISO 8601 timestamp of the most recent sync. */
  lastSeen: string
  deviceState: 'fresh' | 'stale'
  /** True when the device has registered but has never completed a skill sync. */
  neverSynced: boolean
  skills: SkillView[]
}

/**
 * Page-level empty-state classifier. Controls which prompt the
 * `/account/skills` page renders instead of the comparison table.
 *
 * | consent | devices | state |
 * |---------|---------|-------|
 * | false   | any     | consent-off |
 * | true    | 0       | opted-in-no-devices |
 * | true    | 1       | single-machine |
 * | true    | ≥2      | populated |
 */
export type EmptyState = 'consent-off' | 'opted-in-no-devices' | 'single-machine' | 'populated'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Staleness horizon in hours. Matches the RPC's default `p_stale_after` parameter
 * value of `INTERVAL '24 hours'` — the single source of truth shared between the
 * database and the UI tooltip copy.
 */
export const STALE_AFTER_HOURS = 24

/**
 * Human-readable label, one-line tooltip, and suggested next action for each
 * {@link SkillState}. The `.astro` component maps each state to an
 * icon/shape; this module owns only the text.
 *
 * `suggestedAction` may contain inline-code spans delimited by backtick
 * pairs (`` ` ``...`` ` ``), which the renderer converts to `<code>` tags.
 * The literal placeholder token `<skill>` (inside a backtick span) appears
 * only in the `drifted` and `pinned` entries and is substituted by the
 * renderer with the real skill ID. `suggestedAction` is `null` when a state
 * has no actionable next step.
 */
export const SKILL_STATE_META: Record<
  SkillState,
  { label: string; description: string; suggestedAction: string | null }
> = {
  current: {
    label: 'Up to date',
    description: 'Up to date with the registry',
    suggestedAction: 'No action needed.',
  },
  drifted: {
    label: 'Update available',
    description: 'A newer version is available in the registry',
    suggestedAction: 'Run `skillsmith update <skill>` on that machine.',
  },
  missing: {
    label: 'Missing',
    description: 'Installed before but not seen in the latest sync',
    suggestedAction:
      'Confirm the skill is still installed, then re-run `skillsmith inventory push` from that machine — or reinstall it if it was removed intentionally.',
  },
  pinned: {
    label: 'Pinned',
    description: 'Pinned to a version; drift checks suppressed',
    suggestedAction:
      'No action needed. Run `skillsmith unpin <skill>` if you want drift checks again.',
  },
  unknown: {
    label: 'Unknown',
    description: 'Not matched to a registry skill (local or custom)',
    suggestedAction:
      'No action needed — expected for skills you wrote yourself or installed outside the registry.',
  },
  local: {
    label: 'Local',
    description: 'Installed locally; no registry or declared source',
    suggestedAction:
      "No action needed. Add `author`, `repository`, and `license` front-matter to the skill's `SKILL.md` if you'd like it to show as Claimed source instead.",
  },
  'source-identified': {
    label: 'Claimed source',
    description: "Source declared in the skill's own metadata (not registry-verified)",
    suggestedAction:
      "No action needed — the author/repository shown is self-reported and hasn't been verified by the registry. It would show as a verified source if the skill is published to the registry (`skillsmith publish`).",
  },
  pending: {
    label: 'Checking…',
    description: 'Resolving source — check back shortly',
    suggestedAction: 'None — this is a transient state. Refresh the page in a few seconds.',
  },
}

// ─── View-model builder ───────────────────────────────────────────────────────

/**
 * Group `get_user_inventory()` rows into {@link DeviceView} objects.
 *
 * Preserves the RPC's row ordering (typically most-recently-seen device first).
 * A device whose only row has `skill_id = null` is "never-synced": its `skills`
 * array is empty and `neverSynced` is set to `true`. Rows with a `null`
 * `skill_state` are the "no skills yet" sentinel — they are dropped when building
 * the skills list.
 *
 * @param rows - Raw rows returned by `get_user_inventory()`.
 * @returns One {@link DeviceView} per distinct `device_id`, in RPC order.
 *
 * @example
 * const devices = buildInventoryView(rpcRows)
 * const hasSkills = devices.some(d => d.skills.length > 0)
 */
export function buildInventoryView(rows: InventoryRow[]): DeviceView[] {
  // Map preserves insertion order, which mirrors the RPC's device ordering.
  const byDevice = new Map<string, DeviceView>()

  for (const row of rows) {
    if (!byDevice.has(row.device_id)) {
      byDevice.set(row.device_id, {
        deviceId: row.device_id,
        label: row.device_label,
        hostnameDisplay: row.hostname_display,
        platform: row.platform,
        lastSeen: row.device_last_seen,
        deviceState: row.device_state,
        neverSynced: false, // resolved in the post-pass below
        skills: [],
      })
    }

    const device = byDevice.get(row.device_id)!

    // Null skill_id or null skill_state marks the "no skills yet" sentinel row.
    if (row.skill_id !== null && row.skill_state !== null) {
      device.skills.push({
        harness: row.harness ?? '',
        skillId: row.skill_id,
        version: row.version,
        present: row.present ?? false,
        pinned: row.pinned ?? false,
        state: row.skill_state,
        author: row.author ?? null,
        repository: row.repository ?? null,
        license: row.license ?? null,
      })
    }
  }

  // Post-pass: a device with no skills after processing all rows was never synced.
  for (const device of byDevice.values()) {
    if (device.skills.length === 0) {
      device.neverSynced = true
    }
  }

  return Array.from(byDevice.values())
}

// ─── Device-wide batch tips ───────────────────────────────────────────────────

/**
 * Copy shown when a device has multiple drifted skills, suggesting a single
 * batch-update command instead of updating each skill individually.
 */
export const DEVICE_BATCH_UPDATE_TIP =
  'Multiple skills on this machine have updates — run `skillsmith update --all` to update everything at once.'

/**
 * Decide whether to show the {@link DEVICE_BATCH_UPDATE_TIP} for a device.
 *
 * Threshold is evaluated **device-wide, across all harnesses** — not
 * per-harness. A device with one `drifted` skill under `claude-code` and one
 * `drifted` skill under `cursor` still crosses the threshold, because
 * `skillsmith update --all` operates on the whole machine, not a single
 * harness. Callers must pass the full flat list of a device's skills
 * (i.e. call this *before* any per-harness grouping) — grouping first and
 * calling this per-harness-group would undercount and suppress the tip.
 *
 * @param skills - All skills for a single device, across every harness.
 * @returns {@link DEVICE_BATCH_UPDATE_TIP} when 2 or more skills are
 *   `drifted`; otherwise `null`.
 *
 * @example
 * computeDeviceBatchTip(device.skills) // => tip string or null
 */
export function computeDeviceBatchTip(skills: SkillView[]): string | null {
  const driftedCount = skills.filter((s) => s.state === 'drifted').length
  return driftedCount >= 2 ? DEVICE_BATCH_UPDATE_TIP : null
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format a past ISO 8601 timestamp as a short human-readable relative string.
 *
 * Buckets (evaluated in order, smallest delta first):
 * - `"just now"` when delta < 60 s
 * - `"N minute(s) ago"` when delta < 60 min
 * - `"N hour(s) ago"` when delta < 24 h
 * - `"N day(s) ago"` when delta < 7 days
 * - `"YYYY-MM-DD"` (UTC) for everything older
 *
 * Returns the original string unchanged for invalid ISO input.
 *
 * @param iso - ISO 8601 timestamp string (UTC).
 * @param now - Current time as milliseconds since epoch. Injected so tests are
 *   deterministic; pass `Date.now()` in production.
 *
 * @example
 * formatRelativeTime('2026-06-26T11:59:30.000Z', Date.now()) // => 'just now'
 */
export function formatRelativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso

  const sec = Math.floor((now - then) / 1000)
  if (sec < 60) return 'just now'

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`

  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`

  const days = Math.floor(hr / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`

  // Older than 7 days — render as YYYY-MM-DD in UTC to avoid timezone jitter in SSR.
  const d = new Date(iso)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Format an ISO 8601 timestamp as a full, locale-aware date/time string for
 * use in a tooltip (`title=` attribute). The output is intentionally verbose
 * and includes the timezone abbreviation.
 *
 * Returns the original string unchanged for invalid ISO input.
 *
 * @param iso - ISO 8601 timestamp string.
 *
 * @example
 * formatAbsoluteTime('2026-06-26T12:00:00.000Z') // => "June 26, 2026 at 12:00 PM UTC"
 */
export function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// ─── Page-level empty-state detection ────────────────────────────────────────

/**
 * Classify the inventory page's empty-state based on user consent and the
 * number of devices the RPC returned.
 *
 * - `consent-off` — consent is disabled; show the opt-in prompt regardless of
 *   device count (the RPC returns no rows when consent is off, but the caller
 *   may know the count from a separate source).
 * - `opted-in-no-devices` — consent is on but no devices have ever registered.
 * - `single-machine` — exactly one device; show a "push from another machine"
 *   nudge because the cross-device comparison value needs at least two devices.
 * - `populated` — two or more devices; render the comparison table.
 *
 * @param consentEnabled - Whether the user has enabled inventory sync.
 * @param deviceCount - Number of distinct devices returned by the RPC.
 */
export function detectEmptyState(consentEnabled: boolean, deviceCount: number): EmptyState {
  if (!consentEnabled) return 'consent-off'
  if (deviceCount === 0) return 'opted-in-no-devices'
  if (deviceCount === 1) return 'single-machine'
  return 'populated'
}
