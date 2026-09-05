/**
 * @fileoverview skill_outdated MCP tool — execution helpers
 * @module @skillsmith/mcp-server/tools/outdated.helpers
 * @see SMI-3138: Wave 5 — Dependency intelligence outdated tool
 *
 * Split out of `outdated.ts` (SMI-6343 Wave 3, 500-line file gate) — the
 * generic file-read and dependency-satisfaction helpers, distinct from
 * `outdated.identity.ts`'s Wave-3-specific tamper-check classification.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import type { SkillDependencyRow } from '@skillsmith/core'
import type { DependencyStatus } from './outdated.js'

/**
 * Read the installed SKILL.md's raw content. Returns null if the file
 * cannot be read.
 *
 * SMI-6343 (Wave 3): split out of the old `readInstalledHash` so the raw
 * content is available for signal 2's front-matter parsing too, without a
 * second file read.
 */
export async function readInstalledContent(installPath: string): Promise<string | null> {
  const skillMdPath = path.join(installPath, 'SKILL.md')
  try {
    const raw = await fs.readFile(skillMdPath, 'utf-8')
    // Defensive `typeof` guard: a mocked `readFile` with no implementation
    // wired for a given call can resolve to `undefined` without throwing.
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

/**
 * Check dependency satisfaction for a skill.
 * - skill_hard / skill_soft / skill_peer: satisfied if dep_target is in installedSkillIds
 * - mcp_server / model_minimum / other: marked satisfied (best-effort, can't verify)
 */
export function checkDependencies(
  deps: SkillDependencyRow[],
  installedSkillIds: Set<string>
): DependencyStatus {
  const satisfied: string[] = []
  const missing: string[] = []

  for (const dep of deps) {
    const label = `${dep.dep_type}:${dep.dep_target}`

    if (
      dep.dep_type === 'skill_hard' ||
      dep.dep_type === 'skill_soft' ||
      dep.dep_type === 'skill_peer'
    ) {
      if (installedSkillIds.has(dep.dep_target)) {
        satisfied.push(label)
      } else {
        missing.push(label)
      }
    } else {
      // mcp_server, model_minimum, etc. — can't reliably verify, mark satisfied
      satisfied.push(label)
    }
  }

  return { total: deps.length, satisfied, missing }
}
