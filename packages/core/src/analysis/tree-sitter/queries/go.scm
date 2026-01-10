; SMI-1305: Go Language Tree-Sitter Queries
;
; Tree-sitter queries for extracting imports, exports, functions,
; and type definitions from Go source files.
;
; @see docs/architecture/multi-language-analysis.md

; ==================================
; Package Declaration
; ==================================

(package_clause
  (package_identifier) @package.name)

; ==================================
; Import Statements
; ==================================

; Single import with optional alias
(import_declaration
  (import_spec
    path: (interpreted_string_literal) @import.path
    name: (package_identifier)? @import.alias))

; Import block with multiple imports
(import_declaration
  (import_spec_list
    (import_spec
      path: (interpreted_string_literal) @import.path
      name: (package_identifier)? @import.alias)))

; Blank import (for side effects)
(import_declaration
  (import_spec
    path: (interpreted_string_literal) @import.path
    name: (blank_identifier) @import.blank))

; Dot import (import into current namespace)
(import_declaration
  (import_spec
    path: (interpreted_string_literal) @import.path
    name: "." @import.dot))

; ==================================
; Function Definitions
; ==================================

; Regular function
(function_declaration
  name: (identifier) @function.name
  parameters: (parameter_list) @function.params
  result: (_)? @function.return) @function.def

; Method (function with receiver)
(method_declaration
  receiver: (parameter_list) @method.receiver
  name: (field_identifier) @function.name
  parameters: (parameter_list) @function.params
  result: (_)? @function.return) @method.def

; ==================================
; Type Definitions
; ==================================

; Struct type
(type_declaration
  (type_spec
    name: (type_identifier) @type.name
    type: (struct_type) @type.struct)) @type.struct.def

; Interface type
(type_declaration
  (type_spec
    name: (type_identifier) @type.name
    type: (interface_type) @type.interface)) @type.interface.def

; Type alias
(type_declaration
  (type_spec
    name: (type_identifier) @type.name
    type: (type_identifier) @type.alias)) @type.alias.def

; Generic type parameters (Go 1.18+)
(type_declaration
  (type_spec
    name: (type_identifier) @type.name
    type_parameters: (type_parameter_list) @type.params)) @type.generic.def

; ==================================
; Struct Fields
; ==================================

; Named field
(field_declaration
  name: (field_identifier) @field.name
  type: (_) @field.type)

; Embedded field (anonymous)
(field_declaration
  type: (type_identifier) @field.embedded)

; Field with tag
(field_declaration
  name: (field_identifier) @field.name
  type: (_) @field.type
  tag: (raw_string_literal) @field.tag)

; ==================================
; Interface Methods
; ==================================

(method_spec
  name: (field_identifier) @interface.method.name
  parameters: (parameter_list) @interface.method.params
  result: (_)? @interface.method.return)

; ==================================
; Constants and Variables
; ==================================

; Single const declaration
(const_declaration
  (const_spec
    name: (identifier) @const.name
    type: (_)? @const.type
    value: (_)? @const.value))

; Single var declaration
(var_declaration
  (var_spec
    name: (identifier) @var.name
    type: (_)? @var.type
    value: (_)? @var.value))

; ==================================
; Comments (for documentation)
; ==================================

; Line comment
(comment) @comment.line

; Block comment
(comment) @comment.block

; ==================================
; Composite Patterns for Analysis
; ==================================

; Exported function (name starts with uppercase)
(function_declaration
  name: (identifier) @function.exported
  (#match? @function.exported "^[A-Z]"))

; Exported type (name starts with uppercase)
(type_declaration
  (type_spec
    name: (type_identifier) @type.exported
    (#match? @type.exported "^[A-Z]")))

; Test function
(function_declaration
  name: (identifier) @function.test
  (#match? @function.test "^Test"))

; Benchmark function
(function_declaration
  name: (identifier) @function.benchmark
  (#match? @function.benchmark "^Benchmark"))

; Example function (for documentation)
(function_declaration
  name: (identifier) @function.example
  (#match? @function.example "^Example"))
