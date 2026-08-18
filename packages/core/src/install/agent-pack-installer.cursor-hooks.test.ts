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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

describe('installAgentPack — cursor hooks.json stale legacy-key cleanup (SMI-5893 Wave 10, GH#2368 C-07)', () => {
  const hooksJsonPath = () => join(homeDir, '.cursor', 'hooks.json')
  const startPath = () => join(homeDir, '.cursor', 'hooks', 'session-start.sh')
  const endPath = () => join(homeDir, '.cursor', 'hooks', 'session-end.sh')

  /**
   * Writes a pre-Wave-8a stale hooks.json: Claude-shaped SessionStart/
   * SessionEnd for OUR own scripts, nested under `hooks` — matching Claude's
   * OWN keyPath shape (`['hooks', 'SessionStart']`) that Cursor's pre-fix
   * code mistakenly copied (only the casing changed post-fix, not the
   * nesting).
   */
  function seedStaleClaudeShapedHooksJson(extraHooksKeys?: Record<string, unknown>) {
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    writeFileSync(
      hooksJsonPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: startPath() }] }],
            SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: endPath() }] }],
            ...extraHooksKeys,
          },
        },
        null,
        2
      )
    )
  }

  it('removes the legacy capitalized keys entirely once they contain only our own entries', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    seedStaleClaudeShapedHooksJson()

    installAgentPack({ homeDir })

    const doc = readCursorHooksJson(homeDir) as unknown as {
      hooks: {
        SessionStart?: unknown
        SessionEnd?: unknown
        sessionStart: unknown
        sessionEnd: unknown
      }
    }
    expect(doc.hooks.SessionStart).toBeUndefined()
    expect(doc.hooks.SessionEnd).toBeUndefined()
    // The correct lowercase keys are still written as normal.
    expect(doc.hooks.sessionStart).toEqual([{ command: startPath() }])
    expect(doc.hooks.sessionEnd).toEqual([{ command: endPath() }])
  })

  it('preserves a foreign entry under the same legacy key, removing only our own', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    const foreignEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: '/some/other/tool.sh' }],
    }
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    writeFileSync(
      hooksJsonPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              foreignEntry,
              { matcher: '', hooks: [{ type: 'command', command: startPath() }] },
            ],
          },
        },
        null,
        2
      )
    )

    installAgentPack({ homeDir })

    const doc = readCursorHooksJson(homeDir) as unknown as { hooks: { SessionStart: unknown[] } }
    expect(doc.hooks.SessionStart).toEqual([foreignEntry])
  })

  it('backs up the file before mutating it', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    seedStaleClaudeShapedHooksJson()

    installAgentPack({ homeDir })

    const backupsDir = join(manifestDir, 'backups')
    const backups = existsSync(backupsDir) ? readdirSync(backupsDir) : []
    expect(backups.some((f) => f.includes('hooks.json'))).toBe(true)
  })

  it('the cleanup step itself backs up the file, isolated from the sibling wire-merge backup (code-review finding)', () => {
    // Seed the CORRECT lowercase keys up front (so startWire/endWire will
    // both report 'unchanged' and write no backup of their own), plus the
    // stale legacy keys the cleanup step is the ONLY thing that should touch.
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    writeFileSync(
      hooksJsonPath(),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: startPath() }],
            sessionEnd: [{ command: endPath() }],
            SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: startPath() }] }],
            SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: endPath() }] }],
          },
        },
        null,
        2
      )
    )

    const result = installAgentPack({ homeDir })

    const cursorReport = result.harnessReports.find((r) => r.harness === 'cursor')
    // The wire-merge calls found nothing to change (lowercase keys already correct).
    const wireResults = cursorReport?.hookConfig.slice(0, 2) ?? []
    expect(wireResults.every((r) => r.status === 'unchanged' && r.backupPath === null)).toBe(true)
    // The cleanup step is what actually mutated the file and backed it up —
    // it must appear as its own entry in hookConfig (code-review finding:
    // previously this step's mutation was invisible to the report).
    const cleanupResult = cursorReport?.hookConfig[2]
    expect(cleanupResult?.status).toBe('updated')
    expect(cleanupResult?.backupPath).not.toBeNull()

    const doc = readCursorHooksJson(homeDir) as unknown as { hooks: { SessionStart?: unknown } }
    expect(doc.hooks.SessionStart).toBeUndefined()
  })

  it('does NOT touch the file at all when the wire-merge reports a conflict (code-review finding: prevents data loss)', () => {
    // An incompatible top-level `version` makes both mergeJsonArrayEntry
    // calls fail closed with status:'conflict' and write NOTHING. The
    // legacy-cleanup step must be skipped entirely in that case — running it
    // anyway would silently wipe the user's legacy hooks to `hooks: {}` even
    // though the "real" installer refused to touch the file.
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    const original = JSON.stringify(
      {
        version: 2, // incompatible with CURSOR_HOOKS_JSON_DEFAULTS's required version: 1
        hooks: {
          SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: startPath() }] }],
          SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: endPath() }] }],
        },
      },
      null,
      2
    )
    writeFileSync(hooksJsonPath(), original)

    const result = installAgentPack({ homeDir })

    // The file must be byte-for-byte unchanged — no partial cleanup.
    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(original)
    const cursorReport = result.harnessReports.find((r) => r.harness === 'cursor')
    expect(cursorReport?.hookConfig.some((r) => r.status === 'conflict')).toBe(true)
    // No THIRD (cleanup) entry was pushed — it was skipped entirely, not
    // run-and-reported-as-a-no-op.
    expect(cursorReport?.hookConfig).toHaveLength(2)
  })

  it('removes a legacy key that is already an empty array (a dead key from a prior interrupted cleanup)', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    writeFileSync(
      hooksJsonPath(),
      JSON.stringify({ hooks: { SessionStart: [], SessionEnd: [] } }, null, 2)
    )

    installAgentPack({ homeDir })

    const doc = readCursorHooksJson(homeDir) as unknown as {
      hooks: { SessionStart?: unknown; SessionEnd?: unknown }
    }
    expect(doc.hooks.SessionStart).toBeUndefined()
    expect(doc.hooks.SessionEnd).toBeUndefined()
  })

  it('leaves a malformed (non-array) legacy value untouched instead of crashing', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    mkdirSync(join(homeDir, '.cursor'), { recursive: true })
    writeFileSync(
      hooksJsonPath(),
      JSON.stringify({ hooks: { SessionStart: 'not-an-array', SessionEnd: null } }, null, 2)
    )

    expect(() => installAgentPack({ homeDir })).not.toThrow()

    const raw = JSON.parse(readFileSync(hooksJsonPath(), 'utf-8')) as {
      hooks: { SessionStart: unknown; SessionEnd: unknown; sessionStart: unknown[] }
    }
    expect(raw.hooks.SessionStart).toBe('not-an-array')
    expect(raw.hooks.SessionEnd).toBeNull()
    // The correct lowercase keys are still written alongside the untouched malformed ones.
    expect(raw.hooks.sessionStart).toHaveLength(1)
  })

  it('is idempotent: a second install run on an already-cleaned file makes no further change', () => {
    mkdirSync(join(homeDir, '.cursor', 'skills'), { recursive: true })
    seedStaleClaudeShapedHooksJson()

    installAgentPack({ homeDir }) // first run: cleans the legacy keys
    const afterFirst = readFileSync(hooksJsonPath(), 'utf-8')
    const result = installAgentPack({ homeDir }) // second run: nothing left to clean
    const afterSecond = readFileSync(hooksJsonPath(), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
    const cursorReport = result.harnessReports.find((r) => r.harness === 'cursor')
    expect(cursorReport?.hookConfig.every((r) => r.status === 'unchanged')).toBe(true)
  })
})
