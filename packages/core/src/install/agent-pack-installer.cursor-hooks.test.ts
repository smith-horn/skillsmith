/**
 * Cursor `hooks.json` native-shape regression coverage (SMI-5893 Wave 8a).
 *
 * Split from agent-pack-installer.test.ts at the 500-line gate; shares its
 * temp-HOME + manifest-env fixture shape. `~/.cursor/hooks.json` was
 * previously written in Claude-shaped keys/entry values
 * (`{ SessionStart: [{ matcher: '', hooks: [{ type: 'command', command }] }] }`)
 * despite a code comment claiming Claude-compatibility a live Cursor UAT
 * report (GH#2368 C-06) contradicted. Cursor's real native shape — verified
 * 2026-08 against three independent fetches of cursor.com/docs/hooks — is a
 * top-level `{ version: 1, hooks: { sessionStart: [...], sessionEnd: [...] } }`
 * envelope with direct `{ command }` entries, no `matcher`/`type` wrapper.
 *
 * @module @skillsmith/core/install/agent-pack-installer.cursor-hooks.test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installAgentPack } from './agent-pack-installer.js'
import { AGENT_INSTALL_DIR_ENV_VAR, getAgentManifestPath } from './agent-manifest.js'

let homeDir: string
let manifestDir: string
let prevInstallDirEnv: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-home-'))
  manifestDir = mkdtempSync(join(tmpdir(), 'skillsmith-agent-install-manifest-'))
  prevInstallDirEnv = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  process.env[AGENT_INSTALL_DIR_ENV_VAR] = manifestDir
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(manifestDir, { recursive: true, force: true })
  if (prevInstallDirEnv !== undefined) process.env[AGENT_INSTALL_DIR_ENV_VAR] = prevInstallDirEnv
  else delete process.env[AGENT_INSTALL_DIR_ENV_VAR]
})

interface CursorHooksJsonDoc {
  version: number
  hooks: {
    sessionStart: Array<{ command: string }>
    sessionEnd: Array<{ command: string }>
  }
  SessionStart?: unknown
  SessionEnd?: unknown
}

function readCursorHooksJson(homeDirPath: string): CursorHooksJsonDoc {
  const raw = readFileSync(join(homeDirPath, '.cursor', 'hooks.json'), 'utf-8')
  return JSON.parse(raw) as CursorHooksJsonDoc
}

describe('installAgentPack — cursor hooks.json native shape', () => {
  it('writes { version: 1, hooks: { sessionStart, sessionEnd } } with direct { command } entries', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    installAgentPack({ homeDir })
    const startPath = join(homeDir, '.cursor', 'hooks', 'session-start.sh')
    const endPath = join(homeDir, '.cursor', 'hooks', 'session-end.sh')
    const doc = readCursorHooksJson(homeDir)

    expect(doc.version).toBe(1)
    expect(doc.hooks.sessionStart).toEqual([{ command: startPath }])
    expect(doc.hooks.sessionEnd).toEqual([{ command: endPath }])
    // No `matcher`/`type` wrapper (Claude's shape) on either entry.
    expect(Object.keys(doc.hooks.sessionStart[0]!).sort()).toEqual(['command'])
    expect(Object.keys(doc.hooks.sessionEnd[0]!).sort()).toEqual(['command'])
    // No leftover Claude-shaped top-level SessionStart/SessionEnd keys.
    expect(doc.SessionStart).toBeUndefined()
    expect(doc.SessionEnd).toBeUndefined()
  })

  it('is idempotent: re-install adds no duplicate entries and reports unchanged', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    installAgentPack({ homeDir })
    const result = installAgentPack({ homeDir })

    const doc = readCursorHooksJson(homeDir)
    expect(doc.hooks.sessionStart).toHaveLength(1)
    expect(doc.hooks.sessionEnd).toHaveLength(1)

    const cursorReport = result.harnessReports.find((r) => r.harness === 'cursor')
    expect(cursorReport?.hookConfig.every((r) => r.status === 'unchanged')).toBe(true)
  })

  it('records exactly one hook-config manifest entry for hooks.json (not one per event)', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    installAgentPack({ homeDir })
    const manifest = JSON.parse(readFileSync(getAgentManifestPath(), 'utf-8')) as {
      entries: Array<{ path: string; kind: string; harness: string }>
    }
    const hooksJsonPath = join(homeDir, '.cursor', 'hooks.json')
    const hookConfigEntries = manifest.entries.filter(
      (e) => e.path === hooksJsonPath && e.kind === 'hook-config' && e.harness === 'cursor'
    )
    expect(hookConfigEntries).toHaveLength(1)
    expect(existsSync(hooksJsonPath)).toBe(true)
  })
})
