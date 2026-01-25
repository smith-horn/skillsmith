/**
 * Span utility classes for Skillsmith Tracer
 * @module @skillsmith/core/telemetry/span-utils
 */

import type { Span, SpanAttributes, SpanStatusCode, SpanWrapper } from './tracer-types.js'

/**
 * No-op span wrapper for when tracing is disabled
 */
export class NoOpSpanWrapper implements SpanWrapper {
  setAttributes(_attributes: SpanAttributes): void {}
  setStatus(_code: 'ok' | 'error', _message?: string): void {}
  recordException(_error: Error): void {}
  addEvent(_name: string, _attributes?: SpanAttributes): void {}
  end(): void {}
  getSpan(): Span | null {
    return null
  }
}

/**
 * Active span wrapper with real OTEL span
 */
export class ActiveSpanWrapper implements SpanWrapper {
  constructor(private span: Span) {}

  setAttributes(attributes: SpanAttributes): void {
    // Filter out undefined values
    const filtered: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {}
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        filtered[key] = value
      }
    }
    this.span.setAttributes(filtered)
  }

  setStatus(code: 'ok' | 'error', message?: string): void {
    const statusCode: SpanStatusCode = code === 'ok' ? 1 : 2 // SpanStatusCode.OK = 1, ERROR = 2
    this.span.setStatus({ code: statusCode, message })
  }

  recordException(error: Error): void {
    this.span.recordException(error)
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    // Filter out undefined values
    const filtered: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {}
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) {
          filtered[key] = value
        }
      }
    }
    this.span.addEvent(name, filtered)
  }

  end(): void {
    this.span.end()
  }

  getSpan(): Span {
    return this.span
  }
}
