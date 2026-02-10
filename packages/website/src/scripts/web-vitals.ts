/**
 * Web Vitals RUM tracking (SMI-2344, SMI-2363)
 *
 * Shared module for Core Web Vitals reporting.
 * Used by BaseLayout and standalone pages (index.astro).
 * Side-effect import: registers LCP, CLS, INP observers on load.
 */
import { onLCP, onCLS, onINP } from 'web-vitals';
import type { Metric } from 'web-vitals';

function reportMetric(metric: Metric): void {
  const ms = Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value);
  const unit = metric.name === 'CLS' ? '' : 'ms';
  console.log(`[CWV] ${metric.name}: ${ms}${unit} (${metric.rating}) id=${metric.id}`);

  // Forward to Google Analytics if gtag is present
  if (typeof window.gtag === 'function') {
    window.gtag('event', metric.name, {
      value: ms,
      event_category: 'Web Vitals',
      event_label: metric.id,
      non_interaction: true,
    });
  }
}

onLCP(reportMetric);
onCLS(reportMetric);
onINP(reportMetric);
