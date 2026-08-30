/**
 * ADR-139 (SMI-6274 Wave 4): scan-target resolution shared by
 * `skills-directory.ts` (`getInstalledSkills`/`getInstalledSkillsForClient`)
 * and `skills-directory.per-harness.ts` (`getInstalledSkillsPerHarness`) —
 * extracted to its own module so both scans consult the SAME directory
 * list and cannot drift on which client/scope combinations are covered
 * (ADR-139 point 1: "a missed reader is a silent wrong-scope read"), and so
 * `skills-directory.ts` stays under the 500-line standard.
 */

import { join } from 'path'
import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  CLIENT_WORKSPACE_SEGMENTS,
  findWorkspaceRoot,
  resolveWorkspaceManifestPath,
  type ClientId,
  type InstallScope,
} from '@skillsmith/core/install'
import { DEFAULT_MANIFEST_PATH } from '../config.js'
import { getLocalSkillsDir } from './local-skills-dir.js'

/**
 * One directory this module scans, plus the manifest its installs are
 * tracked in. `manifestPath` is only consulted by callers that need
 * `untracked` detection (`getInstalledSkills`/`getInstalledSkillsForClient`
 * in `skills-directory.ts`); `getInstalledSkillsPerHarness`
 * (`skills-directory.per-harness.ts`) ignores it — its `HarnessSkillEntry`
 * output type has no field for it.
 */
export interface ScanTarget {
  dir: string
  installedVia: ClientId | 'local'
  scope: InstallScope
  manifestPath: string
}

/**
 * The repo-workspace scan target for the canonical (`claude-code`) client.
 * `getLocalSkillsDir()` already does the marker-first / VCS-fallback
 * ancestor walk (ADR-139 point 7's deprecated wrapper); this re-derives the
 * SAME workspace root (or `cwd`, matching that function's own fallback) to
 * resolve the matching manifest path for untracked detection.
 */
export function buildLocalScanTarget(cwd: string): ScanTarget {
  const dir = getLocalSkillsDir()
  const found = findWorkspaceRoot(cwd, CANONICAL_CLIENT)
  const manifestPath = resolveWorkspaceManifestPath(found ? found.root : cwd)
  return { dir, installedVia: 'local', scope: 'workspace', manifestPath }
}

/**
 * Every scan target for the full cross-client inventory (ADR-139): the
 * repo-local target, every client's global directory, and — new in this
 * wave — every OTHER client's workspace directory when one is found above
 * `cwd` (claude-code's own workspace is already covered by the local
 * target, so it's excluded here to avoid a redundant duplicate scan of the
 * same directory under two different labels).
 */
export function buildScanTargets(cwd: string): ScanTarget[] {
  const targets: ScanTarget[] = [buildLocalScanTarget(cwd)]

  for (const client of CLIENT_IDS) {
    targets.push({
      dir: CLIENT_NATIVE_PATHS[client],
      installedVia: client,
      scope: 'global',
      manifestPath: DEFAULT_MANIFEST_PATH,
    })
  }

  for (const client of CLIENT_IDS) {
    if (client === CANONICAL_CLIENT) continue // covered by the local target above
    const segments = CLIENT_WORKSPACE_SEGMENTS[client]
    if (!segments) continue
    const found = findWorkspaceRoot(cwd, client)
    if (!found) continue
    targets.push({
      dir: join(found.root, ...segments),
      installedVia: client,
      scope: 'workspace',
      manifestPath: resolveWorkspaceManifestPath(found.root),
    })
  }

  return targets
}
