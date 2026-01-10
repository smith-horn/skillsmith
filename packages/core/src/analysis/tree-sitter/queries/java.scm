; SMI-1307: Java Language Tree-Sitter Queries
;
; Tree-sitter queries for extracting imports, exports, functions,
; and type definitions from Java source files.
;
; @see docs/architecture/multi-language-analysis.md

; ==================================
; Package Declaration
; ==================================

(package_declaration
  (scoped_identifier) @package.name)

(package_declaration
  (identifier) @package.name)

; ==================================
; Import Statements
; ==================================

; Regular import: import com.example.Class;
(import_declaration
  (scoped_identifier) @import.path) @import.def

; Static import: import static com.example.Class.method;
(import_declaration
  "static" @import.static
  (scoped_identifier) @import.path) @import.static.def

; Wildcard import: import com.example.*;
(import_declaration
  (scoped_identifier) @import.path
  (asterisk) @import.wildcard) @import.wildcard.def

; ==================================
; Class Declarations
; ==================================

; Regular class
(class_declaration
  name: (identifier) @class.name) @class.def

; Class with modifiers
(class_declaration
  (modifiers
    (modifier) @class.modifier)
  name: (identifier) @class.name) @class.def

; Abstract class
(class_declaration
  (modifiers
    "abstract" @class.abstract)
  name: (identifier) @class.name) @class.abstract.def

; Final class
(class_declaration
  (modifiers
    "final" @class.final)
  name: (identifier) @class.name) @class.final.def

; Public class
(class_declaration
  (modifiers
    "public" @class.public)
  name: (identifier) @class.name) @class.public.def

; Generic class
(class_declaration
  name: (identifier) @class.name
  type_parameters: (type_parameters) @class.type_params) @class.generic.def

; Class extending another
(class_declaration
  name: (identifier) @class.name
  (superclass
    (type_identifier) @class.extends)) @class.extends.def

; Class implementing interfaces
(class_declaration
  name: (identifier) @class.name
  (super_interfaces
    (type_list
      (type_identifier) @class.implements))) @class.implements.def

; ==================================
; Interface Declarations
; ==================================

(interface_declaration
  name: (identifier) @interface.name) @interface.def

; Interface with modifiers
(interface_declaration
  (modifiers
    (modifier) @interface.modifier)
  name: (identifier) @interface.name) @interface.def

; Generic interface
(interface_declaration
  name: (identifier) @interface.name
  type_parameters: (type_parameters) @interface.type_params) @interface.generic.def

; ==================================
; Enum Declarations
; ==================================

(enum_declaration
  name: (identifier) @enum.name) @enum.def

; Enum constants
(enum_constant
  name: (identifier) @enum.constant.name) @enum.constant.def

; ==================================
; Annotation Type Declarations
; ==================================

(annotation_type_declaration
  name: (identifier) @annotation_type.name) @annotation_type.def

; ==================================
; Method Declarations
; ==================================

; Regular method
(method_declaration
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.def

; Method with return type
(method_declaration
  type: (_) @method.return_type
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.def

; Method with modifiers
(method_declaration
  (modifiers
    (modifier) @method.modifier)
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.def

; Public method
(method_declaration
  (modifiers
    "public" @method.public)
  name: (identifier) @method.name) @method.public.def

; Private method
(method_declaration
  (modifiers
    "private" @method.private)
  name: (identifier) @method.name) @method.private.def

; Protected method
(method_declaration
  (modifiers
    "protected" @method.protected)
  name: (identifier) @method.name) @method.protected.def

; Static method
(method_declaration
  (modifiers
    "static" @method.static)
  name: (identifier) @method.name) @method.static.def

; Abstract method
(method_declaration
  (modifiers
    "abstract" @method.abstract)
  name: (identifier) @method.name) @method.abstract.def

; Synchronized method
(method_declaration
  (modifiers
    "synchronized" @method.synchronized)
  name: (identifier) @method.name) @method.synchronized.def

; Generic method
(method_declaration
  type_parameters: (type_parameters) @method.type_params
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.generic.def

; ==================================
; Constructor Declarations
; ==================================

(constructor_declaration
  name: (identifier) @constructor.name
  parameters: (formal_parameters) @constructor.params) @constructor.def

; Constructor with modifiers
(constructor_declaration
  (modifiers
    (modifier) @constructor.modifier)
  name: (identifier) @constructor.name
  parameters: (formal_parameters) @constructor.params) @constructor.def

; ==================================
; Annotations
; ==================================

; Simple annotation: @Override
(marker_annotation
  name: (identifier) @annotation.name) @annotation.marker

; Annotation with single value: @SuppressWarnings("unchecked")
(annotation
  name: (identifier) @annotation.name
  arguments: (annotation_argument_list) @annotation.args) @annotation.def

; Scoped annotation: @org.junit.Test
(marker_annotation
  name: (scoped_identifier) @annotation.name) @annotation.scoped

; ==================================
; Field Declarations
; ==================================

(field_declaration
  (modifiers)? @field.modifiers
  type: (_) @field.type
  declarator: (variable_declarator
    name: (identifier) @field.name)) @field.def

; ==================================
; Method Parameters
; ==================================

; Formal parameter
(formal_parameter
  type: (_) @param.type
  name: (identifier) @param.name) @param.def

; Spread parameter (varargs): String... args
(spread_parameter
  type: (_) @param.type
  (variable_declarator
    name: (identifier) @param.name)) @param.varargs.def

; ==================================
; Type Patterns
; ==================================

; Generic type: List<String>
(generic_type
  (type_identifier) @type.name
  (type_arguments) @type.args) @type.generic

; Array type: String[]
(array_type
  element: (_) @type.element) @type.array

; ==================================
; Comments (for documentation)
; ==================================

; Line comment
(line_comment) @comment.line

; Block comment
(block_comment) @comment.block

; ==================================
; Composite Patterns for Analysis
; ==================================

; Test method (JUnit)
(method_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @_test))
  name: (identifier) @method.test
  (#eq? @_test "Test"))

; Override method
(method_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @_override))
  name: (identifier) @method.override
  (#eq? @_override "Override"))

; Spring Controller method
(method_declaration
  (modifiers
    (annotation
      name: (identifier) @_mapping))
  name: (identifier) @method.endpoint
  (#match? @_mapping ".*Mapping"))

; Spring Autowired field
(field_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @_autowired))
  declarator: (variable_declarator
    name: (identifier) @field.autowired)
  (#eq? @_autowired "Autowired"))

; Lombok annotations
(class_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @_lombok))
  name: (identifier) @class.lombok
  (#match? @_lombok "^(Data|Getter|Setter|Builder|NoArgsConstructor|AllArgsConstructor)$"))

; Main method pattern
(method_declaration
  (modifiers
    "public" @_public
    "static" @_static)
  type: (void_type)
  name: (identifier) @method.main
  parameters: (formal_parameters
    (formal_parameter
      type: (array_type
        element: (type_identifier) @_string_type)))
  (#eq? @method.main "main")
  (#eq? @_string_type "String"))
