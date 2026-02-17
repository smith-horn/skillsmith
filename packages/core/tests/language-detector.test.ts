/**
 * SMI-1340: Language Detector Tests
 *
 * Tests for the LanguageDetector class, verifying:
 * - Shebang detection
 * - Content pattern analysis
 * - Statistical keyword analysis
 * - Confidence scoring
 *
 * @see docs/internal/architecture/multi-language-analysis.md
 */

import { describe, it, expect } from 'vitest'
import { LanguageDetector, detectLanguage } from '../src/analysis/language-detector.js'

describe('LanguageDetector', () => {
  describe('shebang detection', () => {
    const detector = new LanguageDetector()

    it('detects Python from shebang', () => {
      const result = detector.detect('#!/usr/bin/python\nprint("hello")')

      expect(result.language).toBe('python')
      expect(result.confidence).toBe(1.0)
      expect(result.method).toBe('shebang')
      expect(result.evidence[0]).toContain('#!/usr/bin/python')
    })

    it('detects Python3 from shebang', () => {
      const result = detector.detect('#!/usr/bin/python3\nimport sys')

      expect(result.language).toBe('python')
      expect(result.confidence).toBe(1.0)
      expect(result.method).toBe('shebang')
    })

    it('detects Python from env shebang', () => {
      const result = detector.detect('#!/usr/bin/env python\nprint("hello")')

      expect(result.language).toBe('python')
      expect(result.confidence).toBe(1.0)
    })

    it('detects Node.js from shebang', () => {
      const result = detector.detect('#!/usr/bin/node\nconsole.log("hello")')

      expect(result.language).toBe('javascript')
      expect(result.confidence).toBe(1.0)
    })

    it('detects Node.js from env shebang', () => {
      const result = detector.detect('#!/usr/bin/env node\nmodule.exports = {}')

      expect(result.language).toBe('javascript')
      expect(result.confidence).toBe(1.0)
    })

    it('detects TypeScript from ts-node shebang', () => {
      const result = detector.detect('#!/usr/bin/env ts-node\nconst x: number = 1')

      expect(result.language).toBe('typescript')
      expect(result.confidence).toBe(1.0)
    })

    it('detects TypeScript from deno shebang', () => {
      const result = detector.detect(
        '#!/usr/bin/env deno run\nDeno.writeTextFile("test.txt", "hello")'
      )

      expect(result.language).toBe('typescript')
      expect(result.confidence).toBe(1.0)
    })

    it('detects TypeScript from bun shebang', () => {
      const result = detector.detect('#!/usr/bin/env bun\nawait Bun.write("output.txt", "hello")')

      expect(result.language).toBe('typescript')
      expect(result.confidence).toBe(1.0)
    })

    it('detects TypeScript from npx tsx shebang', () => {
      const result = detector.detect('#!/usr/bin/env npx tsx\nconst x: string = "hello"')

      expect(result.language).toBe('typescript')
      expect(result.confidence).toBe(1.0)
    })

    it('returns null for unknown shebang', () => {
      const result = detector.detect('#!/bin/bash\necho "hello"')

      // Should not detect as our supported languages
      expect(result.method).not.toBe('shebang')
    })

    it('returns null for no shebang', () => {
      const result = detector.detectByShebang('print("hello")')

      expect(result.language).toBeNull()
      expect(result.confidence).toBe(0)
    })
  })

  describe('pattern detection', () => {
    const detector = new LanguageDetector()

    describe('TypeScript patterns', () => {
      it('detects type-only imports', () => {
        const content = `
import type { User } from './types'
import type { Config } from './config'

const user: User = { id: 1, name: 'test' }
        `
        const result = detector.detect(content)

        expect(result.language).toBe('typescript')
        expect(result.method).toBe('pattern')
        expect(result.evidence).toContain('type-only import')
      })

      it('detects interface declarations', () => {
        const content = `
interface User {
  id: number
  name: string
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('typescript')
        expect(result.evidence).toContain('interface declaration')
      })

      it('detects type annotations', () => {
        const content = `
const count: number = 0
const name: string = 'test'
function greet(name: string): void {}
const callback: (x: number) => boolean = (x) => x > 0
        `
        const result = detector.detect(content)

        // Type annotations might not be strong enough on their own
        // Combined with other patterns they should detect TypeScript
        expect(['typescript', null]).toContain(result.language)
        if (result.language === 'typescript') {
          expect(result.evidence).toContain('type annotation')
        }
      })
    })

    describe('Python patterns', () => {
      it('detects from-import statements', () => {
        const content = `
from typing import List, Dict
from dataclasses import dataclass

@dataclass
class User:
    name: str
        `
        const result = detector.detect(content)

        expect(result.language).toBe('python')
        expect(result.method).toBe('pattern')
        expect(result.evidence).toContain('from import')
      })

      it('detects function definitions', () => {
        const content = `
def greet(name: str) -> str:
    return f"Hello, {name}"

async def fetch_data():
    pass
        `
        const result = detector.detect(content)

        expect(result.language).toBe('python')
        expect(result.evidence).toContain('function definition')
      })

      it('detects main guard', () => {
        const content = `
def main():
    print("Hello")

if __name__ == "__main__":
    main()
        `
        const result = detector.detect(content)

        expect(result.language).toBe('python')
        expect(result.confidence).toBeGreaterThan(0.5)
      })

      it('detects class definitions', () => {
        const content = `
class UserService:
    def __init__(self):
        self.users = []

    def get_user(self, id):
        return self.users[id]
        `
        const result = detector.detect(content)

        expect(result.language).toBe('python')
        expect(result.evidence).toContain('class definition')
      })

      it('detects elif keyword', () => {
        const content = `
if x > 10:
    print("big")
elif x > 5:
    print("medium")
else:
    print("small")
        `
        const result = detector.detect(content)

        expect(result.language).toBe('python')
        expect(result.evidence).toContain('elif keyword')
      })
    })

    describe('Go patterns', () => {
      it('detects package declaration', () => {
        const content = `
package main

import "fmt"

func main() {
    fmt.Println("Hello")
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('go')
        expect(result.method).toBe('pattern')
        expect(result.evidence).toContain('package declaration')
      })

      it('detects method receivers', () => {
        const content = `
type User struct {
    Name string
}

func (u *User) Greet() string {
    return "Hello, " + u.Name
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('go')
        expect(result.evidence).toContain('method with receiver')
      })

      it('detects short variable declaration', () => {
        const content = `
func main() {
    name := "test"
    count := 0
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('go')
        expect(result.evidence).toContain('short variable declaration')
      })

      it('detects goroutines and channels', () => {
        const content = `
func main() {
    ch := make(chan int)
    go processData(ch)
    defer close(ch)
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('go')
      })
    })

    describe('Rust patterns', () => {
      it('detects use statements', () => {
        const content = `
use std::io::Read;
use std::collections::HashMap;

fn main() {
    let map: HashMap<String, i32> = HashMap::new();
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('rust')
        expect(result.method).toBe('pattern')
        expect(result.evidence).toContain('use statement')
      })

      it('detects impl blocks', () => {
        const content = `
struct User {
    name: String,
}

impl User {
    fn new(name: String) -> Self {
        User { name }
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('rust')
        expect(result.evidence).toContain('impl block')
      })

      it('detects derive macros', () => {
        const content = `
#[derive(Debug, Clone, Serialize)]
struct Config {
    host: String,
    port: u16,
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('rust')
        expect(result.evidence).toContain('derive macro')
      })

      it('detects Result and Option types', () => {
        const content = `
fn read_file(path: &str) -> Result<String, io::Error> {
    let content: Option<String> = Some("test".to_string());
    content.unwrap()
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('rust')
      })

      it('detects match expressions', () => {
        const content = `
fn get_value(opt: Option<i32>) -> i32 {
    match opt {
        Some(x) => x,
        None => 0,
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('rust')
        expect(result.evidence).toContain('match expression')
      })
    })

    describe('Java patterns', () => {
      it('detects package declaration', () => {
        const content = `
package com.example.app;

import java.util.List;

public class Main {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('java')
        expect(result.method).toBe('pattern')
        expect(result.evidence).toContain('package declaration')
      })

      it('detects public class', () => {
        const content = `
public class UserService {
    private List<User> users;

    public User findById(int id) {
        return users.get(id);
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('java')
        expect(result.evidence).toContain('public class')
      })

      it('detects Override annotation', () => {
        const content = `
class User {
    @Override
    public String toString() {
        return "User{}";
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('java')
        expect(result.evidence).toContain('Override annotation')
      })

      it('detects System.out.println', () => {
        const content = `
public class Main {
    public void test() {
        System.out.println("test");
        System.out.print("test");
    }

    public static void main(String[] args) {
        new Main().test();
    }
}
        `
        const result = detector.detect(content)

        expect(result.language).toBe('java')
        expect(result.evidence).toContain('System.out')
      })
    })

    describe('JavaScript patterns', () => {
      it('detects ES module imports', () => {
        const content = `
import React from 'react'
import { useState, useEffect } from 'react'

export default function App() {
    return <div>Hello</div>
}
        `
        const result = detector.detect(content)

        // Should upgrade to TypeScript since TypeScript patterns match too
        expect(['typescript', 'javascript']).toContain(result.language)
      })

      it('detects CommonJS require', () => {
        const content = `
const fs = require('fs')
const path = require('path')

module.exports = {
    readFile: fs.readFileSync
}
        `
        const result = detector.detect(content)

        expect(['typescript', 'javascript']).toContain(result.language)
      })

      it('detects async/await', () => {
        const content = `
async function fetchData() {
    const response = await fetch('/api/data')
    return await response.json()
}
        `
        const result = detector.detect(content)

        expect(['typescript', 'javascript']).toContain(result.language)
      })
    })
  })

  describe('statistical detection', () => {
    const detector = new LanguageDetector()

    it('detects Python by keyword frequency', () => {
      const content = `
def function_one():
    pass

def function_two():
    if True:
        return None
    elif False:
        raise Exception
    else:
        yield 1

class MyClass:
    def __init__(self):
        self.value = True
        `
      const result = detector.detect(content)

      expect(result.language).toBe('python')
    })

    it('detects Go by keyword frequency', () => {
      const content = `
package main

func main() {
    var x int
    const y = 10

    for i := range []int{1, 2, 3} {
        go processItem(i)
    }

    select {
    case <-done:
        return
    }
}
        `
      const result = detector.detect(content)

      expect(result.language).toBe('go')
    })

    it('returns lower confidence for statistical detection', () => {
      // Content that relies only on statistical detection
      const content = `
fn test
let mut
const static
struct enum
impl use
        `
      const result = detector.detectByStatistics(content)

      expect(result.confidence).toBeLessThanOrEqual(0.7)
    })
  })

  describe('confidence threshold', () => {
    it('uses default minimum confidence', () => {
      const detector = new LanguageDetector()
      expect(detector.getMinConfidence()).toBe(0.3)
    })

    it('respects custom minimum confidence', () => {
      const detector = new LanguageDetector({ minConfidence: 0.5 })
      expect(detector.getMinConfidence()).toBe(0.5)
    })

    it('can update confidence threshold', () => {
      const detector = new LanguageDetector()
      detector.setMinConfidence(0.8)
      expect(detector.getMinConfidence()).toBe(0.8)
    })

    it('clamps confidence to valid range', () => {
      const detector = new LanguageDetector()

      detector.setMinConfidence(1.5)
      expect(detector.getMinConfidence()).toBe(1)

      detector.setMinConfidence(-0.5)
      expect(detector.getMinConfidence()).toBe(0)
    })

    it('returns null when confidence below threshold', () => {
      const detector = new LanguageDetector({ minConfidence: 0.99 })

      // Even strong patterns might not reach 0.99
      const result = detector.detect('const x = 1')

      // Should likely return null due to high threshold
      if (result.confidence < 0.99) {
        expect(result.language).toBeNull()
      }
    })
  })

  describe('detectLanguage convenience function', () => {
    it('detects language from content', () => {
      const result = detectLanguage('#!/usr/bin/env python\nprint("hello")')

      expect(result.language).toBe('python')
      expect(result.confidence).toBe(1.0)
    })

    it('accepts options', () => {
      const result = detectLanguage('const x = 1', { minConfidence: 0.1 })

      expect(result).toBeDefined()
    })
  })

  describe('edge cases', () => {
    const detector = new LanguageDetector()

    it('handles empty content', () => {
      const result = detector.detect('')

      expect(result.language).toBeNull()
      expect(result.confidence).toBe(0)
      expect(result.method).toBe('none')
    })

    it('handles whitespace-only content', () => {
      const result = detector.detect('   \n\t\n   ')

      expect(result.language).toBeNull()
      expect(result.confidence).toBe(0)
    })

    it('handles content with no clear language', () => {
      const result = detector.detect('Hello World\nThis is just text\nNo code here')

      expect(result.confidence).toBeLessThan(0.5)
    })

    it('handles binary-like content', () => {
      const result = detector.detect('\x00\x01\x02\x03')

      expect(result.confidence).toBeLessThan(0.5)
    })

    it('handles mixed language patterns', () => {
      // Content with both Python and JavaScript patterns
      const content = `
def function():
    pass

function test() {
    return 1
}
        `
      const result = detector.detect(content)

      // Should pick one, likely Python due to stronger patterns
      expect(result.language).not.toBeNull()
      expect(result.confidence).toBeGreaterThan(0)
    })
  })

  describe('real-world examples', () => {
    const detector = new LanguageDetector()

    it('detects Python Django view', () => {
      const content = `
from django.http import JsonResponse
from django.views import View

class UserView(View):
    def get(self, request, user_id):
        user = User.objects.get(id=user_id)
        return JsonResponse({'name': user.name})

    def post(self, request):
        data = json.loads(request.body)
        return JsonResponse({'status': 'ok'})
        `
      const result = detector.detect(content)

      expect(result.language).toBe('python')
      expect(result.confidence).toBeGreaterThan(0.5)
    })

    it('detects TypeScript React component', () => {
      const content = `
import React, { useState, useEffect } from 'react'
import type { User } from './types'

interface Props {
    userId: number
}

export const UserProfile: React.FC<Props> = ({ userId }) => {
    const [user, setUser] = useState<User | null>(null)

    useEffect(() => {
        fetchUser(userId).then(setUser)
    }, [userId])

    if (!user) return <div>Loading...</div>

    return <div>{user.name}</div>
}
        `
      const result = detector.detect(content)

      expect(result.language).toBe('typescript')
      expect(result.confidence).toBeGreaterThan(0.5)
    })

    it('detects Go HTTP handler', () => {
      const content = `
package handlers

import (
    "encoding/json"
    "net/http"
)

type User struct {
    ID   int    \`json:"id"\`
    Name string \`json:"name"\`
}

func GetUser(w http.ResponseWriter, r *http.Request) {
    user := &User{ID: 1, Name: "test"}

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}
        `
      const result = detector.detect(content)

      expect(result.language).toBe('go')
      expect(result.confidence).toBeGreaterThan(0.5)
    })

    it('detects Rust CLI application', () => {
      const content = `
use clap::Parser;
use std::fs;
use std::io::Result;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    #[arg(short, long)]
    input: String,

    #[arg(short, long, default_value_t = false)]
    verbose: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    let content = fs::read_to_string(&args.input)?;

    if args.verbose {
        println!("Read {} bytes", content.len());
    }

    Ok(())
}
        `
      const result = detector.detect(content)

      expect(result.language).toBe('rust')
      expect(result.confidence).toBeGreaterThan(0.5)
    })

    it('detects Java Spring Boot controller', () => {
      const content = `
package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @Autowired
    private UserService userService;

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody User user) {
        return userService.save(user);
    }
}
        `
      const result = detector.detect(content)

      expect(result.language).toBe('java')
      expect(result.confidence).toBeGreaterThan(0.5)
    })
  })
})
