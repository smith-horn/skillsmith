/**
 * SMI-1306: Rust Language Adapter Tests
 *
 * Comprehensive tests for the Rust adapter including:
 * - Import extraction (use statements, extern crate)
 * - Export detection (pub visibility)
 * - Function extraction (sync, async, with attributes)
 * - Cargo.toml parsing
 * - Framework detection rules
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RustAdapter, parseCargoToml } from '../rust.js'

describe('RustAdapter', () => {
  let adapter: RustAdapter

  beforeEach(() => {
    adapter = new RustAdapter()
  })

  afterEach(() => {
    adapter.dispose()
  })

  describe('canHandle', () => {
    it('handles .rs files', () => {
      expect(adapter.canHandle('main.rs')).toBe(true)
      expect(adapter.canHandle('lib.rs')).toBe(true)
      expect(adapter.canHandle('path/to/module.rs')).toBe(true)
    })

    it('does not handle non-Rust files', () => {
      expect(adapter.canHandle('main.ts')).toBe(false)
      expect(adapter.canHandle('main.py')).toBe(false)
      expect(adapter.canHandle('main.go')).toBe(false)
      expect(adapter.canHandle('main.java')).toBe(false)
      expect(adapter.canHandle('Cargo.toml')).toBe(false)
    })

    it('handles case-insensitive extensions', () => {
      expect(adapter.canHandle('main.RS')).toBe(true)
      expect(adapter.canHandle('main.Rs')).toBe(true)
    })
  })

  describe('parseFile - imports', () => {
    it('extracts simple use statement', () => {
      const content = `
use std::io;
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'std::io',
        namedImports: ['io'],
        isTypeOnly: false,
        sourceFile: 'main.rs',
      })
    })

    it('extracts use with alias', () => {
      const content = `
use std::collections::HashMap as Map;
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'std::collections::HashMap',
        defaultImport: 'Map',
      })
    })

    it('extracts glob import', () => {
      const content = `
use std::prelude::*;
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'std::prelude',
        namespaceImport: '*',
        namedImports: [],
      })
    })

    it('extracts grouped imports', () => {
      const content = `
use std::{io, fs, path};
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'std',
        namedImports: ['io', 'fs', 'path'],
      })
    })

    it('extracts crate-relative imports', () => {
      const content = `
use crate::models::User;
use crate::utils::helpers;
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0].module).toBe('crate::models::User')
      expect(result.imports[1].module).toBe('crate::utils::helpers')
    })

    it('extracts super imports', () => {
      const content = `
use super::parent_module;
use super::super::grandparent;
`
      const result = adapter.parseFile(content, 'child.rs')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0].module).toBe('super::parent_module')
    })

    it('extracts self imports', () => {
      const content = `
use self::submodule;
`
      const result = adapter.parseFile(content, 'mod.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe('self::submodule')
    })

    it('extracts extern crate', () => {
      const content = `
extern crate serde;
extern crate serde_json as json;
`
      const result = adapter.parseFile(content, 'lib.rs')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: 'serde',
        namedImports: [],
      })
      expect(result.imports[1]).toMatchObject({
        module: 'serde_json',
        defaultImport: 'json',
      })
    })

    it('handles grouped imports with self', () => {
      const content = `
use actix_web::{self, web, App, HttpServer};
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].namedImports).toContain('web')
      expect(result.imports[0].namedImports).toContain('App')
      expect(result.imports[0].namedImports).toContain('HttpServer')
      // self should be filtered out
      expect(result.imports[0].namedImports).not.toContain('self')
    })
  })

  describe('parseFile - exports', () => {
    it('detects pub struct', () => {
      const content = `
pub struct User {
    id: u64,
    name: String,
}

struct PrivateData {
    secret: String,
}
`
      const result = adapter.parseFile(content, 'models.rs')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'User',
        kind: 'struct',
        isDefault: false,
        sourceFile: 'models.rs',
        visibility: 'public',
      })
    })

    it('detects pub enum', () => {
      const content = `
pub enum Status {
    Active,
    Inactive,
}

enum InternalState {
    Running,
    Stopped,
}
`
      const result = adapter.parseFile(content, 'types.rs')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Status',
        kind: 'enum',
        visibility: 'public',
      })
    })

    it('detects pub trait', () => {
      const content = `
pub trait Serialize {
    fn serialize(&self) -> Vec<u8>;
}

trait InternalFormat {
    fn format(&self) -> String;
}
`
      const result = adapter.parseFile(content, 'traits.rs')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Serialize',
        kind: 'trait',
        visibility: 'public',
      })
    })

    it('detects pub fn', () => {
      const content = `
pub fn public_function() {
}

fn private_function() {
}

pub async fn async_public() {
}
`
      const result = adapter.parseFile(content, 'lib.rs')

      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toContain('public_function')
      expect(result.exports.map((e) => e.name)).toContain('async_public')
      expect(result.exports.map((e) => e.name)).not.toContain('private_function')
    })

    it('detects pub mod', () => {
      const content = `
pub mod api;
pub mod handlers;
mod internal;
`
      const result = adapter.parseFile(content, 'lib.rs')

      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toContain('api')
      expect(result.exports.map((e) => e.name)).toContain('handlers')
      expect(result.exports.every((e) => e.kind === 'module')).toBe(true)
    })

    it('detects pub type', () => {
      const content = `
pub type Result<T> = std::result::Result<T, Error>;
type InternalResult = Result<()>;
`
      const result = adapter.parseFile(content, 'types.rs')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Result',
        kind: 'type',
        visibility: 'public',
      })
    })

    it('detects pub const and pub static', () => {
      const content = `
pub const MAX_SIZE: usize = 1024;
pub static GLOBAL_CONFIG: Config = Config::new();
const INTERNAL_LIMIT: usize = 512;
static INTERNAL_STATE: State = State::new();
`
      const result = adapter.parseFile(content, 'config.rs')

      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toContain('MAX_SIZE')
      expect(result.exports.map((e) => e.name)).toContain('GLOBAL_CONFIG')
      expect(result.exports.every((e) => e.kind === 'variable')).toBe(true)
    })

    it('handles pub(crate) visibility', () => {
      const content = `
pub(crate) struct InternalStruct {
    field: u32,
}

pub(crate) fn internal_function() {
}
`
      const result = adapter.parseFile(content, 'internal.rs')

      // pub(crate) is still considered an export for analysis purposes
      expect(result.exports).toHaveLength(2)
      expect(result.exports.map((e) => e.name)).toContain('InternalStruct')
      expect(result.exports.map((e) => e.name)).toContain('internal_function')
    })
  })

  describe('parseFile - functions', () => {
    it('extracts function with no parameters', () => {
      const content = `
fn do_something() {
}
`
      const result = adapter.parseFile(content, 'main.rs')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'do_something',
        parameterCount: 0,
        isAsync: false,
        isExported: false,
        sourceFile: 'main.rs',
        line: 2,
      })
    })

    it('extracts function with parameters', () => {
      const content = `
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn greet(name: &str, times: u32) {
}
`
      const result = adapter.parseFile(content, 'math.rs')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'add',
        parameterCount: 2,
        isExported: false,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'greet',
        parameterCount: 2,
      })
    })

    it('extracts method with self parameter', () => {
      const content = `
impl User {
    fn get_name(&self) -> &str {
        &self.name
    }

    fn set_name(&mut self, name: String) {
        self.name = name;
    }

    fn new(name: String) -> Self {
        Self { name }
    }
}
`
      const result = adapter.parseFile(content, 'user.rs')

      expect(result.functions).toHaveLength(3)
      // get_name: &self is not counted
      expect(result.functions[0]).toMatchObject({
        name: 'get_name',
        parameterCount: 0,
      })
      // set_name: &mut self is not counted, name is
      expect(result.functions[1]).toMatchObject({
        name: 'set_name',
        parameterCount: 1,
      })
      // new: no self, name is counted
      expect(result.functions[2]).toMatchObject({
        name: 'new',
        parameterCount: 1,
      })
    })

    it('extracts async functions', () => {
      const content = `
async fn fetch_data() {
}

pub async fn handle_request(req: Request) -> Response {
}
`
      const result = adapter.parseFile(content, 'handlers.rs')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'fetch_data',
        isAsync: true,
        isExported: false,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'handle_request',
        isAsync: true,
        isExported: true,
        parameterCount: 1,
      })
    })

    it('extracts generic functions', () => {
      const content = `
fn process<T: Clone>(item: T) -> T {
    item.clone()
}

fn transform<T, U>(input: T, f: impl Fn(T) -> U) -> U {
    f(input)
}
`
      const result = adapter.parseFile(content, 'generic.rs')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'process',
        parameterCount: 1,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'transform',
        parameterCount: 2,
      })
    })

    it('detects attributes on functions', () => {
      const content = `
#[test]
fn test_addition() {
    assert_eq!(2 + 2, 4);
}

#[tokio::test]
async fn test_async() {
}

#[derive(Debug)]
#[inline]
pub fn optimized() {
}
`
      const result = adapter.parseFile(content, 'tests.rs')

      expect(result.functions).toHaveLength(3)
      expect(result.functions[0].attributes).toEqual(['test'])
      expect(result.functions[1].attributes).toEqual(['tokio::test'])
      expect(result.functions[2].attributes).toEqual(['derive', 'inline'])
    })

    it('correctly reports line numbers', () => {
      const content = `fn first() {}

fn second() {}

fn third() {}
`
      const result = adapter.parseFile(content, 'lines.rs')

      expect(result.functions).toHaveLength(3)
      expect(result.functions[0].line).toBe(1)
      expect(result.functions[1].line).toBe(3)
      expect(result.functions[2].line).toBe(5)
    })
  })

  describe('parseFile - complex cases', () => {
    it('parses a complete Rust file', () => {
      const content = `
use std::io::{self, Read, Write};
use serde::{Deserialize, Serialize};
use actix_web::{web, App, HttpServer};

pub struct AppConfig {
    port: u16,
    host: String,
}

pub trait Handler {
    fn handle(&self, req: Request) -> Response;
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
}

pub async fn start_server(config: AppConfig) -> io::Result<()> {
    HttpServer::new(|| {
        App::new()
    })
    .bind((config.host, config.port))?
    .run()
    .await
}

fn internal_helper() {
}

pub const DEFAULT_PORT: u16 = 8080;
`
      const result = adapter.parseFile(content, 'server.rs')

      // Imports
      expect(result.imports).toHaveLength(3)
      expect(result.imports.map((i) => i.module)).toContain('std::io')
      expect(result.imports.map((i) => i.module)).toContain('serde')
      expect(result.imports.map((i) => i.module)).toContain('actix_web')

      // Exports (pub items)
      expect(result.exports.map((e) => e.name)).toContain('AppConfig')
      expect(result.exports.map((e) => e.name)).toContain('Handler')
      expect(result.exports.map((e) => e.name)).toContain('Request')
      expect(result.exports.map((e) => e.name)).toContain('start_server')
      expect(result.exports.map((e) => e.name)).toContain('DEFAULT_PORT')
      expect(result.exports.map((e) => e.name)).not.toContain('internal_helper')

      // Functions
      const startServer = result.functions.find((f) => f.name === 'start_server')
      expect(startServer).toMatchObject({
        isAsync: true,
        isExported: true,
        parameterCount: 1,
      })

      const helper = result.functions.find((f) => f.name === 'internal_helper')
      expect(helper).toMatchObject({
        isAsync: false,
        isExported: false,
        parameterCount: 0,
      })
    })
  })

  describe('getFrameworkRules', () => {
    it('includes Actix framework detection', () => {
      const rules = adapter.getFrameworkRules()
      const actix = rules.find((r) => r.name === 'Actix')

      expect(actix).toBeDefined()
      expect(actix?.depIndicators).toContain('actix-web')
      expect(actix?.importIndicators).toContain('actix_web')
    })

    it('includes Tokio detection', () => {
      const rules = adapter.getFrameworkRules()
      const tokio = rules.find((r) => r.name === 'Tokio')

      expect(tokio).toBeDefined()
      expect(tokio?.depIndicators).toContain('tokio')
    })

    it('includes Serde detection', () => {
      const rules = adapter.getFrameworkRules()
      const serde = rules.find((r) => r.name === 'Serde')

      expect(serde).toBeDefined()
      expect(serde?.depIndicators).toContain('serde')
      expect(serde?.depIndicators).toContain('serde_json')
    })

    it('includes Axum detection', () => {
      const rules = adapter.getFrameworkRules()
      const axum = rules.find((r) => r.name === 'Axum')

      expect(axum).toBeDefined()
      expect(axum?.importIndicators).toContain('axum')
    })

    it('includes SQLx detection', () => {
      const rules = adapter.getFrameworkRules()
      const sqlx = rules.find((r) => r.name === 'SQLx')

      expect(sqlx).toBeDefined()
      expect(sqlx?.depIndicators).toContain('sqlx')
    })

    it('includes Clap detection', () => {
      const rules = adapter.getFrameworkRules()
      const clap = rules.find((r) => r.name === 'Clap')

      expect(clap).toBeDefined()
      expect(clap?.depIndicators).toContain('clap')
    })
  })

  describe('parseIncremental', () => {
    it('returns same result as parseFile', () => {
      const content = `
use std::io;

pub fn hello() {
    println!("Hello");
}
`
      const parseResult = adapter.parseFile(content, 'main.rs')
      const incrementalResult = adapter.parseIncremental(content, 'main.rs')

      expect(incrementalResult).toEqual(parseResult)
    })
  })
})

describe('parseCargoToml', () => {
  it('extracts regular dependencies', () => {
    const content = `
[package]
name = "my-app"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = "1.28"
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ name: 'serde', version: '1.0', isDev: false })
    expect(result).toContainEqual({ name: 'tokio', version: '1.28', isDev: false })
  })

  it('extracts dev dependencies', () => {
    const content = `
[dependencies]
serde = "1.0"

[dev-dependencies]
mockall = "0.11"
criterion = "0.5"
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(3)
    expect(result.find((d) => d.name === 'serde')?.isDev).toBe(false)
    expect(result.find((d) => d.name === 'mockall')?.isDev).toBe(true)
    expect(result.find((d) => d.name === 'criterion')?.isDev).toBe(true)
  })

  it('handles table-format dependencies', () => {
    const content = `
[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1.28", features = ["full"] }
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ name: 'serde', version: '1.0', isDev: false })
    expect(result).toContainEqual({ name: 'tokio', version: '1.28', isDev: false })
  })

  it('handles git/path dependencies', () => {
    const content = `
[dependencies]
local-lib = { path = "../local-lib" }
git-lib = { git = "https://github.com/user/repo" }
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(2)
    expect(result.find((d) => d.name === 'local-lib')).toMatchObject({
      name: 'local-lib',
      version: 'git/path',
      isDev: false,
    })
  })

  it('handles build dependencies', () => {
    const content = `
[dependencies]
serde = "1.0"

[build-dependencies]
cc = "1.0"
`
    const result = parseCargoToml(content)

    // Build dependencies are not marked as dev
    expect(result).toHaveLength(2)
    expect(result.find((d) => d.name === 'cc')?.isDev).toBe(false)
  })

  it('parses complete Cargo.toml', () => {
    const content = `
[package]
name = "my-awesome-app"
version = "0.1.0"
edition = "2021"

[dependencies]
actix-web = "4.0"
serde = { version = "1.0", features = ["derive"] }
sqlx = { version = "0.7", features = ["postgres", "runtime-tokio"] }
tokio = { version = "1.28", features = ["full"] }

[dev-dependencies]
mockall = "0.11"
tokio-test = "0.4"

[build-dependencies]
prost-build = "0.12"
`
    const result = parseCargoToml(content)

    expect(result.filter((d) => !d.isDev).length).toBe(5)
    expect(result.filter((d) => d.isDev).length).toBe(2)
    expect(result.map((d) => d.name)).toContain('actix-web')
    expect(result.map((d) => d.name)).toContain('mockall')
  })

  it('handles empty Cargo.toml', () => {
    const content = `
[package]
name = "minimal"
version = "0.1.0"
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(0)
  })

  it('ignores comments', () => {
    const content = `
[dependencies]
# This is a comment
serde = "1.0"
# tokio = "1.28"
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('serde')
  })

  it('stops parsing at other sections', () => {
    const content = `
[dependencies]
serde = "1.0"

[features]
default = ["full"]
full = []

[profile.release]
opt-level = 3
`
    const result = parseCargoToml(content)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('serde')
  })
})
