# Skillsmith Monitoring and Observability Guide

This document provides comprehensive guidance for monitoring and observability of Skillsmith deployments. The system integrates with OpenTelemetry for distributed tracing and metrics, with graceful fallback when OTEL packages are unavailable.

## Table of Contents

- [Overview](#overview)
- [Health Check Endpoints](#health-check-endpoints)
- [Prometheus Metrics Export](#prometheus-metrics-export)
- [Alert Threshold Definitions](#alert-threshold-definitions)
- [Grafana Dashboard Configuration](#grafana-dashboard-configuration)
- [Log Aggregation Setup](#log-aggregation-setup)
- [Trace Correlation with OpenTelemetry](#trace-correlation-with-opentelemetry)
- [Key Metrics Reference](#key-metrics-reference)
- [Implementation Guide](#implementation-guide)

---

## Overview

Skillsmith's observability stack consists of three pillars:

| Pillar | Technology | Purpose |
|--------|-----------|---------|
| **Metrics** | OpenTelemetry / Prometheus | Performance monitoring, capacity planning |
| **Traces** | OpenTelemetry / Jaeger | Request flow analysis, latency debugging |
| **Logs** | Structured JSON logging | Error debugging, audit trails |

### Architecture Diagram

```
                                    +------------------+
                                    |    Grafana       |
                                    |   (Dashboards)   |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v-----------+       +----------v----------+
    |    Prometheus     |        |        Jaeger         |       |    Loki / ELK       |
    |    (Metrics)      |        |       (Traces)        |       |      (Logs)         |
    +-------------------+        +-----------------------+       +---------------------+
              ^                              ^                              ^
              |                              |                              |
    +---------+---------+        +-----------+-----------+       +----------+----------+
    |   OTEL Collector  |<-------+   Skillsmith MCP      +------>|   Log Shipper       |
    | (metrics export)  |        |      Server           |       |  (fluentd/vector)   |
    +-------------------+        +-----------+-----------+       +---------------------+
                                             |
                                 +-----------+-----------+
                                 |  Health / Readiness   |
                                 |      Endpoints        |
                                 +-----------------------+
```

---

## Health Check Endpoints

Skillsmith provides two health check endpoints for Kubernetes liveness and readiness probes.

### `/health` - Liveness Probe

The health endpoint performs a lightweight check that returns quickly without external dependencies.

**Response Schema:**

```typescript
interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy'
  uptime: number        // Process uptime in seconds
  version: string       // Application version
  timestamp: string     // ISO 8601 timestamp
  info?: Record<string, unknown>  // Optional additional info
}
```

**HTTP Status Codes:**

| Status | HTTP Code | Description |
|--------|-----------|-------------|
| `ok` | 200 | Service is healthy |
| `degraded` | 200 | Service operational but with issues |
| `unhealthy` | 503 | Service unavailable |

**Example Response:**

```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "0.1.0",
  "timestamp": "2025-01-02T12:00:00.000Z"
}
```

**Usage with Express:**

```typescript
import { checkHealth, formatHealthResponse } from '@skillsmith/mcp-server/health';

app.get('/health', async (req, res) => {
  const health = await checkHealth();
  const { statusCode, body } = formatHealthResponse(health);
  res.status(statusCode).json(body);
});
```

### `/ready` - Readiness Probe

The readiness endpoint performs deep health checks including database connectivity and cache status.

**Response Schema:**

```typescript
interface ReadinessResponse {
  ready: boolean           // Overall readiness status
  statusCode: number       // HTTP status code to return
  timestamp: string        // ISO 8601 timestamp
  checks: DependencyCheck[] // Individual check results
  totalDuration: number    // Total check duration in ms
}

interface DependencyCheck {
  name: string
  status: 'ok' | 'degraded' | 'unhealthy'
  responseTime?: number    // Response time in ms
  error?: string           // Error message if unhealthy
  details?: Record<string, unknown>
}
```

**Example Response:**

```json
{
  "ready": true,
  "statusCode": 200,
  "timestamp": "2025-01-02T12:00:00.000Z",
  "checks": [
    {
      "name": "database",
      "status": "ok",
      "responseTime": 2.45,
      "details": { "type": "sqlite" }
    },
    {
      "name": "cache",
      "status": "ok",
      "responseTime": 0.12
    },
    {
      "name": "embedding_service",
      "status": "ok",
      "responseTime": 15.32,
      "details": { "mode": "onnx" }
    }
  ],
  "totalDuration": 17.89
}
```

**Usage with Express:**

```typescript
import { checkReadiness, formatReadinessResponse, configureReadinessCheck } from '@skillsmith/mcp-server/health';

// Configure dependencies
configureReadinessCheck({
  database: dbInstance,
  cacheCheck: async () => cache.ping(),
  customChecks: [
    {
      name: 'embedding_service',
      check: async () => ({ ok: embeddingService.isReady() }),
      critical: false
    }
  ]
});

app.get('/ready', async (req, res) => {
  const readiness = await checkReadiness();
  const { statusCode, body } = formatReadinessResponse(readiness);
  res.status(statusCode).json(body);
});
```

### Kubernetes Probe Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: skillsmith-mcp
spec:
  template:
    spec:
      containers:
      - name: skillsmith
        image: skillsmith/mcp-server:latest
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 3
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 3
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

---

## Prometheus Metrics Export

### Environment Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP endpoint URL (e.g., `http://otel-collector:4318`) |
| `OTEL_SERVICE_NAME` | `skillsmith` | Service name for metrics |
| `SKILLSMITH_TELEMETRY_ENABLED` | `auto` | Master switch: `true`, `false`, or `auto` |
| `SKILLSMITH_METRICS_ENABLED` | `auto` | Metrics switch: `true`, `false`, or `auto` |

### OpenTelemetry Collector Configuration

Create `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 10s
    send_batch_size: 1000
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: skillsmith
    const_labels:
      environment: production
    resource_to_telemetry_conversion:
      enabled: true

  # Optional: Export to remote Prometheus
  prometheusremotewrite:
    endpoint: "https://prometheus.example.com/api/v1/write"
    headers:
      Authorization: "Bearer ${PROMETHEUS_TOKEN}"

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

### Docker Compose Setup

```yaml
version: '3.8'
services:
  skillsmith:
    image: skillsmith/mcp-server:latest
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
      - OTEL_SERVICE_NAME=skillsmith
      - SKILLSMITH_TELEMETRY_ENABLED=true
    depends_on:
      - otel-collector

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus metrics

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.enable-lifecycle'
```

### Prometheus Scrape Configuration

Create `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'skillsmith'
    static_configs:
      - targets: ['otel-collector:8889']
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: 'skillsmith_.*'
        action: keep

  - job_name: 'skillsmith-health'
    metrics_path: /metrics
    static_configs:
      - targets: ['skillsmith:3000']
    scrape_interval: 30s
```

### Metrics Endpoint Implementation

Add a `/metrics` endpoint for direct Prometheus scraping:

```typescript
import { getMetrics } from '@skillsmith/core/telemetry';

app.get('/metrics', async (req, res) => {
  const registry = getMetrics();
  const snapshot = registry.getSnapshot();

  // Convert to Prometheus text format
  const lines: string[] = [];

  // Counters
  for (const [name, value] of Object.entries(snapshot.counters)) {
    const metricName = name.replace(/\./g, '_');
    lines.push(`# TYPE ${metricName} counter`);
    lines.push(`${metricName} ${value}`);
  }

  // Histograms
  for (const [name, stats] of Object.entries(snapshot.histograms)) {
    const metricName = name.replace(/\./g, '_');
    lines.push(`# TYPE ${metricName} histogram`);
    lines.push(`${metricName}_count ${stats.count}`);
    lines.push(`${metricName}_sum ${stats.sum}`);
    lines.push(`${metricName}{quantile="0.5"} ${stats.p50}`);
    lines.push(`${metricName}{quantile="0.95"} ${stats.p95}`);
    lines.push(`${metricName}{quantile="0.99"} ${stats.p99}`);
  }

  // Gauges
  for (const [name, value] of Object.entries(snapshot.gauges)) {
    const metricName = name.replace(/\./g, '_');
    lines.push(`# TYPE ${metricName} gauge`);
    lines.push(`${metricName} ${value}`);
  }

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n'));
});
```

---

## Alert Threshold Definitions

### Prometheus Alert Rules

Create `skillsmith-alerts.yml`:

```yaml
groups:
  - name: skillsmith.availability
    interval: 30s
    rules:
      - alert: SkillsmithDown
        expr: up{job="skillsmith"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Skillsmith service is down"
          description: "Skillsmith MCP server has been unreachable for more than 1 minute"

      - alert: SkillsmithHighErrorRate
        expr: |
          (
            rate(skillsmith_mcp_error_count[5m]) /
            rate(skillsmith_mcp_request_count[5m])
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      - alert: SkillsmithCriticalErrorRate
        expr: |
          (
            rate(skillsmith_mcp_error_count[5m]) /
            rate(skillsmith_mcp_request_count[5m])
          ) > 0.15
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Critical error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 15%)"

  - name: skillsmith.latency
    interval: 30s
    rules:
      - alert: SkillsmithHighLatency
        expr: |
          histogram_quantile(0.95,
            rate(skillsmith_mcp_request_latency_bucket[5m])
          ) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High request latency"
          description: "P95 latency is {{ $value }}ms (threshold: 1000ms)"

      - alert: SkillsmithCriticalLatency
        expr: |
          histogram_quantile(0.95,
            rate(skillsmith_mcp_request_latency_bucket[5m])
          ) > 5000
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Critical request latency"
          description: "P95 latency is {{ $value }}ms (threshold: 5000ms)"

      - alert: SkillsmithSlowDatabaseQueries
        expr: |
          histogram_quantile(0.95,
            rate(skillsmith_db_query_latency_bucket[5m])
          ) > 500
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow database queries detected"
          description: "P95 DB query latency is {{ $value }}ms (threshold: 500ms)"

  - name: skillsmith.cache
    interval: 30s
    rules:
      - alert: SkillsmithLowCacheHitRate
        expr: |
          (
            rate(skillsmith_cache_hits[5m]) /
            (rate(skillsmith_cache_hits[5m]) + rate(skillsmith_cache_misses[5m]))
          ) < 0.7
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low cache hit rate"
          description: "Cache hit rate is {{ $value | humanizePercentage }} (threshold: 70%)"

      - alert: SkillsmithCacheCritical
        expr: |
          (
            rate(skillsmith_cache_hits[5m]) /
            (rate(skillsmith_cache_hits[5m]) + rate(skillsmith_cache_misses[5m]))
          ) < 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Critical cache hit rate"
          description: "Cache hit rate is {{ $value | humanizePercentage }} (threshold: 50%)"

  - name: skillsmith.skills
    interval: 30s
    rules:
      - alert: SkillsmithInstallFailureRate
        expr: |
          (
            rate(skillsmith_skill_install_failures[5m]) /
            rate(skillsmith_skill_install_total[5m])
          ) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High skill installation failure rate"
          description: "{{ $value | humanizePercentage }} of skill installations are failing"

      - alert: SkillsmithSearchLatency
        expr: |
          histogram_quantile(0.95,
            rate(skillsmith_search_latency_bucket[5m])
          ) > 2000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow skill search operations"
          description: "P95 search latency is {{ $value }}ms (threshold: 2000ms)"

  - name: skillsmith.resources
    interval: 30s
    rules:
      - alert: SkillsmithHighMemoryUsage
        expr: |
          process_resident_memory_bytes{job="skillsmith"} /
          container_spec_memory_limit_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
          description: "Memory usage is {{ $value | humanizePercentage }}"

      - alert: SkillsmithHighActiveOperations
        expr: skillsmith_operations_active > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High number of active operations"
          description: "{{ $value }} concurrent operations (threshold: 100)"
```

### Alert Thresholds Summary

| Metric | Warning | Critical | Duration |
|--------|---------|----------|----------|
| Error Rate | > 5% | > 15% | 5m / 2m |
| P95 Latency | > 1000ms | > 5000ms | 5m / 2m |
| DB Query P95 | > 500ms | - | 5m |
| Cache Hit Rate | < 70% | < 50% | 10m / 5m |
| Skill Install Failure | > 10% | - | 5m |
| Search P95 Latency | > 2000ms | - | 5m |
| Memory Usage | > 85% | - | 5m |
| Active Operations | > 100 | - | 5m |

---

## Grafana Dashboard Configuration

### Dashboard JSON

Save as `skillsmith-dashboard.json`:

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": "-- Grafana --",
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 0 },
      "id": 1,
      "panels": [],
      "title": "Overview",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "mappings": [
            { "options": { "0": { "color": "red", "index": 0, "text": "DOWN" } }, "type": "value" },
            { "options": { "1": { "color": "green", "index": 1, "text": "UP" } }, "type": "value" }
          ],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": null },
              { "color": "green", "value": 1 }
            ]
          }
        },
        "overrides": []
      },
      "gridPos": { "h": 4, "w": 4, "x": 0, "y": 1 },
      "id": 2,
      "options": {
        "colorMode": "value",
        "graphMode": "none",
        "justifyMode": "auto",
        "orientation": "horizontal",
        "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false },
        "textMode": "auto"
      },
      "pluginVersion": "9.5.0",
      "targets": [
        {
          "expr": "up{job=\"skillsmith\"}",
          "legendFormat": "Status",
          "refId": "A"
        }
      ],
      "title": "Service Status",
      "type": "stat"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "off" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }] },
          "unit": "reqps"
        },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 10, "x": 4, "y": 1 },
      "id": 3,
      "options": { "legend": { "calcs": ["mean", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        {
          "expr": "rate(skillsmith_mcp_request_count[5m])",
          "legendFormat": "Request Rate",
          "refId": "A"
        }
      ],
      "title": "Request Rate",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 0.05 }, { "color": "red", "value": 0.15 }] },
          "unit": "percentunit"
        },
        "overrides": []
      },
      "gridPos": { "h": 4, "w": 5, "x": 14, "y": 1 },
      "id": 4,
      "options": { "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "horizontal", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
      "targets": [
        {
          "expr": "rate(skillsmith_mcp_error_count[5m]) / rate(skillsmith_mcp_request_count[5m])",
          "legendFormat": "Error Rate",
          "refId": "A"
        }
      ],
      "title": "Error Rate",
      "type": "stat"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }, { "color": "yellow", "value": 500 }, { "color": "red", "value": 1000 }] },
          "unit": "ms"
        },
        "overrides": []
      },
      "gridPos": { "h": 4, "w": 5, "x": 19, "y": 1 },
      "id": 5,
      "options": { "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "horizontal", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
      "targets": [
        {
          "expr": "histogram_quantile(0.95, rate(skillsmith_mcp_request_latency_bucket[5m]))",
          "legendFormat": "P95 Latency",
          "refId": "A"
        }
      ],
      "title": "P95 Latency",
      "type": "stat"
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 9 },
      "id": 6,
      "panels": [],
      "title": "Latency Distribution",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "line+area" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "transparent", "value": null }, { "color": "red", "value": 1000 }] },
          "unit": "ms"
        },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 10 },
      "id": 7,
      "options": { "legend": { "calcs": ["mean", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "histogram_quantile(0.50, rate(skillsmith_mcp_request_latency_bucket[5m]))", "legendFormat": "P50", "refId": "A" },
        { "expr": "histogram_quantile(0.90, rate(skillsmith_mcp_request_latency_bucket[5m]))", "legendFormat": "P90", "refId": "B" },
        { "expr": "histogram_quantile(0.95, rate(skillsmith_mcp_request_latency_bucket[5m]))", "legendFormat": "P95", "refId": "C" },
        { "expr": "histogram_quantile(0.99, rate(skillsmith_mcp_request_latency_bucket[5m]))", "legendFormat": "P99", "refId": "D" }
      ],
      "title": "Request Latency Percentiles",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "line+area" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "transparent", "value": null }, { "color": "red", "value": 500 }] },
          "unit": "ms"
        },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 10 },
      "id": 8,
      "options": { "legend": { "calcs": ["mean", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "histogram_quantile(0.50, rate(skillsmith_db_query_latency_bucket[5m]))", "legendFormat": "P50", "refId": "A" },
        { "expr": "histogram_quantile(0.95, rate(skillsmith_db_query_latency_bucket[5m]))", "legendFormat": "P95", "refId": "B" },
        { "expr": "histogram_quantile(0.99, rate(skillsmith_db_query_latency_bucket[5m]))", "legendFormat": "P99", "refId": "C" }
      ],
      "title": "Database Query Latency",
      "type": "timeseries"
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 18 },
      "id": 9,
      "panels": [],
      "title": "Cache Performance",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "thresholds" },
          "mappings": [],
          "max": 1,
          "min": 0,
          "thresholds": { "mode": "absolute", "steps": [{ "color": "red", "value": null }, { "color": "yellow", "value": 0.5 }, { "color": "green", "value": 0.7 }] },
          "unit": "percentunit"
        },
        "overrides": []
      },
      "gridPos": { "h": 6, "w": 6, "x": 0, "y": 19 },
      "id": 10,
      "options": { "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "showThresholdLabels": false, "showThresholdMarkers": true },
      "targets": [
        {
          "expr": "rate(skillsmith_cache_hits[5m]) / (rate(skillsmith_cache_hits[5m]) + rate(skillsmith_cache_misses[5m]))",
          "legendFormat": "Hit Rate",
          "refId": "A"
        }
      ],
      "title": "Cache Hit Rate",
      "type": "gauge"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "normal" }, "thresholdsStyle": { "mode": "off" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }] },
          "unit": "short"
        },
        "overrides": [
          { "matcher": { "id": "byName", "options": "Hits" }, "properties": [{ "id": "color", "value": { "fixedColor": "green", "mode": "fixed" } }] },
          { "matcher": { "id": "byName", "options": "Misses" }, "properties": [{ "id": "color", "value": { "fixedColor": "red", "mode": "fixed" } }] }
        ]
      },
      "gridPos": { "h": 6, "w": 9, "x": 6, "y": 19 },
      "id": 11,
      "options": { "legend": { "calcs": ["sum"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "rate(skillsmith_cache_hits[5m])", "legendFormat": "Hits", "refId": "A" },
        { "expr": "rate(skillsmith_cache_misses[5m])", "legendFormat": "Misses", "refId": "B" }
      ],
      "title": "Cache Operations",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "off" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }] },
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": { "h": 6, "w": 9, "x": 15, "y": 19 },
      "id": 12,
      "options": { "legend": { "calcs": ["lastNotNull"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "skillsmith_cache_size", "legendFormat": "Cache Size", "refId": "A" }
      ],
      "title": "Cache Size",
      "type": "timeseries"
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 25 },
      "id": 13,
      "panels": [],
      "title": "Skill Operations",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "off" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }] },
          "unit": "ms"
        },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 26 },
      "id": 14,
      "options": { "legend": { "calcs": ["mean", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "histogram_quantile(0.50, rate(skillsmith_search_latency_bucket[5m]))", "legendFormat": "P50", "refId": "A" },
        { "expr": "histogram_quantile(0.95, rate(skillsmith_search_latency_bucket[5m]))", "legendFormat": "P95", "refId": "B" },
        { "expr": "histogram_quantile(0.99, rate(skillsmith_search_latency_bucket[5m]))", "legendFormat": "P99", "refId": "C" }
      ],
      "title": "Search Latency",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "fieldConfig": {
        "defaults": {
          "color": { "mode": "palette-classic" },
          "custom": { "axisCenteredZero": false, "axisColorMode": "text", "axisLabel": "", "axisPlacement": "auto", "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none", "hideFrom": { "legend": false, "tooltip": false, "viz": false }, "lineInterpolation": "smooth", "lineWidth": 2, "pointSize": 5, "scaleDistribution": { "type": "linear" }, "showPoints": "never", "spanNulls": false, "stacking": { "group": "A", "mode": "none" }, "thresholdsStyle": { "mode": "off" } },
          "mappings": [],
          "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }] },
          "unit": "ms"
        },
        "overrides": []
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 26 },
      "id": 15,
      "options": { "legend": { "calcs": ["mean", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true }, "tooltip": { "mode": "multi", "sort": "desc" } },
      "targets": [
        { "expr": "histogram_quantile(0.50, rate(skillsmith_embedding_latency_bucket[5m]))", "legendFormat": "P50", "refId": "A" },
        { "expr": "histogram_quantile(0.95, rate(skillsmith_embedding_latency_bucket[5m]))", "legendFormat": "P95", "refId": "B" },
        { "expr": "histogram_quantile(0.99, rate(skillsmith_embedding_latency_bucket[5m]))", "legendFormat": "P99", "refId": "C" }
      ],
      "title": "Embedding Generation Latency",
      "type": "timeseries"
    }
  ],
  "refresh": "30s",
  "schemaVersion": 38,
  "style": "dark",
  "tags": ["skillsmith", "mcp", "observability"],
  "templating": {
    "list": [
      {
        "current": { "selected": false, "text": "Prometheus", "value": "Prometheus" },
        "hide": 0,
        "includeAll": false,
        "label": "Data Source",
        "multi": false,
        "name": "DS_PROMETHEUS",
        "options": [],
        "query": "prometheus",
        "refresh": 1,
        "regex": "",
        "skipUrlSync": false,
        "type": "datasource"
      }
    ]
  },
  "time": { "from": "now-1h", "to": "now" },
  "timepicker": {},
  "timezone": "",
  "title": "Skillsmith MCP Server",
  "uid": "skillsmith-mcp",
  "version": 1,
  "weekStart": ""
}
```

### Importing the Dashboard

1. In Grafana, go to **Dashboards > Import**
2. Upload `skillsmith-dashboard.json` or paste the JSON
3. Select your Prometheus data source
4. Click **Import**

---

## Log Aggregation Setup

### Structured Logging Format

Skillsmith uses structured JSON logging for easy aggregation:

```typescript
interface LogEntry {
  timestamp: string      // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  service: string        // 'skillsmith'
  traceId?: string       // OpenTelemetry trace ID
  spanId?: string        // OpenTelemetry span ID
  context?: {
    tool?: string        // MCP tool name
    skillId?: string     // Skill identifier
    userId?: string      // User identifier (if applicable)
    duration?: number    // Operation duration in ms
    error?: {
      name: string
      message: string
      stack?: string
    }
  }
}
```

**Example Log Output:**

```json
{
  "timestamp": "2025-01-02T12:00:00.000Z",
  "level": "info",
  "message": "Skill search completed",
  "service": "skillsmith",
  "traceId": "abc123def456",
  "spanId": "789ghi",
  "context": {
    "tool": "search",
    "query": "testing",
    "results": 15,
    "duration": 45
  }
}
```

### Fluentd Configuration

Create `fluent.conf`:

```apache
<source>
  @type forward
  port 24224
  bind 0.0.0.0
</source>

<source>
  @type tail
  path /var/log/skillsmith/*.log
  pos_file /var/log/td-agent/skillsmith.pos
  tag skillsmith.*
  <parse>
    @type json
    time_key timestamp
    time_format %Y-%m-%dT%H:%M:%S.%LZ
  </parse>
</source>

<filter skillsmith.**>
  @type record_transformer
  <record>
    hostname "#{Socket.gethostname}"
    environment "#{ENV['ENVIRONMENT'] || 'development'}"
  </record>
</filter>

# Send to Elasticsearch
<match skillsmith.**>
  @type elasticsearch
  host elasticsearch
  port 9200
  index_name skillsmith-logs
  type_name _doc
  logstash_format true
  logstash_prefix skillsmith
  <buffer>
    @type file
    path /var/log/td-agent/buffer/elasticsearch
    flush_mode interval
    flush_interval 5s
    chunk_limit_size 8MB
    queue_limit_length 64
    retry_max_interval 30
    retry_forever true
  </buffer>
</match>

# Alternative: Send to Loki
<match skillsmith.**>
  @type loki
  url "http://loki:3100"
  <label>
    service skillsmith
    level ${level}
  </label>
  <buffer>
    flush_interval 5s
    flush_at_shutdown true
  </buffer>
</match>
```

### Vector Configuration (Alternative)

Create `vector.toml`:

```toml
[sources.skillsmith_logs]
type = "file"
include = ["/var/log/skillsmith/*.log"]
read_from = "beginning"

[transforms.parse_json]
type = "remap"
inputs = ["skillsmith_logs"]
source = '''
. = parse_json!(.message)
.host = get_hostname!()
'''

[transforms.add_labels]
type = "remap"
inputs = ["parse_json"]
source = '''
.labels.service = "skillsmith"
.labels.level = .level
.labels.environment = get_env_var("ENVIRONMENT") ?? "development"
'''

[sinks.loki]
type = "loki"
inputs = ["add_labels"]
endpoint = "http://loki:3100"
encoding.codec = "json"
labels.service = "{{ labels.service }}"
labels.level = "{{ labels.level }}"
labels.environment = "{{ labels.environment }}"

[sinks.elasticsearch]
type = "elasticsearch"
inputs = ["add_labels"]
endpoints = ["http://elasticsearch:9200"]
index = "skillsmith-logs-%Y.%m.%d"
```

### Loki LogQL Queries

```logql
# All errors in the last hour
{service="skillsmith"} |= "error"

# Search tool operations
{service="skillsmith"} | json | tool="search"

# Slow operations (>1000ms)
{service="skillsmith"} | json | duration > 1000

# Skill installation failures
{service="skillsmith"} | json | tool="install_skill" |= "failed"

# Trace correlation
{service="skillsmith"} | json | traceId="abc123def456"
```

---

## Trace Correlation with OpenTelemetry

### Environment Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP endpoint (e.g., `http://jaeger:4318`) |
| `OTEL_SERVICE_NAME` | `skillsmith` | Service name in traces |
| `SKILLSMITH_TELEMETRY_ENABLED` | `auto` | Master switch |
| `SKILLSMITH_TRACING_ENABLED` | `auto` | Tracing switch |

### Tracer Initialization

```typescript
import { initializeTracing, getTracer } from '@skillsmith/core/telemetry';

// Initialize at application startup
await initializeTracing({
  serviceName: 'skillsmith',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  sampleRate: 1.0,  // 100% sampling
  autoInstrument: true
});

// Usage in handlers
const tracer = getTracer();

async function handleSearch(query: string) {
  return tracer.withSpan('mcp.tool.search', async (span) => {
    span.setAttributes({
      'mcp.tool': 'search',
      'search.query': query
    });

    // Perform search...
    const results = await searchSkills(query);

    span.setAttributes({
      'search.results_count': results.length
    });

    return results;
  });
}
```

### Trace Context Propagation

For HTTP requests between services:

```typescript
import { context, propagation, trace } from '@opentelemetry/api';

// Inject trace context into outgoing requests
function injectTraceContext(headers: Record<string, string>): void {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    propagation.inject(context.active(), headers);
  }
}

// Extract trace context from incoming requests
function extractTraceContext(headers: Record<string, string>): void {
  const ctx = propagation.extract(context.active(), headers);
  return ctx;
}
```

### Log-Trace Correlation

Add trace IDs to logs automatically:

```typescript
import { trace } from '@opentelemetry/api';

function createLogger() {
  return {
    info(message: string, context?: Record<string, unknown>) {
      const span = trace.getActiveSpan();
      const spanContext = span?.spanContext();

      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message,
        service: 'skillsmith',
        traceId: spanContext?.traceId,
        spanId: spanContext?.spanId,
        context
      }));
    },
    // ... other log methods
  };
}
```

### Jaeger Configuration

Docker Compose setup with Jaeger:

```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686"  # Jaeger UI
      - "4317:4317"    # OTLP gRPC
      - "4318:4318"    # OTLP HTTP

  skillsmith:
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
      - OTEL_SERVICE_NAME=skillsmith
      - SKILLSMITH_TRACING_ENABLED=true
```

### Span Naming Conventions

| Operation | Span Name | Attributes |
|-----------|-----------|------------|
| MCP Tool | `mcp.tool.{name}` | `mcp.tool`, `mcp.request_id` |
| Database | `db.query` | `db.system`, `db.statement` |
| Cache | `cache.{get\|set}` | `cache.key`, `cache.hit` |
| Search | `search.skills` | `search.query`, `search.results_count` |
| Embedding | `embedding.generate` | `embedding.model`, `embedding.dimensions` |
| HTTP | `http.request` | `http.method`, `http.url`, `http.status_code` |

---

## Key Metrics Reference

### Request Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `skillsmith_mcp_request_count` | Counter | Total MCP requests | `tool`, `status` |
| `skillsmith_mcp_request_latency` | Histogram | Request latency (ms) | `tool` |
| `skillsmith_mcp_error_count` | Counter | Total MCP errors | `tool`, `error_type` |
| `skillsmith_operations_active` | Gauge | Active operations | - |

### Database Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `skillsmith_db_query_count` | Counter | Total DB queries | `operation` |
| `skillsmith_db_query_latency` | Histogram | Query latency (ms) | `operation` |

### Cache Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `skillsmith_cache_hits` | Counter | Cache hits | `cache_type` |
| `skillsmith_cache_misses` | Counter | Cache misses | `cache_type` |
| `skillsmith_cache_size` | Gauge | Cache entry count | `cache_type` |

### Search & Embedding Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `skillsmith_search_count` | Counter | Search operations | `type` |
| `skillsmith_search_latency` | Histogram | Search latency (ms) | `type` |
| `skillsmith_embedding_count` | Counter | Embeddings generated | `model` |
| `skillsmith_embedding_latency` | Histogram | Embedding latency (ms) | `model` |

### Skill Installation Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `skillsmith_skill_install_total` | Counter | Total installations | `trust_tier` |
| `skillsmith_skill_install_failures` | Counter | Failed installations | `trust_tier`, `error_type` |
| `skillsmith_skill_uninstall_total` | Counter | Total uninstallations | - |

### Histogram Bucket Boundaries

Latency metrics use these bucket boundaries (milliseconds):

```
[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
```

---

## Implementation Guide

### Adding Custom Metrics

```typescript
import { getMetrics } from '@skillsmith/core/telemetry';

const metrics = getMetrics();

// Create custom counter
const customCounter = metrics.createCounter('skillsmith.custom.operation', {
  description: 'Custom operation count',
  unit: 'operations'
});

// Create custom histogram
const customLatency = metrics.createHistogram('skillsmith.custom.latency', {
  description: 'Custom operation latency',
  unit: 'ms'
});

// Use in code
customCounter.increment({ operation: 'my_operation' });
customLatency.record(duration, { operation: 'my_operation' });
```

### Adding Health Checks

```typescript
import { getReadinessCheck } from '@skillsmith/mcp-server/health';

const readiness = getReadinessCheck();

// Add custom dependency check
readiness.addCheck(
  'external_api',
  async () => {
    const response = await fetch('https://api.example.com/health');
    return {
      ok: response.ok,
      details: { statusCode: response.status }
    };
  },
  true // critical = true
);
```

### Implementing Trace Instrumentation

```typescript
import { getTracer, traced } from '@skillsmith/core/telemetry';

class SkillService {
  private tracer = getTracer();

  // Using decorator
  @traced('skill.install')
  async installSkill(skillId: string): Promise<void> {
    // Method implementation...
  }

  // Manual instrumentation
  async searchSkills(query: string): Promise<Skill[]> {
    return this.tracer.withSpan('skill.search', async (span) => {
      span.setAttributes({
        'search.query': query,
        'search.filters': JSON.stringify(filters)
      });

      try {
        const results = await this.repository.search(query);
        span.setAttributes({ 'search.results': results.length });
        return results;
      } catch (error) {
        span.recordException(error as Error);
        throw error;
      }
    });
  }
}
```

### Graceful Fallback Handling

When OpenTelemetry is unavailable, the system falls back gracefully:

```typescript
import { getMetrics, getTracer } from '@skillsmith/core/telemetry';

const metrics = getMetrics();
const tracer = getTracer();

// Check if OTEL is enabled
if (metrics.isEnabled()) {
  console.log('Metrics export enabled');
} else {
  console.log('Using in-memory metrics (available via getSnapshot())');
}

if (tracer.isEnabled()) {
  console.log('Distributed tracing enabled');
} else {
  console.log('Tracing disabled - using no-op spans');
}

// Get local metrics snapshot (works even without OTEL)
const snapshot = metrics.getSnapshot();
console.log('Current metrics:', snapshot);
```

---

## Quick Reference

### Environment Variables Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | OTLP collector endpoint |
| `OTEL_SERVICE_NAME` | `skillsmith` | Service name for telemetry |
| `SKILLSMITH_TELEMETRY_ENABLED` | `auto` | Master telemetry switch |
| `SKILLSMITH_METRICS_ENABLED` | `auto` | Metrics collection switch |
| `SKILLSMITH_TRACING_ENABLED` | `auto` | Distributed tracing switch |

### Production Checklist

- [ ] Configure OTLP endpoint for metrics and traces
- [ ] Set up Prometheus scraping
- [ ] Import Grafana dashboard
- [ ] Configure alert rules in Prometheus
- [ ] Set up log aggregation (Fluentd/Vector to Loki/Elasticsearch)
- [ ] Verify health endpoints accessible
- [ ] Configure Kubernetes probes
- [ ] Test alert notifications
- [ ] Validate trace correlation in logs

### Useful Commands

```bash
# Check metrics endpoint
curl http://localhost:3000/metrics

# Check health
curl http://localhost:3000/health

# Check readiness
curl http://localhost:3000/ready

# Query Prometheus
curl 'http://prometheus:9090/api/v1/query?query=skillsmith_mcp_request_count'

# Search Loki logs
curl -G 'http://loki:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={service="skillsmith"}'
```

---

## Related Documentation

- [Telemetry Module Source](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/telemetry/index.ts)
- [Health Check Implementation](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/mcp-server/src/health/healthCheck.ts)
- [Readiness Check Implementation](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/mcp-server/src/health/readinessCheck.ts)
- [Metrics Implementation](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/telemetry/metrics.ts)
- [Tracer Implementation](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/telemetry/tracer.ts)
