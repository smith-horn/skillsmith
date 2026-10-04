/**
 * SMI-6978 (SMI-6944 retro): Check 4 command-word bypasses through wrapper
 * words, redirections, `find -exec`, a function body and `alias`.
 *
 * Every positive case is paired with a presence control: the same shape around
 * the absolute lockfile path is NOT flagged, AND the scanner still reports it as
 * a Vercel call whose word is that path, so a clean result cannot come from a
 * scanner that found no command at all.
 *
 * @see scripts/ci/check-supply-chain-pins.wrappers.mjs
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect } from 'vitest'

const cmds = (await import('../ci/check-supply-chain-pins.commands.mjs')) as {
  vercelCalls: (b: string) => Array<{ word: string; verb: string }>
  nonLockfileVercelCalls: (b: string) => Array<{ word: string; verb: string }>
}
const dispatch = (await import('../ci/check-supply-chain-pins.vercel-dispatch.mjs')) as {
  vercelAssignments: (b: string) => Array<{ name: string; value: string }>
}
const { scanWorkflowSource } = (await import('../ci/check-supply-chain-pins.mjs')) as {
  scanWorkflowSource: (
    src: string,
    file: string,
    deps: Set<string>,
    lock?: Map<string, string>
  ) => { findings: Array<{ rule: string }> }
}

const ABS = '"$GITHUB_WORKSPACE/node_modules/.bin/vercel"'

/** Each shape takes the command word W and builds a run line around it. */
const SHAPES: Array<[string, (w: string) => string]> = [
  ['sudo -u (value flag)', (w) => `sudo -u runner ${w} deploy`],
  ['sudo --user (long value flag)', (w) => `sudo --user runner ${w} deploy`],
  ['env -u (value flag)', (w) => `env -u FOO ${w} deploy`],
  ['env -S (split string)', (w) => `env -S '${w} deploy'`],
  ['exec -a (value flag)', (w) => `exec -a x ${w} deploy`],
  ['timeout -s plus DURATION', (w) => `timeout -s KILL 60 ${w} deploy`],
  ['timeout --signal= plus DURATION', (w) => `timeout --signal=KILL 60 ${w} deploy`],
  ['setsid', (w) => `setsid ${w} deploy`],
  ['stdbuf -oL (attached value)', (w) => `stdbuf -oL ${w} deploy`],
  ['stdbuf -o L (separate value)', (w) => `stdbuf -o L ${w} deploy`],
  ['nice -n', (w) => `nice -n 10 ${w} deploy`],
  ['nohup', (w) => `nohup ${w} deploy &`],
  ['time -p', (w) => `time -p ${w} deploy`],
  ['xargs -I', (w) => `xargs -I {} ${w} deploy {}`],
  ['doas -u', (w) => `doas -u runner ${w} deploy`],
  ['a leading redirection', (w) => `>/dev/null ${w} deploy`],
  ['a leading detached redirection', (w) => `> /dev/null ${w} deploy`],
  ['a leading fd duplication', (w) => `2>&1 ${w} deploy`],
  ['find -exec ... \\;', (w) => `find . -exec ${w} deploy \\;`],
  ["find -execdir ... ';'", (w) => `find . -execdir ${w} deploy ';'`],
  ['find -exec ... +', (w) => `find . -name x -exec ${w} {} +`],
  ['a function body', (w) => `function f { ${w} deploy; }`],
]

describe('SMI-6978: Check 4 wrapper and redirection bypasses', () => {
  it.each(SHAPES)('flags vercel through %s', (_n, shape) => {
    const body = shape('vercel')
    const found = cmds.nonLockfileVercelCalls(body)
    expect(found).toHaveLength(1)
    expect(found[0].word).toBe('vercel')
  })

  it.each(SHAPES)('flags vc through %s', (_n, shape) => {
    expect(cmds.nonLockfileVercelCalls(shape('vc'))).toHaveLength(1)
  })

  it.each(SHAPES)(
    'presence control, not flagged: the lockfile path through %s is seen and clean',
    (_n, shape) => {
      const body = shape(ABS)
      expect(cmds.nonLockfileVercelCalls(body)).toEqual([])
      expect(cmds.vercelCalls(body).map((c) => c.word)).toEqual([ABS])
    }
  )

  it('a redirection glued to the command word is split from it', () => {
    expect(cmds.nonLockfileVercelCalls('vercel>/dev/null deploy')).toHaveLength(1)
    expect(cmds.vercelCalls(`${ABS}>/dev/null deploy`).map((c) => c.word)).toEqual([ABS])
    expect(cmds.nonLockfileVercelCalls(`${ABS}>/dev/null deploy`)).toEqual([])
  })

  it('negative controls: a lookup, an argument, and a redirect target are not commands', () => {
    for (const body of [
      'command -v vercel',
      'echo vercel deploy > out.txt',
      'timeout 60 echo vercel',
      'echo done > vercel',
    ]) {
      expect(cmds.vercelCalls(body), body).toEqual([])
    }
  })

  describe('alias', () => {
    it.each([
      ['alias v=vercel; v deploy', 'v'],
      ["alias v='vc deploy'", 'v'],
      [`alias v=${ABS}`, 'v'],
    ])('flags %s as indirect dispatch', (body, name) => {
      expect(dispatch.vercelAssignments(body).map((a) => a.name)).toEqual([name])
    })
    it('an alias for something else is not flagged, and the rule runs in Check 4', () => {
      expect(dispatch.vercelAssignments("alias ll='ls -la'")).toEqual([])
      const wf = ['jobs:', '  j:', '    steps:', '      - run: alias v=vercel; v deploy', ''].join(
        '\n'
      )
      const rules = scanWorkflowSource(wf, 'wf.yml', new Set(['vercel'])).findings.map(
        (f) => f.rule
      )
      expect(rules).toContain('workflow-vercel-indirect-dispatch')
    })
  })
})
