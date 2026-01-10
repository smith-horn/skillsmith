; SMI-1306: Rust Language Tree-Sitter Queries
;
; Tree-sitter queries for extracting imports, exports, functions,
; and type definitions from Rust source files.
;
; @see docs/architecture/multi-language-analysis.md

; ==================================
; Use Statements
; ==================================

; Simple use: use module::path::item;
(use_declaration
  argument: (scoped_identifier) @import.path)

; Glob import: use module::*;
(use_declaration
  argument: (use_wildcard
    path: (scoped_identifier) @import.path))

; Grouped import: use module::{item1, item2};
(use_declaration
  argument: (use_list) @import.group)

; Use with alias: use module::item as alias;
(use_declaration
  argument: (use_as_clause
    path: (scoped_identifier) @import.path
    alias: (identifier) @import.alias))

; Crate-relative import: use crate::module;
(use_declaration
  argument: (scoped_identifier
    path: (crate) @import.crate))

; Super import: use super::module;
(use_declaration
  argument: (scoped_identifier
    path: (super) @import.super))

; Self import: use self::module;
(use_declaration
  argument: (scoped_identifier
    path: (self) @import.self))

; ==================================
; Extern Crate Declarations
; ==================================

(extern_crate_declaration
  name: (identifier) @extern.name)

(extern_crate_declaration
  name: (identifier) @extern.name
  alias: (identifier) @extern.alias)

; ==================================
; Function Definitions
; ==================================

; Regular function
(function_item
  name: (identifier) @function.name
  parameters: (parameters) @function.params) @function.def

; Async function
(function_item
  "async" @function.async
  name: (identifier) @function.name
  parameters: (parameters) @function.params) @function.async.def

; Public function
(function_item
  (visibility_modifier) @function.visibility
  name: (identifier) @function.name
  parameters: (parameters) @function.params) @function.public.def

; Function with return type
(function_item
  name: (identifier) @function.name
  parameters: (parameters) @function.params
  return_type: (type_identifier) @function.return) @function.typed.def

; Function with generic parameters
(function_item
  name: (identifier) @function.name
  type_parameters: (type_parameters) @function.generics
  parameters: (parameters) @function.params) @function.generic.def

; ==================================
; Visibility Modifiers
; ==================================

; pub
(visibility_modifier) @visibility.public

; pub(crate)
(visibility_modifier
  path: (crate) @visibility.crate)

; pub(super)
(visibility_modifier
  path: (super) @visibility.super)

; pub(in path)
(visibility_modifier
  path: (scoped_identifier) @visibility.path)

; ==================================
; Struct Definitions
; ==================================

; Regular struct
(struct_item
  name: (type_identifier) @struct.name) @struct.def

; Public struct
(struct_item
  (visibility_modifier) @struct.visibility
  name: (type_identifier) @struct.name) @struct.public.def

; Struct with generic parameters
(struct_item
  name: (type_identifier) @struct.name
  type_parameters: (type_parameters) @struct.generics) @struct.generic.def

; Struct field
(field_declaration
  name: (field_identifier) @field.name
  type: (_) @field.type)

; ==================================
; Enum Definitions
; ==================================

; Regular enum
(enum_item
  name: (type_identifier) @enum.name) @enum.def

; Public enum
(enum_item
  (visibility_modifier) @enum.visibility
  name: (type_identifier) @enum.name) @enum.public.def

; Enum variant
(enum_variant
  name: (identifier) @enum.variant.name)

; ==================================
; Trait Definitions
; ==================================

; Regular trait
(trait_item
  name: (type_identifier) @trait.name) @trait.def

; Public trait
(trait_item
  (visibility_modifier) @trait.visibility
  name: (type_identifier) @trait.name) @trait.public.def

; Trait with generic parameters
(trait_item
  name: (type_identifier) @trait.name
  type_parameters: (type_parameters) @trait.generics) @trait.generic.def

; Trait bounds
(trait_item
  bounds: (trait_bounds) @trait.bounds)

; ==================================
; Impl Blocks
; ==================================

; Impl for type
(impl_item
  type: (type_identifier) @impl.type) @impl.def

