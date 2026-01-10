; SMI-1304: Python Tree-Sitter Queries
;
; Query patterns for extracting imports, exports, and functions
; from Python files using tree-sitter.
;
; These queries will be used for incremental parsing in SMI-1309.
; @see docs/architecture/multi-language-analysis.md

; ====================
; Import Statements
; ====================

; Simple import: import module
(import_statement
  name: (dotted_name) @import.module)

; Import with alias: import module as alias
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.module
    alias: (identifier) @import.alias))

; From import: from module import name
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (dotted_name) @import.name)

; From import with alias: from module import name as alias
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (aliased_import
    name: (dotted_name) @import.name
    alias: (identifier) @import.alias))

; From import wildcard: from module import *
(import_from_statement
  module_name: (dotted_name) @import.module
  (wildcard_import) @import.wildcard)

; Relative import: from . import module
(import_from_statement
  module_name: (relative_import
    (import_prefix) @import.relative
    (dotted_name)? @import.module)
  name: (_) @import.name)

; ====================
; Function Definitions
; ====================

; Regular function: def foo():
(function_definition
  name: (identifier) @function.name
  parameters: (parameters) @function.params
  return_type: (type)? @function.returnType
  body: (block) @function.body) @function.def

; Async function: async def foo():
(function_definition
  "async" @function.async
  name: (identifier) @function.name
  parameters: (parameters) @function.params
  return_type: (type)? @function.returnType
  body: (block) @function.body) @function.asyncDef

; Lambda expression: lambda x: x + 1
(lambda
  parameters: (lambda_parameters)? @function.params
  body: (_) @function.body) @function.lambda

; ====================
; Class Definitions
; ====================

; Class definition: class Foo:
(class_definition
  name: (identifier) @class.name
  body: (block) @class.body) @class.def

; Class with bases: class Foo(Bar, Baz):
(class_definition
  name: (identifier) @class.name
  superclasses: (argument_list
    (_) @class.base)
  body: (block) @class.body) @class.inheritance

; ====================
; Decorators
; ====================

; Function/class decorator: @decorator
(decorator
  (identifier) @decorator.name) @decorator

; Decorator with call: @decorator()
(decorator
  (call
    function: (identifier) @decorator.name
    arguments: (argument_list) @decorator.args)) @decorator.call

; Decorator with attribute: @module.decorator
(decorator
  (attribute
    object: (_) @decorator.module
    attribute: (identifier) @decorator.name)) @decorator.attribute

; ====================
; Exports (__all__)
; ====================

; __all__ = ['name1', 'name2']
(assignment
  left: (identifier) @export.allVar
  right: (list
    (string) @export.name)
  (#eq? @export.allVar "__all__")) @export.all

; __all__ += ['name']
(augmented_assignment
  left: (identifier) @export.allVar
  right: (list
    (string) @export.name)
  (#eq? @export.allVar "__all__")) @export.allAppend

; ====================
; Variable Assignments
; ====================

; Simple assignment: foo = value
(assignment
  left: (identifier) @variable.name
  right: (_) @variable.value) @variable.assignment

; Typed assignment: foo: Type = value
(assignment
  left: (identifier) @variable.name
  type: (type) @variable.type
  right: (_) @variable.value) @variable.typedAssignment

; Multiple assignment: a, b = values
(assignment
  left: (pattern_list
    (_) @variable.name)
  right: (_) @variable.value) @variable.multiAssignment

; ====================
; Type Hints (PEP 484)
; ====================

; Function parameter type hint
(typed_parameter
  (identifier) @param.name
  type: (type) @param.type) @param.typed

; Function return type hint
(function_definition
  return_type: (type) @function.returnType)

; ====================
; Docstrings
; ====================

; Module docstring (first statement)
(module
  (expression_statement
    (string) @docstring.module) @docstring.statement)

; Function docstring
(function_definition
  body: (block
    (expression_statement
      (string) @docstring.function)))

; Class docstring
(class_definition
  body: (block
    (expression_statement
      (string) @docstring.class)))

; ====================
; Special Patterns
; ====================

; if __name__ == "__main__":
(if_statement
  condition: (comparison_operator
    (identifier) @main.nameVar
    (string) @main.mainStr)
  (#eq? @main.nameVar "__name__")
  (#eq? @main.mainStr "\"__main__\"")) @main.block

; Type alias: TypeAlias = Union[A, B]
(assignment
  left: (identifier) @type.aliasName
  right: (subscript) @type.aliasValue
  type: (type
    (identifier) @type.aliasType)
  (#eq? @type.aliasType "TypeAlias")) @type.alias
