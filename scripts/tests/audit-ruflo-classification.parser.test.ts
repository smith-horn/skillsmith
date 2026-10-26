/**
 * SMI-6744 A5.3: Check 79 parser-edge red arms, split from
 * audit-ruflo-classification.test.ts to stay under the 500-line limit.
 * Found by the confirmation governance pass on 04cdbde23.
 *
 * Each arm starts from the clean base fixture (proven clean in the main test
 * file) and changes one line, logging `applied=<mutation>`.
 */
import { describe, expect, it } from 'vitest'
import { applied, base, row, run } from './audit-ruflo-classification.fixtures'

describe('Check 79: parser-edge red arms', () => {
  it('base fixture is clean here too (negative control for this file)', () => {
    expect(run(base()).findings).toEqual([])
  })

  it('y: a denied tool written by its full name in an Allowed cell -> rule C', () => {
    for (const token of ['hooks_intelligence_learn', 'mcp__ruflo__hooks_intelligence_learn']) {
      const fx = base()
      row(fx, 'hooks_').allowed = `\`safe\`, \`${token}\``
      applied(`y:allowed-full-name:${token}`)
      expect(run(fx).findings).toEqual([
        `rule C: denied "hooks_intelligence_learn" appears in the Allowed cell as "${token}"`,
      ])
    }
  })

  it('y negative control: a full name of an allowed tool in an Allowed cell is clean', () => {
    const fx = base()
    row(fx, 'hooks_').allowed = '`safe`, `hooks_intelligence_stats`'
    applied('y:allowed-full-name-not-denied')
    expect(run(fx).findings).toEqual([])
  })

  it('z: a second header-shaped line inside the table -> rule F2', () => {
    const fx = base()
    fx.extraTableLines = ['| Prefix | `intelligence_learn` (allowed) | none |']
    applied('z:second-header')
    expect(run(fx).findings).toEqual([
      'rule F2: unparsed table row: | Prefix | `intelligence_learn` (allowed) | none |',
    ])
  })

  it('z2: a table row without a leading pipe -> rule F2', () => {
    const fx = base()
    fx.extraTableLines = ['`hooks_intelligence*` | all | none |']
    applied('z2:no-leading-pipe')
    expect(run(fx).findings).toEqual([
      'rule F2: table row without a leading pipe: `hooks_intelligence*` | all | none |',
    ])
  })
})
