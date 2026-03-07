/**
 * Web Vitals RUM tracking (SMI-2344, SMI-2363, SMI-2420)
 *
 * Shared module for Core Web Vitals reporting.
 * Used by BaseLayout and standalone pages (index.astro).
 *
 * SMI-2420: Changed from side-effect import to named export.
 * Call registerWebVitals() inside an astro:page-load listener to defer
 * the web-vitals bundle load without missing LCP events.
 * onLCP must register promptly on page-load — it uses a PerformanceObserver
 * that cannot capture LCP if registered after the LCP event fires.
 */
import { onLCP, onCLS, onINP } from 'web-vitals'
import type { Metric } from 'web-vitals'

function reportMetric(metric: Metric): void {
  const ms = Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value)
  const unit = metric.name === 'CLS' ? '' : 'ms'
  console.log(`[CWV] ${metric.name}: ${ms}${unit} (${metric.rating}) id=${metric.id}`)

  // Forward to Google Analytics if gtag is present
  if (typeof window.gtag === 'function') {
    window.gtag('event', metric.name, {
      value: ms,
      event_category: 'Web Vitals',
      event_label: metric.id,
      non_interaction: true,
    })
  }
}

/**
 * Register Core Web Vitals observers.
 * Must be called promptly on astro:page-load — do not defer inside
 * requestIdleCallback as LCP events may already have fired by idle time.
 */
export function registerWebVitals(): void {
  onLCP(reportMetric)
  onCLS(reportMetric)
  onINP(reportMetric)
}
