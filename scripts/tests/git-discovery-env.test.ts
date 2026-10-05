/**
 * SMI-6994 B4: behavioural test of the shared git-discovery-env helper
 * (scripts/lib/git-discovery-env.mjs), used by Check 72 and the Check 76 seeds module.
 * The canonical list is written out by hand, not derived from the regex, so a narrowed
 * regex fails here.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { gitDiscoveryScrubbedEnv } from '../lib/git-discovery-env.mjs'

const CANONICAL = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]
const NEAR_MISSES: Record<string, string> = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_PARAMETERS: "'core.x=y'",
  GIT_AUTHOR_NAME: 'a',
  GIT_DIR_EXTRA: 'e',
  XGIT_DIR: 'x',
  git_dir: 'lower',
}

describe('gitDiscoveryScrubbedEnv', () => {
  it.each(CANONICAL)('removes %s and keeps every near-miss with its value', (name) => {
    const input: Record<string, string> = { ...NEAR_MISSES, [name]: '/nowhere', KEEP: 'k' }
    const out = gitDiscoveryScrubbedEnv(input) as Record<string, string>
    expect(out).not.toHaveProperty(name)
    for (const [k, v] of Object.entries(NEAR_MISSES)) expect(out[k]).toBe(v)
    expect(out.KEEP).toBe('k')
  })

  it('does not mutate its argument', () => {
    const input: Record<string, string> = {}
    for (const n of CANONICAL) input[n] = '/x'
    const before = { ...input }
    gitDiscoveryScrubbedEnv(input)
    expect(input).toEqual(before)
    for (const n of CANONICAL) expect(input).toHaveProperty(n)
  })

  it('defaults to process.env', () => {
    const script = fileURLToPath(new URL('../lib/git-discovery-env.mjs', import.meta.url))
    const code =
      `import(${JSON.stringify(script)}).then((m) => ` +
      `{ const e = m.gitDiscoveryScrubbedEnv(); ` +
      `console.log(JSON.stringify([ 'GIT_DIR' in e, e.SMI6994_KEEP, process.env.GIT_DIR ])) })`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: '/x', SMI6994_KEEP: '1' },
    })
    expect(r.status).toBe(0)
    // GIT_DIR scrubbed, AND a non-git variable carried over from process.env (presence: the
    // default really is process.env, not an empty object), AND the real env left intact
    expect(JSON.parse(r.stdout)).toEqual([false, '1', '/x'])
  })
})
