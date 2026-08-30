/**
 * SMI-5895 (Wave 2 Step 1) + ADR-139 (SMI-6274 Wave 4): pure helpers for
 * `manage.update.ts`'s `getSkillDiff`/`updateSkill` — split out to stay
 * under the 500-line standard once ADR-139's scope-aware filtering pushed
 * `manage.update.ts` past it.
 */

import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  SkillParser,
  SkillRepository,
  SourceRecoveryService,
  ManifestManager,
  adoptUntrackedSkillEntry,
  hashContent,
  manifestKeyFor,
  type DatabaseType,
  type RecoveryConfidence,
  type Skill,
  type SkillRecoveryResult,
} from '@skillsmith/core'
import { getInstalledSkillsForClient, type InstalledSkill } from '../utils/skills-directory.js'
import {
  buildFindCandidatesByName,
  buildFindRegistryIdByRepoUrl,
} from '../utils/source-recovery-deps.js'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { loadManifest } from '../utils/manifest.js'
import { createApiBackedRegistryLookup } from './install.js'
import { CANONICAL_CLIENT, type ClientId, type ScopedInstallTarget } from '@skillsmith/core/install'

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

/**
 * SMI-5895 (Wave 2 Step 1): confidence tiers that {@link recoverConfidentSourceId}
 * auto-applies without asking the user to confirm — matches the same
 * "exact/high/user-specified auto-backfill, medium/low review-only" floor
 * `backfillManifest`'s own default `minConfidence: 'high'` already encodes
 * (`provenance/backfill.ts`, `commands/audit-sources.ts --min-confidence`
 * default). A medium/low match is a *speculative* name lookup — silently
 * trusting it here could overwrite a local skill with the wrong upstream
 * version, so `update` fails safely instead (plan-review correction).
 */
export const AUTO_APPLY_RECOVERY_CONFIDENCES = new Set<RecoveryConfidence>([
  'exact',
  'high',
  'user-specified',
])

/**
 * SMI-5895 (Wave 2 Step 1): fall back to `SourceRecoveryService` (SMI-5407,
 * already exposed via `sklx audit sources` / `skill_recover_source`) ONLY
 * when the manifest has no entry for this skill at all. Gated on confidence
 * — see {@link AUTO_APPLY_RECOVERY_CONFIDENCES}. Returns null (never
 * throws) when recovery is unavailable, unresolved/ambiguous, or below the
 * auto-apply confidence floor; the caller directs the user to
 * `sklx audit sources` for manual review in that case.
 */
export async function recoverConfidentSourceId(
  skillName: string,
  installed: InstalledSkill,
  db: DatabaseType
): Promise<string | null> {
  let skillMd: string | null
  try {
    skillMd = await readFile(join(installed.path, 'SKILL.md'), 'utf-8')
  } catch {
    skillMd = null
  }
  const service = new SourceRecoveryService({
    hashContent,
    findCandidatesByName: buildFindCandidatesByName(db),
    findRegistryIdByRepoUrl: buildFindRegistryIdByRepoUrl(db),
  })
  let result: SkillRecoveryResult
  try {
    result = await service.recoverOne(installed.path, skillName, skillMd)
  } catch {
    // The injected deps hit the local `skills` cache directly, so a missing/
    // corrupt table throws rather than returning zero candidates. Recovery is
    // a best-effort fallback — degrade to "unresolvable" (whose message points
    // at `sklx audit sources`) instead of failing the whole update command.
    return null
  }
  if (result.status !== 'recovered' || !AUTO_APPLY_RECOVERY_CONFIDENCES.has(result.confidence)) {
    return null
  }
  // SMI-5895 review (D-1): prefer the skill-specific recoveredSource.url over
  // registryId. registryId comes from findRegistryIdByRepoUrl's `repo_url`-only
  // lookup (source-recovery-deps.ts), which has no per-skill disambiguation --
  // a multi-skill plugin/monorepo shares one repo_url across every skill in it,
  // so it can resolve to a DIFFERENT skill's registry row than the one being
  // recovered. recoveredSource is always populated alongside registryId for
  // both auto-apply-eligible tiers (SourceRecoveryService.recoverOne's
  // git-remote/plugin-json branches), so this never loses real recovery
  // coverage -- registryId only remains as a defensive fallback for a future
  // confidence tier that might populate one without the other.
  return result.recoveredSource?.url ?? result.registryId ?? null
}

/**
 * SMI-6103: the installed skill's own claimed author, read directly from its
 * SKILL.md front-matter (never null-defaulted to a directory/display name —
 * an unclaimed "Local" skill, the website's own term, genuinely has none).
 * Returns null on any read/parse failure or an absent `author` field.
 */
export async function readClaimedAuthor(installedPath: string): Promise<string | null> {
  try {
    const skillMd = await readFile(join(installedPath, 'SKILL.md'), 'utf-8')
    const parsed = new SkillParser().parse(skillMd)
    const author = (parsed as unknown as Record<string, unknown> | undefined)?.['author']
    return typeof author === 'string' && author.trim().length > 0 ? author.trim() : null
  } catch {
    return null
  }
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
 * adoption entirely (GPT-5.6-Sol PR review round 2 finding). Returns
 * `'adopted-unresolvable'` (distinct from plain `'unresolvable'`) when the
 * entry — freshly adopted here, or already `source: 'unknown'` from an
 * earlier adoption — still has no resolvable registry id, so the caller can
 * say so explicitly (ADR-139: "the entry records it as unknown and the
 * command says so"). Returns `{ adoptionError }` only if the adoption WRITE
 * itself fails (naming the skill, path, and manifest — the same failure
 * contract `performUninstall()` uses).
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
 */
export async function getSkillDiff(
  skillName: string,
  dbPath: string,
  client: ClientId = CANONICAL_CLIENT,
  scopeTarget?: ScopedInstallTarget
): Promise<
  SkillDiff | 'not-installed' | 'unresolvable' | 'adopted-unresolvable' | { adoptionError: string }
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
      return manifestEntry.source === 'unknown' ? 'adopted-unresolvable' : 'unresolvable'
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
    }
  } finally {
    db.close()
  }
}
