/**
 * SMI-1305: Go Language Adapter Tests
 *
 * Comprehensive tests for the Go adapter including:
 * - Import extraction (single and block imports)
 * - Export detection (capitalization-based visibility)
 * - Function extraction (with receivers)
 * - go.mod parsing
 * - Framework detection rules
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GoAdapter, parseGoMod } from '../go.js'

describe('GoAdapter', () => {
  let adapter: GoAdapter

  beforeEach(() => {
    adapter = new GoAdapter()
  })

  afterEach(() => {
    adapter.dispose()
  })

  describe('canHandle', () => {
    it('handles .go files', () => {
      expect(adapter.canHandle('main.go')).toBe(true)
      expect(adapter.canHandle('handler.go')).toBe(true)
      expect(adapter.canHandle('path/to/file.go')).toBe(true)
    })

    it('does not handle non-Go files', () => {
      expect(adapter.canHandle('main.ts')).toBe(false)
      expect(adapter.canHandle('main.py')).toBe(false)
      expect(adapter.canHandle('main.rs')).toBe(false)
      expect(adapter.canHandle('main.java')).toBe(false)
      expect(adapter.canHandle('go.mod')).toBe(false)
    })

    it('handles case-insensitive extensions', () => {
      expect(adapter.canHandle('main.GO')).toBe(true)
      expect(adapter.canHandle('main.Go')).toBe(true)
    })
  })

  describe('parseFile - imports', () => {
    it('extracts single import', () => {
      const content = `
package main

import "fmt"
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'fmt',
        namedImports: [],
        isTypeOnly: false,
        sourceFile: 'main.go',
      })
    })

    it('extracts single import with alias', () => {
      const content = `
package main

import f "fmt"
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'fmt',
        defaultImport: 'f',
      })
    })

    it('extracts import block', () => {
      const content = `
package main

import (
    "fmt"
    "os"
    "strings"
)
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.imports).toHaveLength(3)
      expect(result.imports.map((i) => i.module)).toEqual(['fmt', 'os', 'strings'])
    })

    it('extracts import block with aliases', () => {
      const content = `
package main

import (
    "fmt"
    gin "github.com/gin-gonic/gin"
    _ "github.com/lib/pq"
    . "github.com/onsi/ginkgo"
)
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.imports).toHaveLength(4)
      expect(result.imports[1]).toMatchObject({
        module: 'github.com/gin-gonic/gin',
        defaultImport: 'gin',
      })
      expect(result.imports[2]).toMatchObject({
        module: 'github.com/lib/pq',
        defaultImport: '_',
      })
      expect(result.imports[3]).toMatchObject({
        module: 'github.com/onsi/ginkgo',
        defaultImport: '.',
      })
    })

    it('extracts external package imports', () => {
      const content = `
package main

import (
    "github.com/gin-gonic/gin"
    "gorm.io/gorm"
    "google.golang.org/grpc"
)
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.imports).toHaveLength(3)
      expect(result.imports.map((i) => i.module)).toContain('github.com/gin-gonic/gin')
      expect(result.imports.map((i) => i.module)).toContain('gorm.io/gorm')
      expect(result.imports.map((i) => i.module)).toContain('google.golang.org/grpc')
    })
  })

  describe('parseFile - exports', () => {
    it('detects exported struct types', () => {
      const content = `
package main

type User struct {
    ID   int
    Name string
}

type privateData struct {
    secret string
}
`
      const result = adapter.parseFile(content, 'models.go')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'User',
        kind: 'struct',
        isDefault: false,
        sourceFile: 'models.go',
      })
    })

    it('detects exported interface types', () => {
      const content = `
package main

type Reader interface {
    Read(p []byte) (n int, err error)
}

type writer interface {
    Write(p []byte) (n int, err error)
}
`
      const result = adapter.parseFile(content, 'interfaces.go')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Reader',
        kind: 'interface',
        isDefault: false,
      })
    })

    it('detects exported functions', () => {
      const content = `
package main

func PublicFunc() {
}

func privateFunc() {
}

func AnotherPublic(a, b int) int {
    return a + b
}
`
      const result = adapter.parseFile(content, 'funcs.go')

      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toEqual(['PublicFunc', 'AnotherPublic'])
      expect(result.exports[0].kind).toBe('function')
    })

    it('detects exported methods', () => {
      const content = `
package main

func (u *User) GetName() string {
    return u.Name
}

func (u *User) setName(name string) {
    u.Name = name
}
`
      const result = adapter.parseFile(content, 'methods.go')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'GetName',
        kind: 'function',
      })
    })

    it('detects exported constants', () => {
      const content = `
package main

const MaxSize = 1024
const minSize = 64

const (
    StatusOK = 200
    statusError = 500
)
`
      const result = adapter.parseFile(content, 'constants.go')

      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toContain('MaxSize')
      expect(result.exports.map((e) => e.name)).toContain('StatusOK')
      expect(result.exports.map((e) => e.name)).not.toContain('minSize')
    })

    it('detects exported variables', () => {
      const content = `
package main

var GlobalConfig Config
var internalState state
`
      const result = adapter.parseFile(content, 'vars.go')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'GlobalConfig',
        kind: 'variable',
      })
    })
  })

  describe('parseFile - functions', () => {
    it('extracts function with no parameters', () => {
      const content = `
package main

func doSomething() {
}
`
      const result = adapter.parseFile(content, 'main.go')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'doSomething',
        parameterCount: 0,
        isAsync: false,
        isExported: false,
        sourceFile: 'main.go',
        line: 4,
      })
    })

    it('extracts function with parameters', () => {
      const content = `
package main

func add(a int, b int) int {
    return a + b
}

func greet(name string, age int, active bool) {
}
`
      const result = adapter.parseFile(content, 'math.go')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'add',
        parameterCount: 2,
        isExported: false,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'greet',
        parameterCount: 3,
      })
    })

    it('extracts method with receiver', () => {
      const content = `
package main

func (u *User) GetName() string {
    return u.Name
}

func (s Server) Start() error {
    return nil
}
`
      const result = adapter.parseFile(content, 'methods.go')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'GetName',
        parameterCount: 0,
        isExported: true,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'Start',
        parameterCount: 0,
        isExported: true,
      })
    })

    it('correctly identifies exported functions', () => {
      const content = `
package main

func PublicOne() {}
func privateOne() {}
func PublicTwo(x int) {}
func privateTwo(x int) {}
`
      const result = adapter.parseFile(content, 'mixed.go')

      expect(result.functions).toHaveLength(4)
      expect(result.functions.filter((f) => f.isExported)).toHaveLength(2)
      expect(result.functions.filter((f) => !f.isExported)).toHaveLength(2)
    })

    it('correctly reports line numbers', () => {
      const content = `package main

func first() {}

func second() {}

func third() {}
`
      const result = adapter.parseFile(content, 'lines.go')

      expect(result.functions).toHaveLength(3)
      expect(result.functions[0].line).toBe(3)
      expect(result.functions[1].line).toBe(5)
      expect(result.functions[2].line).toBe(7)
    })
  })

  describe('parseFile - complex cases', () => {
    it('parses a complete Go file', () => {
      const content = `
package handlers

import (
    "encoding/json"
    "net/http"

    "github.com/gin-gonic/gin"
    "gorm.io/gorm"
)

type UserHandler struct {
    db *gorm.DB
}

type userResponse struct {
    ID   int    \`json:"id"\`
    Name string \`json:"name"\`
}

func NewUserHandler(db *gorm.DB) *UserHandler {
    return &UserHandler{db: db}
}

func (h *UserHandler) GetUser(c *gin.Context) {
    var user userResponse
    c.JSON(http.StatusOK, user)
}

func (h *UserHandler) createUser(c *gin.Context) {
    // private method
}

const Version = "1.0.0"

var DefaultTimeout = 30
`
      const result = adapter.parseFile(content, 'handlers/user.go')

      // Imports
      expect(result.imports).toHaveLength(4)
      expect(result.imports.map((i) => i.module)).toContain('encoding/json')
      expect(result.imports.map((i) => i.module)).toContain('github.com/gin-gonic/gin')

      // Exports (uppercase identifiers)
      expect(result.exports.map((e) => e.name)).toContain('UserHandler')
      expect(result.exports.map((e) => e.name)).toContain('NewUserHandler')
      expect(result.exports.map((e) => e.name)).toContain('GetUser')
      expect(result.exports.map((e) => e.name)).toContain('Version')
      expect(result.exports.map((e) => e.name)).toContain('DefaultTimeout')
      expect(result.exports.map((e) => e.name)).not.toContain('userResponse')
      expect(result.exports.map((e) => e.name)).not.toContain('createUser')

      // Functions
      expect(result.functions).toHaveLength(3)
      expect(result.functions.find((f) => f.name === 'NewUserHandler')?.isExported).toBe(true)
      expect(result.functions.find((f) => f.name === 'createUser')?.isExported).toBe(false)
    })
  })

  describe('getFrameworkRules', () => {
    it('includes Gin framework detection', () => {
      const rules = adapter.getFrameworkRules()
      const gin = rules.find((r) => r.name === 'Gin')

      expect(gin).toBeDefined()
      expect(gin?.depIndicators).toContain('github.com/gin-gonic/gin')
      expect(gin?.importIndicators).toContain('github.com/gin-gonic/gin')
    })

    it('includes Echo framework detection', () => {
      const rules = adapter.getFrameworkRules()
      const echo = rules.find((r) => r.name === 'Echo')

      expect(echo).toBeDefined()
      expect(echo?.importIndicators).toContain('github.com/labstack/echo/v4')
    })

    it('includes GORM detection', () => {
      const rules = adapter.getFrameworkRules()
      const gorm = rules.find((r) => r.name === 'GORM')

      expect(gorm).toBeDefined()
      expect(gorm?.depIndicators).toContain('gorm.io/gorm')
    })

    it('includes gRPC detection', () => {
      const rules = adapter.getFrameworkRules()
      const grpc = rules.find((r) => r.name === 'gRPC')

      expect(grpc).toBeDefined()
      expect(grpc?.importIndicators).toContain('google.golang.org/grpc')
    })

    it('includes testify detection', () => {
      const rules = adapter.getFrameworkRules()
      const testify = rules.find((r) => r.name === 'testify')

      expect(testify).toBeDefined()
      expect(testify?.importIndicators).toContain('github.com/stretchr/testify/assert')
    })
  })

  describe('parseIncremental', () => {
    it('returns same result as parseFile', () => {
      const content = `
package main

import "fmt"

func Hello() {
    fmt.Println("Hello")
}
`
      const parseResult = adapter.parseFile(content, 'main.go')
      const incrementalResult = adapter.parseIncremental(content, 'main.go')

      expect(incrementalResult).toEqual(parseResult)
    })
  })
})

describe('parseGoMod', () => {
  it('extracts module name', () => {
    const content = `
module github.com/user/project

go 1.21
`
    const result = parseGoMod(content)

    expect(result.module).toBe('github.com/user/project')
  })

  it('extracts Go version', () => {
    const content = `
module example.com/myapp

go 1.21.5
`
    const result = parseGoMod(content)

    expect(result.goVersion).toBe('1.21.5')
  })

  it('extracts single require directive', () => {
    const content = `
module example.com/myapp

go 1.21

require github.com/gin-gonic/gin v1.9.0
`
    const result = parseGoMod(content)

    expect(result.require).toHaveLength(1)
    expect(result.require[0]).toEqual({
      path: 'github.com/gin-gonic/gin',
      version: 'v1.9.0',
    })
  })

  it('extracts require block', () => {
    const content = `
module example.com/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.0
    gorm.io/gorm v1.25.0
    github.com/spf13/cobra v1.7.0
)
`
    const result = parseGoMod(content)

    expect(result.require).toHaveLength(3)
    expect(result.require.map((r) => r.path)).toContain('github.com/gin-gonic/gin')
    expect(result.require.map((r) => r.path)).toContain('gorm.io/gorm')
    expect(result.require.map((r) => r.path)).toContain('github.com/spf13/cobra')
  })

  it('extracts single replace directive', () => {
    const content = `
module example.com/myapp

go 1.21

replace github.com/old/pkg => github.com/new/pkg v1.0.0
`
    const result = parseGoMod(content)

    expect(result.replace).toHaveLength(1)
    expect(result.replace[0]).toEqual({
      old: 'github.com/old/pkg',
      new: 'github.com/new/pkg',
      version: 'v1.0.0',
    })
  })

  it('extracts replace block', () => {
    const content = `
module example.com/myapp

go 1.21

replace (
    github.com/old/one => github.com/new/one v1.0.0
    github.com/old/two => ../local/two
)
`
    const result = parseGoMod(content)

    expect(result.replace).toHaveLength(2)
    expect(result.replace[0].old).toBe('github.com/old/one')
    expect(result.replace[1].new).toBe('../local/two')
  })

  it('parses complete go.mod file', () => {
    const content = `
module github.com/user/myproject

go 1.21

require (
    github.com/gin-gonic/gin v1.9.0
    gorm.io/gorm v1.25.0
    github.com/stretchr/testify v1.8.4
)

require (
    github.com/indirect/dep v0.1.0 // indirect
)

replace github.com/old/broken => github.com/new/fixed v1.0.0
`
    const result = parseGoMod(content)

    expect(result.module).toBe('github.com/user/myproject')
    expect(result.goVersion).toBe('1.21')
    expect(result.require.length).toBeGreaterThanOrEqual(3)
    expect(result.replace).toHaveLength(1)
  })

  it('handles minimal go.mod', () => {
    const content = `module example.com/minimal`
    const result = parseGoMod(content)

    expect(result.module).toBe('example.com/minimal')
    expect(result.goVersion).toBeUndefined()
    expect(result.require).toHaveLength(0)
    expect(result.replace).toHaveLength(0)
  })
})
