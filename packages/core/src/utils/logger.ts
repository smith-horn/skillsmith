/**
 * Logger Utility with Audit Support (SMI-728)
 *
 * Enhanced logger with structured logging, audit trails, and security events.
 * Provides environment-aware logging with different verbosity levels and
 * support for audit event tracking.
 */

/**
 * Log severity levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  AUDIT = 4,
  SECURITY = 5,
}

/**
 * Audit event types
 */
export type AuditEventType =
  | 'skill.install'
  | 'skill.uninstall'
  | 'skill.fetch'
  | 'skill.scan'
  | 'adapter.request'
  | 'adapter.error'
  | 'cache.hit'
  | 'cache.miss'
  | 'security.violation'

/**
 * Security event types
 */
export type SecurityEventType =
  | 'ssrf.blocked'
  | 'path_traversal.blocked'
  | 'validation.failed'
  | 'rate_limit.exceeded'
  | 'malware.detected'
  | 'suspicious.pattern'

/**
 * Audit event structure
 */
export interface AuditEvent {
  /** Type of audit event */
  eventType: AuditEventType
  /** When the event occurred */
  timestamp: string
  /** Who performed the action (user, system, adapter) */
  actor: string
  /** Resource being accessed (URL, path, skill_id) */
  resource: string
  /** Action being performed (fetch, read, install, scan) */
  action: string
  /** Result of the action (success, blocked, error) */
  result: 'success' | 'blocked' | 'error'
  /** Additional context as key-value pairs */
  metadata?: Record<string, unknown>
}

/**
 * Security event structure
 */
export interface SecurityEvent {
  /** Type of security event */
  eventType: SecurityEventType
  /** When the event occurred */
  timestamp: string
  /** Severity level (low, medium, high, critical) */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** Resource being protected */
  resource: string
  /** Action that was blocked/detected */
  action: string
  /** Details about the security event */
  details: string
  /** Additional context */
  metadata?: Record<string, unknown>
}

/**
 * Structured log entry
 */
export interface LogEntry {
  level: LogLevel
  timestamp: string
  namespace?: string
  message: string
  context?: Record<string, unknown>
  error?: Error
}

/**
 * Log aggregator interface for future persistence
 */
export interface LogAggregator {
  /** Add a log entry to the aggregator */
  add(entry: LogEntry): void
  /** Add an audit event */
  addAudit(event: AuditEvent): void
  /** Add a security event */
  addSecurity(event: SecurityEvent): void
  /** Flush logs to persistence layer */
  flush(): Promise<void>
  /** Get all logs */
  getLogs(): LogEntry[]
  /** Get all audit events */
  getAuditEvents(): AuditEvent[]
  /** Get all security events */
  getSecurityEvents(): SecurityEvent[]
}

/**
 * Logger interface with audit support
 */
export interface Logger {
  warn: (message: string, context?: Record<string, unknown>) => void
  error: (message: string, error?: Error, context?: Record<string, unknown>) => void
  info: (message: string, context?: Record<string, unknown>) => void
  debug: (message: string, context?: Record<string, unknown>) => void
  auditLog: (event: AuditEvent) => void
  securityLog: (event: SecurityEvent) => void
}

/**
 * In-memory log aggregator
 */
class MemoryLogAggregator implements LogAggregator {
  private logs: LogEntry[] = []
  private auditEvents: AuditEvent[] = []
  private securityEvents: SecurityEvent[] = []
  private maxSize: number

  constructor(maxSize = 10000) {
    this.maxSize = maxSize
  }

  add(entry: LogEntry): void {
    this.logs.push(entry)
    if (this.logs.length > this.maxSize) {
      this.logs.shift()
    }
  }

  addAudit(event: AuditEvent): void {
    this.auditEvents.push(event)
    if (this.auditEvents.length > this.maxSize) {
      this.auditEvents.shift()
    }
  }

  addSecurity(event: SecurityEvent): void {
    this.securityEvents.push(event)
    if (this.securityEvents.length > this.maxSize) {
      this.securityEvents.shift()
    }
  }

