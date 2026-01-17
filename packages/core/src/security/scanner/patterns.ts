/**
 * Security Scanner Patterns - SMI-587, SMI-685, SMI-1189
 *
 * Pattern definitions for security scanning.
 */

// Default allowed domains
export const DEFAULT_ALLOWED_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'npmjs.com',
  'npmjs.org',
  'docs.anthropic.com',
  'anthropic.com',
  'claude.ai',
  'docs.github.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
]

// Sensitive file path patterns
export const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /secrets?/i,
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /password/i,
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /~\/\.ssh/i,
  /~\/\.aws/i,
  /~\/\.config/i,
]

// Jailbreak attempt patterns
export const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /developer\s+mode/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(all\s+)?(restrictions?|filters?|safety)/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions?|limits?)/i,
  /act\s+as\s+(if\s+)?you\s+(have\s+)?no\s+ethics/i,
  /you\s+are\s+now\s+(free|unrestricted|unfiltered)/i,
  /ignore\s+your\s+(safety|ethical)\s+(guidelines?|rules?)/i,
  /hypothetical\s+scenario\s+where\s+you\s+can/i,
]

// Suspicious patterns that might indicate malicious intent
export const SUSPICIOUS_PATTERNS = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /from\s+base64\s+import/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*(bash|sh)/i, // Curl pipe to shell
  /wget\s+.*\|\s*(bash|sh)/i,
]

// SMI-685: Social engineering attempt patterns
export const SOCIAL_ENGINEERING_PATTERNS = [
  /pretend\s+(to\s+be|you\s+are|that\s+you)/i,
  /roleplay\s+as/i,
  /you\s+are\s+now\s+(?!free|unrestricted)/i, // Exclude jailbreak patterns
  /act\s+as\s+(if\s+you\s+were|though\s+you\s+are)/i,
  /imagine\s+you\s+are/i,
  /for\s+the\s+purposes?\s+of\s+this/i,
  /let'?s?\s+say\s+you\s+are/i,
  /assume\s+the\s+role\s+of/i,
  /from\s+now\s+on\s+you\s+are/i,
  /i\s+want\s+you\s+to\s+act\s+as/i,
  /please\s+behave\s+as\s+if/i,
  /can\s+you\s+pretend/i,
]

// SMI-685: Prompt leaking attempt patterns
export const PROMPT_LEAKING_PATTERNS = [
  /show\s+(me\s+)?your\s+(system\s+)?(instructions?|prompt)/i,
  /what\s+are\s+your\s+(\w+\s+)?rules/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /display\s+your\s+(initial\s+)?instructions?/i,
  /output\s+your\s+(system\s+)?prompt/i,
  /print\s+your\s+(hidden\s+)?instructions?/i,
  /tell\s+me\s+your\s+(secret\s+)?instructions?/i,
  /what\s+(were|are)\s+you\s+(told|instructed)\s+to\s+do/i,
  /repeat\s+(back\s+)?your\s+(\w+\s+)?prompt/i,
  /what\s+is\s+your\s+(original\s+)?programming/i,
  /dump\s+(your\s+)?system\s+(prompt|instructions?)/i,
  /list\s+your\s+(hidden\s+)?directives?/i,
  /what\s+(constraints?|limitations?)\s+do\s+you\s+have/i,
  /echo\s+(back\s+)?your\s+(initial\s+)?prompt/i,
]

