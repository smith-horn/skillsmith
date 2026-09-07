/**
 * Security Scanner Patterns — the `sensitive_path` family
 * @module @skillsmith/core/security/scanner/patterns.sensitive-path
 *
 * SMI-5207: extracted from patterns.ts, which sat 18 lines under the repo's
 * 500-line pre-commit gate (scripts/check-file-length.mjs) before this wave —
 * not enough headroom for the 12 hoisted pattern consts plus the two new
 * severity-gate classification sets below (~42 lines). Same
 * move-the-family-then-re-export convention already used twice in patterns.ts
 * (patterns.jailbreak.ts, SMI-5876; patterns.exec.ts, SMI-6033 Wave 4).
 *
 * Every symbol here is re-exported unchanged from patterns.ts, so every
 * existing import path keeps working AND reference identity is preserved —
 * load-bearing, because scanSensitivePaths() classifies patterns by reference
 * (`pattern === ENV_PATH_PATTERN`, `VALUE_GATED_KEYWORD_PATTERNS.has(pattern)`,
 * and now `PATH_FORM_PATTERNS.has(pattern)` /
 * `VALUE_GATED_ASSIGNMENT_PATTERNS.has(pattern)`).
 *
 * NOTE: a change to SENSITIVE_PATH_PATTERNS or to the severity classification
 * below requires bumping SCANNER_RULESET_VERSION in patterns.ts — see that
 * constant's own doc comment.
 */

// Sensitive file path patterns
// SMI-4396 Wave 2: bare-keyword variants (credentials, secrets?, password) tightened
// to require assignment/path/file-extension context. Without this tuning,
// documentation keywords in SKILL.md frontmatter and prose (1Password integration
// guides, security-research skill domain vocabulary) tripped HIGH severity.
//
// SMI-5359 Wave 4 — FP-narrowing for two over-firing entries (severity policy lives
// in scanSensitivePaths so the array length / regression-guard baseline is unchanged):
//   MF-1: bare /api[_-]?key/i & /auth[_-]?token/i fired HIGH on ANY substring —
//     benign prose ("set your api_key in the dashboard"), `export API_KEY=$1`, and
//     `apiKey: <YOUR_KEY>` placeholders. They are now VALUE-GATED: HIGH only when the
//     line assigns a real (non-placeholder, sufficiently-entropic) secret. The
//     value-BEARING leak is already caught at PII (PII_PATTERNS[0/2]); the
//     credential-in-an-outbound-curl exfil is caught by DATA_EXFILTRATION_PATTERNS
//     (the `$API_KEY`-in-a-fetched-URL pattern added there). See
//     VALUE_GATED_KEYWORD_PATTERNS.
//   MF-2: lone /\.env/i fired HIGH on every `.env` mention AND on the benign committed
//     family (.envrc, .env.example/.sample/.template/.schema/.dist). ENV_PATH_PATTERN
//     negative-lookaheads exclude that family; scanSensitivePaths downgrades a LONE
//     `.env` to MEDIUM and keeps HIGH when it co-occurs with a read/exfil verb or
//     shell pipe/redirect (`cat .env | curl ...`).
//
// SMI-5207 — the remaining 12 entries got the same treatment the two MF-1 keywords
// and the MF-2 `.env` entry already had: severity is now context-gated rather than
// unconditionally HIGH. MF-3 covers the 9 path-form entries (action verb or shell
// operator within +/-1 line), MF-4 the 3 keyword-assignment entries (HIGH unless the
// assigned value positively reads as prose). Both gates live in
// SecurityScanner.scanners.ts; this module only supplies the classification.

// MF-2: `.env` as a real env-file reference. Excludes `.envrc` (direnv config) and the
// committed placeholder family (.env.example/.sample/.template/.schema/.dist). The
// `(?![A-Za-z])` guard also drops the `.environment`/`.envision` English-word FP while
// still matching real variants like `.env`, `.env.local`, `.env.production`.
export const ENV_PATH_PATTERN = /\.env(?![A-Za-z])(?!\.(?:example|sample|template|schema|dist))/i

// MF-1: bare credential keywords — value-gated in scanSensitivePaths, never standalone HIGH.
const API_KEY_KEYWORD = /api[_-]?key/i
const AUTH_TOKEN_KEYWORD = /auth[_-]?token/i

