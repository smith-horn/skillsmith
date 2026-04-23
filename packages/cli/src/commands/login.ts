// SMI-4402: RFC 8628 device-code OAuth flow replacing paste-key model.
// --paste-legacy retained as deliberate opt-out (L1 deprecation window).

import { Command } from 'commander'
import { password } from '@inquirer/prompts'
import chalk from 'chalk'
import {
  getApiKey,
  getApiBaseUrl,
  loadCredentials,
  storeCredentials,
  storeApiKey,
  isValidApiKeyFormat,
  type TokenCredentials,
} from '@skillsmith/core'

const DEVICE_PAGE_URL = 'https://skillsmith.app/device'
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000
const POLL_MS = 5_000
const SLOW_DOWN_MS = 10_000

// Per plan spec §Wave 3 CLI matrix (C6)
const EXIT = { success: 0, generic: 1, cancelled: 2, authError: 3, timeout: 4, network: 5 } as const

interface DeviceCodeBody {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

type PollResult =
  | { ok: true; creds: Omit<TokenCredentials, 'version'> }
  | { ok: false; status: 'pending' | 'slow_down' | 'expired' | 'declined' }

function termCols(): number {
  return Math.max(40, (process.stdout.columns ?? 80) - 4)
}

// OSC 8 hyperlink — degrades to plain URL in unsupported terminals
function oscLink(label: string, url: string): string {
  if (!process.stdout.isTTY) return url
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}

function renderCodeBox(userCode: string): string {
  const raw = userCode.replace(/-/g, '').toUpperCase()
  const display = raw.length >= 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}` : raw
  const inner = `  ${display}  `
  const bar = '─'.repeat(inner.length)
  return `┌${bar}┐\n│${inner}│\n└${bar}┘`
}

function isHeadless(): boolean {
  return process.env['CI'] === 'true' || (process.platform === 'linux' && !process.env['DISPLAY'])
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  try {
    const { default: open } = await import('open')
    await open(url)
    return true
  } catch {
    return false
  }
}

// Returns the legacy sk_live_* key from env or config file, or null.
function detectLegacyKey(): string | null {
  const envKey = process.env['SKILLSMITH_API_KEY']
  if (envKey && /^sk_live_/.test(envKey)) return envKey
  const cfgKey = getApiKey()
  if (cfgKey && /^sk_live_/.test(cfgKey)) return cfgKey
  return null
}

function functionUrl(name: string): string {
  const base = getApiBaseUrl()
  // getApiBaseUrl() already ends with /functions/v1 in production
  return base.endsWith('/functions/v1') ? `${base}/${name}` : `${base}/functions/v1/${name}`
}

async function requestDeviceCode(): Promise<DeviceCodeBody> {
  const res = await fetch(functionUrl('auth-device-code'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_type: 'cli' }),
  })
  if (!res.ok) throw new Error(`auth-device-code HTTP ${res.status}`)
  return res.json() as Promise<DeviceCodeBody>
}

async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const res = await fetch(functionUrl('auth-device-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  })

  if (res.status === 428) return { ok: false, status: 'pending' }
  if (res.status === 429) return { ok: false, status: 'slow_down' }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (!res.ok) {
    const err = (body['error'] as string) ?? ''
    if (err === 'expired_token') return { ok: false, status: 'expired' }
    if (err === 'authorization_declined') return { ok: false, status: 'declined' }
    throw new Error(`auth-device-token error: ${err || res.status}`)
  }

  if (typeof body['error'] === 'string') {
    const errVal = body['error']
    if (errVal === 'authorization_pending') return { ok: false, status: 'pending' }
    if (errVal === 'slow_down') return { ok: false, status: 'slow_down' }
    if (errVal === 'expired_token') return { ok: false, status: 'expired' }
    if (errVal === 'authorization_declined') return { ok: false, status: 'declined' }
    throw new Error(`auth-device-token error: ${errVal}`)
  }

  const expiresIn = (body['expires_in'] as number) ?? 3600
  return {
    ok: true,
    creds: {
      accessToken: body['access_token'] as string,
      refreshToken: body['refresh_token'] as string,
      expiresAt: Date.now() + expiresIn * 1000,
    },
  }
}

async function runDeviceCodeFlow(noBrowser: boolean): Promise<void> {
  let dc: DeviceCodeBody
  try {
    dc = await requestDeviceCode()
  } catch (err) {
    if (process.stdout.isTTY) {
      console.error(chalk.red('Network error requesting device code.'))
      if (err instanceof Error) console.error(chalk.dim(err.message))
    } else {
      process.stderr.write(
        JSON.stringify({
          error: 'network_error',
          message: err instanceof Error ? err.message : String(err),
        }) + '\n'
      )
    }
    process.exit(EXIT.network)
  }

  const approveUrl = `${DEVICE_PAGE_URL}?user_code=${encodeURIComponent(dc.user_code)}`
  const width = termCols()

  console.log()
  console.log(chalk.bold('Your one-time code:'))
  console.log(chalk.cyan(renderCodeBox(dc.user_code)))
  console.log()
  console.log(
    `Enter it at: ${oscLink(chalk.cyan(DEVICE_PAGE_URL), DEVICE_PAGE_URL)}`.slice(0, width)
  )
  console.log(chalk.dim('Code expires in 15 minutes.'))
  console.log()

  if (!noBrowser && !isHeadless()) {
    const opened = await tryOpenBrowser(approveUrl)
    console.log(
      opened
        ? chalk.dim('Browser opened — approve the request, then return here.')
        : chalk.dim(`Could not open browser. Visit the URL above.`)
    )
  } else if (noBrowser) {
    console.log(chalk.dim('--no-browser: visit the URL above to approve.'))
  }

  console.log(chalk.dim('Waiting for approval…'))

  let pollMs = POLL_MS
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollMs))

    let result: PollResult
    try {
      result = await pollDeviceToken(dc.device_code)
    } catch (err) {
      if (process.stdout.isTTY) {
        console.error(chalk.red('\nNetwork error while polling.'))
        if (err instanceof Error) console.error(chalk.dim(err.message))
      } else {
        process.stderr.write(
          JSON.stringify({
            error: 'network_error',
            message: err instanceof Error ? err.message : String(err),
          }) + '\n'
        )
      }
      process.exit(EXIT.network)
    }

    if (!result.ok) {
      if (result.status === 'pending') continue
      if (result.status === 'slow_down') {
        pollMs = SLOW_DOWN_MS
        continue
      }
      if (result.status === 'expired') {
        console.error(chalk.red('\nCode expired. Run `skillsmith login` again.'))
        process.exit(EXIT.timeout)
      }
      // declined
      console.error(
        chalk.red('\nRequest denied. Run `skillsmith login` again if this was a mistake.')
      )
      process.exit(EXIT.authError)
    }

    await storeCredentials({ ...result.creds, version: 2 })
    console.log(chalk.green('\nLogged in successfully.'))
    process.exit(EXIT.success)
  }

  console.error(chalk.red('\nApproval timed out. Run `skillsmith login` again.'))
  process.exit(EXIT.timeout)
}

async function runPasteLegacyFlow(): Promise<void> {
  console.log(`\nVisit: ${chalk.cyan('https://skillsmith.app/account/cli-token')}`)
  console.log('Copy your API key and paste it below.\n')

  let attempts = 0
  try {
    while (attempts < 3) {
      const raw = await password({ message: 'Paste your API key:' })
      if (!isValidApiKeyFormat(raw)) {
        attempts++
        if (attempts < 3) {
          console.error(
            chalk.red(`Invalid format (expected sk_live_…). Try again (${attempts}/3).`)
          )
        }
        continue
      }
      try {
        await storeApiKey(raw)
      } catch (err) {
        console.error(
          chalk.red(
            'Failed to store credentials: ' + (err instanceof Error ? err.message : String(err))
          )
        )
        process.exit(EXIT.generic)
      }
      console.log(chalk.green('\nLogged in successfully.'))
      console.log(chalk.dim('  Clear your clipboard when done.'))
      process.exit(EXIT.success)
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'ExitPromptError') {
      console.log(chalk.dim('\nCancelled.'))
      process.exit(EXIT.cancelled)
    }
    throw err
  }

  console.error(chalk.red('\nToo many invalid attempts.'))
  console.error(chalk.cyan('https://skillsmith.app/account/cli-token'))
  process.exit(EXIT.generic)
}

export function createLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate the Skillsmith CLI')
    .option('--no-browser', 'Print URL instead of opening browser (for CI/headless)')
    .option('--paste-legacy', 'Use legacy API-key paste flow')
    .action(async (options: { browser: boolean; pasteLegacy?: boolean }) => {
      // Already authenticated via JWT?
      const existing = await loadCredentials()
      if (existing && Date.now() < existing.expiresAt) {
        console.log('Already authenticated. Run `skillsmith logout` to switch accounts.')
        process.exit(EXIT.success)
      }

      // Legacy key detection: offer 3-choice menu (M10)
      const legacyKey = detectLegacyKey()
      if (legacyKey && !options.pasteLegacy) {
        const suffix = legacyKey.slice(-6)
        console.log()
        console.log(chalk.yellow(`A legacy API key is active (ends in …${suffix}).`))
        console.log()
        console.log(`  ${chalk.bold('(a)')} Keep using this key       [Enter]`)
        console.log(`  ${chalk.bold('(d)')} Switch to device-code flow`)
        console.log(`  ${chalk.bold('(p)')} Paste a new legacy key`)
        console.log()

        const { default: readline } = await import('readline')
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: false,
        })
        const choice = await new Promise<string>((resolve) => {
          process.stdout.write('Choice [a]: ')
          rl.once('line', (line) => {
            rl.close()
            resolve(line.trim().toLowerCase())
          })
        })

        if (choice === '' || choice === 'a') {
          console.log(chalk.dim('Keeping existing key.'))
          process.exit(EXIT.success)
        } else if (choice === 'p') {
          await runPasteLegacyFlow()
          return
        }
        // 'd' or anything else → device flow
        await runDeviceCodeFlow(!options.browser)
        return
      }

      if (options.pasteLegacy) {
        await runPasteLegacyFlow()
        return
      }

      await runDeviceCodeFlow(!options.browser)
    })
}
