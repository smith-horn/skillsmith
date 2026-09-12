/**
 * SMI-5895 (Wave 2 Step 1) + ADR-139 (SMI-6274 Wave 4): pure helpers for
 * `manage.update.ts`'s `getSkillDiff`/`updateSkill` — split out to stay
 * under the 500-line standard once ADR-139's scope-aware filtering pushed
 * `manage.update.ts` past it.
 */

import { basename } from 'path'
import {
  SkillRepository,
  ManifestManager,
  adoptUntrackedSkillEntry,
  manifestKeyFor,
  type Skill,
  type SkillManifestEntry,
} from '@skillsmith/core'
import { getInstalledSkillsForClient, type InstalledSkill } from '../utils/skills-directory.js'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { loadManifest } from '../utils/manifest.js'
import { createApiBackedRegistryLookup } from './install.js'
import { CANONICAL_CLIENT, type ClientId, type ScopedInstallTarget } from '@skillsmith/core/install'
import { recoverConfidentSourceId, readClaimedAuthor } from './manage.update.recovery.js'

/**
 * ADR-139 (SMI-6274 Wave 4): the `installedVia` label an entry from
 * `getInstalledSkillsForClient` carries for `client`'s OWN installs —
 * `'local'` for the canonical client (SMI-1630 convention), else `client`
 * itself. Local duplicate of the identical helper in `manage.action.ts`
 * (not imported from there — that module imports FROM this file's sibling
 * `manage.update.ts`, so importing back would be circular); both must stay
 * in sync if this mapping ever changes.
 */
export function installedViaFor(client: ClientId): ClientId | 'local' {
  return client === CANONICAL_CLIENT ? 'local' : client
}

/**
 * Extended Skill type with optional version field.
 * Used for type-safe version comparisons in getSkillDiff.
 */
export interface SkillWithVersion extends Skill {
  version?: string
}

// ADR-139 (SMI-6274 Wave 4) adoption note: the race-safe untracked-skill
// adoption write that used to live here (`adoptUntrackedSkill`) was moved to
// `@skillsmith/core` (`adoptUntrackedSkillEntry`, exported alongside
// `buildAdoptedManifestEntry` from `skill-installation.uninstall.ts`) in
// GPT-5.6-Sol PR review round 4 — `performUninstall` (core) had its OWN,
// still-non-race-safe inline copy of this same logic, and importing a CLI
// file into `core` to consolidate onto this one would have been a layering
// violation. `getSkillDiff` below imports `adoptUntrackedSkillEntry`
// directly from `@skillsmith/core` instead of calling a wrapper in this file.

/** Resolved diff/update target for a single installed skill. */
export interface SkillDiff {
  /** Full `author/name` registry ID to pass to SkillInstallationService.install(). */
  skillId: string
  oldVersion: string | null
  newVersion: string | null
  changes: string[]
  /**
   * SMI-6343 (Wave 3, H5): the manifest entry CURRENTLY installed under this
   * name/client — i.e. the one `install(force: true)` is about to overwrite.
   * Always populated alongside a real `SkillDiff` (every return branch below
   * has already resolved `manifestEntry` by this point, via either a direct
   * lookup or ADR-139's untracked-skill adoption). Consumed by `updateSkill`'s
   * pre-install contradiction gate (`manage.update.identity.ts`).
   */
  currentEntry: SkillManifestEntry
  /**
   * SMI-6343 (Wave 3, H5): registry author/name ALREADY obtained while
   * resolving this diff — reused directly for the pre-install gate's signal
   * 2 (front-matter contradiction) instead of firing a second lookup.
   * `null` specifically means THIS resolution path never consulted the
   * registry (the raw-URL branch, a legitimate, sanctioned code path — not
   * a network failure): a direct-URL install has no registry-backed
   * identity to check against in the first place.
   */
  resolvedRegistryRecord: { author: string | null; name: string | null } | null
  /**
   * SMI-6529 M6: the exact on-disk directory `getSkillDiff` actually
   * compared against — `getInstalledSkillsForClient(client, dbPath)`'s
   * matched entry's `.path`, NOT `currentEntry.installPath` (the manifest's
   * OWN recorded path, which can legitimately differ — e.g. a repo-local
   * skill resolved outside the client's normal install dir, or a manifest
   * entry that's stale relative to what's actually on disk today).
   * `updateSkill()` passes THIS, not `currentEntry.installPath`, as
   * `expectedInstallPath` — `install()`'s target guard must refuse to write
   * anywhere other than the directory this diff was actually computed
   * against, and the manifest's own recorded path is not guaranteed to be
   * that directory.
   */
  installedPath: string
}

