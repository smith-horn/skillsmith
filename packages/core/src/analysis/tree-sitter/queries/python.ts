/**
 * SMI-4293: Python Tree-Sitter Query Strings
 *
 * TypeScript-consumable tree-sitter queries used by the PythonAdapter
 * when the WASM parser is available. Paired with python.scm for reference
 * but this module is what runtime code imports (loadable without fs reads).
 *
 * These queries drive the query-based extraction path that replaces the
 * regex fallback. The extraction must match-or-exceed the regex baseline;
 * see queryExtractionMatchesOrExceedsRegex.test.ts (finding H3).
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 * @module analysis/tree-sitter/queries/python
 */

/**
 * Query capturing `import x`, `import x as y`, `import x.y.z`.
 */
export const PYTHON_IMPORT_QUERY = `
(import_statement
  name: (dotted_name) @import.module)

(import_statement
  name: (aliased_import
    name: (dotted_name) @import.module
    alias: (identifier) @import.alias))
`

/**
 * Query capturing `from module import name`, aliased imports, and wildcard.
 * Relative imports (`from .x import y`) capture the dotted_name portion as
 * the module name; the leading dots are preserved via relative_import wrapping.
 */
export const PYTHON_FROM_IMPORT_QUERY = `
(import_from_statement
  module_name: (dotted_name) @from.module
  name: (dotted_name) @from.name)

(import_from_statement
  module_name: (dotted_name) @from.module
  name: (aliased_import
    name: (dotted_name) @from.name
    alias: (identifier) @from.alias))

(import_from_statement
  module_name: (dotted_name) @from.module
  (wildcard_import) @from.wildcard)

(import_from_statement
  module_name: (relative_import) @from.module
  name: (_) @from.name)
`

/**
 * Query capturing top-level and nested function definitions.
 * `async` is a child marker when present; we detect it via node type.
 */
export const PYTHON_FUNCTION_QUERY = `
(function_definition
  name: (identifier) @function.name
  parameters: (parameters) @function.params) @function.def
`

/**
 * Query capturing class definitions.
 */
export const PYTHON_CLASS_QUERY = `
(class_definition
  name: (identifier) @class.name) @class.def
`

/**
 * Query capturing `__all__ = [...]` export declarations.
 */
export const PYTHON_ALL_EXPORT_QUERY = `
(assignment
  left: (identifier) @all.var
  right: (list
    (string) @all.name)
  (#eq? @all.var "__all__"))
`

/**
 * Combined query used for a single pass over the tree.
 * Keeps capture names namespaced so extraction can partition results.
 */
export const PYTHON_COMBINED_QUERY = [
  PYTHON_IMPORT_QUERY,
  PYTHON_FROM_IMPORT_QUERY,
  PYTHON_FUNCTION_QUERY,
  PYTHON_CLASS_QUERY,
  PYTHON_ALL_EXPORT_QUERY,
].join('\n')
