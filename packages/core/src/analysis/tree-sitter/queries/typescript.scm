; SMI-1310: TypeScript Tree-Sitter Queries
;
; Query patterns for extracting imports, exports, and functions
; from TypeScript/JavaScript files using tree-sitter.
;
; These queries will be used for incremental parsing in SMI-1309.
; @see docs/architecture/multi-language-analysis.md

; ====================
; Import Statements
; ====================

; Named imports: import { foo, bar } from 'module'
(import_statement
  source: (string) @import.source
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.name))))

; Default import: import foo from 'module'
(import_statement
  source: (string) @import.source
  (import_clause
    (identifier) @import.default))

; Namespace import: import * as foo from 'module'
(import_statement
  source: (string) @import.source
  (import_clause
    (namespace_import
      (identifier) @import.namespace)))

; Side-effect import: import 'module'
(import_statement
  source: (string) @import.source) @import.sideEffect

; Dynamic import: import('module')
(call_expression
  function: (import)
  arguments: (arguments
    (string) @import.dynamic))

; ====================
; Export Statements
; ====================

; Export function: export function foo() {}
(export_statement
  declaration: (function_declaration
    name: (identifier) @export.name)) @export.function

; Export async function: export async function foo() {}
(export_statement
  declaration: (function_declaration
    "async"
    name: (identifier) @export.name)) @export.asyncFunction

; Export class: export class Foo {}
(export_statement
  declaration: (class_declaration
    name: (type_identifier) @export.name)) @export.class

; Export variable: export const foo = ...
(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @export.name))) @export.variable

; Export type: export type Foo = ...
(export_statement
  declaration: (type_alias_declaration
    name: (type_identifier) @export.name)) @export.type

; Export interface: export interface Foo {}
(export_statement
  declaration: (interface_declaration
    name: (type_identifier) @export.name)) @export.interface

; Export enum: export enum Foo {}
(export_statement
  declaration: (enum_declaration
    name: (identifier) @export.name)) @export.enum

; Named exports: export { foo, bar }
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name))) @export.named

; Default export: export default foo
(export_statement
  "default"
  value: (_) @export.default)

; ====================
; Function Definitions
; ====================

; Function declaration: function foo() {}
(function_declaration
  name: (identifier) @function.name
  parameters: (formal_parameters) @function.params) @function.def

; Async function: async function foo() {}
(function_declaration
  "async" @function.async
  name: (identifier) @function.name
  parameters: (formal_parameters) @function.params) @function.asyncDef

; Arrow function: const foo = () => {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function
      parameters: (formal_parameters) @function.params))) @function.arrow

; Async arrow function: const foo = async () => {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function
      "async" @function.async
      parameters: (formal_parameters) @function.params))) @function.asyncArrow

; Method definition: class { foo() {} }
(method_definition
  name: (property_identifier) @function.name
  parameters: (formal_parameters) @function.params) @function.method

; Async method: class { async foo() {} }
(method_definition
  "async" @function.async
  name: (property_identifier) @function.name
  parameters: (formal_parameters) @function.params) @function.asyncMethod

; ====================
; Class Definitions
; ====================

; Class declaration: class Foo {}
(class_declaration
  name: (type_identifier) @class.name) @class.def

; Class with extends: class Foo extends Bar {}
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (extends_clause
      (identifier) @class.extends))) @class.inheritance

; ====================
; Type Definitions (TypeScript)
; ====================

; Type alias: type Foo = ...
(type_alias_declaration
  name: (type_identifier) @type.name) @type.alias

; Interface: interface Foo {}
(interface_declaration
  name: (type_identifier) @interface.name) @interface.def

; Enum: enum Foo {}
(enum_declaration
  name: (identifier) @enum.name) @enum.def
