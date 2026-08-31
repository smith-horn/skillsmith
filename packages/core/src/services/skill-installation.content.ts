/**
 * @fileoverview Content-based skill install path (private registry).
 * @module @skillsmith/core/services/skill-installation.content
 * @see SMI-5905 Wave 1: installFromContent() + resolveFreshAccessToken() extraction
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * `install()` (skill-installation.service.ts) only knows how to fetch a
 * skill from GitHub. This module adds a second entry point,
 * `installFromContent()`, for skills whose content has already been resolved
 * elsewhere (a private-registry `content` JSONB column, read via a
 * per-team-member Supabase session or the `private-registry-get` Edge
 * Function — Waves 2/3 wire those transports; this module only needs the
 * already-fetched `{skillId, version, content}` triple).
 *
 * SCOPE TRIM (Sol review #5 — read before extending this function):
 * `installFromContent()` deliberately reuses only two things from the
 * `install()` policy chain:
 *   1. `writeInstallFiles()`'s disk-write + rollback-on-partial-write handling
 *      (skill-installation.io.ts), plus this module's own manifest-driven
 *      already-installed/force gate (mirrors `install()`'s ALREADY_INSTALLED
 *      check).
 *   2. A security scan at the `community` trust tier, via the same
 *      `classifyBundledFile()`/`isRejectableScan()` policy `install()` uses
 *      for optional bundled files (skill-installation.policy.ts) — applied
 *      here to every content-map entry (including "SKILL.md" itself, which
 *      falls through to the conservative 'structured' default class since it
 *      has no BUNDLED_SCAN_FILES entry).
 *
 * It deliberately does NOT route through the rest of `install()`'s chain:
 *   - `skipScan` is NOT an accepted option here. Registry-content installs
 *     always scan — there is no opt-out, unlike `install()`'s tier-gated
 *     skipScan.
 *   - Dependency-intelligence extraction/persistence (extractDepIntel,
 *     persistDependencies, checkDepsAgainstQuarantine), risk-history
 *     recording, AI-defence feedback, and co-install-session recording are
 *     all OUT of v1 scope — a known, intentional gap, not a silent drop.
 *     Wave 3's MCP `install` action and Wave 4's CLI command do not get
 *     these signals for private-registry installs yet.
 *   - Frontmatter/manifest validation on `SKILL.md` itself DOES still run
 *     (`validateSkillMd()`), same as any other install.
 *
 * PATH VALIDATION (Sol review #2, critical, confirmed exploitable): every key
 * in `content` is attacker-controlled — any team member with publish access
 * chooses these filenames — and flows into `writeInstallFiles()`'s
 * `path.join(installPath, subSkill.filename)` (skill-installation.io.ts:167)
 * with NO containment check of its own. `path.join('/a/b', '../../etc/passwd')`
 * escapes `installPath` after normalization, so every key is validated here,
 * BEFORE any disk write — see `validateContentKeys()`.
 */

import * as path from 'path'
import type { TrustTier } from '../types/skill.js'
import type { Database } from '../db/database-interface.js'
import type { ClientId } from '../install/paths.js'
import type {
  ProgressCallback,
  InstallFromContentOptions,
  InstallResult,
} from './skill-installation.types.js'
import { TRUST_TIER_SCANNER_OPTIONS } from './skill-installation.types.js'
import type { ManifestManager } from './skill-manifest.js'
import { SecurityScanner } from '../security/index.js'
import type { ScanReport } from '../security/index.js'
import {
  classifyBundledFile,
  extractPackageJsonLifecycleScripts,
  isRejectableScan,
} from './skill-installation.policy.js'
import { validateSkillMd } from './skill-installation.validate.js'
import { buildInstallFailure } from './skill-installation.errors.js'
import { writeInstallFiles } from './skill-installation.io.js'
import {
  applyOptimization,
  generateTips,
  hashContent,
  manifestKeyFor,
  sanitizeInstallError,
} from './skill-installation.helpers.js'