// SMI-5207: the 12 non-`.env` entries are hoisted from inline array literals to named
// consts so scanSensitivePaths can classify each by severity gate BY REFERENCE. The
// array's contents, order, and length (15) are unchanged — the regression-guard floor
// (scanner-regression-guard.test.ts) still holds.
// Contextual credentials: filename or assignment, not bare prose
const CREDENTIALS_FILE_PATTERN = /credentials\.(?:json|ya?ml|env|toml|txt)/i
const CREDENTIALS_ASSIGN_PATTERN = /credentials\s*[:=]/i
// Contextual secrets: assignment or path, not bare word
const SECRETS_ASSIGN_PATTERN = /\bsecrets?\s*[:=]/i
const SECRETS_PATH_PATTERN = /\bsecrets?\/[a-z0-9_.-]+/i
const PEM_PATTERN = /\.pem$/i
const KEY_FILE_PATTERN = /\.key$/i
const CRT_PATTERN = /\.crt$/i
// Contextual password: assignment or URL (postgres://user:pass@host) only
const PASSWORD_ASSIGN_PATTERN = /password\s*[:=]/i
const SSH_DIR_PATTERN = /~\/\.ssh/i
const AWS_DIR_PATTERN = /~\/\.aws/i
const CONFIG_DIR_PATTERN = /~\/\.config/i
// SMI-4396 Wave 2: explicit system-file paths. Added so that tightening
// bare /credentials/i and /password/i into assignment-context variants
// doesn't drop coverage of obvious sensitive references like /etc/passwd.
const ETC_SYSTEM_FILE_PATTERN = /\/etc\/(?:passwd|shadow|sudoers|hosts)\b/i

export const SENSITIVE_PATH_PATTERNS = [
  ENV_PATH_PATTERN,
  CREDENTIALS_FILE_PATTERN,
  CREDENTIALS_ASSIGN_PATTERN,
  SECRETS_ASSIGN_PATTERN,
  SECRETS_PATH_PATTERN,
  PEM_PATTERN,
  KEY_FILE_PATTERN,
  CRT_PATTERN,
  PASSWORD_ASSIGN_PATTERN,
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
  SSH_DIR_PATTERN,
  AWS_DIR_PATTERN,
  CONFIG_DIR_PATTERN,
  ETC_SYSTEM_FILE_PATTERN,
]

// MF-1: the two bare-keyword patterns above emit HIGH only when accompanied by a real
// assigned secret value; scanSensitivePaths suppresses an otherwise-bare match.
export const VALUE_GATED_KEYWORD_PATTERNS: ReadonlySet<RegExp> = new Set([
  API_KEY_KEYWORD,
  AUTH_TOKEN_KEYWORD,
])

/**
 * SMI-5207 (MF-3): the 9 path/filename-form entries. HIGH only when an action
 * verb or shell operator appears within +/-1 line of the match; otherwise
 * MEDIUM — a bare path *mention* is the common case, so evidence is required
 * to escalate. See scanSensitivePaths' hasPathActionContext().
 */
export const PATH_FORM_PATTERNS: ReadonlySet<RegExp> = new Set([
  CREDENTIALS_FILE_PATTERN,
  SECRETS_PATH_PATTERN,
  PEM_PATTERN,
  KEY_FILE_PATTERN,
  CRT_PATTERN,
  SSH_DIR_PATTERN,
  AWS_DIR_PATTERN,
  CONFIG_DIR_PATTERN,
  ETC_SYSTEM_FILE_PATTERN,
])

/**
 * SMI-5207 (MF-4): the 3 keyword-assignment entries. HIGH BY DEFAULT —
 * `keyword: value` is a syntactic credential-assignment shape, rare in
 * innocent prose — downgraded to MEDIUM only on positive prose evidence about
 * the assigned value. See scanSensitivePaths' assignmentHasRealValue().
 *
 * Partition check (guarded by a dedicated test): 1 (ENV) + 9 (PATH_FORM) +
 * 3 (ASSIGNMENT) + 2 (VALUE_GATED_KEYWORD) = 15, total and disjoint. An
 * unclassified future pattern falls through to scanSensitivePaths' fail-CLOSED
 * `else` branch and stays HIGH.
 */
export const VALUE_GATED_ASSIGNMENT_PATTERNS: ReadonlySet<RegExp> = new Set([
  CREDENTIALS_ASSIGN_PATTERN,
  SECRETS_ASSIGN_PATTERN,
  PASSWORD_ASSIGN_PATTERN,
])
