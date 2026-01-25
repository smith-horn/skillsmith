/**
 * Type definitions for Skillsmith Tracer
 * @module @skillsmith/core/telemetry/tracer-types
 */

/**
 * Local type definitions matching OpenTelemetry interfaces
 * SMI-755: Allows compilation without @opentelemetry/api installed
 */
export interface OTelSpan {
  setAttributes(attributes: Record<string, unknown>): void
  setStatus(status: { code: number; message?: string }): void
  recordException(error: Error): void
  addEvent(name: string, attributes?: Record<string, unknown>): void
  end(): void
}

export interface OTelTracer {
  startSpan(name: string, options?: unknown): OTelSpan
}

export interface OTelSpanOptions {
  attributes?: Record<string, unknown>
  links?: unknown[]
  startTime?: number
  root?: boolean
  kind?: number
}

// Type aliases for API compatibility
export type Span = OTelSpan
export type Tracer = OTelTracer
export type SpanOptions = OTelSpanOptions
export type SpanStatusCode = number

/**
 * Tracer configuration
 */
export interface TracerConfig {
  /** Service name for spans (default: skillsmith) */
  serviceName?: string
  /** OTLP endpoint URL */
  endpoint?: string
  /** Enable auto-instrumentation (default: true) */
  autoInstrument?: boolean
  /** Enable console exporter for debugging (default: false) */
  consoleExport?: boolean
  /** Sample rate 0-1 (default: 1.0 = 100%) */
  sampleRate?: number
}

/**
 * Span attribute types
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean | string[] | number[] | boolean[] | undefined
}

/**
 * Span wrapper for easier usage
 */
export interface SpanWrapper {
  /** Add attributes to span */
  setAttributes(attributes: SpanAttributes): void
  /** Set span status */
  setStatus(code: 'ok' | 'error', message?: string): void
  /** Record an exception */
  recordException(error: Error): void
  /** Add an event to the span */
  addEvent(name: string, attributes?: SpanAttributes): void
  /** End the span */
  end(): void
  /** Get the underlying OTEL span (if available) */
  getSpan(): Span | null
}

/**
 * Type-safe accessors for OTEL modules (SMI-755)
 * These provide typed access while avoiding compile-time dependency
 */
export interface OTelApi {
  trace: {
    getTracer(name: string, version?: string): OTelTracer
    getActiveSpan(): OTelSpan | undefined
  }
}

export interface OTelNodeSDK {
  new (config: unknown): { start(): Promise<void>; shutdown(): Promise<void> }
}

/**
 * Resource factory function type (v2.x uses resourceFromAttributes instead of class)
 */
export type OTelResourceFromAttributes = (attributes: Record<string, string>) => unknown
