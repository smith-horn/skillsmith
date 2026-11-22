/**
 * SMI-6531 (#3283): `shellQuote` against a case table, and the property that
 * makes it correct: a real shell given the quoted word passes the original
 * bytes to the program. Checked under `/bin/sh` and, where it exists,
 * `/bin/bash` (which expands `~` after `name=` or `:` inside a word).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shellQuote } from './shell-quote.js'

const SHELLS = ['/bin/sh', '/bin/bash'].filter((s) => fs.existsSync(s))

/** What `shell` hands `printf` as its one argument for `word`. */
function throughShell(shell: string, word: string): string {
  const r = spawnSync(shell, ['-c', `printf '%s' ${word}`], { encoding: 'utf8' })
  expect(r.status, shell).toBe(0)
  return r.stdout
}

const CASES: Array<[string, string, 'bare' | 'quoted']> = [
  ['a plain path', '/home/u/.claude/skills/.skillsmith-parked/op/my-skill-0123abcd', 'bare'],
  ['every other bare character', '/a_b.c:d@e%f+g,h-i/9', 'bare'],
  ['a space', '/Users/u/Library/Application Support/x', 'quoted'],
  ['a single quote', "/tmp/o'q/x", 'quoted'],
  ['a dollar sign', '/tmp/$HOME/x', 'quoted'],
  ['a backtick', '/tmp/`id`/x', 'quoted'],
  ['a newline', '/tmp/a\nb/x', 'quoted'],
  ['a leading tilde', '~/x', 'quoted'],
  ['a tilde inside a word', '/a~b/x', 'quoted'],
  ['a tilde after name=', 'a=~/x', 'quoted'],
  ['a tilde after a colon', 'x:~/y', 'quoted'],
  ['a leading equals sign', '=ls', 'quoted'],
  ['a leading dash', '-x', 'quoted'],
  ['non-ASCII', '/tmp/é/x', 'quoted'],
  ['empty', '', 'quoted'],
]

describe('shellQuote', () => {
  it('runs against at least /bin/sh', () => {
    expect(SHELLS).toContain('/bin/sh')
  })

  for (const [name, arg, form] of CASES) {
    it(`${name}: ${form}, and every shell passes the same bytes`, () => {
      const q = shellQuote(arg)
      if (form === 'bare') expect(q).toBe(arg)
      else expect(q.startsWith("'") && q.endsWith("'")).toBe(true)
      for (const shell of SHELLS) expect(throughShell(shell, q), shell).toBe(arg)
    })
  }

  it('a single quote is written as the close-escape-reopen sequence', () => {
    expect(shellQuote("a'b c")).toBe(`'a'\\''b c'`)
  })
})