/**
 * Get skill diff for an installed skill, checking the local registry cache
 * first and falling back to the remote registry when the cache doesn't have
 * it (SMI-5427: the local SQLite cache is commonly empty in the
 * remote-default world — the local-only lookup this replaced would report
 * "not found in registry" for most real installs).
 *
 * Returns `'not-installed'` when the skill isn't installed at all, or
 * `'unresolvable'` when it's installed but no registry ID can be resolved
 * for it — from the local cache, the manifest, or (below) a confident
 * SourceRecoveryService recovery.
 *
 * SMI-5894 (Wave 1 Steps 2/3): `client` scopes the "is this installed"
 * lookup to the resolved client's own directory (plus repo-local skills)
 * via `getInstalledSkillsForClient`, instead of `getInstalledSkills()`'s
 * global cross-client dedup. Without this, a skill installed under two
 * clients with the same name would always resolve to whichever client wins
 * that dedup's precedence (Claude Code), not necessarily the client the
 * caller asked `update --client <id>` to target.
 *
 * SMI-5895 (Wave 2 Step 1): when the local cache doesn't have the skill,
 * this now consults `~/.skillsmith/manifest.json` — which
 * `SkillInstallationService.install()` already writes a correct `id`/
 * `source` into on every successful install (skill-installation.service.ts)
 * — keyed by `manifestKeyFor(<install dir basename>, client)` so a
 * same-named skill installed independently under two clients resolves to
 * the entry that actually matches the client being asked about, not
 * whichever one was written last (see the key-derivation note at the lookup
 * site). Only when the manifest entry is genuinely missing does this
 * fall back to a confidence-gated `SourceRecoveryService` recovery (see
 * {@link recoverConfidentSourceId}) — replacing the previous
 * `resolveInstalledSkillId()` dead code, which read a `SKILL.md`
 * front-matter `id` field `SkillParser` never actually populates.
 *
 * ADR-139 (SMI-6274 Wave 4): `scopeTarget` narrows the lookup to the exact
 * `(scope, client)` pair and reads the matching manifest (workspace-local
 * or global) instead of always `~/.skillsmith/manifest.json` — the same
 * exact-triple resolution `remove` now applies (manage.action.ts).
 *
 * ADR-139 point 1 / GPT-5.6-Sol PR review follow-up: a skill present on
 * disk with NO manifest entry (untracked) is now ADOPTED here — a
 * reconstructed manifest entry is written via `adoptUntrackedSkillEntry`
 * (`@skillsmith/core`, the same `buildAdoptedManifestEntry()` builder `performUninstall()`
 * uses) BEFORE source resolution is attempted (via EITHER the local-cache
 * bare-name match below or the manifest/recovery fallback), so the skill
 * becomes tracked regardless of which path answers the diff, or whether a
 * real registry source can be found at all. Previously this adoption call
 * lived only inside the manifest-fallback branch, AFTER the cache-match
 * check had already returned — so an untracked skill whose front-matter
 * author happened to match a cache row of the same name silently skipped
 * adoption entirely (GPT-5.6-Sol PR review round 2 finding). SMI-6529 Wave A0
 * / L18 (round 2): a freshly-adopted entry always carries `source: 'unknown'`,
 * and the `provenance === 'local' || source === 'unknown'` check further down
 * this function now short-circuits ANY such entry straight to
 * `'skipped-local'` before source resolution ever runs — so the entry this
 * paragraph used to describe as reaching a distinct `'adopted-unresolvable'`
 * outcome can no longer get there at all; that string outcome was removed as
 * dead code (see the L18 comment at its former return site). Returns
 * `{ adoptionError }` only if the adoption WRITE itself fails (naming the
 * skill, path, and manifest — the same failure contract
 * `performUninstall()` uses).
 *
 * GPT-5.6-Sol PR review finding (adoption-guessed-id guard): an adopted
 * entry's `id` is a GUESS (`= skillName`, since the real registry id can't
 * be derived from disk alone) — `manifestId` below is only trusted when
 * `source !== 'unknown'`, so an adopted (or otherwise source-unknown)
 * entry's guessed `id` can never be selected as an authoritative registry
 * id. Without this guard, a leftover `source: 'unknown'` entry (e.g. from a
 * `remove` that adopted but then failed partway through) could later cause
 * `update` to silently pick an unrelated same-named registry skill.
 *
 * GPT-5.6-Sol PR review round 2 (race): `adoptUntrackedSkillEntry`'s
 * `updateSafely()` write re-checks manifest state UNDER LOCK before writing
 * the guessed entry — a concurrent real `install()`/`update()` that tracks
 * this exact skill between the read below and that locked write wins over
 * the guess, never the other way around.
 *
 * GPT-5.6-Sol PR review round 4: `adoptUntrackedSkillEntry` moved to
 * `@skillsmith/core` (`skill-installation.uninstall.ts`, alongside
 * `buildAdoptedManifestEntry`) so `performUninstall()` (also core) could
 * call the SAME race-safe implementation directly, instead of its own
 * still-non-race-safe inline copy — a CLI-package-local helper couldn't be
 * imported into `core` without a layering violation. See `manifestId`'s own
 * doc comment below for the sibling cache-match-consistency fix from the
 * same review round.
 *
 * Split out of manage.update.ts into this file (SMI-6274 Wave 4, file-length
 * gate) — re-exported from manage.update.ts so manage.action.ts's existing
 * import path is unaffected.
 *
 * SMI-6529 Wave A0: `dryRun` (default false) suppresses the untracked-skill
 * adoption WRITE below — a dry run must never touch the manifest. Since a
 * freshly-adopted entry always carries `source: 'unknown'`, and (see below)
 * ANY `source: 'unknown'`/`provenance: 'local'` entry now short-circuits to
 * `'skipped-local'` before any resolution runs, a dry run on an untracked
 * skill can skip straight to that same outcome without writing anything.
 */
