import * as vscode from 'vscode'

const UPDATE_COMMAND = 'npm install -g @skillsmith/mcp-server@latest'

/**
 * Parse an x.y.z version string into a [major, minor, patch] tuple.
 * Returns null for anything that is not three non-negative integers — pre-release
 * suffixes (`0.5.0-beta.1`) truncate at the dash, which is good enough for a
 * non-blocking gate (conservative: treat unparseable as "unknown", skip prompt).
 */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v || typeof v !== 'string') return null
  const core = v.split('-')[0] ?? ''
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const [maj, min, pat] = parts as [string, string, string]
  if (!/^\d+$/.test(maj) || !/^\d+$/.test(min) || !/^\d+$/.test(pat)) return null
  return [Number(maj), Number(min), Number(pat)]
}

/**
 * Returns true when `actual` satisfies `>= minimum`. If either version cannot be
 * parsed, returns true (fail-open — a toast on every connect would be noise).
 */
export function meetsMinimum(actual: string | null | undefined, minimum: string): boolean {
  const a = parseVersion(actual)
  const m = parseVersion(minimum)
  if (!a || !m) return true
  const [aMaj, aMin, aPat] = a
  const [mMaj, mMin, mPat] = m
  if (aMaj !== mMaj) return aMaj > mMaj
  if (aMin !== mMin) return aMin > mMin
  return aPat >= mPat
}

/**
 * SMI-4194: Non-blocking version-floor check. On mismatch, shows an
 * informational toast with a "Copy update command" action. Silent on match
 * or when versions are unparseable (fail-open).
 *
 * Tested directly rather than via extension.ts to keep vscode mocking tractable.
 */
export async function promptIfOutdated(
  serverVersion: string | null,
  minimumVersion: string,
  deps: {
    showInformationMessage: typeof vscode.window.showInformationMessage
    clipboardWrite: (text: string) => Thenable<void>
  }
): Promise<void> {
  if (meetsMinimum(serverVersion, minimumVersion)) return

  const selection = await deps.showInformationMessage(
    `Skillsmith MCP server ${serverVersion} is older than the extension's minimum (${minimumVersion}). Run \`${UPDATE_COMMAND}\` to update.`,
    'Copy update command'
  )
  if (selection === 'Copy update command') {
    await deps.clipboardWrite(UPDATE_COMMAND)
  }
}