/** SMI-5905: content-based installs always scan at this trust tier — no skipScan opt-out. */
const CONTENT_INSTALL_TRUST_TIER: TrustTier = 'community'

/** Byte used to detect NUL-byte injection in a content-map key. */
const NUL_BYTE = '\x00'

/**
 * Classify why a single content-map key is unsafe to use as a relative
 * install-path filename, or return null when it's safe.
 *
 * Each check below is independently sufficient to reject the key — order
 * only affects which reason surfaces first in the error message.
 */
function unsafeContentKeyReason(key: string): string | null {
  if (key.length === 0 || key === '.') return 'is empty or a bare "." path'
  if (key.includes(NUL_BYTE)) return 'contains a NUL byte'
  if (key.includes('\\')) return 'contains a backslash'
  // path.win32.isAbsolute() recognizes drive-letter ("C:\\foo") and UNC
  // ("\\\\server\\share") forms regardless of the host platform; POSIX-style
  // absolute paths are covered by path.posix.isAbsolute().
  if (path.posix.isAbsolute(key) || path.win32.isAbsolute(key)) return 'is an absolute path'
  const segments = key.split('/')
  if (segments.some((seg) => seg === '..')) return 'contains a ".." path segment'
  if (segments[0] === '.git') return 'targets the .git directory'
  return null
}

/**
 * Validate every key in a content map before any disk write.
 *
 * Rejects (as a single combined error, first offense wins):
 *   - path-traversal (`..` segment), absolute paths (posix or win32/UNC),
 *     NUL bytes, backslashes, empty/bare-"."/".git"-adjacent keys;
 *   - any key that, after `path.resolve()` against `installPath`, resolves
 *     outside `installPath` (a lexical backstop behind the checks above,
 *     matching `writeInstallFiles()`'s own lexical escape check);
 *   - two keys that `path.normalize()` to the same on-disk path (a
 *     collision — e.g. "SKILL.md" and "./SKILL.md").
 */
export function validateContentKeys(
  content: Record<string, string>,
  installPath: string
): { valid: true } | { valid: false; error: string } {
  const resolvedInstall = path.resolve(installPath)
  const seenByNormalizedPath = new Map<string, string>()

  for (const key of Object.keys(content)) {
    const reason = unsafeContentKeyReason(key)
    if (reason) {
      return { valid: false, error: `Rejected content key "${key}": ${reason}.` }
    }

    const resolved = path.resolve(installPath, key)
    if (resolved !== resolvedInstall && !resolved.startsWith(resolvedInstall + path.sep)) {
      return {
        valid: false,
        error: `Rejected content key "${key}": resolves outside the install directory.`,
      }
    }

    const normalized = path.normalize(key)
    const priorKey = seenByNormalizedPath.get(normalized)
    if (priorKey !== undefined) {
      return {
        valid: false,
        error:
          `Rejected content keys "${priorKey}" and "${key}": both normalize to the ` +
          'same on-disk path.',
      }
    }
    seenByNormalizedPath.set(normalized, key)
  }

  return { valid: true }
}

/**
 * Scan every content-map entry at the `community` trust tier, reusing the
 * exact per-file classification/rejection policy `install()` applies to
 * optional bundled files (skill-installation.policy.ts) — unchanged.
 *
 * "SKILL.md" has no BUNDLED_SCAN_FILES entry, so it falls through to the
 * conservative 'structured' default class (hard-reject on failure), which is
 * the correct posture for a team member's own untrusted main content.
 *
 * Returns the first rejecting file's report, or null if every file passed
 * (or was a 'doc'-class file whose scan failure is a documented FP-control
 * skip — see isRejectableScan()'s doc comment).
 */
