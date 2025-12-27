#!/usr/bin/env node
/**
 * Standards Audit Script for Skillsmith
 *
 * Checks codebase compliance with engineering standards.
 * Run: npm run audit:standards
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let warnings = 0;
let failed = 0;

function pass(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
  passed++;
}

function warn(msg, fix) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`);
  if (fix) console.log(`  ${YELLOW}Fix:${RESET} ${fix}`);
  warnings++;
}

function fail(msg, fix) {
  console.log(`${RED}✗${RESET} ${msg}`);
  if (fix) console.log(`  ${YELLOW}Fix:${RESET} ${fix}`);
  failed++;
}

function getFilesRecursive(dir, extensions) {
  const files = [];
  if (!existsSync(dir)) return files;

  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    if (item === 'node_modules' || item === 'dist' || item === '.git') continue;

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getFilesRecursive(fullPath, extensions));
    } else if (extensions.some(ext => item.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

console.log(`\n${BOLD}📋 Skillsmith Standards Audit${RESET}\n`);
console.log('━'.repeat(50) + '\n');

// 1. TypeScript Strict Mode
console.log(`${BOLD}1. TypeScript Configuration${RESET}`);
try {
  const tsConfigs = ['packages/core/tsconfig.json', 'packages/mcp-server/tsconfig.json', 'packages/cli/tsconfig.json'];
  for (const configPath of tsConfigs) {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.compilerOptions?.strict === true) {
        pass(`${configPath}: strict mode enabled`);
      } else {
        fail(`${configPath}: strict mode not enabled`, 'Set "strict": true in compilerOptions');
      }
    }
  }
} catch (e) {
  fail(`Error checking tsconfig: ${e.message}`);
}

// 2. No 'any' types in source
console.log(`\n${BOLD}2. Type Safety (no 'any' types)${RESET}`);
try {
  const sourceFiles = getFilesRecursive('packages', ['.ts', '.tsx'])
    .filter(f => !f.includes('.test.') && !f.includes('.d.ts'));

  let anyCount = 0;
  const filesWithAny = [];

  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8');
    // Match ': any' or '<any>' but not in comments
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (line.match(/:\s*any[^a-zA-Z]|<any>|as\s+any/)) {
        anyCount++;
        if (!filesWithAny.includes(file)) {
          filesWithAny.push({ file, line: i + 1 });
        }
      }
    }
  }

  if (anyCount === 0) {
    pass('No untyped "any" found in source files');
  } else {
    warn(`Found ${anyCount} "any" types in ${filesWithAny.length} files`, 'Use "unknown" for external data or add proper types');
    filesWithAny.slice(0, 3).forEach(({ file, line }) => {
      console.log(`    ${relative(process.cwd(), file)}:${line}`);
    });
  }
} catch (e) {
  fail(`Error checking for 'any' types: ${e.message}`);
}

// 3. File Length
console.log(`\n${BOLD}3. File Length (max 500 lines)${RESET}`);
try {
  const sourceFiles = getFilesRecursive('packages', ['.ts', '.tsx'])
    .filter(f => !f.includes('.test.'));

  const longFiles = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8');
    const lineCount = content.split('\n').length;
    if (lineCount > 500) {
      longFiles.push({ file: relative(process.cwd(), file), lines: lineCount });
    }
  }

  if (longFiles.length === 0) {
    pass('All source files under 500 lines');
  } else {
    warn(`${longFiles.length} files exceed 500 lines`, 'Split into smaller modules');
    longFiles.forEach(({ file, lines }) => {
      console.log(`    ${file}: ${lines} lines`);
    });
  }
} catch (e) {
  fail(`Error checking file lengths: ${e.message}`);
}

// 4. Test Files Exist
console.log(`\n${BOLD}4. Test Coverage${RESET}`);
try {
  const testFiles = getFilesRecursive('packages', ['.test.ts', '.test.tsx', '.spec.ts']);
  if (testFiles.length > 0) {
    pass(`Found ${testFiles.length} test files`);
  } else {
    fail('No test files found', 'Add *.test.ts files alongside source');
  }
} catch (e) {
  fail(`Error checking test files: ${e.message}`);
}

// 5. Standards.md exists
console.log(`\n${BOLD}5. Documentation${RESET}`);
if (existsSync('docs/architecture/standards.md')) {
  pass('standards.md exists');
} else {
  fail('docs/architecture/standards.md not found', 'Create from governance template');
}

if (existsSync('CLAUDE.md')) {
  pass('CLAUDE.md exists');
} else {
  fail('CLAUDE.md not found', 'Create at project root');
}

// 6. ADR Directory
console.log(`\n${BOLD}6. Architecture Decision Records${RESET}`);
if (existsSync('docs/adr')) {
  const adrs = readdirSync('docs/adr').filter(f => f.endsWith('.md'));
  pass(`docs/adr/ exists with ${adrs.length} ADRs`);
} else {
  warn('docs/adr/ directory not found', 'Create for architecture decisions');
}

// 7. Pre-commit Hooks
console.log(`\n${BOLD}7. Pre-commit Hooks${RESET}`);
if (existsSync('.husky/pre-commit')) {
  pass('Husky pre-commit hook configured');
} else {
  warn('Pre-commit hook not found', 'Run: npx husky add .husky/pre-commit');
}

// Summary
console.log('\n' + '━'.repeat(50));
console.log(`\n${BOLD}📊 Summary${RESET}\n`);
console.log(`${GREEN}Passed:${RESET}   ${passed}`);
console.log(`${YELLOW}Warnings:${RESET} ${warnings}`);
console.log(`${RED}Failed:${RESET}   ${failed}`);

const total = passed + warnings + failed;
const score = Math.round((passed / total) * 100);
console.log(`\nCompliance Score: ${score >= 80 ? GREEN : score >= 60 ? YELLOW : RED}${score}%${RESET}`);

if (failed > 0) {
  console.log(`\n${RED}${BOLD}Standards audit failed.${RESET} Fix the failures above.\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\n${YELLOW}Standards audit passed with warnings.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`\n${GREEN}${BOLD}Standards audit passed!${RESET}\n`);
  process.exit(0);
}
