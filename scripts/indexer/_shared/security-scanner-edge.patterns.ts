/**
 * SMI-5402: Edge scanner pattern arrays
 * @module scripts/indexer/_shared/security-scanner-edge.patterns (Node port)
 *
 * The five high-risk pattern arrays used by the edge security scanner, split
 * out of security-scanner-edge.ts to stay under the 500-line limit (SMI-5402).
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs.
 */

// ============================================================================
// Patterns - High-risk subset from core SecurityScanner
// ============================================================================

/**
 * Jailbreak attempt patterns - attempts to manipulate AI behavior
 *
 * SMI-4960: `/developer\s+mode/i` required an activation verb (enable / enter /
 * activate / switch to). Bare "developer mode" is browser/VS-Code documentation
 * vocabulary (xixu-me/develop-userscripts FP); only an explicit activation
 * instruction is a jailbreak signal. The remaining patterns mirror core
 * patterns.ts JAILBREAK_PATTERNS (no looser core equivalent exists for these).
 */
export const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /(enable|enter|activate|switch\s+to)\s+developer\s+mode/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(all\s+)?(restrictions?|filters?|safety)/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions?|limits?)/i,
  /you\s+are\s+now\s+(free|unrestricted|unfiltered)/i,
  /ignore\s+your\s+(safety|ethical)\s+(guidelines?|rules?)/i,
]

/**
 * Suspicious patterns - code execution, shell commands
 */
export const SUSPICIOUS_PATTERNS: RegExp[] = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /from\s+base64\s+import/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*(bash|sh)/i,
  /wget\s+.*\|\s*(bash|sh)/i,
]

/**
 * Data exfiltration patterns - suspicious data transfer
 *
 * SMI-4960: tightened to core patterns.ts DATA_EXFILTRATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior `/upload\s+.*(to|the)\s+(server|cloud|remote)/i`
 * matched "upload to Cloudinary" (Cloud prefix substring); the bounded
 * `[\w\s]{0,30}?` + `\bcloud\b` word-boundary excludes
 * Cloudinary/cloudfront/cloudflare/iCloud. The `(send|transmit|leak|dump|steal|
 * extract) … (passwords|credentials|secrets)` form preserves imperative
 * exfiltration coverage without re-introducing prose FPs.
 */