function scanContentFiles(
  content: Record<string, string>,
  skillId: string
): { file: string; report: ScanReport } | null {
  const scanner = new SecurityScanner(TRUST_TIER_SCANNER_OPTIONS[CONTENT_INSTALL_TRUST_TIER])

  for (const [filename, text] of Object.entries(content)) {
    const fileClass = classifyBundledFile(filename)
    let textToScan: string | null = text
    if (fileClass === 'package-json') {
      const lifecycle = extractPackageJsonLifecycleScripts(text)
      textToScan = lifecycle.length > 0 ? lifecycle : null
    }
    if (textToScan === null) continue

    const report = scanner.scan(skillId + '/' + filename, textToScan)
    if (isRejectableScan(report)) {
      if (fileClass === 'doc') continue // H6 FP control — same as fetchAndScanOptionalFiles
      return { file: filename, report }
    }
  }
  return null
}

/**
 * Derive the on-disk skill name from an `author/name`-format skillId, or `null` if any
 * `/`-separated segment is unsafe as a path component.
 *
 * Sol final-code-review finding #1 (confirmed exploitable): callers upstream (the MCP/CLI/Edge
 * Function skillId validators, and the `private_registry_skills.skill_id` DB CHECK itself) all
 * share the same permissive `/^[^/]+\/[^/]+$/` format check, which accepts "." and ".." as
 * either segment — "myteam/.." passes it. Without this check, `path.join(skillsDir, '..')`
 * collapses the install path to skillsDir's PARENT, and `writeInstallFiles()` would happily
 * write "SKILL.md" there. This is the actual disk-write boundary and the last line of defense
 * regardless of what any upstream schema/DB-constraint layer allows — a schema-only fix would
 * not protect a stub/test call site (or a future caller) that bypasses Zod entirely.
 */
function skillNameFromSkillId(skillId: string): string | null {
  const parts = skillId.split('/')
  const name = parts.length >= 2 ? parts[parts.length - 1] : skillId
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return null
  }
  return name
}

/** Internal params bag: the caller's InstallFromContentOptions plus the service state
 *  installFromContent() needs (mirrors performUninstall()'s flattened-params convention
 *  in skill-installation.helpers.ts). */
export interface InstallFromContentParams extends InstallFromContentOptions {
  db: Database
  skillsDir: string
  manifest: ManifestManager
  client: ClientId
  onProgress: ProgressCallback
  /**
   * SMI-5982 code-review fix #1: base dir for resolving a relative companion-agent
   * target (Antigravity only) — see writeInstallFiles()'s own doc comment.
   * PR-review follow-up: optional (not required) — an omitted value must flow
   * through to `resolveCompanionAgentPath()`'s own required-`baseDir` guard as
   * `undefined`, not be silently defaulted anywhere in this chain.
   */
  companionBaseDir?: string
}

/**
 * Install an already-resolved private-registry skill's content to disk.
 *
 * See this file's header doc comment for the full scope trim vs. `install()`.
 */
