/**
 * SMI-1307: Java Language Adapter Tests
 *
 * Comprehensive tests for the Java adapter including:
 * - Import extraction (regular, static, wildcard)
 * - Export detection (class, interface, enum, @interface)
 * - Function extraction (with visibility, annotations, generics)
 * - pom.xml parsing (Maven dependencies)
 * - build.gradle parsing (Gradle dependencies)
 * - Framework detection rules
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JavaAdapter, parsePomXml, parseBuildGradle } from '../src/analysis/adapters/java.js'

describe('JavaAdapter', () => {
  let adapter: JavaAdapter

  beforeEach(() => {
    adapter = new JavaAdapter()
  })

  afterEach(() => {
    adapter.dispose()
  })

  describe('canHandle', () => {
    it('handles .java files', () => {
      expect(adapter.canHandle('Main.java')).toBe(true)
      expect(adapter.canHandle('UserService.java')).toBe(true)
      expect(adapter.canHandle('path/to/File.java')).toBe(true)
    })

    it('does not handle non-Java files', () => {
      expect(adapter.canHandle('main.ts')).toBe(false)
      expect(adapter.canHandle('main.py')).toBe(false)
      expect(adapter.canHandle('main.go')).toBe(false)
      expect(adapter.canHandle('main.rs')).toBe(false)
      expect(adapter.canHandle('pom.xml')).toBe(false)
      expect(adapter.canHandle('build.gradle')).toBe(false)
    })

    it('handles case-insensitive extensions', () => {
      expect(adapter.canHandle('Main.JAVA')).toBe(true)
      expect(adapter.canHandle('Main.Java')).toBe(true)
    })
  })

  describe('parseFile - imports', () => {
    it('extracts regular import', () => {
      const content = `
package com.example;

import java.util.List;
`
      const result = adapter.parseFile(content, 'Main.java')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'java.util.List',
        namedImports: ['List'],
        isTypeOnly: true,
        sourceFile: 'Main.java',
      })
    })

    it('extracts static import', () => {
      const content = `
package com.example;

import static org.junit.Assert.assertEquals;
`
      const result = adapter.parseFile(content, 'Test.java')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'org.junit.Assert.assertEquals',
        namedImports: ['assertEquals'],
        isTypeOnly: false, // Static imports are not type-only
        sourceFile: 'Test.java',
      })
    })

    it('extracts wildcard import', () => {
      const content = `
package com.example;

import java.util.*;
`
      const result = adapter.parseFile(content, 'Main.java')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'java.util',
        namedImports: [],
        namespaceImport: '*',
        sourceFile: 'Main.java',
      })
    })

    it('extracts static wildcard import', () => {
      const content = `
package com.example;

import static java.lang.Math.*;
`
      const result = adapter.parseFile(content, 'Math.java')

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0]).toMatchObject({
        module: 'java.lang.Math',
        namespaceImport: '*',
        isTypeOnly: false,
      })
    })

    it('extracts multiple imports', () => {
      const content = `
package com.example;

import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import static org.junit.Assert.*;
import com.google.gson.Gson;
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.imports).toHaveLength(5)
      expect(result.imports.map((i) => i.module)).toContain('java.util.List')
      expect(result.imports.map((i) => i.module)).toContain('java.util.Map')
      expect(result.imports.map((i) => i.module)).toContain('java.util.ArrayList')
      expect(result.imports.map((i) => i.module)).toContain('org.junit.Assert')
      expect(result.imports.map((i) => i.module)).toContain('com.google.gson.Gson')
    })

    it('records line numbers for imports', () => {
      const content = `package com.example;

import java.util.List;
import java.util.Map;
`
      const result = adapter.parseFile(content, 'Main.java')

      expect(result.imports[0].line).toBe(3)
      expect(result.imports[1].line).toBe(4)
    })
  })

  describe('parseFile - exports', () => {
    it('detects public class', () => {
      const content = `
package com.example;

public class UserService {
    // class body
}
`
      const result = adapter.parseFile(content, 'UserService.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'UserService',
        kind: 'class',
        isDefault: false,
        visibility: 'public',
        sourceFile: 'UserService.java',
      })
    })

    it('detects package-private class', () => {
      const content = `
package com.example;

class InternalHelper {
    // class body
}
`
      const result = adapter.parseFile(content, 'InternalHelper.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'InternalHelper',
        kind: 'class',
        visibility: 'internal',
      })
    })

    it('detects public interface', () => {
      const content = `
package com.example;

public interface UserRepository {
    User findById(Long id);
}
`
      const result = adapter.parseFile(content, 'UserRepository.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'UserRepository',
        kind: 'interface',
        visibility: 'public',
      })
    })

    it('detects public enum', () => {
      const content = `
package com.example;

public enum Status {
    ACTIVE,
    INACTIVE,
    PENDING
}
`
      const result = adapter.parseFile(content, 'Status.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Status',
        kind: 'enum',
        visibility: 'public',
      })
    })

    it('detects annotation type', () => {
      const content = `
package com.example;

public @interface MyAnnotation {
    String value();
}
`
      const result = adapter.parseFile(content, 'MyAnnotation.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'MyAnnotation',
        kind: 'interface',
        visibility: 'public',
      })
    })

    it('detects abstract class', () => {
      const content = `
package com.example;

public abstract class BaseService {
    public abstract void process();
}
`
      const result = adapter.parseFile(content, 'BaseService.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'BaseService',
        kind: 'class',
        visibility: 'public',
      })
    })

    it('detects generic class', () => {
      const content = `
package com.example;

public class Repository<T, ID> {
    // generic class body
}
`
      const result = adapter.parseFile(content, 'Repository.java')

      expect(result.exports).toHaveLength(1)
      expect(result.exports[0]).toMatchObject({
        name: 'Repository',
        kind: 'class',
        visibility: 'public',
      })
    })

    it('detects multiple classes in file', () => {
      const content = `
package com.example;

public class MainClass {
}

class HelperClass {
}

interface SomeInterface {
}
`
      const result = adapter.parseFile(content, 'MainClass.java')

      expect(result.exports).toHaveLength(3)
      expect(result.exports.map((e) => e.name)).toEqual([
        'MainClass',
        'HelperClass',
        'SomeInterface',
      ])
    })
  })

  describe('parseFile - functions', () => {
    it('extracts public method', () => {
      const content = `
package com.example;

public class Service {
    public void doSomething() {
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'doSomething',
        parameterCount: 0,
        isAsync: false,
        isExported: true,
        sourceFile: 'Service.java',
      })
    })

    it('extracts private method', () => {
      const content = `
package com.example;

public class Service {
    private void helperMethod() {
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'helperMethod',
        isExported: false,
      })
    })

    it('extracts protected method', () => {
      const content = `
package com.example;

public class Service {
    protected void inheritableMethod() {
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'inheritableMethod',
        isExported: true, // protected is considered exported
      })
    })

    it('extracts method with parameters', () => {
      const content = `
package com.example;

public class Service {
    public String greet(String name, int age) {
        return "Hello " + name;
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'greet',
        parameterCount: 2,
      })
    })

    it('extracts static method', () => {
      const content = `
package com.example;

public class Utils {
    public static String format(String input) {
        return input.trim();
    }
}
`
      const result = adapter.parseFile(content, 'Utils.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'format',
        parameterCount: 1,
        isExported: true,
      })
    })

    it('extracts generic method', () => {
      const content = `
package com.example;

public class Utils {
    public <T> List<T> filter(List<T> items, Predicate<T> predicate) {
        return items.stream().filter(predicate).collect(Collectors.toList());
    }
}
`
      const result = adapter.parseFile(content, 'Utils.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'filter',
        parameterCount: 2,
      })
    })

    it('extracts method with annotations', () => {
      const content = `
package com.example;

public class Service {
    @Override
    public String toString() {
        return "Service";
    }

    @Test
    @DisplayName("Test method")
    public void testSomething() {
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0].decorators).toEqual(['Override'])
      expect(result.functions[1].decorators).toEqual(['Test', 'DisplayName'])
    })

    it('extracts abstract method', () => {
      const content = `
package com.example;

public abstract class BaseService {
    public abstract void process();
}
`
      const result = adapter.parseFile(content, 'BaseService.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'process',
        parameterCount: 0,
      })
    })

    it('handles generics in parameters correctly', () => {
      const content = `
package com.example;

public class Service {
    public void process(Map<String, List<Integer>> data, Function<String, Integer> mapper) {
    }
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(1)
      expect(result.functions[0]).toMatchObject({
        name: 'process',
        parameterCount: 2, // Should count correctly despite nested generics
      })
    })

    it('records line numbers for methods', () => {
      const content = `package com.example;

public class Service {
    public void first() {}

    public void second() {}

    public void third() {}
}
`
      const result = adapter.parseFile(content, 'Service.java')

      expect(result.functions).toHaveLength(3)
      expect(result.functions[0].line).toBe(4)
      expect(result.functions[1].line).toBe(6)
      expect(result.functions[2].line).toBe(8)
    })
  })

  describe('parseFile - complex cases', () => {
    it('parses a complete Spring Boot controller', () => {
      const content = `
package com.example.controller;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @Autowired
    private UserService userService;

    @GetMapping
    public List<User> getAllUsers() {
        return userService.findAll();
    }

    @GetMapping("/{id}")
    public User getUserById(@PathVariable Long id) {
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody User user) {
        return userService.save(user);
    }

    @DeleteMapping("/{id}")
    public void deleteUser(@PathVariable Long id) {
        userService.deleteById(id);
    }
}
`
      const result = adapter.parseFile(content, 'UserController.java')

      // Imports
      expect(result.imports.length).toBeGreaterThanOrEqual(3)
      expect(result.imports.map((i) => i.module)).toContain(
        'org.springframework.beans.factory.annotation.Autowired'
      )

      // Exports (class)
      expect(result.exports).toHaveLength(1)
      expect(result.exports[0].name).toBe('UserController')

      // Functions
      expect(result.functions).toHaveLength(4)
      expect(result.functions.map((f) => f.name)).toEqual([
        'getAllUsers',
        'getUserById',
        'createUser',
        'deleteUser',
      ])

      // Check annotations
      expect(result.functions[0].decorators).toEqual(['GetMapping'])
      expect(result.functions[2].decorators).toEqual(['PostMapping'])
    })

    it('parses JUnit test class', () => {
      const content = `
package com.example.test;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class UserServiceTest {

    private UserService userService;

    @BeforeEach
    void setUp() {
        userService = new UserService();
    }

    @Test
    @DisplayName("Should find user by ID")
    void testFindById() {
        User user = userService.findById(1L);
        assertNotNull(user);
    }

    @Test
    void testCreateUser() {
        User user = new User("John");
        User saved = userService.save(user);
        assertEquals("John", saved.getName());
    }
}
`
      const result = adapter.parseFile(content, 'UserServiceTest.java')

      expect(result.imports).toHaveLength(2)
      expect(result.exports).toHaveLength(1)
      expect(result.exports[0].name).toBe('UserServiceTest')

      expect(result.functions).toHaveLength(3)
      expect(result.functions[0].decorators).toEqual(['BeforeEach'])
      expect(result.functions[1].decorators).toEqual(['Test', 'DisplayName'])
      expect(result.functions[2].decorators).toEqual(['Test'])
    })
  })

  describe('getFrameworkRules', () => {
    it('includes Spring Boot framework detection', () => {
      const rules = adapter.getFrameworkRules()
      const springBoot = rules.find((r) => r.name === 'Spring Boot')

      expect(springBoot).toBeDefined()
      expect(springBoot?.depIndicators).toContain('spring-boot')
      expect(springBoot?.importIndicators).toContain('org.springframework.boot')
    })

    it('includes JUnit detection', () => {
      const rules = adapter.getFrameworkRules()
      const junit = rules.find((r) => r.name === 'JUnit')

      expect(junit).toBeDefined()
      expect(junit?.depIndicators).toContain('junit')
      expect(junit?.importIndicators).toContain('org.junit')
    })

    it('includes Hibernate detection', () => {
      const rules = adapter.getFrameworkRules()
      const hibernate = rules.find((r) => r.name === 'Hibernate')

      expect(hibernate).toBeDefined()
      expect(hibernate?.depIndicators).toContain('hibernate')
      expect(hibernate?.importIndicators).toContain('javax.persistence')
    })

    it('includes Lombok detection', () => {
      const rules = adapter.getFrameworkRules()
      const lombok = rules.find((r) => r.name === 'Lombok')

      expect(lombok).toBeDefined()
      expect(lombok?.depIndicators).toContain('lombok')
      expect(lombok?.importIndicators).toContain('lombok')
    })

    it('includes Quarkus detection', () => {
      const rules = adapter.getFrameworkRules()
      const quarkus = rules.find((r) => r.name === 'Quarkus')

      expect(quarkus).toBeDefined()
      expect(quarkus?.depIndicators).toContain('io.quarkus')
    })

    it('includes Mockito detection', () => {
      const rules = adapter.getFrameworkRules()
      const mockito = rules.find((r) => r.name === 'Mockito')

      expect(mockito).toBeDefined()
      expect(mockito?.importIndicators).toContain('org.mockito')
    })
  })

  describe('parseIncremental', () => {
    it('returns same result as parseFile', () => {
      const content = `
package com.example;

import java.util.List;

public class Service {
    public void process() {
    }
}
`
      const parseResult = adapter.parseFile(content, 'Service.java')
      const incrementalResult = adapter.parseIncremental(content, 'Service.java')

      expect(incrementalResult).toEqual(parseResult)
    })
  })
})

describe('parsePomXml', () => {
  it('extracts single dependency', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>3.0.0</version>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: 'org.springframework.boot:spring-boot-starter',
      version: '3.0.0',
      isDev: false,
    })
  })

  it('extracts multiple dependencies', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>3.0.0</version>
        </dependency>
        <dependency>
            <groupId>com.google.guava</groupId>
            <artifactId>guava</artifactId>
            <version>31.1-jre</version>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(2)
    expect(result.map((d) => d.name)).toContain('org.springframework.boot:spring-boot-starter-web')
    expect(result.map((d) => d.name)).toContain('com.google.guava:guava')
  })

  it('identifies test scope dependencies as dev', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>5.9.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(1)
    expect(result[0].isDev).toBe(true)
  })

  it('identifies provided scope dependencies as dev', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>javax.servlet</groupId>
            <artifactId>javax.servlet-api</artifactId>
            <version>4.0.1</version>
            <scope>provided</scope>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(1)
    expect(result[0].isDev).toBe(true)
  })

  it('handles dependencies without version', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('unspecified')
  })

  it('ignores XML comments', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <!-- This is commented out
        <dependency>
            <groupId>com.example</groupId>
            <artifactId>commented-out</artifactId>
            <version>1.0.0</version>
        </dependency>
        -->
        <dependency>
            <groupId>com.example</groupId>
            <artifactId>real-dependency</artifactId>
            <version>2.0.0</version>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('com.example:real-dependency')
  })

  it('parses complete pom.xml with various scopes', () => {
    const content = `
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.example</groupId>
    <artifactId>myapp</artifactId>
    <version>1.0.0</version>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>3.0.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
            <version>3.0.0</version>
        </dependency>
        <dependency>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
            <version>1.18.24</version>
            <scope>provided</scope>
        </dependency>
        <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>5.9.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>
`
    const result = parsePomXml(content)

    expect(result).toHaveLength(4)
    expect(result.filter((d) => d.isDev)).toHaveLength(2)
    expect(result.filter((d) => !d.isDev)).toHaveLength(2)
  })
})

describe('parseBuildGradle', () => {
  it('extracts implementation dependency with single quotes', () => {
    const content = `
plugins {
    id 'java'
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter:3.0.0'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: 'org.springframework.boot:spring-boot-starter',
      version: '3.0.0',
      isDev: false,
    })
  })

  it('extracts implementation dependency with double quotes', () => {
    const content = `
plugins {
    id 'java'
}

dependencies {
    implementation "org.springframework.boot:spring-boot-starter:3.0.0"
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('org.springframework.boot:spring-boot-starter')
  })

  it('extracts Kotlin DSL style dependency', () => {
    const content = `
plugins {
    kotlin("jvm")
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter:3.0.0")
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('org.springframework.boot:spring-boot-starter')
  })

  it('identifies testImplementation as dev dependency', () => {
    const content = `
dependencies {
    testImplementation 'org.junit.jupiter:junit-jupiter:5.9.0'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].isDev).toBe(true)
  })

  it('extracts api dependency', () => {
    const content = `
dependencies {
    api 'org.apache.commons:commons-lang3:3.12.0'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].isDev).toBe(false)
  })

  it('extracts annotationProcessor as dev dependency', () => {
    const content = `
dependencies {
    annotationProcessor 'org.projectlombok:lombok:1.18.24'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].isDev).toBe(true)
  })

  it('handles dependency without version', () => {
    const content = `
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('unspecified')
  })

  it('extracts multiple dependencies', () => {
    const content = `
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.0.0'
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa:3.0.0'
    runtimeOnly 'org.postgresql:postgresql:42.5.0'
    testImplementation 'org.springframework.boot:spring-boot-starter-test:3.0.0'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.9.0'
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(5)
    expect(result.filter((d) => d.isDev)).toHaveLength(2)
    expect(result.filter((d) => !d.isDev)).toHaveLength(3)
  })

  it('extracts Kotlin DSL with named parameters', () => {
    const content = `
dependencies {
    implementation(group = "org.springframework.boot", name = "spring-boot-starter", version = "3.0.0")
    testImplementation(group = "org.junit.jupiter", name = "junit-jupiter", version = "5.9.0")
}
`
    const result = parseBuildGradle(content)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'org.springframework.boot:spring-boot-starter',
      version: '3.0.0',
      isDev: false,
    })
    expect(result[1].isDev).toBe(true)
  })

  it('ignores project dependencies', () => {
    const content = `
dependencies {
    implementation project(':core')
    implementation 'org.springframework.boot:spring-boot-starter:3.0.0'
}
`
    const result = parseBuildGradle(content)

    // Should only capture the external dependency, not the project reference
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('org.springframework.boot:spring-boot-starter')
  })

  it('parses complete build.gradle file', () => {
    const content = `
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.0.0'
}

group = 'com.example'
version = '1.0.0'

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.0.0'
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa:3.0.0'
    compileOnly 'org.projectlombok:lombok:1.18.24'
    annotationProcessor 'org.projectlombok:lombok:1.18.24'
    runtimeOnly 'org.postgresql:postgresql:42.5.0'
    testImplementation 'org.springframework.boot:spring-boot-starter-test:3.0.0'
}

test {
    useJUnitPlatform()
}
`
    const result = parseBuildGradle(content)

    expect(result.length).toBeGreaterThanOrEqual(5)
    expect(result.map((d) => d.name)).toContain('org.springframework.boot:spring-boot-starter-web')
    expect(result.map((d) => d.name)).toContain('org.projectlombok:lombok')
  })
})
