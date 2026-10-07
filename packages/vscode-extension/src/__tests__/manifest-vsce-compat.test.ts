/**
 * The extension's declared minimum VS Code version (`engines.vscode`) must not be
 * older than the API types it compiles against (`@types/vscode`). vsce refuses to
 * package otherwise, and no CI job runs vsce, so without this test the mismatch
 * only surfaces at release time (SMI-7008: it sat unnoticed from the 1.125.0 types
 * pin until the next packaging attempt).
 *
 * The test calls vsce's own check rather than re-implementing the comparison, so
 * it asserts the rule vsce actually enforces. If a vsce upgrade moves or renames
 * the function, the require fails loudly rather than the test passing vacuously.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  engines: { vscode: string }
  devDependencies: Record<string, string | undefined>
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- vsce ships CommonJS with no exports map for this module
const { validateVSCodeTypesCompatibility } = require('@vscode/vsce/out/validation') as {
  validateVSCodeTypesCompatibility: (engine: string, types: string) => void
}

describe('package.json engines.vscode vs @types/vscode (vsce packaging rule)', () => {
  it('vsce accepts the manifest: @types/vscode is not newer than engines.vscode', () => {
    const engine = manifest.engines.vscode
    const types = manifest.devDependencies['@types/vscode'] ?? ''
    expect(typeof validateVSCodeTypesCompatibility).toBe('function')
    expect(engine).toMatch(/\d+\.\d+/)
    expect(types).toMatch(/\d+\.\d+/)
    expect(() => validateVSCodeTypesCompatibility(engine, types)).not.toThrow()
  })

  it('positive control: the same vsce check refuses types newer than the engine floor', () => {
    expect(() => validateVSCodeTypesCompatibility('^1.110.0', '1.125.0')).toThrow(
      /greater than engines\.vscode/
    )
  })
})
