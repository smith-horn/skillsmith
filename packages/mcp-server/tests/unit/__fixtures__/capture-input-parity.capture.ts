/**
 * SMI-7168: regenerates `input-parity.zod3.json`, the zod 3.25.76 baseline that
 * input-schema-parity.test.ts compares every later zod against.
 *
 * Not a test (the name does not match `*.test.ts`); it runs only through vitest.capture.config.ts,
 * which aliases `zod` to the copy named by ZOD3_DIR and refuses any version other than 3.25.76.
 *
 * Command (from the repo root, in the dev container; ZOD3_DIR is an extracted `npm pack zod@3.25.76`):
 *
 *   ZOD3_DIR=<dir>/package npx vitest run -c packages/mcp-server/tests/unit/__fixtures__/vitest.capture.config.ts
 *
 * It prints the case count and the git tree SHA of the checkout it ran in, then writes the fixture,
 * formatted by the repo's prettier config so the bytes match what is committed. On an unchanged
 * case table it reproduces the committed file exactly; `git diff` is the check. Regenerate only to
 * ADD cases (new keys); a changed existing entry means the baseline itself moved and needs a reason.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import { format, resolveConfig } from 'prettier'
import {
  ALL_ENTRIES,
  recordAll,
  serializeFixture,
  zodMajorOf,
} from '../input-schema-parity.helpers.js'

const FIXTURE = fileURLToPath(new URL('./input-parity.zod3.json', import.meta.url))

it('captures the zod 3 baseline', async () => {
  expect(zodMajorOf(ALL_ENTRIES[0].schema), 'the aliased zod must be a zod 3 install').toBe(3)

  const fixture = recordAll()
  // A worktree's .git points at a host path, so git can fail inside the container; say so, don't guess.
  let treeSha = process.env.GIT_TREE_SHA ?? ''
  if (!treeSha) {
    try {
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    } catch {
      treeSha =
        'unavailable here (run `git rev-parse HEAD^{tree}` on the host, or pass GIT_TREE_SHA)'
    }
  }
  console.log(`capture: ${Object.keys(fixture).length} cases, git tree ${treeSha}`)

  const options = (await resolveConfig(FIXTURE)) ?? {}
  const text = await format(serializeFixture(fixture), { ...options, filepath: FIXTURE })
  const before = readFileSync(FIXTURE, 'utf8')
  writeFileSync(FIXTURE, text)
  console.log(
    `capture: wrote ${FIXTURE} (${text === before ? 'identical to' : 'DIFFERENT from'} the previous file)`
  )
})
