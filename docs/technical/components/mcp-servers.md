# MCP Server Architecture

> **Navigation**: [Components Index](./index.md) | [Technical Index](../index.md) | [API Design](../api/index.md)

---

## Server Consolidation

Based on VP Engineering feedback, we consolidate from 6 servers to 3 servers for improved performance and reduced complexity.

| Original Servers | Consolidated Into | Rationale |
|-----------------|-------------------|-----------|
| `skill-index` | `discovery-core` | Core discovery functionality |
| `codebase-scan` | `discovery-core` | Tightly coupled with recommendations |
| `skill-install` | `discovery-core` | Part of install workflow |
| `recommendations` | `discovery-core` | Depends on scan + index |
| `learning` | `learning` | Distinct bounded context |
| `swarm` | Deferred to Phase 5 | Complex, not MVP-critical |
| `index-sync` | `sync` | Background sync operations |

---

## discovery-core MCP Server

**Responsibility:** All skill discovery, analysis, installation, and auditing operations.

### Tools Provided

```typescript
interface DiscoveryCoreMCPTools {
  // Search and browse
  search(query: string, filters?: SearchFilters): Promise<SkillResult[]>;
  get_skill(id: string): Promise<SkillDetail>;
  list_categories(): Promise<Category[]>;
  get_similar(skill_id: string, limit?: number): Promise<SkillResult[]>;

  // Codebase analysis
  analyze_codebase(path: string): Promise<CodebaseAnalysis>;
  detect_stack(path: string): Promise<TechStack>;
  recommend_skills(analysis: CodebaseAnalysis): Promise<Recommendation[]>;
  find_gaps(path: string): Promise<SkillGap[]>;

  // Installation
  install_skill(skill_id: string): Promise<InstallResult>;
  uninstall_skill(skill_id: string): Promise<void>;
  list_installed(): Promise<InstalledSkill[]>;

  // Conflict and audit
  check_conflicts(skill_ids: string[]): Promise<ConflictReport>;
  audit_activation(skill_id: string): Promise<ActivationAudit>;
  get_health_report(): Promise<HealthReport>;
}
```

### Performance Budget

- Startup time: <1.5s
- Memory footprint: <150MB
- Search latency: <200ms (cached), <500ms (uncached)

---

## learning MCP Server

**Responsibility:** Educational content, exercises, and progress tracking.

### Tools Provided

```typescript
interface LearningMCPTools {
  get_path(name: string): Promise<LearningPath>;
  list_paths(): Promise<LearningPath[]>;
  next_exercise(options?: ExerciseOptions): Promise<Exercise>;
  submit_solution(exercise_id: string): Promise<ValidationResult>;
  get_progress(): Promise<UserProgress>;
  reset_progress(path_id?: string): Promise<void>;
}
```

### Performance Budget

- Startup time: <0.5s
- Memory footprint: <50MB

---

## sync MCP Server

**Responsibility:** Background synchronization and index updates.

### Tools Provided

```typescript
interface SyncMCPTools {
  refresh_index(source?: string): Promise<SyncResult>;
  get_sync_status(): Promise<SyncStatus>;
  export_recommendations(format: 'md' | 'json'): Promise<string>;
  import_blocklist(url: string): Promise<void>;
  check_updates(): Promise<UpdateAvailable[]>;
}
```

### Performance Budget

- Startup time: <0.5s
- Memory footprint: <100MB
- Full index sync: <10 minutes (incremental: <1 minute)

---

## Inter-Server Communication

Servers communicate through the shared SQLite database and file system. No direct IPC is required.

```
+----------------+     +----------------+     +----------------+
| discovery-core |     | learning       |     | sync           |
+----------------+     +----------------+     +----------------+
        |                     |                     |
        v                     v                     v
+================================================================+
|               ~/.claude-discovery/ (shared storage)            |
+================================================================+
```

### Shared Resources

| Resource | Access Pattern | Locking |
|----------|----------------|---------|
| `skills.db` | Read: all servers, Write: sync only | WAL mode |
| `embeddings.bin` | Read: discovery-core only | None (memory-mapped) |
| `cache/` | Read/Write: discovery-core | File-level locking |
| `config/` | Read: all, Write: user commands | None |

---

## Related Documentation

- [Skill Index](./skill-index.md) - Data model details
- [API Design](../api/index.md) - Complete tool definitions
- [Performance](../performance.md) - Performance requirements

---

*Next: [Skill Index](./skill-index.md)*
