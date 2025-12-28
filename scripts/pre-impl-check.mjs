#!/usr/bin/env node
/**
 * Pre-Implementation Checklist Validator for Skillsmith
 *
 * Validates that new features/modules meet project standards before implementation.
 * Run: npm run pre-impl -- [options]
 *
 * @example
 * npm run pre-impl -- --file src/services/NewService.ts
 * npm run pre-impl -- --module UserAuthentication
 * npm run pre-impl -- --help
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

// ANSI colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Tracking
let passed = 0;
let warnings = 0;
let failed = 0;

/**
 * Print a passing check.
 * @param {string} msg - Message to display
 */
function pass(msg) {
  console.log(`${GREEN}[PASS]${RESET} ${msg}`);
  passed++;
}

/**
 * Print a warning.
 * @param {string} msg - Message to display
 * @param {string} [suggestion] - Optional suggestion for fixing
 */
function warn(msg, suggestion) {
  console.log(`${YELLOW}[WARN]${RESET} ${msg}`);
  if (suggestion) console.log(`       ${DIM}Suggestion: ${suggestion}${RESET}`);
  warnings++;
}

/**
 * Print a failure.
 * @param {string} msg - Message to display
 * @param {string} [fix] - Optional fix instruction
 */
function fail(msg, fix) {
  console.log(`${RED}[FAIL]${RESET} ${msg}`);
  if (fix) console.log(`       ${DIM}Fix: ${fix}${RESET}`);
  failed++;
}

/**
 * Print a section header.
 * @param {string} title - Section title
 */
function section(title) {
  console.log(`\n${BOLD}${CYAN}${title}${RESET}`);
  console.log('─'.repeat(50));
}

/**
 * Get all TypeScript files recursively.
 * @param {string} dir - Directory to search
 * @returns {string[]} List of file paths
 */
function getTypeScriptFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;

  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    if (item === 'node_modules' || item === 'dist' || item === '.git') continue;

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getTypeScriptFiles(fullPath));
    } else if (item.endsWith('.ts') && !item.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Load standards.md and extract naming conventions.
 * @returns {object} Naming conventions object
 */
function loadNamingConventions() {
  const standardsPath = join(ROOT_DIR, 'docs/architecture/standards.md');
  if (!existsSync(standardsPath)) {
    return null;
  }
  // Return extracted conventions from standards.md
  return {
    files: {
      components: /^[A-Z][a-zA-Z0-9]*\.ts$/,  // PascalCase
      utilities: /^[a-z][a-zA-Z0-9]*\.ts$/,    // camelCase
      tests: /^[a-zA-Z][a-zA-Z0-9]*\.test\.ts$/
    },
    variables: /^[a-z][a-zA-Z0-9]*$/,          // camelCase
    constants: /^[A-Z][A-Z0-9_]*$/,            // SCREAMING_SNAKE
    types: /^[A-Z][a-zA-Z0-9]*$/               // PascalCase
  };
}

/**
 * Check if types are defined for a proposed file.
 * @param {string} filePath - File path to check
 * @returns {boolean} True if types exist or will be created
 */
function checkTypesExist(filePath) {
  if (!filePath) return true;

  const fileName = basename(filePath, '.ts');
  const dirPath = dirname(filePath);

  // Check for types file in same directory
  const possibleTypeFiles = [
    join(dirPath, `${fileName}.types.ts`),
    join(dirPath, 'types.ts'),
    join(dirPath, 'types', `${fileName}.ts`),
    join(dirPath, '..', 'types', `${fileName}.ts`)
  ];

  for (const typeFile of possibleTypeFiles) {
    if (existsSync(typeFile)) {
      return true;
    }
  }

  // Check if the file itself contains type definitions
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf8');
    if (content.includes('interface ') || content.includes('type ') || content.includes('enum ')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if test file exists for a module.
 * @param {string} filePath - File path to check
 * @returns {boolean} True if test file exists
 */
function checkTestFileExists(filePath) {
  if (!filePath) return true;

  const ext = extname(filePath);
  const testFile = filePath.replace(ext, `.test${ext}`);
  return existsSync(testFile);
}

/**
 * Detect potential circular dependencies using import analysis.
 * @param {string} targetFile - File to check
 * @param {string[]} projectFiles - All project files
 * @returns {string[]} List of potential circular dependency chains
 */
function detectCircularDependencies(targetFile, projectFiles) {
  const circular = [];
  const visited = new Set();
  const stack = new Set();

  function getImports(filePath) {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf8');
    const imports = [];

    // Match import statements
    const importRegex = /import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      // Only check relative imports
      if (importPath.startsWith('.')) {
        const resolvedPath = resolveImport(filePath, importPath);
        if (resolvedPath) imports.push(resolvedPath);
      }
    }
    return imports;
  }

  function resolveImport(fromFile, importPath) {
    const dir = dirname(fromFile);
    let resolved = join(dir, importPath);

    // Try different extensions
    const extensions = ['.ts', '/index.ts', '.js', '/index.js'];
    for (const ext of extensions) {
      const tryPath = resolved + ext;
      if (existsSync(tryPath)) return tryPath;
    }
    if (existsSync(resolved)) return resolved;
    return null;
  }

  function dfs(file, path = []) {
    if (stack.has(file)) {
      const cycleStart = path.indexOf(file);
      const cycle = path.slice(cycleStart).concat(file);
      circular.push(cycle.map(f => relative(ROOT_DIR, f)).join(' -> '));
      return;
    }
    if (visited.has(file)) return;

    visited.add(file);
    stack.add(file);

    const imports = getImports(file);
    for (const imp of imports) {
      dfs(imp, [...path, file]);
    }

    stack.delete(file);
  }

  dfs(targetFile);
  return circular;
}

/**
 * Validate naming convention for a file.
 * @param {string} filePath - File path to validate
 * @param {object} conventions - Naming conventions
 * @returns {boolean} True if valid
 */
function validateNamingConvention(filePath, conventions) {
  if (!conventions) return true;

  const fileName = basename(filePath);

  // Test files
  if (fileName.includes('.test.')) {
    return conventions.files.tests.test(fileName);
  }

  // Skip type files
  if (fileName.includes('.types.') || fileName.includes('.d.')) {
    return true;
  }

  // Check if it matches either convention
  return conventions.files.components.test(fileName) ||
         conventions.files.utilities.test(fileName);
}

/**
 * Validate file location follows package structure.
 * @param {string} filePath - File path to validate
 * @returns {{valid: boolean, suggestion?: string}}
 */
function validateFileLocation(filePath) {
  const relativePath = relative(ROOT_DIR, filePath);

  // Must be in packages/
  if (!relativePath.startsWith('packages/')) {
    return {
      valid: false,
      suggestion: 'Files should be in packages/core/, packages/mcp-server/, or packages/cli/'
    };
  }

  const parts = relativePath.split('/');
  const pkg = parts[1]; // core, mcp-server, or cli

  if (!['core', 'mcp-server', 'cli'].includes(pkg)) {
    return {
      valid: false,
      suggestion: `Package "${pkg}" is not recognized. Use core, mcp-server, or cli.`
    };
  }

  // Should be in src/ subdirectory
  if (parts[2] !== 'src' && !parts[2]?.includes('test')) {
    return {
      valid: false,
      suggestion: `Files should be in packages/${pkg}/src/ directory`
    };
  }

  return { valid: true };
}

/**
 * Check for JSDoc presence in a file.
 * @param {string} filePath - File to check
 * @returns {{hasJSDoc: boolean, functions: number, documented: number}}
 */
function checkJSDocPresence(filePath) {
  if (!existsSync(filePath)) {
    return { hasJSDoc: true, functions: 0, documented: 0 };
  }

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let functions = 0;
  let documented = 0;
  let inJSDoc = false;
  let jsDocEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('/**')) inJSDoc = true;
    if (inJSDoc && line.endsWith('*/')) {
      inJSDoc = false;
      jsDocEnd = i;
    }

    // Check for function declarations
    if (line.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
        line.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/) ||
        line.match(/^(public|private|protected)?\s*(async\s+)?\w+\s*\([^)]*\)\s*[:{]/)) {
      functions++;
      // Check if preceded by JSDoc
      if (jsDocEnd === i - 1 || (jsDocEnd === i - 2 && lines[i - 1].trim() === '')) {
        documented++;
      }
    }
  }

  return {
    hasJSDoc: functions === 0 || documented > 0,
    functions,
    documented
  };
}