export async function getSkillDiff(
  skillName: string,
  dbPath: string,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget,
  dryRun = false,
  /**
   * SMI-6529 L19: optional out-param the caller can pass to receive the
   * resolved `installed` record this function ALREADY looked up via
   * `getInstalledSkillsForClient()` — for EVERY outcome, including the bare
   * string ones (`'skipped-local'`/`'unresolvable'`) that carry no
   * `SkillDiff` object of their own. Lets a caller building a
   * user-facing display label for one of those outcomes (`updateSkillWithOutcome`'s
   * label resolution) reuse this lookup instead of re-scanning the same
   * client's installed-skills directory a second time per skipped skill.
   * Never changes `getSkillDiff`'s own return type/contract — purely additive.
   */
  outInstalled?: { current?: InstalledSkill }
): Promise<
  SkillDiff | 'not-installed' | 'unresolvable' | 'skipped-local' | { adoptionError: string }
> {
  const wantedVia = installedViaFor(client)
  const installed = (await getInstalledSkillsForClient(client, dbPath)).find(
    (s) =>
      s.name.toLowerCase() === skillName.toLowerCase() &&
      (!scopeTarget || (s.installedVia === wantedVia && s.scope === scopeTarget.scope))
  )
  if (!installed) {
    return 'not-installed'
  }
  if (outInstalled) outInstalled.current = installed

  const db = await openCliDatabase(dbPath)
  const skillRepo = new SkillRepository(db)

  try {
    // Consult the manifest FIRST — before EITHER resolution path below —
    // and adopt if this skill is untracked (ADR-139 point 1; see the
    // function doc comment's round-2 note on why this must happen before
    // the cache-match check, not only inside the manifest-fallback branch).
    // Keyed by (name, client) per SMI-5894 Wave 1 Step 3 so a same-named
    // skill installed under two clients resolves the entry that matches
    // THIS client, not name alone.
    //
    // The key is derived from the install DIRECTORY basename, not from
    // `skillName` (the caller-supplied argument) or `installed.name` (which
    // `getSkillsFromDirectory` takes from SKILL.md front-matter, falling
    // back to the directory name). `install()` builds both `installPath =
    // join(skillsDir, skillName)` and `manifestKeyFor(skillName, client)`
    // from the same string, so the basename is the only value guaranteed to
    // reproduce the key it wrote — the argument is matched case-insensitively
    // ("update Astro" resolves the `astro` install) and front-matter `name`
    // can differ from the directory outright, so keying off either silently
    // misses the entry.
    const manifest = scopeTarget
      ? await loadManifest(scopeTarget.manifestPath)
      : await loadManifest()
    const manifestKey = manifestKeyFor(basename(installed.path), client)
    let manifestEntry = manifest.installedSkills?.[manifestKey]

    if (!manifestEntry) {
      // SMI-6529 Wave A0: a dry run must never write the manifest. A freshly
      // adopted entry always carries `source: 'unknown'`, which the check
      // just below this block always redirects to 'skipped-local' anyway —
      // so skip the adoption WRITE entirely and go straight to that outcome.
      if (dryRun) {
        return 'skipped-local'
      }
      // manifestPathForAdoption mirrors updateSkill()'s own scopeTarget-first
      // resolution so the write lands in the SAME manifest the read above
      // just consulted.
      const manifestPathForAdoption = scopeTarget?.manifestPath ?? DEFAULT_MANIFEST_PATH
      const adoptResult = await adoptUntrackedSkillEntry(
        skillName,
        basename(installed.path),
        installed.path,
        manifestKey,
        new ManifestManager(manifestPathForAdoption)
      )
      if ('adoptionError' in adoptResult) {
        // Only if adoption itself fails does the command error — naming the
        // skill, the path, and the manifest it tried to write (ADR-139
        // point 1's failure contract, identical to performUninstall()'s).
        return adoptResult
      }
      manifestEntry = adoptResult.entry
    }

    // SMI-6529 Wave A0: a `provenance: 'local'` row is a positive user
    // assertion ("this is my own skill, not registry-tracked"), and
    // `source: 'unknown'` is what BOTH that assertion AND a just-adopted
    // untracked row carry — for either, `update` must never chase a source:
    // no bare-name cache match, no SourceRecoveryService recovery, no
    // registry lookup. This is the actual fix for the reported data-loss
    // bug (a git-cloned or otherwise untracked skill directory silently
    // resolved via a same-name/same-author cache match and got
    // force-overwritten from an unrelated registry skill). Placed BEFORE
    // every resolution path below, including the bare-name cache-match scan.
    if (manifestEntry.provenance === 'local' || manifestEntry.source === 'unknown') {
      return 'skipped-local'
    }

    // GPT-5.6-Sol PR review finding: `source !== 'unknown'` guards against
    // trusting a GUESSED adoption id as registry-authoritative. Hoisted
    // above BOTH resolution branches (GPT-5.6-Sol PR review round 4) so the
    // cache-match branch below can prefer this trustworthy id too — it used
    // to only be consulted in the manifest-fallback branch further down,
    // meaning the cache-match branch could return an id inconsistent with a
    // manifest entry that JUST resolved (via adoption above) to a
    // non-guessed, authoritative value — most concretely, a concurrent
    // writer's real entry discovered by adoption's own race-safety check.
    // Investigated: yes, `skill.id` (bare-name+author SQLite-cache match)
    // and `manifestEntry.id` CAN legitimately diverge for the same (name,
    // author) pair — e.g. a raw-URL direct install records `manifestEntry.id`
    // as the GitHub URL while a same-name/same-author registry row's id is
    // the canonical `author/name` form, or a registry republish/rename can
    // leave a stale manifest id pointed at a superseded registry id — so
    // this is not dead code, it's the same trust guard applied one branch
    // earlier for consistency.
    const manifestId =
      typeof manifestEntry.id === 'string' &&
      manifestEntry.id.trim().length > 0 &&
      manifestEntry.source !== 'unknown'
        ? manifestEntry.id
        : null

    // Find skill in the local registry cache by name (case-insensitive search).
    // SMI-6103: a bare-name match here is only trustworthy when the installed
    // skill's OWN front-matter claims the same author as the matched cache
    // row — otherwise this silently resolves to an unrelated same-named
    // skill from a different author (confirmed data loss: two personal,
    // unclaimed skills were overwritten with unrelated registry content this
    // way). A skill with no claimed author at all ("Local", the website's
    // own term for this) must fall through to the confidence-gated
    // manifest/recovery path below rather than be trusted here. Matching
    // must scan every same-name row for one whose author agrees — not just
    // the first same-name row found — otherwise an unrelated author's row
    // that happens to sort first in the cache would make a legitimate
    // same-name, correct-author update wrongly unresolvable (plan-review
    // correction, GPT-5.6-Sol PR review on #2465).
    const allSkills = skillRepo.findAll(1000, 0)
    const claimedAuthor = await readClaimedAuthor(installed.path)
    const nameMatches = allSkills.items.filter(
      (s: Skill) => s.name.toLowerCase() === skillName.toLowerCase()
    )
    const skill = claimedAuthor
      ? nameMatches.find(
          (s: Skill) => s.author && s.author.toLowerCase() === claimedAuthor.toLowerCase()
        )
      : undefined

    if (skill) {
      const changes: string[] = []
      const skillWithVersion = skill as SkillWithVersion

      if (installed.version !== skillWithVersion.version) {
        changes.push(
          `Version: ${installed.version || 'N/A'} -> ${skillWithVersion.version || 'N/A'}`
        )
      }

      if (installed.trustTier !== skill.trustTier) {
        changes.push(`Trust Tier: ${installed.trustTier || 'unknown'} -> ${skill.trustTier}`)
      }

      return {
        // GPT-5.6-Sol PR review round 4: prefer the manifest's own
        // (trustworthy, non-guessed) id over the cache-matched one — see
        // `manifestId`'s doc comment above for why these can diverge and why
        // this matters most in the adoption race window. The version/
        // trust-tier diff above still comes from the richer cache row (the
        // manifest alone can't render a version diff, see the comment at the
        // raw-GitHub-URL / registry-lookup branch below) — only the install
        // target id is redirected.
        skillId: manifestId ?? skill.id,
        oldVersion: installed.version,
        newVersion: skillWithVersion.version || null,
        changes,
        currentEntry: manifestEntry,
        resolvedRegistryRecord: { author: skill.author ?? null, name: skill.name ?? null },
        installedPath: installed.path,
      }
    }
    // No bare-name cache row whose author agrees with the installed skill's
    // own claim (or no claim at all) — do not trust any bare-name match.
    // Fall through to the manifest / confidence-gated recovery path. The
    // skill is already tracked-or-adopted by this point regardless.

    // Genuinely missing from the manifest — fall back to a confidence-gated
    // SourceRecoveryService recovery (SMI-5407). Never silently trust a
    // medium/low-confidence speculative match here.
    const resolvedId = manifestId ?? (await recoverConfidentSourceId(skillName, installed, db))
    if (!resolvedId) {
      // SMI-6529 L18: `manifestEntry.source === 'unknown'` can no longer be
      // true here — the early `provenance === 'local' || source === 'unknown'`
      // short-circuit above (redirecting straight to 'skipped-local') already
      // returned before this point whenever that would have held, making the
      // former `'adopted-unresolvable'` branch this ternary fed dead code.
      return 'unresolvable'
    }

    // A raw GitHub URL (a direct-URL install's manifest `id`, or a
    // git-remote/plugin-json SourceRecoveryService recovery) isn't a
    // registry ID — skip the registry API confirmation below and let the
    // force-install fetch it directly, same as a direct-URL `install` does.
    if (resolvedId.startsWith('https://github.com/')) {
      return {
        skillId: resolvedId,
        oldVersion: installed.version,
        newVersion: null,
        changes: [
          `Source resolved to ${resolvedId} — no cached version to diff; will fetch and overwrite with the latest content.`,
        ],
        currentEntry: manifestEntry,
        // A direct-URL install/update never consults the registry — see the
        // field's own doc comment on `SkillDiff`.
        resolvedRegistryRecord: null,
        installedPath: installed.path,
      }
    }

    const registryLookup = await createApiBackedRegistryLookup(skillRepo, db)
    const remote = await registryLookup.lookup(resolvedId)
    if (!remote) {
      return 'unresolvable'
    }

    // The registry API doesn't expose a comparable version string, so we
    // can't render a version diff here — confirm the source and let the
    // force-install fetch + overwrite with the latest content.
    return {
      skillId: resolvedId,
      oldVersion: installed.version,
      newVersion: null,
      changes: [
        `Registry source confirmed at ${remote.repoUrl} — no cached version to diff; will fetch and overwrite with the latest content.`,
      ],
      currentEntry: manifestEntry,
      resolvedRegistryRecord: { author: remote.author ?? null, name: remote.name ?? null },
      installedPath: installed.path,
    }
  } finally {
    db.close()
  }
}
