/**
 * SMI-7060: the experiment script's description extraction and exit status.
 */
import { describe, expect, it } from 'vitest'

import { experimentExitCode, skillDescription } from '../run-large-skill-experiments.helpers.ts'

describe('skillDescription', () => {
  const fm = (yaml: string) => `---\n${yaml}\n---\n\n# Body\n`

  it('reads a plain value', () => {
    expect(skillDescription(fm('name: x\ndescription: Does a thing'))).toBe('Does a thing')
  })

  it('reads a quoted value without its quotes', () => {
    expect(skillDescription(fm('description: "Does a thing"'))).toBe('Does a thing')
  })

  it('reads a folded value as its text, not the literal ">"', () => {
    expect(skillDescription(fm('description: >\n  Does a\n  thing'))).toBe('Does a thing')
  })

  // The value starts on the line after the key. The shared parser still drops
  // continuation lines when a plain scalar starts ON the key line (SMI-7064);
  // add that form here once SMI-7064 fixes the parser.
  it('reads a multi-line plain scalar in full', () => {
    expect(skillDescription(fm('description:\n  Does a\n  thing well'))).toBe('Does a thing well')
  })

  it('is empty when the key is missing', () => {
    expect(skillDescription(fm('name: x'))).toBe('')
  })

  it('ignores a description: line in the body when there is no frontmatter', () => {
    expect(skillDescription('# Title\n\ndescription: not frontmatter\n')).toBe('')
  })
})

describe('experimentExitCode', () => {
  it('control: no failed transformation exits 0', () => {
    expect(experimentExitCode({ attempted: 3, transformFailed: 0 })).toBe(0)
  })

  it('every transformation failing exits non-zero', () => {
    expect(experimentExitCode({ attempted: 3, transformFailed: 3 })).toBe(1)
  })

  it('a single failed transformation exits non-zero', () => {
    expect(experimentExitCode({ attempted: 3, transformFailed: 1 })).toBe(1)
  })
})