  async flush(): Promise<void> {
    // Future: Persist to database
    // For now, this is a no-op
  }

  getLogs(): LogEntry[] {
    return [...this.logs]
  }

  getAuditEvents(): AuditEvent[] {
    return [...this.auditEvents]
  }

  getSecurityEvents(): SecurityEvent[] {
    return [...this.securityEvents]
  }

  clear(): void {
    this.logs = []
    this.auditEvents = []
    this.securityEvents = []
  }
}

/**
 * Global log aggregator instance
 */
let globalAggregator: LogAggregator = new MemoryLogAggregator()

/**
 * Set the global log aggregator
 */
export function setLogAggregator(aggregator: LogAggregator): void {
  globalAggregator = aggregator
}

/**
 * Get the global log aggregator
 */
export function getLogAggregator(): LogAggregator {
  return globalAggregator
}

/**
 * Format log entry for output
 */
function formatLogEntry(entry: LogEntry, useJson: boolean): string {
  if (useJson) {
    return JSON.stringify({
      level: LogLevel[entry.level],
      timestamp: entry.timestamp,
      namespace: entry.namespace,
      message: entry.message,
      context: entry.context,
      error: entry.error
        ? {
            message: entry.error.message,
            stack: entry.error.stack,
          }
        : undefined,
    })
  }

  const prefix = entry.namespace ? `[skillsmith:${entry.namespace}]` : '[skillsmith]'
  const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : ''
  return `${prefix} ${entry.message}${contextStr}`
}

/**
 * Format audit event for output
 */
function formatAuditEvent(event: AuditEvent, useJson: boolean): string {
  if (useJson) {
    return JSON.stringify(event)
  }

  const metaStr = event.metadata ? ` ${JSON.stringify(event.metadata)}` : ''
  return `[AUDIT] ${event.eventType} | ${event.actor} -> ${event.action} on ${event.resource} = ${event.result}${metaStr}`
}

/**
 * Format security event for output
 */
function formatSecurityEvent(event: SecurityEvent, useJson: boolean): string {
  if (useJson) {
    return JSON.stringify(event)
  }

  const metaStr = event.metadata ? ` ${JSON.stringify(event.metadata)}` : ''
  return `[SECURITY:${event.severity.toUpperCase()}] ${event.eventType} | ${event.action} on ${event.resource} - ${event.details}${metaStr}`
}

/**
 * Create a logger instance
 */
function createLoggerInstance(namespace?: string): Logger {
  const useJson = process.env.LOG_FORMAT === 'json'
  const minLevel = process.env.LOG_LEVEL ? parseInt(process.env.LOG_LEVEL, 10) : LogLevel.WARN

  const shouldLog = (level: LogLevel): boolean => {
    // In test mode, suppress WARN to keep test output clean
    // (but don't suppress INFO/DEBUG if DEBUG is enabled, or ERROR which is always shown)
    if (process.env.NODE_ENV === 'test' && level === LogLevel.WARN) {
      return false
    }
    // DEBUG flag enables info and debug output
    if (level === LogLevel.DEBUG || level === LogLevel.INFO) {
      return !!process.env.DEBUG
    }
    return level >= minLevel
  }

  const createLogEntry = (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): LogEntry => ({
    level,
    timestamp: new Date().toISOString(),
    namespace,
    message,
    context,
    error,
  })

  return {
    warn: (message: string, context?: Record<string, unknown>) => {
      const entry = createLogEntry(LogLevel.WARN, message, context)
      if (shouldLog(LogLevel.WARN)) {
        console.warn(formatLogEntry(entry, useJson))
      }
      globalAggregator.add(entry)
    },

    error: (message: string, error?: Error, context?: Record<string, unknown>) => {
      const entry = createLogEntry(LogLevel.ERROR, message, context, error)
      if (shouldLog(LogLevel.ERROR)) {
        console.error(formatLogEntry(entry, useJson))
        if (error && !useJson) {
          console.error(error)
        }
      }
      globalAggregator.add(entry)
    },

    info: (message: string, context?: Record<string, unknown>) => {
      const entry = createLogEntry(LogLevel.INFO, message, context)
      if (shouldLog(LogLevel.INFO)) {
        console.info(formatLogEntry(entry, useJson))
      }
      globalAggregator.add(entry)
    },

    debug: (message: string, context?: Record<string, unknown>) => {
      const entry = createLogEntry(LogLevel.DEBUG, message, context)
      if (shouldLog(LogLevel.DEBUG)) {
        console.debug(formatLogEntry(entry, useJson))
      }
      globalAggregator.add(entry)
    },

    auditLog: (event: AuditEvent) => {
      const entry = createLogEntry(LogLevel.AUDIT, formatAuditEvent(event, false))
      if (shouldLog(LogLevel.AUDIT) || process.env.AUDIT_LOG === 'true') {
        console.log(formatAuditEvent(event, useJson))
      }
      globalAggregator.add(entry)
      globalAggregator.addAudit(event)
    },

    securityLog: (event: SecurityEvent) => {
      const entry = createLogEntry(LogLevel.SECURITY, formatSecurityEvent(event, false))
      // Security events always log unless in test mode
      if (process.env.NODE_ENV !== 'test') {
        console.warn(formatSecurityEvent(event, useJson))
      }
      globalAggregator.add(entry)
      globalAggregator.addSecurity(event)
    },
  }
}

