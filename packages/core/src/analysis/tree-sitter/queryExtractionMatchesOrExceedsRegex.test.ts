/**
 * SMI-4293 / finding H3: Regression guard for query-based extraction.
 *
 * Before the WASM query path replaces the regex path, this test asserts
 * that for every Python fixture, the query-based extraction produces a
 * SUPERSET OR EQUAL SET of constructs relative to the regex baseline.
 * A missing construct in the query path blocks the PR — queries must be
 * extended until parity is reached.
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PythonAdapter } from '../adapters/python.js'
import { PythonIncrementalParser } from './pythonIncremental.js'

interface Fixture {
  name: string
  source: string
}

// Fixtures span every construct the regex extractor recognises, plus a
// handful of edge cases the original Python test suite exercises.
const FIXTURES: Fixture[] = [
  {
    name: 'simple-imports',
    source: `
import os
import sys
import json
    `,
  },
  {
    name: 'aliased-imports',
    source: `
import numpy as np
import pandas as pd
    `,
  },
  {
    name: 'from-imports',
    source: `
from os import path, getcwd
from typing import Optional, List
    `,
  },
  {
    name: 'from-aliased-and-wildcard',
    source: `
from django.http import HttpResponse as Resp
from utils import *
    `,
  },
  {
    name: 'top-level-functions-classes',
    source: `
def top_fn():
    pass

async def async_fn(a, b):
    return a + b

class PublicClass:
    def method(self):
        pass

class _Private:
    pass

def _hidden():
    pass
    `,
  },
  {
    name: 'all-export-list',
    source: `
__all__ = ["ExportedFn", "ExportedCls"]

def ExportedFn():
    pass

class ExportedCls:
    pass

def not_exported_but_public():
    pass
    `,
  },
  {
    name: 'nested-functions',
    source: `
def outer():
    def middle():
        def inner():
            pass
        return inner
    return middle
    `,
  },
  {
    name: 'decorators',
    source: `
@decorator
def decorated():
    pass

@decorator1
@decorator2
def multi_decorated():
    pass

@module.attr_decorator
def attr_decorated():
    pass
    `,
  },
  {
    name: 'type-hinted-function',
    source: `
def typed(a: int, b: str, c: Optional[List[int]]) -> Dict[str, Any]:
    pass
    `,
  },
  {
    name: 'empty-module',
    source: '',
  },
  {
    name: 'comments-only',
    source: `
# just a comment
# nothing else
    `,
  },
]

/**
 * A normalised view used for set comparison between extractors. We compare
 * by key properties only; line numbers are allowed to differ since the
 * regex path occasionally picks a different physical line for the same
 * logical construct (e.g. multiline imports).
 */
interface NormalizedSets {
  imports: Set<string>
  exports: Set<string>
  functions: Set<string>
}

function normalize(result: {
  imports: Array<{ module: string; namedImports: string[] }>
  exports: Array<{ name: string; kind: string }>
  functions: Array<{ name: string; isAsync: boolean }>
}): NormalizedSets {
  return {
    imports: new Set(
      result.imports.map((i) => `${i.module}::${[...i.namedImports].sort().join(',')}`)
    ),
    exports: new Set(result.exports.map((e) => `${e.name}::${e.kind}`)),
    functions: new Set(result.functions.map((f) => `${f.name}::${f.isAsync}`)),
  }
}

function isSuperset<T>(
  candidate: Set<T>,
  baseline: Set<T>
): { ok: true } | { ok: false; missing: T[] } {
  const missing: T[] = []
  for (const item of baseline) if (!candidate.has(item)) missing.push(item)
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

describe('Python query extraction vs regex baseline (finding H3)', () => {
  const regexAdapter = new PythonAdapter()
  const queryParser = new PythonIncrementalParser()

  beforeAll(async () => {
    await queryParser.ensureReady()
  })

  afterAll(() => {
    regexAdapter.dispose()
    queryParser.dispose()
  })

  it('boots the WASM parser for the regression guard', () => {
    expect(queryParser.isReady).toBe(true)
  })

  for (const fixture of FIXTURES) {
    it(`query extraction ⊇ regex baseline for fixture "${fixture.name}"`, () => {
      const regexResult = regexAdapter.parseFile(fixture.source, `${fixture.name}.py`)
      const queryResult = queryParser.parseSync(fixture.source, `${fixture.name}.py`)

      expect(queryResult).not.toBeNull()
      if (!queryResult) return // keep type narrowing happy

      const regex = normalize(regexResult)
      const query = normalize(queryResult)

      const importCheck = isSuperset(query.imports, regex.imports)
      const exportCheck = isSuperset(query.exports, regex.exports)
      const functionCheck = isSuperset(query.functions, regex.functions)

      expect(
        importCheck,
        `imports missing vs regex baseline: ${'missing' in importCheck ? JSON.stringify(importCheck.missing) : '[]'}`
      ).toMatchObject({ ok: true })
      expect(
        exportCheck,
        `exports missing vs regex baseline: ${'missing' in exportCheck ? JSON.stringify(exportCheck.missing) : '[]'}`
      ).toMatchObject({ ok: true })
      expect(
        functionCheck,
        `functions missing vs regex baseline: ${'missing' in functionCheck ? JSON.stringify(functionCheck.missing) : '[]'}`
      ).toMatchObject({ ok: true })
    })
  }
})