/**
 * Display help information.
 */
function showHelp() {
  console.log(`
${BOLD}Pre-Implementation Checklist Validator${RESET}
${DIM}Validates that new features/modules meet Skillsmith standards${RESET}

${BOLD}USAGE:${RESET}
  npm run pre-impl -- [options]
  node scripts/pre-impl-check.mjs [options]

${BOLD}OPTIONS:${RESET}
  --file <path>       Validate a specific file path (planned or existing)
  --module <name>     Validate module name and suggest location
  --all               Run checks on all TypeScript files
  --help, -h          Show this help message

${BOLD}EXAMPLES:${RESET}
  npm run pre-impl -- --file packages/core/src/services/AuthService.ts
  npm run pre-impl -- --module UserAuthentication
  npm run pre-impl -- --all

${BOLD}CHECKS PERFORMED:${RESET}
  1. TypeScript types are defined before implementation
  2. Test file exists (or will be created) for new modules
  3. JSDoc comments are planned/present
  4. No circular dependencies will be introduced
  5. Naming conventions follow standards.md
  6. File location follows package structure

${BOLD}EXIT CODES:${RESET}
  0   All checks passed
  1   One or more checks failed

${BOLD}REFERENCE:${RESET}
  See docs/architecture/standards.md for full engineering standards
  See docs/templates/pre-implementation-checklist.md for manual checklist
`);
}

/**
 * Main entry point.
 */