; Impl trait for type
(impl_item
  trait: (type_identifier) @impl.trait
  type: (type_identifier) @impl.type) @impl.trait.def

; Impl with generic parameters
(impl_item
  type_parameters: (type_parameters) @impl.generics
  type: (type_identifier) @impl.type) @impl.generic.def

; ==================================
; Module Declarations
; ==================================

; Mod declaration
(mod_item
  name: (identifier) @mod.name) @mod.def

; Public mod
(mod_item
  (visibility_modifier) @mod.visibility
  name: (identifier) @mod.name) @mod.public.def

; Mod with body (inline module)
(mod_item
  name: (identifier) @mod.name
  body: (declaration_list) @mod.body) @mod.inline.def

; ==================================
; Type Aliases
; ==================================

; Type alias
(type_item
  name: (type_identifier) @type.name
  type: (_) @type.value) @type.def

; Public type alias
(type_item
  (visibility_modifier) @type.visibility
  name: (type_identifier) @type.name) @type.public.def

; ==================================
; Constants and Statics
; ==================================

; Const declaration
(const_item
  name: (identifier) @const.name
  type: (_) @const.type
  value: (_) @const.value) @const.def

; Public const
(const_item
  (visibility_modifier) @const.visibility
  name: (identifier) @const.name) @const.public.def

; Static declaration
(static_item
  name: (identifier) @static.name
  type: (_) @static.type
  value: (_)? @static.value) @static.def

; ==================================
; Attributes
; ==================================

; Outer attribute #[attr]
(attribute_item
  (attribute
    (identifier) @attribute.name)) @attribute.outer

; Outer attribute with path #[path::attr]
(attribute_item
  (attribute
    (scoped_identifier) @attribute.path)) @attribute.outer.scoped

; Outer attribute with arguments #[attr(args)]
(attribute_item
  (attribute
    (identifier) @attribute.name
    arguments: (token_tree) @attribute.args)) @attribute.outer.with_args

; Inner attribute #![attr]
(inner_attribute_item
  (attribute
    (identifier) @attribute.inner.name)) @attribute.inner

; ==================================
; Macros
; ==================================

; Macro definition
(macro_definition
  name: (identifier) @macro.name) @macro.def

; Macro rules
(macro_rules!
  name: (identifier) @macro.rules.name) @macro.rules.def

; Macro invocation
(macro_invocation
  macro: (identifier) @macro.call.name) @macro.call

; Scoped macro invocation (path::macro!)
(macro_invocation
  macro: (scoped_identifier) @macro.call.scoped) @macro.call.scoped

; ==================================
; Comments
; ==================================

; Line comment
(line_comment) @comment.line

; Block comment
(block_comment) @comment.block

; Doc comment (///)
(line_comment) @comment.doc
(#match? @comment.doc "^///")

; Doc comment (//!)
(line_comment) @comment.doc.inner
(#match? @comment.doc.inner "^//!")

; ==================================
; Composite Patterns for Analysis
; ==================================

; Test function (has #[test] attribute)
(function_item
  (attribute_item
    (attribute
      (identifier) @_test))
  name: (identifier) @function.test
  (#eq? @_test "test"))

; Tokio test function
(function_item
  (attribute_item
    (attribute
      (scoped_identifier
        path: (identifier) @_tokio
        name: (identifier) @_test)))
  name: (identifier) @function.tokio_test
  (#eq? @_tokio "tokio")
  (#eq? @_test "test"))

; Derive macro usage
(attribute_item
  (attribute
    (identifier) @attr.derive
    arguments: (token_tree) @derive.traits)
  (#eq? @attr.derive "derive"))

; Serde derive
(attribute_item
  (attribute
    (identifier) @_derive
    arguments: (token_tree) @serde.derive)
  (#eq? @_derive "derive")
  (#match? @serde.derive "Serialize|Deserialize"))

; Async runtime entry point
(attribute_item
  (attribute
    (scoped_identifier
      path: (identifier) @_runtime
      name: (identifier) @_main))
  (#match? @_runtime "tokio|async_std|smol")
  (#eq? @_main "main"))
