# ADR-015: Immutable Audit Log Storage with SHA-256 Hash Chains

**Status**: Accepted
**Date**: 2026-01-04
**Deciders**: Skillsmith Team
**Related Issues**: SMI-965
**Extends**: ADR-014 (Enterprise Package Architecture)

## Context

Enterprise audit logging for SOC 2 compliance requires tamper-evident storage. Audit logs must be immutable once written, with the ability to detect any unauthorized modifications. This is critical for:

1. **SOC 2 CC7.2**: System anomaly detection and incident response
2. **Legal holds**: Preserving logs during investigations
3. **Forensic analysis**: Proving log integrity in audits

### Requirements

- Logs cannot be modified after creation
- Any tampering must be detectable
- Verification must be efficient (O(1) for single entry, O(n) for full chain)
- Must support export with integrity proofs

## Decision

Implement immutable audit log storage using SHA-256 hash chains with the following architecture:

### 1. Hash Chain Structure

Each audit log entry includes a hash computed from:

```typescript
interface ImmutableLogEntry {
  id: string                    // UUID v4
  timestamp: string             // ISO 8601
  eventType: string
  data: Record<string, unknown>
  previousHash: string          // Hash of previous entry (or genesis hash)
  hash: string                  // SHA-256(previousHash + canonicalizedData)
}
```

**Hash computation**:
```typescript
function computeEntryHash(entry: Omit<ImmutableLogEntry, 'hash'>): string {
  const canonical = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    data: entry.data,
    previousHash: entry.previousHash
  }, Object.keys(entry).sort())

  return crypto.createHash('sha256').update(canonical).digest('hex')
}
```

### 2. Genesis Block

The first entry in each chain uses a deterministic genesis hash:

```typescript
const GENESIS_HASH = crypto
  .createHash('sha256')
  .update('SKILLSMITH_AUDIT_GENESIS_V1')
  .digest('hex')
```

### 3. Database Schema

```sql
CREATE TABLE immutable_audit_log (
  id TEXT PRIMARY KEY,
  sequence_num INTEGER NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,

  -- Write-once constraint via trigger
  CHECK (sequence_num > 0)
);

CREATE INDEX idx_immutable_timestamp ON immutable_audit_log(timestamp);
CREATE INDEX idx_immutable_hash ON immutable_audit_log(hash);

-- Prevent updates/deletes
CREATE TRIGGER prevent_immutable_update
BEFORE UPDATE ON immutable_audit_log
BEGIN
  SELECT RAISE(ABORT, 'Audit log entries are immutable');
END;

CREATE TRIGGER prevent_immutable_delete
BEFORE DELETE ON immutable_audit_log
BEGIN
  SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
END;
```

### 4. Verification Methods

**Single entry verification**:
```typescript
function verifyEntry(entry: ImmutableLogEntry): boolean {
  const computed = computeEntryHash({
    id: entry.id,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    data: entry.data,
    previousHash: entry.previousHash
  })
  return computed === entry.hash
}
```

**Chain verification**:
```typescript
function verifyChain(entries: ImmutableLogEntry[]): VerificationResult {
  for (let i = 0; i < entries.length; i++) {
    // Verify hash integrity
    if (!verifyEntry(entries[i])) {
      return { valid: false, brokenAt: i, reason: 'hash_mismatch' }
    }

    // Verify chain linkage
    if (i > 0 && entries[i].previousHash !== entries[i-1].hash) {
      return { valid: false, brokenAt: i, reason: 'chain_broken' }
    }

    // Verify genesis
    if (i === 0 && entries[i].previousHash !== GENESIS_HASH) {
      return { valid: false, brokenAt: 0, reason: 'invalid_genesis' }
    }
  }
  return { valid: true }
}
```

### 5. Merkle Root for Exports

For audit exports, compute a Merkle root to prove completeness:

```typescript
function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return GENESIS_HASH
  if (hashes.length === 1) return hashes[0]

  const pairs: string[] = []
  for (let i = 0; i < hashes.length; i += 2) {
    const left = hashes[i]
    const right = hashes[i + 1] ?? left
    pairs.push(crypto.createHash('sha256').update(left + right).digest('hex'))
  }
  return computeMerkleRoot(pairs)
}
```

## Alternatives Considered

### 1. Append-Only File System

**Pros**: Simple, filesystem-level immutability
**Cons**: No tamper detection, harder to query, OS-dependent

### 2. External Blockchain

**Pros**: Decentralized verification, strong guarantees
**Cons**: Latency, cost, complexity, external dependency

### 3. Database with Row Versioning

**Pros**: Simpler implementation
**Cons**: No cryptographic integrity, versions can be deleted

### 4. HMAC-based Signatures

**Pros**: Faster than SHA-256 for large payloads
**Cons**: Requires key management, single-key compromise breaks all

## Consequences

### Positive

- **Tamper-evident**: Any modification breaks the hash chain
- **Self-contained**: No external dependencies for verification
- **Efficient**: O(1) append, O(1) single verification, O(n) full chain
- **Auditable**: Merkle roots provide point-in-time snapshots
- **SOC 2 compliant**: Meets CC7.2 requirements for log integrity

### Negative

- **Append-only**: Cannot correct errors (must add correction entries)
- **Chain dependency**: Full verification requires sequential reads
- **Storage growth**: Hash fields add ~64 bytes per entry
- **No partial deletion**: Retention must archive, not delete

### Neutral

- Requires trusted initial state (genesis hash)
- Export includes Merkle proof for completeness verification

## Implementation Notes

### Performance Targets

| Operation | Target |
|-----------|--------|
| Append entry | < 5ms |
| Verify single entry | < 1ms |
| Verify 10,000 entries | < 500ms |
| Compute Merkle root (10,000) | < 100ms |

### Integration with Retention Policy

Retention enforcement (SMI-961) must:
1. Archive entries before chain truncation
2. Preserve Merkle root of archived segment
3. Create new chain with reference to archived root

### Legal Hold Support

During legal holds:
1. Suspend retention enforcement for affected entries
2. Mark entries with hold metadata
3. Include hold status in export reports

## References

- [RFC 6962: Certificate Transparency](https://datatracker.ietf.org/doc/html/rfc6962) - Merkle tree for append-only logs
- [SOC 2 CC7.2](https://us.aicpa.org/content/dam/aicpa/interestareas/frc/assuranceadvisoryservices/downloadabledocuments/trust-services-criteria.pdf) - System anomaly detection
- [Git Object Model](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) - Content-addressed storage
- [ADR-014: Enterprise Package Architecture](014-enterprise-package-architecture.md)
