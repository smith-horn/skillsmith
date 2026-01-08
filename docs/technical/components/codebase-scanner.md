# Codebase Scanner

> **Navigation**: [Components Index](./index.md) | [Technical Index](../index.md) | [Recommendation Engine](./recommendation-engine.md)

---

## Stack Detection Approach

```typescript
interface StackDetector {
  // Ordered by priority (first match wins for conflicts)
  detectors: StackSignal[];
}

interface StackSignal {
  technology: string;
  files: string[];          // Glob patterns
  content_patterns?: RegExp[];
  weight: number;           // 0-1, higher = more confident
}

const STACK_SIGNALS: StackSignal[] = [
  // JavaScript/TypeScript ecosystem
  { technology: 'react', files: ['package.json'], content_patterns: [/"react":/], weight: 0.9 },
  { technology: 'next.js', files: ['next.config.*'], weight: 0.95 },
  { technology: 'vue', files: ['package.json'], content_patterns: [/"vue":/], weight: 0.9 },
  { technology: 'angular', files: ['angular.json'], weight: 0.95 },
  { technology: 'typescript', files: ['tsconfig.json'], weight: 0.95 },

  // Python ecosystem
  { technology: 'python', files: ['*.py', 'requirements.txt', 'pyproject.toml'], weight: 0.9 },
  { technology: 'django', files: ['manage.py', 'settings.py'], weight: 0.95 },
  { technology: 'fastapi', files: ['requirements.txt'], content_patterns: [/fastapi/i], weight: 0.85 },

  // Other ecosystems
  { technology: 'rust', files: ['Cargo.toml'], weight: 0.95 },
  { technology: 'go', files: ['go.mod'], weight: 0.95 },
  { technology: 'java', files: ['pom.xml', 'build.gradle'], weight: 0.95 },

  // Testing
  { technology: 'jest', files: ['jest.config.*', 'package.json'], content_patterns: [/"jest":/], weight: 0.9 },
  { technology: 'pytest', files: ['pytest.ini', 'pyproject.toml'], content_patterns: [/pytest/], weight: 0.9 },

  // Databases
  { technology: 'postgresql', files: ['docker-compose.*'], content_patterns: [/postgres/i], weight: 0.7 },
  { technology: 'mongodb', files: ['package.json'], content_patterns: [/"mongodb"|"mongoose"/], weight: 0.8 },
];
```

---

## Performance Constraints

| Operation | Target | Max |
|-----------|--------|-----|
| Full scan (typical project) | <15s | 30s |
| Incremental scan | <3s | 10s |
| File count limit | 10,000 | 50,000 |
| Max file size to analyze | 1MB | 5MB |

---

## Privacy Considerations

```typescript
interface ScanPrivacyConfig {
  // Files/directories always excluded from analysis
  excluded_patterns: [
    '.env*',
    '**/secrets/**',
    '**/credentials/**',
    '**/*.pem',
    '**/*.key',
    '**/node_modules/**',
    '**/.git/**',
  ],

  // Content never sent externally
  content_stays_local: true,

  // Only metadata leaves local machine
  external_data: ['technology_names', 'file_types', 'package_names'],
}
```

### Privacy Guarantees

1. **Source code never leaves the machine** - Only technology names and file types are used for recommendations
2. **Sensitive files are excluded** - Environment files, keys, and credentials are never scanned
3. **No content extraction** - Only file existence and pattern matching, not content storage

---

## Scan Output

```typescript
interface CodebaseAnalysis {
  path: string;
  scanned_at: string;

  // Detected technologies with confidence
  stack: TechStackItem[];

  // Project metadata
  project_info: {
    name?: string;         // From package.json, Cargo.toml, etc.
    description?: string;
    version?: string;
  };

  // Statistics
  stats: {
    total_files: number;
    analyzed_files: number;
    skipped_files: number;
    scan_duration_ms: number;
  };
}

interface TechStackItem {
  technology: string;
  confidence: number;      // 0-1
  detected_via: string;    // File or pattern that triggered detection
}
```

---

## Related Documentation

- [Recommendation Engine](./recommendation-engine.md) - Uses scan results
- [Performance](../performance.md) - Performance requirements
- [Security](../security/index.md) - Privacy considerations

---

*Next: [Recommendation Engine](./recommendation-engine.md)*