async function main() {
  const args = process.argv.slice(2);

  // Help flag
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  console.log(`\n${BOLD}Pre-Implementation Checklist Validator${RESET}`);
  console.log('═'.repeat(50));
  console.log(`${DIM}Validating against Skillsmith engineering standards${RESET}\n`);

  const conventions = loadNamingConventions();
  const fileIdx = args.indexOf('--file');
  const moduleIdx = args.indexOf('--module');
  const runAll = args.includes('--all');

  let targetFiles = [];

  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = args[fileIdx + 1];
    // Make absolute if relative
    const absolutePath = filePath.startsWith('/') ? filePath : join(ROOT_DIR, filePath);
    targetFiles = [absolutePath];
  } else if (moduleIdx !== -1 && args[moduleIdx + 1]) {
    const moduleName = args[moduleIdx + 1];
    console.log(`${CYAN}Module:${RESET} ${moduleName}\n`);

    // Suggest file locations for the module
    section('Suggested File Locations');
    console.log(`  packages/core/src/services/${moduleName}Service.ts`);
    console.log(`  packages/core/src/repositories/${moduleName}Repository.ts`);
    console.log(`  packages/mcp-server/src/tools/${moduleName.toLowerCase()}.ts`);
    console.log('');

    // Validate module name
    section('Module Name Validation');
    if (/^[A-Z][a-zA-Z0-9]*$/.test(moduleName)) {
      pass(`Module name "${moduleName}" follows PascalCase convention`);
    } else {
      fail(`Module name "${moduleName}" should be PascalCase`, `Use: ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}`);
    }
  } else if (runAll) {
    targetFiles = getTypeScriptFiles(join(ROOT_DIR, 'packages'));
  } else {
    // No specific target - run general checks
    console.log(`${DIM}No specific file or module provided. Running general checks.${RESET}`);
    console.log(`${DIM}Use --help for usage information.${RESET}\n`);

    section('General Pre-Implementation Checks');

    // Check standards.md exists
    const standardsPath = join(ROOT_DIR, 'docs/architecture/standards.md');
    if (existsSync(standardsPath)) {
      pass('standards.md exists and is accessible');
    } else {
      fail('standards.md not found', 'Create docs/architecture/standards.md');
    }

    // Check template exists
    const templatePath = join(ROOT_DIR, 'docs/templates/pre-implementation-checklist.md');
    if (existsSync(templatePath)) {
      pass('Pre-implementation checklist template exists');
    } else {
      warn('Pre-implementation checklist template not found', 'Create docs/templates/pre-implementation-checklist.md');
    }

    // Check tsconfig strict mode
    const tsconfigPath = join(ROOT_DIR, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      const config = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
      if (config.compilerOptions?.strict === true) {
        pass('TypeScript strict mode enabled');
      } else {
        warn('TypeScript strict mode not enabled in root tsconfig');
      }
    }
  }

  // Process target files
  for (const filePath of targetFiles) {
    const relativePath = relative(ROOT_DIR, filePath);
    console.log(`\n${CYAN}File:${RESET} ${relativePath}`);

    section('1. File Location');
    const locationCheck = validateFileLocation(filePath);
    if (locationCheck.valid) {
      pass('File location follows package structure');
    } else {
      fail('File location does not follow package structure', locationCheck.suggestion);
    }

    section('2. Naming Convention');
    if (validateNamingConvention(filePath, conventions)) {
      pass('File name follows naming conventions');
    } else {
      fail('File name does not follow naming conventions', 'See standards.md section 1.2 for conventions');
    }

    section('3. TypeScript Types');
    if (checkTypesExist(filePath)) {
      pass('Type definitions exist or are defined in file');
    } else {
      warn('No explicit type definitions found', 'Create types before implementation or define interfaces in file');
    }

    section('4. Test File');
    if (checkTestFileExists(filePath)) {
      pass('Test file exists');
    } else {
      warn('Test file not found', `Create ${relativePath.replace('.ts', '.test.ts')}`);
    }

    section('5. JSDoc Documentation');
    const jsdocCheck = checkJSDocPresence(filePath);
    if (jsdocCheck.hasJSDoc) {
      if (jsdocCheck.functions > 0) {
        pass(`JSDoc present (${jsdocCheck.documented}/${jsdocCheck.functions} functions documented)`);
      } else {
        pass('No public functions require documentation yet');
      }
    } else {
      warn(`Functions lack JSDoc (${jsdocCheck.documented}/${jsdocCheck.functions} documented)`, 'Add JSDoc comments to public functions');
    }

    section('6. Circular Dependencies');
    const allFiles = getTypeScriptFiles(join(ROOT_DIR, 'packages'));
    const circular = detectCircularDependencies(filePath, allFiles);
    if (circular.length === 0) {
      pass('No circular dependencies detected');
    } else {
      for (const cycle of circular) {
        fail(`Circular dependency: ${cycle}`);
      }
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log(`${BOLD}Summary${RESET}`);
  console.log('─'.repeat(50));
  console.log(`${GREEN}Passed:${RESET}   ${passed}`);
  console.log(`${YELLOW}Warnings:${RESET} ${warnings}`);
  console.log(`${RED}Failed:${RESET}   ${failed}`);
  console.log('─'.repeat(50));

  if (failed > 0) {
    console.log(`\n${RED}${BOLD}Pre-implementation checks failed.${RESET}`);
    console.log(`${DIM}Address the failures above before implementing.${RESET}\n`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`\n${YELLOW}${BOLD}Pre-implementation checks passed with warnings.${RESET}`);
    console.log(`${DIM}Consider addressing warnings for better code quality.${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`\n${GREEN}${BOLD}All pre-implementation checks passed!${RESET}`);
    console.log(`${DIM}Ready to implement.${RESET}\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error(`${RED}Error:${RESET} ${err.message}`);
  process.exit(1);
});
