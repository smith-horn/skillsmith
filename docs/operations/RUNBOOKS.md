# Operational Runbooks

> Last Updated: January 2, 2026

This document contains operational runbooks for the SkillSmith platform. Each runbook provides step-by-step procedures for handling common operational scenarios.

---

## Table of Contents

1. [Database Failover](#1-database-failover)
2. [Service Restart](#2-service-restart)
3. [Cache Invalidation](#3-cache-invalidation)
4. [Performance Degradation Response](#4-performance-degradation-response)
5. [Security Incident Response](#5-security-incident-response)
6. [Backup and Restore](#6-backup-and-restore)

---

## 1. Database Failover

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P1 - Critical |
| **Expected Duration** | 15-45 minutes |
| **Required Permissions** | Database Admin, Infrastructure Admin |
| **On-Call Escalation** | Immediate |

### 1.1 Symptoms

- Application errors with database connection failures
- Increased latency on database queries (>5s response time)
- Connection pool exhaustion alerts
- Primary database node unreachable
- Replication lag exceeds threshold (>30 seconds)
- Health check failures on `/health/db` endpoint
- Error logs showing: `ECONNREFUSED`, `connection timeout`, `too many connections`

### 1.2 Diagnosis Steps

```bash
# Step 1: Check database connectivity from application servers
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "SELECT 1;"

# Step 2: Check primary node status
pg_isready -h $PRIMARY_HOST -p 5432

# Step 3: Check replica status
pg_isready -h $REPLICA_HOST -p 5432

# Step 4: Check replication lag (on primary)
psql -h $PRIMARY_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    (extract(epoch from now()) - extract(epoch from backend_start))::int as connection_age_seconds
FROM pg_stat_replication;
"

# Step 5: Check connection counts
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT count(*) as total_connections,
       state,
       usename
FROM pg_stat_activity
GROUP BY state, usename
ORDER BY total_connections DESC;
"

# Step 6: Check for blocking queries
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    blocked.pid AS blocked_pid,
    blocked.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking.query AS blocking_query,
    now() - blocked.query_start AS blocked_duration
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.cardinality(pg_blocking_pids(blocked.pid)) > 0;
"

# Step 7: Check disk space
df -h /var/lib/postgresql

# Step 8: Check database logs
tail -100 /var/log/postgresql/postgresql-*.log | grep -E "(ERROR|FATAL|PANIC)"
```

### 1.3 Recovery Procedure

#### Scenario A: Primary Node Failure - Promote Replica

```bash
# Step 1: Confirm primary is truly unavailable (wait 30 seconds, retry 3 times)
for i in {1..3}; do
    pg_isready -h $PRIMARY_HOST -p 5432 && echo "Primary is UP" && exit 0
    sleep 10
done
echo "Primary confirmed DOWN - proceeding with failover"

# Step 2: Stop application writes (enable read-only mode)
curl -X POST http://localhost:3000/admin/maintenance/enable \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"mode": "read-only", "reason": "Database failover in progress"}'

# Step 3: Check replica is in sync (if possible)
psql -h $REPLICA_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() as in_sync;
"

# Step 4: Promote replica to primary (on replica server)
sudo -u postgres pg_ctl promote -D /var/lib/postgresql/data

# Step 5: Verify promotion succeeded
psql -h $REPLICA_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "SELECT pg_is_in_recovery();"
# Should return: f (false = primary)

# Step 6: Update application configuration
# Update DATABASE_URL environment variable to point to new primary
kubectl set env deployment/skillsmith-api DATABASE_URL="postgresql://$DATABASE_USER:$DATABASE_PASS@$REPLICA_HOST:5432/$DATABASE_NAME"

# Step 7: Restart application pods to pick up new configuration
kubectl rollout restart deployment/skillsmith-api

# Step 8: Disable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance/disable \
    -H "Authorization: Bearer $ADMIN_TOKEN"

# Step 9: Configure old primary as new replica (when recovered)
# On recovered node:
pg_basebackup -h $NEW_PRIMARY_HOST -D /var/lib/postgresql/data -U replicator -P -R
```

#### Scenario B: Connection Pool Exhaustion

```bash
# Step 1: Kill idle connections older than 10 minutes
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
AND query_start < now() - interval '10 minutes'
AND usename != 'postgres';
"

# Step 2: Kill long-running queries (>5 minutes)
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT pg_terminate_backend(pid), query
FROM pg_stat_activity
WHERE state = 'active'
AND query_start < now() - interval '5 minutes'
AND usename != 'postgres';
"

# Step 3: Increase max_connections temporarily (requires restart)
# Edit postgresql.conf
sudo sed -i 's/max_connections = .*/max_connections = 200/' /etc/postgresql/15/main/postgresql.conf
sudo systemctl restart postgresql

# Step 4: Scale up connection pooler (PgBouncer)
kubectl scale deployment/pgbouncer --replicas=3
```

#### Scenario C: Replication Lag

```bash
# Step 1: Check what's causing lag
psql -h $PRIMARY_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT * FROM pg_stat_replication;
"

# Step 2: Check replica for blocking queries
psql -h $REPLICA_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT pid, now() - query_start as duration, query
FROM pg_stat_activity
WHERE state = 'active'
ORDER BY duration DESC
LIMIT 10;
"

# Step 3: If hot_standby_feedback is causing issues, temporarily disable
psql -h $REPLICA_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
ALTER SYSTEM SET hot_standby_feedback = off;
SELECT pg_reload_conf();
"

# Step 4: Force checkpoint on primary to sync
psql -h $PRIMARY_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "CHECKPOINT;"
```

### 1.4 Verification

```bash
# Verify database is accepting connections
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "SELECT version();"

# Verify application can connect
curl -s http://localhost:3000/health/db | jq .

# Expected response:
# {
#   "status": "healthy",
#   "database": "connected",
#   "latency_ms": 2.5
# }

# Verify replication is working (if applicable)
psql -h $PRIMARY_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    client_addr,
    state,
    sync_state
FROM pg_stat_replication;
"

# Run application smoke tests
npm run test:smoke

# Check error rates in monitoring
curl -s "http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~\"5..\"}[5m])" | jq .
```

### 1.5 Post-Incident Tasks

1. **Document the incident**: Create incident report in incident tracker
2. **Update runbook**: Add any new failure modes discovered
3. **Review alerts**: Ensure alerting caught the issue early enough
4. **Analyze root cause**: Schedule RCA meeting within 48 hours
5. **Test backups**: Verify backup integrity after failover
6. **Review capacity**: Assess if scaling is needed
7. **Notify stakeholders**: Send incident summary to relevant teams

```bash
# Export incident timeline
kubectl logs deployment/skillsmith-api --since=2h > /tmp/incident-logs.txt

# Generate incident report template
cat > /tmp/incident-report.md << 'EOF'
# Incident Report: Database Failover

## Summary
- **Date**: $(date)
- **Duration**:
- **Severity**: P1
- **Impact**:

## Timeline
- HH:MM - First alert received
- HH:MM - On-call engineer engaged
- HH:MM - Root cause identified
- HH:MM - Mitigation applied
- HH:MM - Service restored

## Root Cause

## Resolution

## Action Items
- [ ] Update monitoring
- [ ] Review capacity
- [ ] Update documentation

EOF
```

### 1.6 Rollback Procedure

If the failover creates issues, rollback to previous state:

```bash
# Step 1: If new primary is unstable, switch back to read-only mode
curl -X POST http://localhost:3000/admin/maintenance/enable \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"mode": "read-only"}'

# Step 2: If old primary is recovered, can revert
# Update DATABASE_URL back to original primary
kubectl set env deployment/skillsmith-api DATABASE_URL="postgresql://$DATABASE_USER:$DATABASE_PASS@$ORIGINAL_PRIMARY:5432/$DATABASE_NAME"

# Step 3: Restart applications
kubectl rollout restart deployment/skillsmith-api

# Step 4: Demote accidental primary back to replica
# On the node that was promoted:
pg_ctl stop -D /var/lib/postgresql/data
rm -f /var/lib/postgresql/data/standby.signal
pg_basebackup -h $ORIGINAL_PRIMARY -D /var/lib/postgresql/data -U replicator -P -R
pg_ctl start -D /var/lib/postgresql/data
```

---

## 2. Service Restart

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P2 - High |
| **Expected Duration** | 5-15 minutes |
| **Required Permissions** | DevOps, Platform Admin |
| **On-Call Escalation** | If restart fails after 2 attempts |

### 2.1 When to Restart

**Restart IS appropriate when:**
- Memory usage exceeds 90% and not recovering
- Application is unresponsive but infrastructure is healthy
- After deploying configuration changes that require restart
- Connection pool is corrupted
- Process is in deadlock state
- After security patch application

**Restart is NOT appropriate when:**
- Database is the root cause (fix database first)
- Network connectivity issues (fix network first)
- During active incident without understanding root cause
- High traffic period without load balancer draining

### 2.2 Graceful Shutdown Procedure

```bash
# Step 1: Check current service health
kubectl get pods -l app=skillsmith-api -o wide
curl -s http://localhost:3000/health | jq .

# Step 2: Enable maintenance mode (optional, for zero-downtime)
curl -X POST http://localhost:3000/admin/maintenance/enable \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"mode": "draining", "drain_timeout_seconds": 30}'

# Step 3: Check active connections before shutdown
curl -s http://localhost:3000/metrics | grep "active_connections"

# Step 4: Remove from load balancer (if not using Kubernetes)
# For AWS ALB:
aws elbv2 deregister-targets \
    --target-group-arn $TARGET_GROUP_ARN \
    --targets Id=$INSTANCE_ID

# Step 5: Wait for connections to drain (30-60 seconds)
sleep 30

# Step 6: Send SIGTERM for graceful shutdown
# The application should:
# - Stop accepting new requests
# - Complete in-flight requests (with timeout)
# - Close database connections
# - Flush logs and metrics

# For Docker:
docker stop --time=30 skillsmith-api

# For systemd:
sudo systemctl stop skillsmith-api

# For Kubernetes (handled automatically):
kubectl delete pod $POD_NAME --grace-period=30
```

### 2.3 Container/Process Restart Commands

#### Kubernetes Restart

```bash
# Restart single pod (will be recreated by deployment)
kubectl delete pod $POD_NAME -n skillsmith

# Rolling restart of entire deployment (zero-downtime)
kubectl rollout restart deployment/skillsmith-api -n skillsmith

# Watch rollout progress
kubectl rollout status deployment/skillsmith-api -n skillsmith

# Force restart all pods immediately (causes downtime)
kubectl delete pods -l app=skillsmith-api -n skillsmith

# Restart with resource update
kubectl set resources deployment/skillsmith-api \
    --limits=memory=2Gi,cpu=1000m \
    --requests=memory=1Gi,cpu=500m
```

#### Docker Compose Restart

```bash
# Graceful restart
docker-compose -f docker-compose.prod.yml restart api

# Stop, remove, and recreate
docker-compose -f docker-compose.prod.yml up -d --force-recreate api

# Restart with updated image
docker-compose -f docker-compose.prod.yml pull api
docker-compose -f docker-compose.prod.yml up -d api

# View logs during restart
docker-compose -f docker-compose.prod.yml logs -f api
```

#### Systemd Restart

```bash
# Graceful restart
sudo systemctl restart skillsmith-api

# Reload configuration without full restart (if supported)
sudo systemctl reload skillsmith-api

# Check status after restart
sudo systemctl status skillsmith-api

# View journal logs
sudo journalctl -u skillsmith-api -f --since "5 minutes ago"
```

#### PM2 Restart (Node.js)

```bash
# Graceful restart with 0-downtime
pm2 reload skillsmith-api

# Hard restart
pm2 restart skillsmith-api

# Restart with memory limit
pm2 restart skillsmith-api --max-memory-restart 1G

# View logs
pm2 logs skillsmith-api --lines 100
```

### 2.4 Health Verification

```bash
# Step 1: Wait for pod/container to be ready
kubectl wait --for=condition=ready pod -l app=skillsmith-api --timeout=120s

# Step 2: Check liveness probe
curl -s http://localhost:3000/health/live | jq .
# Expected: {"status": "ok"}

# Step 3: Check readiness probe
curl -s http://localhost:3000/health/ready | jq .
# Expected: {"status": "ok", "checks": {"database": "ok", "cache": "ok"}}

# Step 4: Check full health with dependencies
curl -s http://localhost:3000/health | jq .
# Expected:
# {
#   "status": "healthy",
#   "version": "1.2.3",
#   "uptime": 45,
#   "dependencies": {
#     "database": "connected",
#     "cache": "connected",
#     "queue": "connected"
#   }
# }

# Step 5: Run smoke tests
npm run test:smoke

# Step 6: Check metrics endpoint
curl -s http://localhost:3000/metrics | head -20

# Step 7: Verify in monitoring dashboard
# Check Grafana/DataDog for:
# - Request rate returning to normal
# - Error rate at baseline
# - Latency within SLA

# Step 8: Re-enable in load balancer
aws elbv2 register-targets \
    --target-group-arn $TARGET_GROUP_ARN \
    --targets Id=$INSTANCE_ID

# Step 9: Disable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance/disable \
    -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 2.5 Rollback Procedure

```bash
# If new deployment is failing, rollback to previous version

# Kubernetes rollback
kubectl rollout undo deployment/skillsmith-api -n skillsmith

# Rollback to specific revision
kubectl rollout history deployment/skillsmith-api -n skillsmith
kubectl rollout undo deployment/skillsmith-api --to-revision=3 -n skillsmith

# Docker rollback
docker-compose -f docker-compose.prod.yml stop api
docker tag skillsmith-api:latest skillsmith-api:failed
docker tag skillsmith-api:previous skillsmith-api:latest
docker-compose -f docker-compose.prod.yml up -d api

# Verify rollback
kubectl rollout status deployment/skillsmith-api -n skillsmith
curl -s http://localhost:3000/health | jq .version
```

---

## 3. Cache Invalidation

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P3 - Medium |
| **Expected Duration** | 5-30 minutes |
| **Required Permissions** | Developer, DevOps |
| **On-Call Escalation** | If cache clear causes performance issues |

### 3.1 Full Cache Clear

**When to perform full cache clear:**
- After major data migration
- When cache is corrupted
- After schema changes affecting cached data
- During security incident (credential rotation)

```bash
# Redis - Clear entire cache
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD FLUSHALL

# Redis - Clear specific database
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD -n 0 FLUSHDB

# Verify cache is empty
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD DBSIZE
# Expected: (integer) 0

# Application-level cache clear
curl -X POST http://localhost:3000/admin/cache/clear \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"scope": "all", "confirm": true}'

# CDN cache clear (Cloudflare example)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"purge_everything": true}'

# Varnish cache clear
varnishadm "ban req.url ~ ."
```

### 3.2 Selective Invalidation

```bash
# Clear by pattern (Redis)
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD --scan --pattern "skill:*" | xargs redis-cli DEL

# Clear specific keys
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD DEL "user:123:profile" "user:123:preferences"

# Clear by tag (if using tagged caching)
curl -X POST http://localhost:3000/admin/cache/invalidate \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"tags": ["user-profiles", "skills"]}'

# Clear specific entity
curl -X DELETE "http://localhost:3000/admin/cache/entity/skill/abc123" \
    -H "Authorization: Bearer $ADMIN_TOKEN"

# Clear user-specific cache
curl -X POST http://localhost:3000/admin/cache/invalidate \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"pattern": "user:*:session"}'

# CDN selective purge (Cloudflare)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"files": ["https://example.com/api/skills", "https://example.com/api/users"]}'

# Varnish selective invalidation
varnishadm "ban req.url ~ ^/api/skills"
```

### 3.3 Cache Warming Procedure

After cache invalidation, warm critical caches to prevent thundering herd:

```bash
# Step 1: Check current cache hit rate before warming
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD INFO stats | grep -E "keyspace_hits|keyspace_misses"

# Step 2: Run cache warming script
node scripts/cache-warm.js

# Cache warming script content:
cat > scripts/cache-warm.js << 'EOF'
const axios = require('axios');

const CRITICAL_ENDPOINTS = [
  '/api/skills/featured',
  '/api/categories',
  '/api/skills/popular',
  '/api/config/public',
];

const USERS_TO_WARM = ['user-1', 'user-2', 'user-3']; // Top active users

async function warmCache() {
  console.log('Starting cache warm-up...');

  // Warm public endpoints
  for (const endpoint of CRITICAL_ENDPOINTS) {
    try {
      await axios.get(`${process.env.API_URL}${endpoint}`);
      console.log(`Warmed: ${endpoint}`);
    } catch (err) {
      console.error(`Failed to warm: ${endpoint}`, err.message);
    }
    // Delay to prevent overwhelming the system
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Warm user-specific caches
  for (const userId of USERS_TO_WARM) {
    try {
      await axios.get(`${process.env.API_URL}/api/users/${userId}/recommendations`);
      console.log(`Warmed user: ${userId}`);
    } catch (err) {
      console.error(`Failed to warm user: ${userId}`, err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('Cache warm-up complete');
}

warmCache();
EOF

# Step 3: Alternative - Use curl for warming
for endpoint in "/api/skills/featured" "/api/categories" "/api/skills/popular"; do
    curl -s "http://localhost:3000${endpoint}" > /dev/null
    echo "Warmed: ${endpoint}"
    sleep 0.1
done

# Step 4: Verify cache is populated
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD DBSIZE
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD --scan --pattern "*" | head -20

# Step 5: Monitor hit rate after warming
watch -n 5 'redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD INFO stats | grep -E "keyspace_hits|keyspace_misses"'
```

### 3.4 Success Criteria

```bash
# Verify cache operations working
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD PING
# Expected: PONG

# Check cache size is appropriate
redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD INFO memory | grep used_memory_human

# Verify application cache health
curl -s http://localhost:3000/health/cache | jq .
# Expected:
# {
#   "status": "healthy",
#   "provider": "redis",
#   "connected": true,
#   "keys": 1523,
#   "memory_used": "45.2MB"
# }

# Check hit rate in metrics
curl -s http://localhost:3000/metrics | grep cache_hit_ratio
# Expected: cache_hit_ratio > 0.80

# Verify response times are acceptable
curl -w "\nTime: %{time_total}s\n" -s http://localhost:3000/api/skills/featured | tail -1
# Expected: < 100ms after cache is warm
```

### 3.5 Rollback Procedure

Cache invalidation is generally not reversible, but you can:

```bash
# If cache clear caused performance issues, immediately warm cache
node scripts/cache-warm.js --aggressive

# If Redis is having issues, failover to replica
redis-cli -h $REDIS_SENTINEL -p 26379 SENTINEL failover mymaster

# If CDN clear caused issues, update TTL to allow caching again
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/browser_cache_ttl" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -d '{"value": 14400}'

# Scale up application to handle cache misses
kubectl scale deployment/skillsmith-api --replicas=5
```

---

## 4. Performance Degradation Response

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P2-P3 (depends on impact) |
| **Expected Duration** | 15-60 minutes |
| **Required Permissions** | DevOps, Developer |
| **On-Call Escalation** | If SLA breach > 15 minutes |

### 4.1 Monitoring Indicators

**Alert Thresholds:**

| Metric | Warning | Critical |
|--------|---------|----------|
| P95 Latency | > 500ms | > 2000ms |
| Error Rate | > 1% | > 5% |
| CPU Usage | > 70% | > 90% |
| Memory Usage | > 75% | > 90% |
| DB Connection Pool | > 80% | > 95% |
| Request Queue Depth | > 100 | > 500 |

**Key Dashboards to Monitor:**
- Application Performance Dashboard
- Database Performance Dashboard
- Infrastructure Dashboard
- Error Tracking Dashboard

```bash
# Quick health check script
cat > scripts/perf-check.sh << 'EOF'
#!/bin/bash
echo "=== Performance Health Check ==="
echo ""
echo "API Response Time:"
curl -w "Total: %{time_total}s, Connect: %{time_connect}s, TTFB: %{time_starttransfer}s\n" \
    -s -o /dev/null http://localhost:3000/api/health

echo ""
echo "Database Latency:"
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME \
    -c "SELECT now() - pg_postmaster_start_time() as uptime;" 2>/dev/null

echo ""
echo "Cache Hit Rate:"
redis-cli -h $REDIS_HOST INFO stats 2>/dev/null | grep -E "keyspace_hits|keyspace_misses"

echo ""
echo "Active Connections:"
curl -s http://localhost:3000/metrics | grep -E "http_connections_active|db_pool_active"

echo ""
echo "Error Rate (last 5 min):"
curl -s http://localhost:3000/metrics | grep -E "http_requests_total.*status=\"5"
EOF
chmod +x scripts/perf-check.sh
```

### 4.2 Triage Process

```bash
# Step 1: Confirm the issue (rule out monitoring false positive)
for i in {1..3}; do
    curl -w "Response time: %{time_total}s\n" -s http://localhost:3000/api/health
    sleep 2
done

# Step 2: Check if issue is isolated or widespread
# Check multiple endpoints
curl -w "%{time_total}\n" -s http://localhost:3000/api/skills -o /dev/null
curl -w "%{time_total}\n" -s http://localhost:3000/api/users/me -o /dev/null
curl -w "%{time_total}\n" -s http://localhost:3000/api/health -o /dev/null

# Step 3: Identify the bottleneck layer
# Application layer
kubectl top pods -l app=skillsmith-api

# Database layer
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    state,
    count(*) as count,
    avg(extract(epoch from now() - query_start))::numeric(10,2) as avg_duration
FROM pg_stat_activity
WHERE state IS NOT NULL
GROUP BY state;
"

# Cache layer
redis-cli -h $REDIS_HOST INFO | grep -E "connected_clients|blocked_clients|used_memory"

# Network layer
kubectl exec -it $(kubectl get pod -l app=skillsmith-api -o jsonpath='{.items[0].metadata.name}') -- \
    curl -w "DNS: %{time_namelookup}, Connect: %{time_connect}, Total: %{time_total}\n" \
    -s -o /dev/null http://database-service:5432

# Step 4: Check for recent changes
git log --oneline -10
kubectl rollout history deployment/skillsmith-api
```

### 4.3 Common Causes and Fixes

#### 4.3.1 Slow Database Queries

```bash
# Identify slow queries
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    query,
    calls,
    mean_exec_time::numeric(10,2) as avg_ms,
    total_exec_time::numeric(10,2) as total_ms
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
"

# Fix: Add missing index
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
CREATE INDEX CONCURRENTLY idx_skills_category ON skills(category_id);
"

# Fix: Kill long-running query
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE query_start < now() - interval '5 minutes'
AND state = 'active';
"

# Fix: Increase connection pool
kubectl set env deployment/skillsmith-api DB_POOL_SIZE=50
kubectl rollout restart deployment/skillsmith-api
```

#### 4.3.2 Memory Pressure

```bash
# Check memory usage
kubectl top pods -l app=skillsmith-api --containers

# Check for memory leaks (Node.js)
kubectl exec -it $POD_NAME -- node --expose-gc -e "
const used = process.memoryUsage();
console.log('Memory:', JSON.stringify(used, null, 2));
"

# Fix: Restart pod to clear memory
kubectl delete pod $POD_NAME

# Fix: Increase memory limits
kubectl set resources deployment/skillsmith-api \
    --limits=memory=4Gi \
    --requests=memory=2Gi

# Fix: Enable memory limit restart
kubectl set env deployment/skillsmith-api NODE_OPTIONS="--max-old-space-size=3072"
```

#### 4.3.3 CPU Saturation

```bash
# Check CPU usage
kubectl top pods -l app=skillsmith-api

# Check for CPU-intensive operations
kubectl exec -it $POD_NAME -- top -b -n1 | head -20

# Fix: Scale horizontally
kubectl scale deployment/skillsmith-api --replicas=5

# Fix: Add CPU limits
kubectl set resources deployment/skillsmith-api \
    --limits=cpu=2000m \
    --requests=cpu=1000m
```

#### 4.3.4 Cache Misses

```bash
# Check cache hit rate
redis-cli -h $REDIS_HOST INFO stats | grep keyspace

# Fix: Warm cache
node scripts/cache-warm.js

# Fix: Increase cache size
redis-cli -h $REDIS_HOST CONFIG SET maxmemory 2gb

# Fix: Adjust TTL
curl -X POST http://localhost:3000/admin/cache/config \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"default_ttl": 3600}'
```

#### 4.3.5 External Service Latency

```bash
# Check external service response times
curl -w "Total: %{time_total}s\n" -s https://external-api.example.com/health

# Fix: Enable circuit breaker
kubectl set env deployment/skillsmith-api \
    CIRCUIT_BREAKER_ENABLED=true \
    CIRCUIT_BREAKER_THRESHOLD=5 \
    CIRCUIT_BREAKER_TIMEOUT=30000

# Fix: Use cached fallback
kubectl set env deployment/skillsmith-api \
    EXTERNAL_API_FALLBACK_ENABLED=true
```

### 4.4 Escalation Path

| Time Elapsed | Action |
|--------------|--------|
| 0-5 min | On-call engineer investigates |
| 5-15 min | Apply quick fixes (scaling, cache clear) |
| 15-30 min | Escalate to secondary on-call |
| 30-60 min | Page team lead, consider rollback |
| 60+ min | Incident commander, stakeholder notification |

```bash
# Escalation commands
# Page secondary on-call
pagerduty trigger --service skillsmith-api --severity high \
    --description "Performance degradation persisting >15 min"

# Create incident channel
slack create-channel --name "inc-perf-$(date +%Y%m%d)" \
    --invite @oncall @platform-team

# Send stakeholder notification
curl -X POST $SLACK_WEBHOOK -d '{
    "channel": "#incidents",
    "text": ":warning: Performance Degradation - SkillSmith API\nP95 Latency: 2.5s (SLA: 500ms)\nStatus: Investigating\nETA: 30 minutes"
}'
```

### 4.5 Success Criteria

```bash
# Verify performance is restored
for i in {1..10}; do
    curl -w "%{time_total}\n" -s http://localhost:3000/api/health -o /dev/null
    sleep 1
done | awk '{sum+=$1} END {print "Average: " sum/NR "s"}'
# Expected: < 0.2s

# Check error rate
curl -s http://localhost:3000/metrics | grep http_requests_total | grep 'status="5'
# Expected: < 1% of total requests

# Verify in monitoring
# P95 latency < 500ms
# Error rate < 1%
# CPU usage < 70%
# Memory usage < 75%
```

---

## 5. Security Incident Response

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P1 - Critical |
| **Expected Duration** | 1-4 hours (initial containment) |
| **Required Permissions** | Security Team, Platform Admin |
| **On-Call Escalation** | Immediate |

### 5.1 Detection

**Automated Detection Sources:**
- WAF alerts (suspicious request patterns)
- Failed authentication spikes
- Anomalous API usage patterns
- File integrity monitoring alerts
- Network intrusion detection
- Dependency vulnerability alerts

**Manual Detection Indicators:**
- User reports of unauthorized access
- Unexpected data modifications
- Unknown processes running
- Unusual network traffic

```bash
# Quick security health check
cat > scripts/security-check.sh << 'EOF'
#!/bin/bash
echo "=== Security Health Check ==="

echo -e "\n[1] Failed Login Attempts (last hour):"
grep "authentication failed" /var/log/skillsmith/auth.log | \
    awk -v d="$(date -d '1 hour ago' '+%Y-%m-%d %H:')" '$0 > d' | wc -l

echo -e "\n[2] Suspicious IP Activity:"
grep -E "blocked|banned" /var/log/nginx/access.log | tail -10

echo -e "\n[3] Recent Privilege Escalations:"
grep -E "role.*admin|permission.*granted" /var/log/skillsmith/audit.log | tail -5

echo -e "\n[4] Unusual Outbound Connections:"
netstat -an | grep ESTABLISHED | grep -v -E ":(443|80|5432|6379)\s" | head -10

echo -e "\n[5] Modified Configuration Files (last 24h):"
find /etc -type f -mtime -1 2>/dev/null | head -10

echo -e "\n[6] Running Processes by Unknown Users:"
ps aux | grep -v -E "^(root|www-data|postgres|redis|node)" | grep -v "^USER" | head -10
EOF
chmod +x scripts/security-check.sh
```

### 5.2 Containment

**Immediate Actions (within 15 minutes):**

```bash
# Step 1: Assess severity and notify
# Notify security team immediately
curl -X POST $SECURITY_SLACK_WEBHOOK -d '{
    "text": ":rotating_light: SECURITY INCIDENT DETECTED\nType: [INCIDENT_TYPE]\nSeverity: [P1/P2/P3]\nStatus: Containment in progress"
}'

# Step 2: Preserve evidence BEFORE making changes
# Capture current state
mkdir -p /tmp/incident-$(date +%Y%m%d-%H%M%S)
INCIDENT_DIR="/tmp/incident-$(date +%Y%m%d-%H%M%S)"

# Capture running processes
ps auxwww > "$INCIDENT_DIR/processes.txt"

# Capture network connections
netstat -an > "$INCIDENT_DIR/network.txt"
ss -tunapl > "$INCIDENT_DIR/sockets.txt"

# Capture recent logs
cp /var/log/skillsmith/*.log "$INCIDENT_DIR/"
kubectl logs deployment/skillsmith-api --since=1h > "$INCIDENT_DIR/app-logs.txt"

# Capture database connections
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c \
    "SELECT * FROM pg_stat_activity;" > "$INCIDENT_DIR/db-connections.txt"

# Step 3: Isolate affected systems
# Block suspicious IPs at WAF/firewall level
# Example with iptables:
iptables -A INPUT -s $SUSPICIOUS_IP -j DROP

# Example with AWS WAF:
aws wafv2 update-ip-set \
    --name blocked-ips \
    --scope REGIONAL \
    --addresses "$SUSPICIOUS_IP/32" \
    --lock-token "$LOCK_TOKEN"

# Step 4: Disable compromised accounts
curl -X POST http://localhost:3000/admin/users/$USER_ID/disable \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"reason": "Security incident", "preserve_data": true}'

# Step 5: Revoke compromised tokens/sessions
curl -X POST http://localhost:3000/admin/sessions/revoke-all \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"user_id": "compromised-user-id"}'

# Redis: Clear all sessions for user
redis-cli -h $REDIS_HOST KEYS "session:$USER_ID:*" | xargs redis-cli DEL

# Step 6: Rotate potentially compromised secrets
# Rotate API keys
curl -X POST http://localhost:3000/admin/api-keys/rotate \
    -H "Authorization: Bearer $ADMIN_TOKEN"

# Rotate database credentials (if compromised)
psql -h $DATABASE_HOST -U postgres -c \
    "ALTER USER app_user WITH PASSWORD 'new_secure_password';"

# Update application configuration
kubectl set env deployment/skillsmith-api \
    DATABASE_PASSWORD="new_secure_password"

# Step 7: Enable enhanced logging/monitoring
kubectl set env deployment/skillsmith-api \
    LOG_LEVEL=debug \
    AUDIT_LOG_ENABLED=true \
    SECURITY_MONITORING=enhanced
```

### 5.3 Investigation

```bash
# Step 1: Establish incident timeline
# Check authentication logs
grep -E "login|auth|session" /var/log/skillsmith/auth.log | \
    grep "$SUSPICIOUS_USER" | sort

# Check API access patterns
grep "$SUSPICIOUS_IP" /var/log/nginx/access.log | \
    awk '{print $4, $7, $9}' | sort | uniq -c | sort -rn | head -20

# Step 2: Identify scope of access
# What data was accessed?
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    table_name,
    operation,
    user_id,
    timestamp,
    affected_rows
FROM audit_log
WHERE user_id = '$COMPROMISED_USER_ID'
AND timestamp > now() - interval '24 hours'
ORDER BY timestamp;
"

# What endpoints were accessed?
grep "$SESSION_TOKEN" /var/log/skillsmith/access.log | \
    awk '{print $6, $7}' | sort | uniq -c | sort -rn

# Step 3: Check for persistence mechanisms
# Look for unauthorized SSH keys
find /home -name authorized_keys -exec cat {} \;

# Check cron jobs
for user in $(cut -f1 -d: /etc/passwd); do
    crontab -l -u $user 2>/dev/null
done

# Check systemd services
systemctl list-units --type=service --state=running | grep -v -E "^(system|user)"

# Check for modified binaries
debsums -c 2>/dev/null | head -20

# Step 4: Analyze malicious activity
# Extract suspicious requests
grep -E "(SELECT.*FROM|DROP|DELETE|UNION|script>|onclick)" /var/log/nginx/access.log

# Check for data exfiltration
# Large response sizes
awk '$10 > 1000000 {print $4, $7, $10}' /var/log/nginx/access.log | head -20

# Step 5: Document findings
cat > "$INCIDENT_DIR/investigation-notes.md" << 'EOF'
# Security Incident Investigation Notes

## Timeline
- [TIME] - Initial detection
- [TIME] - Containment started
- [TIME] - Investigation began

## Indicators of Compromise (IOCs)
- IP Addresses:
- User Agents:
- File Hashes:
- URLs:

## Affected Systems
- [ ] Application servers
- [ ] Database
- [ ] Cache
- [ ] User accounts

## Data Impact
- Records accessed:
- Records modified:
- Records exfiltrated:

## Root Cause
[To be determined]

## Recommendations
[To be added]
EOF
```

### 5.4 Recovery

```bash
# Step 1: Verify containment is complete
# Check no active malicious sessions
redis-cli -h $REDIS_HOST KEYS "session:*" | wc -l

# Verify suspicious IPs are blocked
iptables -L INPUT -n | grep $SUSPICIOUS_IP

# Step 2: Clean up compromised systems
# Remove unauthorized access
# Remove suspicious files
find /tmp -type f -mmin -60 -name "*.sh" -exec rm -v {} \;

# Reset modified configurations
git checkout -- config/
kubectl apply -f kubernetes/configmaps/

# Step 3: Patch vulnerability (if applicable)
# Update dependencies
npm audit fix --force

# Apply security patches
apt-get update && apt-get upgrade -y

# Rebuild and redeploy
docker build -t skillsmith-api:patched .
kubectl set image deployment/skillsmith-api api=skillsmith-api:patched

# Step 4: Restore from clean backup (if needed)
# See Section 6: Backup and Restore

# Step 5: Re-enable services gradually
# Remove from maintenance mode
curl -X POST http://localhost:3000/admin/maintenance/disable \
    -H "Authorization: Bearer $ADMIN_TOKEN"

# Monitor closely
watch -n 5 'curl -s http://localhost:3000/health | jq .'

# Step 6: Force password reset for affected users
curl -X POST http://localhost:3000/admin/users/force-password-reset \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"user_ids": ["user-1", "user-2"], "notify": true}'
```

### 5.5 Communication Template

```markdown
# Internal Communication (Immediate)

**To:** Security Team, Engineering Leadership, Legal
**Subject:** [SEVERITY] Security Incident - [BRIEF DESCRIPTION]

## Summary
A security incident was detected at [TIME] on [DATE].

## Current Status
- **Status:** [Detected/Contained/Investigating/Recovered]
- **Severity:** [P1/P2/P3]
- **Incident Commander:** [NAME]

## Impact Assessment
- **Systems Affected:** [LIST]
- **Data Impact:** [DESCRIPTION]
- **User Impact:** [NUMBER] users potentially affected

## Actions Taken
1. [ACTION 1]
2. [ACTION 2]
3. [ACTION 3]

## Next Steps
1. [NEXT STEP 1]
2. [NEXT STEP 2]

## Timeline
- HH:MM - Incident detected
- HH:MM - Containment initiated
- HH:MM - [CURRENT STATUS]

---

# External Communication (If Required)

**To:** Affected Users
**Subject:** Important Security Notice from SkillSmith

Dear [USER],

We are writing to inform you of a security incident that may have affected your account.

## What Happened
On [DATE], we detected unauthorized access to [DESCRIPTION].

## What Information Was Involved
[DESCRIPTION OF DATA]

## What We Are Doing
We have taken immediate steps to:
- [ACTION 1]
- [ACTION 2]
- [ACTION 3]

## What You Can Do
We recommend that you:
1. Change your password immediately
2. Review your recent account activity
3. Enable two-factor authentication if not already enabled

## Contact Us
If you have questions, please contact our security team at security@skillsmith.io.

We apologize for any inconvenience and are committed to protecting your information.

Sincerely,
The SkillSmith Security Team
```

### 5.6 Post-Incident Tasks

```bash
# 1. Preserve all evidence
tar -czvf "incident-$(date +%Y%m%d).tar.gz" "$INCIDENT_DIR"
aws s3 cp "incident-$(date +%Y%m%d).tar.gz" s3://security-incidents/

# 2. Conduct post-mortem (within 72 hours)
cat > post-mortem-template.md << 'EOF'
# Security Incident Post-Mortem

**Date:** [DATE]
**Severity:** [P1/P2/P3]
**Duration:** [START] - [END]

## Executive Summary
[2-3 sentence summary]

## Timeline
| Time | Event |
|------|-------|
| | |

## Root Cause Analysis
### What happened?
### Why did it happen?
### How was it detected?

## Impact
- Users affected:
- Data compromised:
- Downtime:

## Response Evaluation
### What went well?
### What could be improved?

## Action Items
| Priority | Action | Owner | Due Date | Status |
|----------|--------|-------|----------|--------|
| | | | | |

## Lessons Learned
1.
2.
3.
EOF

# 3. Update security controls
# Review and update WAF rules
# Update IDS/IPS signatures
# Review access controls

# 4. Update runbooks with lessons learned

# 5. Schedule security training if needed

# 6. Regulatory notifications (if required)
# GDPR: 72 hours for significant breaches
# CCPA: "Expedient" notification
# Check other applicable regulations
```

---

## 6. Backup and Restore

### Overview

| Attribute | Value |
|-----------|-------|
| **Severity Level** | P2-P3 (depending on situation) |
| **Expected Duration** | 30 min - 4 hours |
| **Required Permissions** | Database Admin, Infrastructure Admin |
| **On-Call Escalation** | If restore fails or data loss confirmed |

### 6.1 Backup Verification

**Regular Verification Schedule:**
- Daily: Verify backup completion
- Weekly: Test restore to non-production
- Monthly: Full disaster recovery drill

```bash
# Step 1: Verify backup exists
# List recent backups
aws s3 ls s3://skillsmith-backups/database/ --recursive | tail -10

# Check backup metadata
aws s3api head-object \
    --bucket skillsmith-backups \
    --key "database/daily/backup-$(date +%Y%m%d).sql.gz"

# Step 2: Verify backup integrity
# Download and verify checksum
aws s3 cp s3://skillsmith-backups/database/daily/backup-latest.sql.gz /tmp/
aws s3 cp s3://skillsmith-backups/database/daily/backup-latest.sql.gz.sha256 /tmp/
sha256sum -c /tmp/backup-latest.sql.gz.sha256

# Verify file is not corrupted
gunzip -t /tmp/backup-latest.sql.gz && echo "Backup is valid"

# Step 3: Verify backup contains expected data
# Extract and check table counts
gunzip -c /tmp/backup-latest.sql.gz | grep "COPY.*FROM stdin" | wc -l

# Check for critical tables
gunzip -c /tmp/backup-latest.sql.gz | grep -E "^COPY (users|skills|transactions)" | head -10

# Step 4: Test restore to staging
# Create test database
psql -h $STAGING_DB_HOST -U postgres -c "CREATE DATABASE restore_test;"

# Restore backup
gunzip -c /tmp/backup-latest.sql.gz | \
    psql -h $STAGING_DB_HOST -U postgres -d restore_test

# Verify restore
psql -h $STAGING_DB_HOST -U postgres -d restore_test -c "
SELECT
    schemaname,
    tablename,
    n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
"

# Cleanup
psql -h $STAGING_DB_HOST -U postgres -c "DROP DATABASE restore_test;"
```

### 6.2 Point-in-Time Recovery

For PostgreSQL with continuous archiving:

```bash
# Step 1: Identify recovery target time
# Find the exact moment before data corruption/loss
grep -E "DROP|DELETE|TRUNCATE" /var/log/postgresql/postgresql-*.log | tail -20

# Or find transaction timestamp
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT xact_start, query
FROM pg_stat_activity
WHERE query ILIKE '%DELETE%' OR query ILIKE '%DROP%'
ORDER BY xact_start DESC
LIMIT 10;
"

# Step 2: Stop the database (if recovering to same server)
sudo systemctl stop postgresql

# Step 3: Backup current data directory
sudo mv /var/lib/postgresql/15/main /var/lib/postgresql/15/main.corrupted

# Step 4: Restore base backup
sudo mkdir /var/lib/postgresql/15/main
sudo tar -xzf /backups/base/base_latest.tar.gz -C /var/lib/postgresql/15/main

# Step 5: Create recovery configuration
cat > /var/lib/postgresql/15/main/recovery.signal << EOF
EOF

cat >> /var/lib/postgresql/15/main/postgresql.auto.conf << EOF
restore_command = 'aws s3 cp s3://skillsmith-wal-archive/%f %p'
recovery_target_time = '2025-01-02 14:30:00 UTC'
recovery_target_action = 'promote'
EOF

# Step 6: Set correct permissions
sudo chown -R postgres:postgres /var/lib/postgresql/15/main

# Step 7: Start PostgreSQL and wait for recovery
sudo systemctl start postgresql
sudo -u postgres tail -f /var/log/postgresql/postgresql-15-main.log

# Step 8: Verify recovery completed
psql -h localhost -U $DATABASE_USER -d $DATABASE_NAME -c "SELECT pg_is_in_recovery();"
# Should return: f (false, meaning recovery is complete)

# Step 9: Verify data integrity
psql -h localhost -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT COUNT(*) as users FROM users;
SELECT COUNT(*) as skills FROM skills;
SELECT MAX(created_at) as latest_record FROM users;
"
```

### 6.3 Full Database Restore

```bash
# Step 1: Notify stakeholders
curl -X POST $SLACK_WEBHOOK -d '{
    "text": ":warning: Database Restore In Progress\nExpected Duration: 1-2 hours\nImpact: Service will be in read-only mode"
}'

# Step 2: Enable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance/enable \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"mode": "read-only", "message": "Database maintenance in progress"}'

# Step 3: Stop application writes
kubectl scale deployment/skillsmith-api --replicas=0

# Step 4: Download latest backup
aws s3 cp s3://skillsmith-backups/database/full/backup-latest.sql.gz /tmp/

# Step 5: Verify backup
gunzip -t /tmp/backup-latest.sql.gz
sha256sum /tmp/backup-latest.sql.gz

# Step 6: Create backup of current state (safety)
pg_dump -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME | \
    gzip > /tmp/pre-restore-backup-$(date +%Y%m%d-%H%M%S).sql.gz

# Step 7: Drop and recreate database
psql -h $DATABASE_HOST -U postgres << EOF
-- Terminate all connections
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$DATABASE_NAME' AND pid <> pg_backend_pid();

-- Drop database
DROP DATABASE IF EXISTS $DATABASE_NAME;

-- Create fresh database
CREATE DATABASE $DATABASE_NAME OWNER $DATABASE_USER;
EOF

# Step 8: Restore from backup
gunzip -c /tmp/backup-latest.sql.gz | \
    psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME

# Alternative: Parallel restore for large databases
pg_restore -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME \
    -j 4 --no-owner --no-privileges /tmp/backup-latest.dump

# Step 9: Run post-restore migrations (if needed)
npm run db:migrate

# Step 10: Verify restore
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    'users' as table_name, COUNT(*) as count FROM users
UNION ALL
SELECT 'skills', COUNT(*) FROM skills
UNION ALL
SELECT 'transactions', COUNT(*) FROM transactions;
"

# Step 11: Restart application
kubectl scale deployment/skillsmith-api --replicas=3
kubectl rollout status deployment/skillsmith-api

# Step 12: Disable maintenance mode
curl -X POST http://localhost:3000/admin/maintenance/disable \
    -H "Authorization: Bearer $ADMIN_TOKEN"

# Step 13: Verify application health
curl -s http://localhost:3000/health | jq .

# Step 14: Notify stakeholders
curl -X POST $SLACK_WEBHOOK -d '{
    "text": ":white_check_mark: Database Restore Complete\nAll systems operational"
}'
```

### 6.4 Data Integrity Verification

```bash
# Step 1: Verify row counts match expectations
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    schemaname,
    relname as table_name,
    n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
"

# Step 2: Verify foreign key integrity
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
-- Check for orphaned records
SELECT 'skills without users' as check_name, COUNT(*) as orphan_count
FROM skills s
LEFT JOIN users u ON s.user_id = u.id
WHERE u.id IS NULL

UNION ALL

SELECT 'transactions without users', COUNT(*)
FROM transactions t
LEFT JOIN users u ON t.user_id = u.id
WHERE u.id IS NULL;
"

# Step 3: Verify data checksums (if stored)
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    table_name,
    stored_checksum,
    md5(string_agg(row_data::text, ''))::text as current_checksum,
    stored_checksum = md5(string_agg(row_data::text, ''))::text as matches
FROM data_checksums
JOIN (SELECT tableoid::regclass as table_name, * FROM users) subq
    ON data_checksums.table_name = subq.table_name::text
GROUP BY data_checksums.table_name, stored_checksum;
"

# Step 4: Run application integrity checks
curl -X POST http://localhost:3000/admin/data/integrity-check \
    -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Step 5: Verify recent data exists
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT
    'users' as table_name,
    MAX(created_at) as latest_record,
    MAX(updated_at) as latest_update
FROM users
UNION ALL
SELECT 'skills', MAX(created_at), MAX(updated_at) FROM skills
UNION ALL
SELECT 'transactions', MAX(created_at), MAX(updated_at) FROM transactions;
"

# Step 6: Run data validation queries
npm run db:validate

# Step 7: Compare with pre-incident snapshot (if available)
diff <(psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
    SELECT COUNT(*) as users FROM users;
    SELECT COUNT(*) as skills FROM skills;
" -t) /tmp/pre-incident-counts.txt
```

### 6.5 Backup Types and Schedules

| Backup Type | Frequency | Retention | Location |
|-------------|-----------|-----------|----------|
| Full Database | Daily (2 AM UTC) | 30 days | S3: `skillsmith-backups/database/daily/` |
| Transaction Logs (WAL) | Continuous | 7 days | S3: `skillsmith-wal-archive/` |
| Weekly Full | Sunday (3 AM UTC) | 90 days | S3: `skillsmith-backups/database/weekly/` |
| Monthly Archive | 1st of month | 1 year | S3: `skillsmith-backups/database/monthly/` |
| Configuration | On change | 90 days | S3: `skillsmith-backups/config/` |
| Secrets (encrypted) | Daily | 30 days | Vault + S3 |

```bash
# Backup commands for reference

# Manual full backup
pg_dump -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME \
    --format=custom --compress=9 --file=/tmp/backup-manual.dump

# Upload to S3
aws s3 cp /tmp/backup-manual.dump \
    s3://skillsmith-backups/database/manual/backup-$(date +%Y%m%d-%H%M%S).dump

# Backup verification cron job
cat > /etc/cron.d/backup-verify << 'EOF'
0 6 * * * root /opt/scripts/verify-backup.sh >> /var/log/backup-verify.log 2>&1
EOF
```

### 6.6 Rollback Procedure

If the restore causes issues:

```bash
# Step 1: Stop application
kubectl scale deployment/skillsmith-api --replicas=0

# Step 2: Restore from pre-restore backup
gunzip -c /tmp/pre-restore-backup-*.sql.gz | \
    psql -h $DATABASE_HOST -U postgres -d $DATABASE_NAME

# Step 3: Verify rollback
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -c "
SELECT COUNT(*) as users FROM users;
SELECT MAX(created_at) as latest FROM users;
"

# Step 4: Restart application
kubectl scale deployment/skillsmith-api --replicas=3

# Step 5: Analyze why restore failed
# Check restore logs
# Verify backup file integrity
# Check for schema mismatches
```

### 6.7 Success Criteria

| Check | Expected Result |
|-------|-----------------|
| Database accepts connections | `pg_isready` returns 0 |
| Row counts match backup | Within 0.1% of backup manifest |
| Application health check passes | `/health` returns 200 |
| No foreign key violations | 0 orphan records |
| Latest timestamp reasonable | Within backup window |
| Smoke tests pass | All critical paths working |
| No error spikes in logs | Error rate < baseline |

```bash
# Run comprehensive verification
cat > scripts/verify-restore.sh << 'EOF'
#!/bin/bash
set -e

echo "Running restore verification..."

# Check 1: Database connection
pg_isready -h $DATABASE_HOST -p 5432 || exit 1
echo "✓ Database accepting connections"

# Check 2: Row counts
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME -t -c \
    "SELECT COUNT(*) FROM users" | tr -d ' '
echo "✓ Users table accessible"

# Check 3: Application health
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
[ "$HTTP_STATUS" = "200" ] || exit 1
echo "✓ Application health check passed"

# Check 4: Smoke tests
npm run test:smoke || exit 1
echo "✓ Smoke tests passed"

echo ""
echo "All restore verification checks passed!"
EOF
chmod +x scripts/verify-restore.sh
```

---

## Appendix A: Contact Information

| Role | Contact | Escalation Time |
|------|---------|-----------------|
| On-Call Engineer | PagerDuty | Immediate |
| Platform Team Lead | @platform-lead | 15 min |
| Security Team | @security | Immediate for P1 |
| Database Admin | @dba-team | 15 min |
| VP Engineering | @vp-eng | 30 min for P1 |

## Appendix B: Useful Commands Reference

```bash
# Quick diagnostic commands
alias k='kubectl'
alias kgp='kubectl get pods'
alias klogs='kubectl logs -f'
alias psql-prod='psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME'
alias redis-prod='redis-cli -h $REDIS_HOST -a $REDIS_PASSWORD'

# Health check all services
check-all() {
    echo "API: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health)"
    echo "DB: $(pg_isready -h $DATABASE_HOST && echo 'OK' || echo 'FAIL')"
    echo "Redis: $(redis-cli -h $REDIS_HOST PING 2>/dev/null || echo 'FAIL')"
}

# Quick pod restart
restart-api() {
    kubectl rollout restart deployment/skillsmith-api
    kubectl rollout status deployment/skillsmith-api
}

# Tail all logs
tail-all() {
    kubectl logs -f -l app=skillsmith-api --all-containers --prefix
}
```

## Appendix C: Runbook Maintenance

- **Review Schedule:** Quarterly
- **Last Review:** January 2, 2026
- **Next Review:** April 2026
- **Owner:** Platform Engineering Team

When updating this runbook:
1. Test all commands in staging
2. Update version dates
3. Add new lessons learned
4. Review escalation paths
5. Validate contact information
