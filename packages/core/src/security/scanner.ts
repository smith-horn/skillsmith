/**
 * SMI-587: Security Scanner
 * Basic security scanning for skill content
 */

export interface SecurityFinding {
  type: 'url' | 'sensitive_path' | 'jailbreak' | 'suspicious_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  location?: string;
  lineNumber?: number;
}

export interface ScanReport {
  skillId: string;
  passed: boolean;
  findings: SecurityFinding[];
  scannedAt: Date;
  scanDurationMs: number;
}

export interface ScannerOptions {
  allowedDomains?: string[];
  blockedPatterns?: RegExp[];
  maxContentLength?: number;
}

// Default allowed domains
const DEFAULT_ALLOWED_DOMAINS = [
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
];

// Sensitive file path patterns
const SENSITIVE_PATH_PATTERNS = [
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
];

// Jailbreak attempt patterns
const JAILBREAK_PATTERNS = [
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
];

// Suspicious patterns that might indicate malicious intent
const SUSPICIOUS_PATTERNS = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /from\s+base64\s+import/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bchmod\s+777\b/i,
  /curl\s+.*\|\s*(bash|sh)/i, // Curl pipe to shell
  /wget\s+.*\|\s*(bash|sh)/i,
];

export class SecurityScanner {
  private allowedDomains: Set<string>;
  private blockedPatterns: RegExp[];
  private maxContentLength: number;

  constructor(options: ScannerOptions = {}) {
    this.allowedDomains = new Set(options.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS);
    this.blockedPatterns = options.blockedPatterns ?? [];
    this.maxContentLength = options.maxContentLength ?? 1_000_000; // 1MB
  }

  /**
   * Extract all URLs from content
   */
  private extractUrls(content: string): Array<{ url: string; line: number }> {
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
    const lines = content.split('\n');
    const results: Array<{ url: string; line: number }> = [];
    
    lines.forEach((line, index) => {
      let match;
      while ((match = urlPattern.exec(line)) !== null) {
        results.push({ url: match[0], line: index + 1 });
      }
    });
    
    return results;
  }

  /**
   * Check if URL domain is allowed
   */
  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      
      // Check exact match or subdomain match
      return Array.from(this.allowedDomains).some(domain => 
        hostname === domain || hostname.endsWith('.' + domain)
      );
    } catch {
      return false;
    }
  }

  /**
   * Scan for non-allowlisted URLs
   */
  private scanUrls(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const urls = this.extractUrls(content);
    
    for (const { url, line } of urls) {
      if (!this.isAllowedDomain(url)) {
        findings.push({
          type: 'url',
          severity: 'medium',
          message: `External URL not in allowlist: ${url}`,
          location: url,
          lineNumber: line,
        });
      }
    }
    
    return findings;
  }

  /**
   * Scan for sensitive file path references
   */
  private scanSensitivePaths(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            type: 'sensitive_path',
            severity: 'high',
            message: `Reference to potentially sensitive path: ${pattern.source}`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          });
          break; // One finding per line
        }
      }
    });
    
    return findings;
  }

  /**
   * Scan for jailbreak attempts
   */
  private scanJailbreakPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      for (const pattern of JAILBREAK_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          findings.push({
            type: 'jailbreak',
            severity: 'critical',
            message: `Potential jailbreak pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          });
          break; // One finding per line
        }
      }
    });
    
    return findings;
  }

  /**
   * Scan for suspicious code patterns
   */
  private scanSuspiciousPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');
    
    lines.forEach((line, index) => {
      for (const pattern of SUSPICIOUS_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          findings.push({
            type: 'suspicious_pattern',
            severity: 'medium',
            message: `Suspicious pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          });
          break; // One finding per line
        }
      }
      
      // Check custom blocked patterns
      for (const pattern of this.blockedPatterns) {
        const match = line.match(pattern);
        if (match) {
          findings.push({
            type: 'suspicious_pattern',
            severity: 'high',
            message: `Blocked pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          });
          break;
        }
      }
    });
    
    return findings;
  }

  /**
   * Perform full security scan
   */
  scan(skillId: string, content: string): ScanReport {
    const startTime = performance.now();
    const findings: SecurityFinding[] = [];
    
    // Check content length
    if (content.length > this.maxContentLength) {
      findings.push({
        type: 'suspicious_pattern',
        severity: 'low',
        message: `Content exceeds maximum length (${this.maxContentLength} bytes)`,
      });
    }
    
    // Run all scans
    findings.push(...this.scanUrls(content));
    findings.push(...this.scanSensitivePaths(content));
    findings.push(...this.scanJailbreakPatterns(content));
    findings.push(...this.scanSuspiciousPatterns(content));
    
    const endTime = performance.now();
    
    // Determine if scan passed (no critical or high findings)
    const hasCritical = findings.some(f => f.severity === 'critical');
    const hasHigh = findings.some(f => f.severity === 'high');
    
    return {
      skillId,
      passed: !hasCritical && !hasHigh,
      findings,
      scannedAt: new Date(),
      scanDurationMs: endTime - startTime,
    };
  }

  /**
   * Quick check without full scan
   */
  quickCheck(content: string): boolean {
    // Check for critical patterns only
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.test(content)) return false;
    }
    return true;
  }

  /**
   * Add allowed domain
   */
  addAllowedDomain(domain: string): void {
    this.allowedDomains.add(domain.toLowerCase());
  }

  /**
   * Add blocked pattern
   */
  addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern);
  }
}

export default SecurityScanner;
