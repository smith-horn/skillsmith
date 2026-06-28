/**
 * @fileoverview Bundled-sibling security scan for `skill_validate` (SMI-5422 Phase 1).
 *
 * Extracted from validate.ts as a standalone, dependency-light function so it can
 * be unit-tested directly (no ToolContext / database). It mirrors the install
 * gate (`fetchAndScanOptionalFiles` + `isRejectableScan`) so an author's local
 * `skill_validate` pre-flight matches what `install_skill` will reject.
 *
 * Detection-coverage limitations are inherited from the scanner patterns and are
 * tracked in SMI-5424 (e.g. `&&`/`;`-chained fetch-execute, JSON `\uXXXX`-escaped
 * commands in raw-scanned structured files, `npx`, `fish`/`bun`/`deno` sinks).
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { SecurityScanner } from '@skillsmith/core'
import {
  BUNDLED_SCAN_FILES,
  classifyBundledFile,
  extractPackageJsonLifecycleScripts,
  isRejectableScan,
} from '@skillsmith/core/services/skill-installation-policy'
import type { ValidationError } from './validate.types.js'

/**
 * Scan the bundled sibling files in a local skill directory the same way the
 * install path does, returning a ValidationError per rejectable file. Doc and
 * config classes are skipped (docs quote attack strings; config.json has its own
 * structural validation). A missing sibling is a silent skip. package.json is
 * scanned KEY-LEVEL (lifecycle hook values only).
 *
 * @param skillPath absolute path to the skill directory
 * @param riskThreshold scanner threshold (default 40 — community tier; validate
 *   has no trust-tier context)
 */
export async function scanBundledSiblings(
  skillPath: string,
  riskThreshold = 40
): Promise<ValidationError[]> {
  const errors: ValidationError[] = []
  const scanner = new SecurityScanner({ riskThreshold })
  for (const siblingFile of BUNDLED_SCAN_FILES) {
    const fileClass = classifyBundledFile(siblingFile)
    if (fileClass === 'doc' || fileClass === 'config') continue

    let siblingContent: string
    try {
      siblingContent = await fs.readFile(join(skillPath, siblingFile), 'utf-8')
    } catch {
      continue // sibling absent — silent skip
    }

    let textToScan: string = siblingContent
    if (fileClass === 'package-json') {
      const lifecycle = extractPackageJsonLifecycleScripts(siblingContent)
      if (lifecycle.length === 0) continue // no lifecycle hooks — no install-time risk
      textToScan = lifecycle
    }

    const report = scanner.scan(`${skillPath}/${siblingFile}`, textToScan)
    if (!isRejectableScan(report)) continue

    // Surface the driving finding: prefer high/critical, else the top-tier
    // exec/obfuscation category that drove a lone-medium rejection.
    const topFinding =
      report.findings.find((f) => f.severity === 'critical' || f.severity === 'high') ??
      report.findings.find(
        (f) => f.type === 'code_execution' || f.type === 'obfuscated_directive'
      ) ??
      report.findings[0]
    const matchedLabel = topFinding ? (topFinding.category ?? topFinding.type) : 'unknown'
    errors.push({
      field: siblingFile,
      message:
        `Security scan failed for "${siblingFile}": ${report.findings.length} finding(s) ` +
        `(risk score ${report.riskScore}, matched: ${matchedLabel}). ` +
        `install_skill would reject this skill. See https://skillsmith.app/docs/security/scanner`,
      severity: 'error',
    })
  }
  return errors
}
