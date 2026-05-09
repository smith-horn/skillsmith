/**
 * SMI-4829 gate #2: LocalIndexer empty-directory contract.
 *
 * Sibling file to LocalIndexer.test.ts. Lives separately because the parent
 * file already exceeds the 500-line gate (~840 lines as of cutover); the
 * SMI-4829 plan §"What NOT to do" forbids in-scope refactoring of unrelated
 * tests. Placing the new test here keeps both files green and readable.
 *
 * Contract from investigation §6.2.3 + plan §3: LocalIndexer.index() MUST
 * return [] (not throw) for three states of the .claude/skills/ directory:
 *   (a) present + non-empty  — covered by LocalIndexer.test.ts (existing)
 *   (b) present + empty       — covered HERE (new for shape (b) cutover)
 *   (c) absent                — covered by LocalIndexer.test.ts:328 (existing)
 *
 * State (b) is the dominant external-contributor scenario post-cutover:
 * the `.claude/skills/` mount-point exists as a submodule mount but the
 * contributor never ran `git submodule update --init` (or the per-clone
 * sparse-checkout cone filtered everything out).
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { LocalIndexer } from '../indexer/LocalIndexer.js'

describe('LocalIndexer — SMI-4829 gate #2 empty-dir contract', () => {
  it('returns [] for present-but-empty directory (state b)', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-empty-'))
    try {
      const indexer = new LocalIndexer(emptyDir)
      const skills = await indexer.index()
      expect(skills).toEqual([])
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