export async function installFromContent(params: InstallFromContentParams): Promise<InstallResult> {
  const {
    db,
    skillsDir,
    manifest,
    client,
    onProgress,
    skillId,
    version,
    content,
    force = false,
    companionBaseDir,
  } = params

  const skillName = skillNameFromSkillId(skillId)
  const trustTier = CONTENT_INSTALL_TRUST_TIER

  if (skillName === null) {
    return buildInstallFailure('INVALID_CONTENT', {
      skillId,
      installPath: skillsDir,
      trustTier,
      error: `Rejected skillId "${skillId}": segments must not be empty, ".", or "..".`,
    })
  }
  const installPath = path.join(skillsDir, skillName)

  try {
    onProgress('validate', 'Validating package content')
    const skillMdContent = content['SKILL.md']
    if (typeof skillMdContent !== 'string' || skillMdContent.length === 0) {
      return buildInstallFailure('INVALID_CONTENT', {
        skillId,
        installPath,
        trustTier,
        error: 'Package content must include a non-empty "SKILL.md" entry.',
      })
    }

    // Critical (Sol review #2): every content-map key is attacker-controlled.
    // Must run BEFORE any disk write.
    const keyValidation = validateContentKeys(content, installPath)
    if (!keyValidation.valid) {
      return buildInstallFailure('INVALID_CONTENT', {
        skillId,
        installPath,
        trustTier,
        error: keyValidation.error,
      })
    }

    const mdValidation = validateSkillMd(skillMdContent)
    if (!mdValidation.valid) {
      return buildInstallFailure('VALIDATION_FAILED', {
        skillId,
        installPath,
        trustTier,
        error: 'Invalid SKILL.md: ' + mdValidation.errors.join(', '),
        tips: [
          'SKILL.md must have YAML frontmatter with name and description fields',
          'Content must be at least 100 characters',
        ],
      })
    }

    onProgress('manifest', 'Checking manifest')
    const manifestData = await manifest.load()
    const manifestKey = manifestKeyFor(skillName, client)
    if (manifestData.installedSkills[manifestKey] && !force) {
      return buildInstallFailure('ALREADY_INSTALLED', {
        skillId,
        installPath,
        trustTier,
        error: 'Skill "' + skillName + '" is already installed. Use force=true to reinstall.',
      })
    }

    onProgress('scan', 'Running security scan')
    const rejected = scanContentFiles(content, skillId)
    if (rejected) {
      return buildInstallFailure('SCAN_REJECTED', {
        skillId,
        installPath,
        trustTier,
        securityReport: rejected.report,
        error:
          'File "' +
          rejected.file +
          '" failed the security scan (risk score ' +
          rejected.report.riskScore +
          '). See https://skillsmith.app/docs/security/scanner',
        tips: [
          'Rejected file: ' + rejected.file,
          'Risk score: ' + rejected.report.riskScore,
          'Security scanner docs: https://skillsmith.app/docs/security/scanner',
        ],
      })
    }

    onProgress('optimize', 'Applying optimization')
    // SMI-6276 pr-reviewer finding: `client` is already resolved above (used
    // by manifestKeyFor/generateTips below) — passing it here is required,
    // not optional, or this install path silently falls back to
    // applyOptimization()'s claude-code default regardless of the real
    // target client.
    const { finalSkillContent, subSkillFiles, subagentContent, optimizationInfo } =
      await applyOptimization(db, skillId, skillName, skillMdContent, client)

    // Team-authored content wins any filename collision with a generated sub-skill.
    const teamAuthoredSubFiles = Object.entries(content)
      .filter(([filename]) => filename !== 'SKILL.md')
      .map(([filename, fileContent]) => ({ filename, content: fileContent }))
    const generatedNoCollision = subSkillFiles.filter(
      (generated) => !teamAuthoredSubFiles.some((team) => team.filename === generated.filename)
    )

    onProgress('write', 'Writing skill files')
    const writeResult = await writeInstallFiles(
      installPath,
      skillsDir,
      skillName,
      finalSkillContent,
      [...generatedNoCollision, ...teamAuthoredSubFiles],
      subagentContent,
      client,
      companionBaseDir
    )
    if (writeResult.subagentPath) {
      optimizationInfo.subagentPath = writeResult.subagentPath
    }

    onProgress('manifest', 'Updating manifest')
    await manifest.updateSafely((currentManifest) => ({
      ...currentManifest,
      installedSkills: {
        ...currentManifest.installedSkills,
        [manifestKey]: {
          id: skillId,
          name: skillName,
          version,
          // SMI-5905: provenance for content-sourced installs (never a github: URL).
          source: 'private-registry:' + skillId,
          installPath,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          originalContentHash: hashContent(finalSkillContent),
          client,
        },
      },
    }))

    onProgress('done', 'Installation complete')
    const tips = generateTips(skillName, optimizationInfo, client, skillsDir)

    return {
      success: true,
      skillId,
      installPath,
      trustTier,
      optimization: optimizationInfo,
      tips,
    }
  } catch (error) {
    return buildInstallFailure('UNKNOWN', {
      skillId,
      installPath,
      trustTier,
      error: sanitizeInstallError(error),
    })
  }
}