// SMI-685: Data exfiltration patterns
export const DATA_EXFILTRATION_PATTERNS = [
  /btoa\s*\(/i, // Base64 encode in JS
  /atob\s*\(/i, // Base64 decode in JS
  /Buffer\.from\s*\([^)]*,\s*['"]base64['"]/i,
  /\.toString\s*\(\s*['"]base64['"]\s*\)/i,
  /encodeURIComponent\s*\(/i,
  /fetch\s*\(\s*['"`][^'"`]*\?.*=/i, // Fetch with query params
  /XMLHttpRequest/i,
  /navigator\.sendBeacon/i,
  /\.upload\s*\(/i,
  /formData\.append/i,
  /new\s+FormData/i,
  /multipart\/form-data/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /data\s*:\s*['"]/i, // Data URLs
  /\.writeFile.*https?:\/\//i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+.*(to|the)\s+(server|cloud|remote)/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
]

// SMI-685: Privilege escalation patterns
export const PRIVILEGE_ESCALATION_PATTERNS = [
  /sudo\s+.*(-S|--stdin)/i, // sudo with password from stdin
  /echo\s+.*\|\s*sudo/i, // Echo password to sudo
  /sudo\s+-S/i,
  /\bchmod\s+[0-7]*[4-7][0-7][0-7]\b/i, // chmod with setuid/setgid
  /\bchmod\s+\+s\b/i, // chmod setuid
  /\bchmod\s+777\b/i, // World writable
  /\bchmod\s+666\b/i, // World readable/writable
  /\bchown\s+root/i,
  /\bchgrp\s+root/i,
  /visudo/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /setuid/i,
  /setgid/i,
  /capability\s+cap_/i,
  /escalat(e|ion)/i,
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
 * SMI-1532: AIDefence CVE-hardened injection patterns
 * Optimized for sub-10ms scan time with compiled regex and no backtracking
 *
 * These patterns detect sophisticated prompt injection attacks based on
 * known CVEs and security research findings.
 *
 * References:
 * - OWASP LLM Top 10: LLM01 Prompt Injection
 * - Anthropic Responsible Disclosure Program findings
 * - Academic research on prompt injection attacks
 */
export const AI_DEFENCE_PATTERNS = [
  // Role injection patterns - attempts to inject system/assistant/user roles
  // Pattern detects role markers that could manipulate conversation boundaries
  // Covers: start of line, after whitespace, with various delimiters
  /(?:^|\s)(?:system|assistant|user)\s*:\s*(?:\n|$)/i,

  // Hidden instruction brackets - obfuscated commands
  /\[\[\s*[^\]]{1,200}\s*\]\]/,

  // HTML/XML comment injection - hiding malicious instructions
  /<!--[\s\S]{0,100}?(?:ignore|override|bypass|system|instruction)[\s\S]{0,100}?-->/i,

  // Unicode homograph attacks - visually similar characters
  // Detects Cyrillic, Greek, or other homoglyphs mixed with Latin
  /[\u0400-\u04FF\u0370-\u03FF]{2,}[\w\s]+(?:ignore|bypass|instruction)/i,

  // Prompt structure manipulation - XML/markdown injection
  /<\/?(?:system|prompt|instruction|context|message)(?:\s[^>]*)?>/i,

  // Base64 encoded instructions (common evasion technique)
  /(?:base64|b64)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}={0,2}["']?/i,

  // Delimiter injection - breaking out of prompt boundaries
  /(?:^|\n)(?:---|\*{3}|#{3,})\s*(?:system|prompt|instruction|override)/i,

  // JSON structure injection in prompts
  // SMI-1532: Refined to require suspicious values, not just field names
  // Matches: "role": "system" or "instruction": "ignore" but not "content": "Hello"
  /["']\s*(?:role|system|instruction)\s*["']\s*:\s*["'](?:system|assistant|user|ignore|override|bypass)/i,

  // Nested instruction blocks
  /<instruction[^>]*>[\s\S]{0,500}?<\/instruction>/i,

  // CRLF injection for prompt manipulation
  /(?:\r\n|\r|\n){2,}\s*(?:ignore|forget|override|bypass)\s+(?:all|previous|above)/i,

  // Template literal injection
  /\$\{\s*(?:system|prompt|instruction|config)/i,

  // Zero-width character obfuscation detection
  // SMI-1532: Enhanced to detect single zero-width chars near sensitive keywords
  /[\u200B-\u200F\u2028-\u202F\uFEFF](?:[\s\S]{0,20}(?:ignore|bypass|system|instruction)|[\u200B-\u200F\u2028-\u202F\uFEFF])/i,

  // Markdown link injection with suspicious targets
  /\[(?:click|here|link|url)[^\]]*\]\([^)]*(?:javascript|data|vbscript):/i,

  // Escape sequence abuse
  /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){3,}/,

  // Unicode normalization attacks - combining characters that render differently
  // Detects combining diacritical marks used to obfuscate text
  /[\u0300-\u036F]{2,}/,
]
