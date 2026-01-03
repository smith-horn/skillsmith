# Skillsmith Production Deployment Guide

This guide covers production deployment of Skillsmith, including system requirements, installation, configuration, and operational procedures.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Database Setup](#database-setup)
5. [Backup Procedures](#backup-procedures)
6. [Upgrade Process](#upgrade-process)
7. [Health Checks](#health-checks)
8. [Logging Configuration](#logging-configuration)
9. [Troubleshooting](#troubleshooting)
10. [Security Considerations](#security-considerations)

---

## System Requirements

### Hardware Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 2 GB | 4+ GB |
| Disk | 10 GB | 50+ GB (SSD recommended) |
| Network | 100 Mbps | 1 Gbps |

### Software Requirements

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 22.0.0+ | Runtime environment |
| npm | 10.0.0+ | Package management |
| Docker | 24.0.0+ | Container runtime (recommended) |
| Docker Compose | 2.20.0+ | Container orchestration |

### Operating System

- **Linux**: Debian 12+, Ubuntu 22.04+, RHEL 9+, Alpine 3.18+
- **macOS**: 13.0+ (Ventura) - development only
- **Windows**: WSL2 with Docker Desktop - development only

> **Note**: Production deployments should use Linux for best performance and compatibility with native modules (better-sqlite3, onnxruntime-node).

---

## Installation

### Option 1: Docker Deployment (Recommended)

Docker is the recommended deployment method as it handles native module compilation and provides consistent environments.

#### 1. Clone the Repository

```bash
git clone https://github.com/Smith-Horn-Group/skillsmith.git
cd skillsmith
```

#### 2. Build Production Image

```bash
# Build the production Docker image
docker build --target prod -t skillsmith:latest .
```

#### 3. Run with Docker Compose

Create a `docker-compose.production.yml`:

```yaml
services:
  skillsmith:
    image: skillsmith:latest
    container_name: skillsmith-prod
    restart: unless-stopped
    ports:
      - '3001:3001'
    volumes:
      - skillsmith-data:/app/data
      - skillsmith-logs:/app/logs
    environment:
      - NODE_ENV=production
      - SKILLSMITH_DB_PATH=/app/data/skills.db
      - LOG_LEVEL=info
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:3001/health')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  skillsmith-data:
  skillsmith-logs:
```

```bash
docker compose -f docker-compose.production.yml up -d
```

### Option 2: npm Installation

For environments where Docker is not available:

#### 1. Install Dependencies

```bash
# Install system dependencies (Debian/Ubuntu)
sudo apt-get update
sudo apt-get install -y python3 make g++ git

# Install Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### 2. Install Skillsmith

```bash
# Clone and install
git clone https://github.com/Smith-Horn-Group/skillsmith.git
cd skillsmith
npm ci --production

# Build packages
npm run build
```

#### 3. Run the MCP Server

```bash
# Start the MCP server
node packages/mcp-server/dist/index.js
```

### Option 3: npx (Quick Start)

For Claude Code integration without local installation:

```bash
npx @skillsmith/mcp-server
```

Add to Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`) |
| `SKILLSMITH_DB_PATH` | No | `~/.skillsmith/skills.db` | SQLite database file path |
| `SKILLSMITH_CACHE_DIR` | No | `~/.skillsmith/cache` | Cache directory path |
| `SKILLSMITH_LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `SKILLSMITH_USE_MOCK_EMBEDDINGS` | No | `false` | Use mock embeddings (for testing) |
| `GITHUB_TOKEN` | No | - | GitHub API token for repository indexing |
| `DEV_PORT` | No | `3001` | Development server port |

### Configuration File

Create `.env` in the project root:

```bash
# Production environment
NODE_ENV=production

# Database configuration
SKILLSMITH_DB_PATH=/var/lib/skillsmith/skills.db

# Cache configuration
SKILLSMITH_CACHE_DIR=/var/cache/skillsmith

# Logging
SKILLSMITH_LOG_LEVEL=info

# GitHub integration (optional)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### Directory Structure

```
/var/lib/skillsmith/          # Data directory
  skills.db                   # SQLite database
  skills.db-wal               # WAL file (auto-created)
  skills.db-shm               # Shared memory (auto-created)

/var/cache/skillsmith/        # Cache directory
  embeddings/                 # Embedding cache
  search/                     # Search result cache

/var/log/skillsmith/          # Log directory
  skillsmith.log              # Application logs
  error.log                   # Error logs
```

### Permissions

```bash
# Create directories with proper permissions
sudo mkdir -p /var/lib/skillsmith /var/cache/skillsmith /var/log/skillsmith
sudo chown -R skillsmith:skillsmith /var/lib/skillsmith /var/cache/skillsmith /var/log/skillsmith
sudo chmod 750 /var/lib/skillsmith /var/cache/skillsmith /var/log/skillsmith
```

---

## Database Setup

### SQLite with WAL Mode

Skillsmith uses SQLite with Write-Ahead Logging (WAL) mode for optimal performance.

#### Automatic Initialization

The database is automatically initialized when the application starts:

```javascript
// Default database path
const dbPath = process.env.SKILLSMITH_DB_PATH || '~/.skillsmith/skills.db'
```

#### Manual Initialization

```bash
# Create database directory
mkdir -p ~/.skillsmith

# Initialize with seed data (development)
npm run seed

# Clear and reinitialize
npm run seed:clear
```

### Database Schema

The schema includes:

- **skills**: Main skill storage with metadata
- **skills_fts**: FTS5 virtual table for full-text search
- **sources**: Tracks skill discovery sources
- **categories**: Hierarchical skill organization
- **cache**: Search result and API response caching
- **audit_logs**: Security audit trail

### WAL Mode Configuration

WAL mode is configured automatically:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;  -- 64MB cache
PRAGMA temp_store = MEMORY;
```

### Performance Tuning

For high-load environments:

```sql
-- Increase cache size for better read performance
PRAGMA cache_size = -128000;  -- 128MB

-- Optimize for SSDs
PRAGMA page_size = 4096;

-- Checkpoint WAL more frequently
PRAGMA wal_autocheckpoint = 1000;
```

### Database Maintenance

```bash
# Optimize database (run periodically)
sqlite3 /var/lib/skillsmith/skills.db "PRAGMA optimize;"

# Vacuum to reclaim space (run during low-traffic periods)
sqlite3 /var/lib/skillsmith/skills.db "VACUUM;"

# Check integrity
sqlite3 /var/lib/skillsmith/skills.db "PRAGMA integrity_check;"
```

---

## Backup Procedures

### Automated Backups

#### Backup Script

Create `/usr/local/bin/skillsmith-backup.sh`:

```bash
#!/bin/bash
set -e

# Configuration
DB_PATH="${SKILLSMITH_DB_PATH:-/var/lib/skillsmith/skills.db}"
BACKUP_DIR="${SKILLSMITH_BACKUP_DIR:-/var/backups/skillsmith}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/skills_${TIMESTAMP}.db"

# Checkpoint WAL before backup
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"

# Create backup using SQLite backup API
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress backup
gzip "$BACKUP_FILE"

# Remove old backups
find "$BACKUP_DIR" -name "skills_*.db.gz" -mtime +$RETENTION_DAYS -delete

# Log backup completion
echo "[$(date -Iseconds)] Backup completed: ${BACKUP_FILE}.gz"
```

#### Cron Schedule

```bash
# Add to /etc/cron.d/skillsmith-backup
# Daily backup at 2:00 AM
0 2 * * * skillsmith /usr/local/bin/skillsmith-backup.sh >> /var/log/skillsmith/backup.log 2>&1
```

### Manual Backup

```bash
# Simple file copy (ensure no writes during copy)
cp /var/lib/skillsmith/skills.db /var/backups/skillsmith/skills_manual.db

# Using SQLite backup command (safe during operation)
sqlite3 /var/lib/skillsmith/skills.db ".backup '/var/backups/skillsmith/skills_backup.db'"
```

### Restore Procedure

```bash
# Stop the service
sudo systemctl stop skillsmith

# Restore from backup
gunzip -c /var/backups/skillsmith/skills_20240115_020000.db.gz > /var/lib/skillsmith/skills.db

# Set permissions
chown skillsmith:skillsmith /var/lib/skillsmith/skills.db

# Start the service
sudo systemctl start skillsmith
```

### Backup Verification

```bash
# Verify backup integrity
sqlite3 /var/backups/skillsmith/skills_backup.db "PRAGMA integrity_check;"

# Check row counts
sqlite3 /var/backups/skillsmith/skills_backup.db "SELECT COUNT(*) FROM skills;"
```

---

## Upgrade Process

### Pre-Upgrade Checklist

- [ ] Review changelog and release notes
- [ ] Create database backup
- [ ] Verify backup integrity
- [ ] Plan maintenance window
- [ ] Notify users of downtime (if applicable)

### Upgrade Steps

#### Docker Deployment

```bash
# Pull latest image
docker pull skillsmith:latest

# Stop current container
docker compose -f docker-compose.production.yml down

# Create backup
docker run --rm -v skillsmith-data:/data -v $(pwd):/backup \
  alpine tar cvf /backup/skillsmith-backup.tar /data

# Start with new image
docker compose -f docker-compose.production.yml up -d

# Verify health
docker compose -f docker-compose.production.yml ps
```

#### npm Deployment

```bash
# Stop the service
sudo systemctl stop skillsmith

# Create backup
npm run backup  # or use manual backup procedure

# Pull latest code
git fetch origin
git checkout v1.2.0  # or desired version

# Install dependencies
npm ci --production

# Rebuild packages
npm run build

# Run migrations (if any)
npm run migrate

# Start the service
sudo systemctl start skillsmith
```

### Post-Upgrade Verification

```bash
# Check service status
sudo systemctl status skillsmith

# Verify database schema version
sqlite3 /var/lib/skillsmith/skills.db "SELECT * FROM schema_version ORDER BY version DESC LIMIT 1;"

# Test API endpoints
curl http://localhost:3001/health

# Check logs for errors
tail -f /var/log/skillsmith/skillsmith.log
```

### Rollback Procedure

```bash
# Stop the service
sudo systemctl stop skillsmith

# Restore backup
npm run restore -- --backup=/var/backups/skillsmith/skills_20240115.db

# Checkout previous version
git checkout v1.1.0

# Rebuild
npm ci --production
npm run build

# Start the service
sudo systemctl start skillsmith
```

---

## Health Checks

### Health Check Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/health/ready` | GET | Readiness check (database connection) |
| `/health/live` | GET | Liveness check |

### Response Format

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "timestamp": "2025-01-02T12:00:00Z",
  "checks": {
    "database": {
      "status": "healthy",
      "latency_ms": 5
    },
    "cache": {
      "status": "healthy",
      "hit_rate": 0.85
    },
    "embedding_service": {
      "status": "healthy",
      "using_fallback": false
    }
  }
}
```

### Monitoring Integration

#### Prometheus Metrics

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'skillsmith'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

#### Kubernetes Probes

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: skillsmith
      livenessProbe:
        httpGet:
          path: /health/live
          port: 3001
        initialDelaySeconds: 10
        periodSeconds: 10
      readinessProbe:
        httpGet:
          path: /health/ready
          port: 3001
        initialDelaySeconds: 5
        periodSeconds: 5
```

#### Docker Health Check

```yaml
healthcheck:
  test: ['CMD', 'curl', '-f', 'http://localhost:3001/health']
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 10s
```

---

## Logging Configuration

### Log Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `error` | Error conditions | Production (minimal) |
| `warn` | Warning conditions | Production (recommended) |
| `info` | Informational messages | Production (default) |
| `debug` | Debug-level messages | Development/troubleshooting |

### Log Format

```
[2025-01-02T12:00:00.000Z] [INFO] [skillsmith] Search completed - query="testing" results=15 latency_ms=45
[2025-01-02T12:00:01.000Z] [ERROR] [skillsmith] Database error - error="SQLITE_BUSY" retry=1
```

### Log Configuration

```bash
# Set log level
export SKILLSMITH_LOG_LEVEL=info

# Set log output
export SKILLSMITH_LOG_OUTPUT=/var/log/skillsmith/skillsmith.log

# Enable structured JSON logging
export SKILLSMITH_LOG_FORMAT=json
```

### Log Rotation

Configure logrotate (`/etc/logrotate.d/skillsmith`):

```
/var/log/skillsmith/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 skillsmith skillsmith
    postrotate
        systemctl reload skillsmith > /dev/null 2>&1 || true
    endscript
}
```

### Structured Logging Example

```json
{
  "timestamp": "2025-01-02T12:00:00.000Z",
  "level": "info",
  "service": "skillsmith",
  "event": "search_completed",
  "query": "testing",
  "results": 15,
  "latency_ms": 45,
  "cache_hit": true,
  "trace_id": "abc123"
}
```

---

## Troubleshooting

### Common Issues

#### 1. Native Module Errors

**Symptom**: `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch

**Solution**:
```bash
# Rebuild native modules
npm rebuild better-sqlite3
npm rebuild onnxruntime-node

# Or use Docker (recommended)
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm rebuild
```

#### 2. Database Locked

**Symptom**: `SQLITE_BUSY` or `database is locked`

**Solution**:
```bash
# Check for WAL checkpoint issues
sqlite3 /var/lib/skillsmith/skills.db "PRAGMA wal_checkpoint(TRUNCATE);"

# Check for stale locks
lsof /var/lib/skillsmith/skills.db

# Increase busy timeout
# In application config: PRAGMA busy_timeout = 5000;
```

#### 3. Search Returns No Results

**Symptom**: Empty search results despite data in database

**Solution**:
```bash
# Verify FTS index is populated
sqlite3 /var/lib/skillsmith/skills.db "SELECT COUNT(*) FROM skills_fts;"

# Rebuild FTS index
sqlite3 /var/lib/skillsmith/skills.db "INSERT INTO skills_fts(skills_fts) VALUES('rebuild');"

# Re-seed data
npm run seed
```

#### 4. High Memory Usage

**Symptom**: Memory consumption grows over time

**Solution**:
```bash
# Reduce SQLite cache size
export SKILLSMITH_CACHE_SIZE=32000  # 32MB instead of 64MB

# Enable memory monitoring
export SKILLSMITH_MEMORY_MONITORING=true

# Restart service to release memory
sudo systemctl restart skillsmith
```

#### 5. Container Won't Start

**Symptom**: Docker container exits immediately

**Solution**:
```bash
# Check logs
docker logs skillsmith-prod

# Verify volumes
docker volume ls | grep skillsmith

# Rebuild container
docker compose down
docker compose build --no-cache
docker compose up -d
```

### Diagnostic Commands

```bash
# Check service status
sudo systemctl status skillsmith

# View recent logs
journalctl -u skillsmith -n 100 --no-pager

# Database statistics
sqlite3 /var/lib/skillsmith/skills.db ".stats on" "SELECT 1;"

# Cache statistics
curl http://localhost:3001/metrics | grep cache

# Memory usage
ps aux | grep skillsmith
```

### Performance Analysis

```bash
# Run benchmarks
npm run benchmark

# Analyze search performance
npm run benchmark:search

# Analyze indexing performance
npm run benchmark:index

# Generate performance report
npm run benchmark -- --output=report.json
```

---

## Security Considerations

### Database Security

- Store database files on encrypted storage
- Restrict file permissions (600 or 640)
- Use separate database files for different environments
- Enable audit logging for sensitive operations

### Network Security

- Run behind reverse proxy (nginx, Caddy)
- Enable TLS termination at proxy
- Use firewall rules to restrict access
- Implement rate limiting

### Secret Management

- Never commit secrets to version control
- Use environment variables or secret managers
- Rotate API keys periodically
- Use Varlock for secure secret injection

### Audit Logging

Skillsmith logs security-relevant events:

- Authentication attempts
- Skill installations
- Configuration changes
- Database operations

See [Security Documentation](../security/index.md) for detailed security guidelines.

---

## Appendix

### Package Structure

```
packages/
  core/           # @skillsmith/core - Database, repositories, services
    src/
      db/         # Database schema and migrations
      repositories/  # Data access layer
      services/   # Business logic
      cache/      # Caching layer
      security/   # Security components

  mcp-server/     # @skillsmith/mcp-server - MCP tools
    src/
      tools/      # MCP tool implementations
      health/     # Health check endpoints

  cli/            # @skillsmith/cli - Command line interface
    src/
      commands/   # CLI commands
```

### Related Documentation

- [Getting Started](../GETTING_STARTED.md)
- [Architecture Standards](../architecture/standards.md)
- [Security Guidelines](../security/index.md)
- [ADR Index](../adr/index.md)
- [CLAUDE.md](../../CLAUDE.md) - Development context

### Support

- GitHub Issues: https://github.com/Smith-Horn-Group/skillsmith/issues
- Discussions: https://github.com/Smith-Horn-Group/skillsmith/discussions
