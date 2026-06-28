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
