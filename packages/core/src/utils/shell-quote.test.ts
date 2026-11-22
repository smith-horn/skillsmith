/**
 * SMI-6531 (#3283): `shellQuote` against a case table, and the property that
 * makes it correct: a real POSIX shell (`/bin/sh`) given the quoted word
 * passes the original bytes to the program.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellQuote } from './shell-quote.js'

/** What `/bin/sh` hands `printf` as its one argument for `word`. */
function throughShell(word: string): string {
  const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' })
  expect(r.status).toBe(0)
  return r.stdout
}

const CASES: Array<[string, string, string]> = [
  ['a plain path', '/home/u/.claude/skills/.skillsmith-parked/op/my-skill-0123abcd', 'bare'],
  ['a space', '/Users/u/Library/Application Support/x', 'quoted'],
  ['a single quote', "/tmp/o'q/x", 'quoted'],
  ['a dollar sign', '/tmp/$HOME/x', 'quoted'],
  ['a backtick', '/tmp/`id`/x', 'quoted'],
  ['a newline', '/tmp/a\nb/x', 'quoted'],
  ['a leading tilde', '~/x', 'quoted'],
  ['empty', '', 'quoted'],
]

describe('shellQuote', () => {
  for (const [name, arg, form] of CASES) {
    it(`${name}: ${form}, and the shell passes the same bytes`, () => {
      const q = shellQuote(arg)
      if (form === 'bare') expect(q).toBe(arg)
      else expect(q.startsWith("'") && q.endsWith("'")).toBe(true)
      expect(throughShell(q)).toBe(arg)
    })
  }

  it('a single quote is written as the close-escape-reopen sequence', () => {
    expect(shellQuote("a'b c")).toBe(`'a'\\''b c'`)
  })
})