export const DATA_EXFILTRATION_PATTERNS: RegExp[] = [
  /navigator\.sendBeacon/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+[\w\s]{0,30}?\s*(?:to|the)\s+(?:server|\bcloud\b|remote)/i,
  /upload\s+[\w\s]{0,50}?\s*(?:private\s+)?(?:key|secret|credential|token)s?\b/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
  /(?:send|transmit|leak|dump|steal|extract)\s+[\w\s']{0,40}(?:passwords?|credentials?|secrets?)\b/i,
  // SMI-5429: ported verbatim from core DATA_EXFILTRATION_PATTERNS — an outbound
  // curl/wget carrying a credential env-var INSIDE the fetched URL's query string
  // (GET) or in a -d/--data/-F/--form request body (POST). A header-borne auth call
  // (curl -H "Authorization: Bearer $TOKEN") matches neither (no `?`-query, the var
  // is outside any -d/-F arg). Bounded lazy-then-anchored quantifiers → ReDoS-safe.
  /\b(?:curl|wget)\b[^\n]{0,150}?https?:\/\/[^\n\s?]{0,200}\?[^\n\s]{0,200}?\$\{?[A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASS|CRED)/i,
  /\b(?:curl|wget)\b[^\n]{0,200}?(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b[^\n]{0,100}?\$\{?[A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASS|CRED)/i,
]

/**
 * Privilege escalation patterns
 *
 * SMI-4960: tightened to core patterns.ts PRIVILEGE_ESCALATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior bare `/escalat(e|ion)/i` matched documentation prose
 * in security-research / prompt-injection-scanner skills that enumerate
 * "privilege escalation" as a technique they DETECT. Replaced with contextual
 * variants (exploit-escalate, attack/vector noun phrases, to-root/to-admin
 * targets) that preserve real coverage.
 */
export const PRIVILEGE_ESCALATION_PATTERNS: RegExp[] = [
  /sudo\s+.*(-S|--stdin)/i,
  /echo\s+.*\|\s*sudo/i,
  /sudo\s+-S/i,
  // SMI-5424 PR2: standalone-critical chmod — genuine privilege threats. Owner-perm
  // chmod (755/644/600/700…) is NOT here (it false-fired on benign `chmod 755 ./bin/cli`);
  // it is now a COMPOUND signal via scanChmodFetchCompound, preserving the
  // curl|bash+chmod co-signal (escalateCodeExecution needs high/crit).
  /\bchmod\s+[0-7]?[0-7][0-7][2367]\b/i, // world-writable (others-write bit set: …2/3/6/7)
  /\bchmod\s+0?[2-7][0-7]{3}\b/i, // setuid/setgid octal (incl. leading-zero 04755/02755 + 3xxx/5xxx)
  /\bchmod\s+[ugoa]*\+s\b/i, // setuid/setgid symbolic (u+s / g+s / +s)
  // SMI-5428: world/others-writable symbolic chmod (o+w / a+w / go+w). The
  // (?=[ugoa]*[oa]) lookahead requires o/a in the target set and [rwxX]*w a `w` perm,
  // so owner/group-only writes (u+w, g+w) and non-write perms (u+x, a+x, o+r) do not match.
  /\bchmod\s+(?=[ugoa]*[oa])[ugoa]*\+[rwxX]*w/i, // world/others-writable symbolic (o+w / a+w / go+w)
  /\bchown\s+root/i,
  /\bchgrp\s+root/i,
  /visudo/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /setuid/i,
  /setgid/i,
  /capability\s+cap_/i,
  /privilege[_\s-]+escalat(?:e|ion)/i,
  /escalat(?:e|ion)\s+(?:attack|vector|(?:to|as)\s+(?:root|admin|superuser))/i,
  /exploit\s+[\w\s]{0,30}?\s*escalat(?:e|ion)/i,
  /privilege[ds]?\s+(elevat|escal)/i,
  /run\s+.*as\s+root/i,
  /(run|execute)\s+as\s+(root|admin)/i,
  /admin(istrator)?\s+access/i,
  /root\s+(access|user)/i,
  /as\s+root\s+user/i,
  /su\s+-\s+root/i,
  /become\s+root/i,
]

/**
 * SMI-5359 Wave 4.2c / SMI-6033 Wave 1: Remote-fetch-to-interpreter
 * ("code_execution") patterns. Previously re-declared inline in
 * security-scanner-edge.exec.ts instead of living here (this module's single
 * source of truth for every other shared pattern array) — moved here so a
 * future edit can't silently apply to only one of the two copies.
 *
 * Every pattern requires BOTH a fetch verb (curl/wget/irm/iwr/Invoke-WebRequest/
 * Net.WebClient) AND an execution sink (| sh|python|node…, <(...), eval $(...),
 * iex, -EncodedCommand). A bare package install (npm/pip/brew/cargo/apt) matches
 * none. Bounded quantifiers exclude the pipe / newline — no catastrophic backtracking.
 *
 * SMI-5359 Wave 4.2c retune (read-only prod sim FP): the curl/wget patterns also
 * require a CONCRETE remote target (http(s):// or a host.tld domain), so a
 * code-review/security-review skill documenting the generic pattern in prose
 * ("curl … | sh", placeholder, no target) no longer matches, while a real
 * "curl https://evil/x | bash" still does.
 */
export const CODE_EXECUTION_PATTERNS: RegExp[] = [
  // curl|wget <target> | [sudo] <interpreter>
  /(?:curl|wget)\b[^\n|]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n|]{0,150}?\|\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // process substitution: bash/sh/zsh/source/. <(curl|wget <target> ...)
  /(?:^|[\s;&])(?:source|\.|ba?sh|zsh|exec)\s+<\(\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // command substitution into eval or `sh -c` with a remote target
  /(?:\beval\b|(?:ba|z)?sh\s+-c)\s+["']?[$`]\(?\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // PowerShell download-and-execute
  /\b(?:iex|invoke-expression)\b[^\n]{0,100}?(?:\birm\b|\biwr\b|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)/i,
  // PowerShell encoded command
  /\bpowershell\b[^\n]{0,60}?\s-e(?:nc|ncodedcommand)?\b\s*[A-Za-z0-9+/=]{16,}/i,
  // decode-then-exec: base64 -d ... | <interpreter>  (SMI-5359 retro NIT: da sink + interpreters)
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,60}?\|\s*(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-1: chained / redirect download-then-execute (curl URL -o /tmp/x && bash /tmp/x)
  /(?:curl|wget)\b[^\n]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n]{0,150}?(?:&&|;)\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-2: npx executing a REMOTE source (URL or github:), never a local package (npx tsc is clean)
  /\bnpx\s+(?:--yes\s+|-y\s+)?(?:https?:\/\/\S+|github:\S+)/i,
  // SMI-5424 FN-4: node/python/deno/bun inline-eval (-e/-c) with a dangerous payload
  /\b(?:node|python[23]?|deno|bun)\s+(?:-e|-c|--eval|--exec)\s+['"][^'"]{0,200}?(?:require\(|child_process|fetch\(|\bexec\b|eval\(|base64|urllib|os\.system|subprocess)/i,
]

/**
 * Prompt injection patterns - AI-specific attacks
 */
export const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // Role injection
  /(?:^|\s)(?:system|assistant|user)\s*:\s*(?:\n|$)/i,
  // Hidden instruction brackets
  /\[\[\s*[^\]]{1,200}\s*\]\]/,
  // HTML comment injection
  /<!--[\s\S]{0,100}?(?:ignore|override|bypass|system|instruction)[\s\S]{0,100}?-->/i,
  // Prompt structure manipulation
  /<\/?(?:system|prompt|instruction|context|message)(?:\s[^>]*)?>/i,
  // Delimiter injection
  /(?:^|\n)(?:---|\*{3}|#{3,})\s*(?:system|prompt|instruction|override)/i,
  // JSON structure injection
  /["']\s*(?:role|system|instruction)\s*["']\s*:\s*["'](?:system|assistant|user|ignore|override|bypass)/i,
]
