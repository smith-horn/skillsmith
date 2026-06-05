/**
 * @fileoverview Validation and ID-parsing helpers for SkillInstallationService
 * @module @skillsmith/core/services/skill-installation.validate
 * @see SMI-4745: domain-driven split to stay under the 500-line CI gate
 */

import type { TrustTier } from '../types/skill.js'
import { parseRepoUrl } from '../utils/github-url.js'
import { validateSkillConfig } from './skill-config-schema.js'
import type {
  DepIntelResult,
  RegistryLookup,
  InstallResult,
  QuarantineStatus,
} from './skill-installation.types.js'
import { buildInstallFailure } from './skill-installation.errors.js'

export interface ParsedSkillId {
  owner: string
  repo: string
  path: string
  isRegistryId: boolean
}

export function parseSkillIdInternal(input: string): ParsedSkillId {
  if (input.startsWith('https://github.com/')) {
    const url = new URL(input)
    const parts = url.pathname.split('/').filter(Boolean)
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/') || '',
      isRegistryId: false,
    }
  }

  if (input.includes('/')) {
    const parts = input.split('/')
    if (parts.length === 2) {
      return { owner: parts[0], repo: parts[1], path: '', isRegistryId: true }
    }
    return {
      owner: parts[0],
      repo: parts[1],
      path: parts.slice(2).join('/'),
      isRegistryId: false,
    }
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (UUID_REGEX.test(input)) {
    return { owner: '', repo: '', path: '', isRegistryId: true }
  }

  throw new Error('Invalid skill ID format: ' + input + '. Use owner/repo or GitHub URL.')
}

export interface SkillMdValidation {
  valid: boolean
  errors: string[]
}
export function validateSkillMd(content: string): SkillMdValidation {
  const errors: string[] = []
  if (!content.includes('# ')) {
    errors.push('Missing title (# heading)')
  }
  if (content.length < 100) {
    errors.push('SKILL.md is too short (minimum 100 characters)')
  }
  return { valid: errors.length === 0, errors }
}

/** SMI-3870: Validate config.json content; returns validity and warnings. */
export function validateOptionalConfig(content: string): {
  valid: boolean
  warnings: string[]
} {
  const result = validateSkillConfig(content)
  if (!result.valid) {
    return { valid: false, warnings: ['config.json rejected: ' + result.errors.join('; ')] }
  }
  return { valid: true, warnings: result.warnings }
}
/** SMI-3871: Cross-reference dependency targets against quarantine status. */
export function checkDepsAgainstQuarantine(
  depIntel: DepIntelResult,
  getStatus: (skillId: string) => QuarantineStatus | null
): { warnings: string[]; quarantinedDeps: string[] } {
  const warnings: string[] = []
  const quarantinedDeps: string[] = []
  const checked = new Set<string>()
  const check = (target: string): void => {
    if (checked.has(target)) return
    checked.add(target)
    const status = getStatus(target)
    if (!status) return
    quarantinedDeps.push(target)
    const label =
      status === 'pending'
        ? 'under review for security concerns'
        : 'quarantined (confirmed malicious)'
    warnings.push('Dependency "' + target + '" is ' + label + '.')
  }
  for (const server of depIntel.dep_inferred_servers) check(server)
  if (depIntel.dep_declared?.platform?.mcp_servers) {
    for (const srv of depIntel.dep_declared.platform.mcp_servers) check(srv.name)
  }
  return { warnings, quarantinedDeps }
}

export type RegistryLookupResult =
  | {
      resolved: true
      owner: string
      repo: string
      basePath: string
      branch: string
      skillName: string
      trustTier: TrustTier
      indexedContentHash: string | undefined
    }
  | { resolved: false; failure: InstallResult }

export async function resolveRegistryInstall(
  skillId: string,
  lookup: RegistryLookup
): Promise<RegistryLookupResult> {
  const registrySkill = await lookup.lookup(skillId)
  if (!registrySkill) {
    return {
      resolved: false,
      failure: buildInstallFailure('REGISTRY_SKILL_NOT_FOUND', {
        skillId,
        installPath: '',
        error:
          'Skill "' +
          skillId +
          '" is indexed for discovery only. ' +
          'No installation source available (repo_url is missing). ' +
          'This may be placeholder/seed data or a metadata-only entry.',
        tips: [
          'Use a full GitHub URL instead: install { skillId: "https://github.com/owner/repo" }',
          'Search for installable skills using the search tool',
          'Many indexed skills are metadata-only and cannot be installed directly',
        ],
      }),
    }
  }
  if (registrySkill.quarantined) {
    return {
      resolved: false,
      failure: buildInstallFailure('QUARANTINED', {
        skillId,
        installPath: '',
        trustTier: registrySkill.trustTier,
        error:
          'Skill "' +
          skillId +
          '" has been quarantined due to security concerns. ' +
          'Installation is blocked to protect your environment.',
        tips: [
          'Visit https://skillsmith.app/docs/quarantine for details on quarantine policies',
          'If you believe this is a false positive, contact support via https://skillsmith.app/contact?topic=security',
          'Contact the skill author or visit the quarantine documentation for more information',
        ],
      }),
    }
  }

  const repoInfo = parseRepoUrl(registrySkill.repoUrl)
  return {
    resolved: true,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    basePath: repoInfo.path ? repoInfo.path + '/' : '',
    branch: repoInfo.branch,
    skillName: registrySkill.name,
    trustTier: registrySkill.trustTier,
    indexedContentHash: registrySkill.contentHash,
  }
}
