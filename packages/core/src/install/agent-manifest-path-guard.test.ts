/**
 * @fileoverview Unit tests for the manifest-path validation guard
 *               (SMI-5456 governance follow-up, code review 2026-07-01).
 * @module @skillsmith/core/install/agent-manifest-path-guard.test
 */
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AGENT_INSTALL_DIR_ENV_VAR, getAgentInstallBackupsDir } from './agent-manifest.js'
import {
  isAllowedManifestBackupPath,
  isAllowedManifestEntryPath,
} from './agent-manifest-path-guard.js'

describe('isAllowedManifestEntryPath', () => {
  it('allows a real claude-code skill pack path', () => {
    expect(
      isAllowedManifestEntryPath(
        join(homedir(), '.claude', 'skills', 'skillsmith-agent', 'SKILL.md')
      )
    ).toBe(true)
  })

  it('allows a real claude-code settings.json (MCP config target)', () => {
    expect(isAllowedManifestEntryPath(join(homedir(), '.claude', 'settings.json'))).toBe(true)
  })

  it('allows a real hermes YAML config path', () => {
    expect(isAllowedManifestEntryPath(join(homedir(), '.hermes', 'config.yaml'))).toBe(true)
  })

  it('allows a real codex hook script path', () => {
    expect(isAllowedManifestEntryPath(join(homedir(), '.codex', 'hooks', 'session-start.sh'))).toBe(
      true
    )
  })

  it('rejects an arbitrary sensitive path never written by the installer', () => {
    expect(isAllowedManifestEntryPath('/etc/passwd')).toBe(false)
    expect(isAllowedManifestEntryPath(join(homedir(), '.ssh', 'id_rsa'))).toBe(false)
  })

  it('rejects a path that merely CONTAINS a known suffix as a substring, not a true path segment', () => {
    // "evilclaude/settings.json" is not the same path component as
    // ".claude/settings.json" — must not match on naive substring search.
    expect(isAllowedManifestEntryPath(join(homedir(), 'evil.claude', 'settings.json'))).toBe(false)
  })

  it('rejects a hand-edited traversal string that resolves outside every known harness dir', () => {
    // A tampered manifest entry could embed literal ".." segments (not
    // produced by `path.join`, which would normalize them away before this
    // function ever sees them) — `resolve()` inside the guard must still
    // collapse them and reject the resulting real path.
    expect(isAllowedManifestEntryPath(`${homedir()}/../../../../etc/passwd`)).toBe(false)
  })

  it('rejects a bare directory that only partially matches (no filename)', () => {
    expect(isAllowedManifestEntryPath(join(homedir(), '.claude', 'skills'))).toBe(false)
  })

  // SMI-6275 Wave 5: AntiGravity's two artifacts are WORKSPACE-relative, not
  // HOME-relative — a separate allowlist branch (module header addendum).
  describe('AntiGravity workspace-relative artifacts (SMI-6275 Wave 5)', () => {
    const workspaceRoot = join(tmpdir(), 'skillsmith-guard-test-workspace')

    it('allows the workspace-scoped skill pack path under ANY workspace root', () => {
      expect(
        isAllowedManifestEntryPath(
          join(workspaceRoot, '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
        )
      ).toBe(true)
      // A DIFFERENT workspace root — the check is deliberately root-agnostic
      // (any file literally named this way, per any workspace), not tied to
      // one specific resolved root (module header explains why).
      expect(
        isAllowedManifestEntryPath(
          join(tmpdir(), 'another-workspace', '.agents', 'skills', 'skillsmith-agent', 'SKILL.md')
        )
      ).toBe(true)
    })

    it('allows the workspace-scoped mcp_config.json path under any workspace root', () => {
      expect(isAllowedManifestEntryPath(join(workspaceRoot, '.agents', 'mcp_config.json'))).toBe(
        true
      )
    })

    it('rejects a path that merely CONTAINS the mcp_config.json suffix as a substring, not a true path segment', () => {
      expect(
        isAllowedManifestEntryPath(join(workspaceRoot, 'evil.agents', 'mcp_config.json'))
      ).toBe(false)
      expect(
        isAllowedManifestEntryPath(join(workspaceRoot, '.agents', 'evil-mcp_config.json'))
      ).toBe(false)
    })

    it('rejects a hand-edited traversal string escaping the intended tail', () => {
      expect(
        isAllowedManifestEntryPath(`${workspaceRoot}/.agents/mcp_config.json/../../../etc/passwd`)
      ).toBe(false)
    })

    it('still rejects an arbitrary sensitive path — the workspace-relative branch does not widen the home-relative rejections', () => {
      expect(isAllowedManifestEntryPath('/etc/passwd')).toBe(false)
      expect(isAllowedManifestEntryPath(join(homedir(), '.ssh', 'id_rsa'))).toBe(false)
    })
  })
})

describe('isAllowedManifestBackupPath', () => {
  it('allows a path under the current backups directory', () => {
    const backupsDir = getAgentInstallBackupsDir()
    expect(isAllowedManifestBackupPath(join(backupsDir, '2026-01-01-settings.json.bak'))).toBe(true)
  })

  it('rejects a path outside the backups directory', () => {
    expect(isAllowedManifestBackupPath(join(homedir(), '.ssh', 'id_rsa'))).toBe(false)
  })

  it('rejects a path that only shares a string prefix with the backups dir, not a real path boundary', () => {
    const backupsDir = getAgentInstallBackupsDir()
    expect(isAllowedManifestBackupPath(`${backupsDir}-evil-sibling/file.bak`)).toBe(false)
  })

  it('respects the SKILLSMITH_AGENT_INSTALL_DIR test-isolation override', () => {
    const prev = process.env[AGENT_INSTALL_DIR_ENV_VAR]
    process.env[AGENT_INSTALL_DIR_ENV_VAR] = join(homedir(), '.skillsmith-test-override')
    try {
      const backupsDir = getAgentInstallBackupsDir()
      expect(backupsDir).toContain('.skillsmith-test-override')
      expect(isAllowedManifestBackupPath(join(backupsDir, 'x.bak'))).toBe(true)
    } finally {
      if (prev !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prev
      else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
    }
  })
})