/**
 * Default logger instance
 *
 * Environment variables:
 * - NODE_ENV=test: Suppress warn/info/debug output
 * - DEBUG=true: Enable info and debug output
 * - LOG_FORMAT=json: Output logs in JSON format
 * - LOG_LEVEL=0-5: Minimum log level to output
 * - AUDIT_LOG=true: Enable audit log output
 *
 * @example
 * ```typescript
 * logger.info('Processing skill', { skillId: 'foo' })
 * logger.error('Failed to fetch', new Error('Network error'))
 * logger.auditLog({
 *   eventType: 'skill.install',
 *   timestamp: new Date().toISOString(),
 *   actor: 'user',
 *   resource: 'skill-id',
 *   action: 'install',
 *   result: 'success'
 * })
 * ```
 */
export const logger: Logger = createLoggerInstance()

/**
 * Create a namespaced logger
 *
 * @param namespace - The namespace prefix for log messages
 * @returns A Logger instance with namespaced messages
 *
 * @example
 * ```typescript
 * const log = createLogger('GitLabAdapter')
 * log.warn('Rate limit exceeded', { remaining: 0 })
 * log.auditLog({
 *   eventType: 'adapter.request',
 *   timestamp: new Date().toISOString(),
 *   actor: 'GitLabAdapter',
 *   resource: 'https://gitlab.com/api/v4/projects',
 *   action: 'fetch',
 *   result: 'success'
 * })
 * ```
 */
export function createLogger(namespace: string): Logger {
  return createLoggerInstance(namespace)
}

/**
 * No-op logger for testing or silent operation
 */
export const silentLogger: Logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  auditLog: () => {},
  securityLog: () => {},
}

/**
 * Helper to create audit events with current timestamp
 */
export function createAuditEvent(
  eventType: AuditEventType,
  actor: string,
  resource: string,
  action: string,
  result: 'success' | 'blocked' | 'error',
  metadata?: Record<string, unknown>
): AuditEvent {
  return {
    eventType,
    timestamp: new Date().toISOString(),
    actor,
    resource,
    action,
    result,
    metadata,
  }
}

/**
 * Helper to create security events with current timestamp
 */
export function createSecurityEvent(
  eventType: SecurityEventType,
  severity: 'low' | 'medium' | 'high' | 'critical',
  resource: string,
  action: string,
  details: string,
  metadata?: Record<string, unknown>
): SecurityEvent {
  return {
    eventType,
    timestamp: new Date().toISOString(),
    severity,
    resource,
    action,
    details,
    metadata,
  }
}
