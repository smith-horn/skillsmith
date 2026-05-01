/**
 * SMI-4586 Goal #5 — Ledger schema + replay validation.
 *
 * Pass criterion:
 *   (a) Replay scenario passes:
 *       1. Install fixture skill A with /ship command
 *       2. User manually renames /ship → /anthropic-ship; ledger entry recorded
 *       3. Pack version bumps; install path re-ships /ship
 *       4. Re-install consults ledger; new file is renamed in place to /anthropic-ship
 *       5. Assertion: /ship does not exist post-replay; /anthropic-ship does
 *   (b) JSON round-trip preserves ULID auditId + ISO8601 timestamps without loss.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface LedgerEntry {
  skillId: string
  originalIdentifier: string
  renamedTo: string
  kind: 'command' | 'agent' | 'skill'
  appliedAt: string // ISO8601
  auditId: string // ULID
  reason: string
}

interface Ledger {
  version: 1
  overrides: LedgerEntry[]
}

function fakeUlid(): string {
  // 26-char Crockford-base32-ish — sufficient for round-trip test
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0')
  const rand = Math.random().toString(36).slice(2, 18).toUpperCase().padEnd(16, 'X')
  return (ts + rand).slice(0, 26)
}

function applyLedgerToInstall(installRoot: string, ledger: Ledger): { renamedFiles: string[] } {
  const renamedFiles: string[] = []
  for (const entry of ledger.overrides) {
    if (entry.kind !== 'command') continue
    const oldPath = join(installRoot, 'commands', `${entry.originalIdentifier.replace(/^\//, '')}.md`)
    const newPath = join(installRoot, 'commands', `${entry.renamedTo.replace(/^\//, '')}.md`)
    if (existsSync(oldPath)) {
      // If the new path already exists from a previous apply, treat the new install of the
      // original as a re-shipped duplicate to be removed (renamed-to is canonical).
      if (existsSync(newPath)) {
        rmSync(oldPath)
        renamedFiles.push(`removed_dup:${oldPath}`)
      } else {
        renameSync(oldPath, newPath)
        renamedFiles.push(`renamed:${oldPath}->${newPath}`)
      }
    }
  }
  return { renamedFiles }
}

function main(): void {
  const root = join(tmpdir(), `smi-4586-ledger-${Date.now()}`)
  mkdirSync(join(root, 'commands'), { recursive: true })

  // Step 1: install skill A with /ship
  writeFileSync(join(root, 'commands', 'ship.md'), '# /ship — initial install')

  // Step 2: user renames /ship → /anthropic-ship; record in ledger
  const ledger: Ledger = {
    version: 1,
    overrides: [
      {
        skillId: 'anthropic/release-tools',
        originalIdentifier: '/ship',
        renamedTo: '/anthropic-ship',
        kind: 'command',
        appliedAt: new Date().toISOString(),
        auditId: fakeUlid(),
        reason: 'collision with built-in /ship verb',
      },
    ],
  }
  const ledgerPath = join(root, 'namespace-overrides.json')
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))

  // Manual rename: ship.md -> anthropic-ship.md
  renameSync(join(root, 'commands', 'ship.md'), join(root, 'commands', 'anthropic-ship.md'))

  // Step 3: simulate pack version bump — re-ships /ship
  writeFileSync(join(root, 'commands', 'ship.md'), '# /ship — re-shipped after version bump')

  // Step 4: install path consults ledger and re-applies
  const reReadLedger: Ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  const { renamedFiles } = applyLedgerToInstall(root, reReadLedger)

  // Step 5: assertions
  const shipExists = existsSync(join(root, 'commands', 'ship.md'))
  const renamedExists = existsSync(join(root, 'commands', 'anthropic-ship.md'))

  // (b) JSON round-trip
  const roundTripped = JSON.parse(JSON.stringify(reReadLedger)) as Ledger
  const orig = reReadLedger.overrides[0]
  const rt = roundTripped.overrides[0]
  const tsOk = rt.appliedAt === orig.appliedAt
  const ulidOk = rt.auditId === orig.auditId

  // Cleanup
  rmSync(root, { recursive: true, force: true })

  const replayPass = !shipExists && renamedExists
  const result = {
    goal: 5,
    replay: {
      ship_exists_after_apply: shipExists,
      renamed_exists_after_apply: renamedExists,
      apply_log: renamedFiles,
      pass: replayPass,
    },
    json_roundtrip: {
      timestamp_preserved: tsOk,
      ulid_preserved: ulidOk,
      original_appliedAt: orig.appliedAt,
      roundtripped_appliedAt: rt.appliedAt,
      original_auditId: orig.auditId,
      roundtripped_auditId: rt.auditId,
      pass: tsOk && ulidOk,
    },
    schema_sample: ledger,
    criterion: 'replay passes AND JSON round-trip preserves auditId + appliedAt',
    verdict: replayPass && tsOk && ulidOk ? 'pass' : 'no-go',
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
