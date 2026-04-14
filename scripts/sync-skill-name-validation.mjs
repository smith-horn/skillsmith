#!/usr/bin/env node
/**
 * Regenerate packages/vscode-extension/src/utils/skillNameValidation.ts
 * from packages/cli/src/utils/skill-name.ts (SMI-4194).
 *
 * The VS Code extension cannot import @skillsmith/cli per ADR-113 (extension
 * is self-contained, esbuild-bundled, no workspace deps). This codegen copies
 * the validator verbatim into the extension and lets audit:standards detect
 * drift if the source changes without regeneration.
 *
 * Usage:
 *   node scripts/sync-skill-name-validation.mjs         # regenerate
 *   node scripts/sync-skill-name-validation.mjs --check # exit non-zero if stale
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const SOURCE = resolve(repoRoot, 'packages/cli/src/utils/skill-name.ts')
const TARGET = resolve(repoRoot, 'packages/vscode-extension/src/utils/skillNameValidation.ts')

const HEADER = `// AUTO-GENERATED from packages/cli/src/utils/skill-name.ts (SMI-4194).
// DO NOT EDIT BY HAND. Regenerate with:
//   node scripts/sync-skill-name-validation.mjs
// audit:standards enforces drift between this copy and the CLI source.
// The VS Code extension cannot import @skillsmith/cli per ADR-113; this
// codegen preserves parity without creating a runtime dependency.
`

function extract(source) {
  const reMatch = source.match(/export const VALID_SKILL_NAME_RE = \/[^\n]+/)
  const fnMatch = source.match(
    /export function validateSkillName\(name: string\): true \| string \{[\s\S]*?\n\}/
  )
  if (!reMatch || !fnMatch) {
    throw new Error(
      'Could not locate VALID_SKILL_NAME_RE or validateSkillName in CLI source. ' +
        'If the CLI source was refactored, update this codegen script.'
    )
  }
  return `${HEADER}\n${reMatch[0]}\n\n${fnMatch[0]}\n`
}

const source = await readFile(SOURCE, 'utf8')
const generated = extract(source)

const checkMode = process.argv.includes('--check')
if (checkMode) {
  const existing = await readFile(TARGET, 'utf8').catch(() => '')
  if (existing !== generated) {
    console.error(
      `✗ ${TARGET} is out of sync with ${SOURCE}.\n` +
        '  Run: node scripts/sync-skill-name-validation.mjs'
    )
    process.exit(1)
  }
  console.log(`✓ skillNameValidation.ts is in sync with CLI source.`)
  process.exit(0)
}

await writeFile(TARGET, generated, 'utf8')
console.log(`✓ Regenerated ${TARGET} from ${SOURCE}.`)
