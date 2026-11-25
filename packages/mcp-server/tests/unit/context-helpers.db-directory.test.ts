/**
 * SMI-7260: the MCP server creates its database directory owner-only (0o700),
 * like the CLI, because it holds the user's skill index.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDbDirectory } from '../../src/context.helpers.js'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('SMI-7260: ensureDbDirectory', () => {
  it('creates a missing database directory with mode 0o700', () => {
    root = mkdtempSync(join(tmpdir(), 'smi7260-mcp-dir-'))
    const dir = join(root, 'not-yet')
    expect(existsSync(dir)).toBe(false)

    ensureDbDirectory(join(dir, 'skills.db'))

    expect(statSync(dir).isDirectory()).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it("leaves an existing directory's mode alone", () => {
    root = mkdtempSync(join(tmpdir(), 'smi7260-mcp-dir-'))
    const dir = join(root, 'already')
    mkdirSync(dir)
    chmodSync(dir, 0o755)

    ensureDbDirectory(join(dir, 'skills.db'))

    expect(statSync(dir).mode & 0o777).toBe(0o755)
  })
})
