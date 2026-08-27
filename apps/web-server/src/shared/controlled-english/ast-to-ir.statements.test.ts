import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  catchHeaderEnglish,
  finallyHeaderEnglish,
  ifPathHeaderEnglish,
  sourceFileEnglish,
  statementHeaderEnglish,
  switchPathHeaderEnglish,
} from './ast-to-ir'
import { parseSource } from './compiler-context'
import { renderEnglish } from './english-renderer'

const english = (source: string, file = 'example.ts'): string => {
  const { sourceFile } = parseSource(file, source)
  return renderEnglish(sourceFileEnglish(sourceFile))
}

type Golden = { name: string; source: string; file?: string; english: string }

const golden = (cases: readonly Golden[]) => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(english(c.source, c.file)).toBe(c.english)
  })
}

// Exact whole-file goldens (spec Phase 9) for statements, declarations,
// class members and module forms.

describe('variable declarations and bindings', () => {
  golden([
    { name: 'let with no initializer', source: 'let x;', english: 'declare variable `x`' },
    { name: 'definite assignment assertion', source: 'let x!: number;', english: 'declare variable `x` asserted as definitely assigned with type number' },
    { name: 'var declaration', source: 'var legacy = 1;', english: 'declare function-scoped variable `legacy` and initialize it to number 1' },
    { name: 'using declaration', source: 'using handle = open();', english: 'declare disposable constant `handle`\nand initialize it to:\n    call `open` with no arguments' },
    {
      name: 'await using declaration',
      source: 'async function f() { await using handle = open(); }',
      english:
        'declare asynchronous function `f`\nwith no parameters\nbody:\n    declare asynchronously disposable constant `handle`\n    and initialize it to:\n        call `open` with no arguments',
    },
    {
      name: 'several declarators in one statement',
      source: 'const a = 1, b = 2;',
      english: 'in one declaration statement:\n    declare constant `a` and initialize it to number 1\n    declare constant `b` and initialize it to number 2',
    },
    {
      name: 'array pattern with default and rest',
      source: 'const [first = 0, , ...rest] = items;',
      english:
        'declare constant:\n    an array pattern binding:\n        bind element 0 to `first` with default number 0\n        skip element 1\n        bind the remaining elements to `rest`\nand initialize it to `items`',
    },
    {
      name: 'object pattern with rest and computed key',
      source: 'const { [key]: value, ...others } = source;',
      english:
        'declare constant:\n    an object pattern binding:\n        bind property named by `key` to `value`\n        bind the remaining properties to `others`\nand initialize it to `source`',
    },
    {
      name: 'object pattern default',
      source: 'const { a = 1 } = o;',
      english: 'declare constant:\n    an object pattern binding:\n        bind property `a` with default number 1\nand initialize it to `o`',
    },
    {
      name: 'nested destructuring',
      source: 'const { user: { name } } = response;',
      english:
        'declare constant:\n    an object pattern binding:\n        bind property `user`\n        to:\n            an object pattern binding:\n                bind property `name`\nand initialize it to `response`',
    },
  ])
})

describe('loops', () => {
  golden([
    {
      name: 'classic for loop',
      source: 'for (let i = 0; i < n; i++) { visit(i); }',
      english:
        'for loop\nsetup:\n    declare variable `i` and initialize it to number 0\ncontinue while `i` is less than `n`\nafter each pass:\n    increment `i` and yield the previous value\nbody:\n    call `visit`\n    with argument `i`',
    },
    { name: 'for loop with no clauses', source: 'for (;;) { spin(); }', english: 'for loop\nbody:\n    call `spin` with no arguments' },
    {
      name: 'for loop with an expression initializer',
      source: 'for (i = 0; i < n; i++) step();',
      english:
        'for loop\nsetup:\n    assign `i` the value number 0\ncontinue while `i` is less than `n`\nafter each pass:\n    increment `i` and yield the previous value\nbody:\n    call `step` with no arguments',
    },
    {
      name: 'for-of over an expression binding',
      source: 'for (item of items) { use(item); }',
      english: 'for each assigning to `item`\nfrom iterable `items`\nbody:\n    call `use`\n    with argument `item`',
    },
    {
      name: 'for-await-of',
      source: 'async function f() { for await (const chunk of stream) { write(chunk); } }',
      english:
        'declare asynchronous function `f`\nwith no parameters\nbody:\n    for await each constant `chunk`\n    from iterable `stream`\n    body:\n        call `write`\n        with argument `chunk`',
    },
    { name: 'for-in', source: 'for (const key in bag) { log(key); }', english: 'for each constant `key`\nfrom the enumerable keys of `bag`\nbody:\n    call `log`\n    with argument `key`' },
    { name: 'while', source: 'while (busy) { wait(); }', english: 'while `busy` is truthy\nbody:\n    call `wait` with no arguments' },
    { name: 'do-while', source: 'do { poll(); } while (pending);', english: 'do:\n    call `poll` with no arguments\nthen repeat while `pending` is truthy' },
  ])
})

describe('branching', () => {
  golden([
    {
      name: 'if with else-if chain',
      source: 'if (a) { one(); } else if (b) { two(); } else { three(); }',
      english:
        'if `a` is truthy\nthen:\n    call `one` with no arguments\notherwise:\n    if `b` is truthy\n    then:\n        call `two` with no arguments\n    otherwise:\n        call `three` with no arguments',
    },
    { name: 'if with a non-block branch', source: 'if (ready) start();', english: 'if `ready` is truthy\nthen:\n    call `start` with no arguments' },
    {
      name: 'switch with fallthrough and default',
      source: 'switch (mode) { case "a": run(); break; case "b": case "c": share(); break; default: idle(); }',
      english:
        'switch on `mode`\nwhen case matches string "a"\nbody:\n    call `run` with no arguments\n    break\nwhen case matches string "b"\nwhen case matches string "c"\nbody:\n    call `share` with no arguments\n    break\nthe default case\nbody:\n    call `idle` with no arguments',
    },
    {
      name: 'labeled break and continue',
      source: 'outer: for (;;) { for (;;) { if (done) break outer; continue outer; } }',
      english:
        'labeled `outer`\nfor loop\nbody:\n    for loop\n    body:\n        if `done` is truthy\n        then:\n            break to label `outer`\n        continue to label `outer`',
    },
  ])
})

describe('exceptions and simple statements', () => {
  golden([
    { name: 'try-catch without a binding', source: 'try { risky(); } catch { recover(); }', english: 'try:\n    call `risky` with no arguments\ncatch:\n    call `recover` with no arguments' },
    { name: 'try-finally only', source: 'try { work(); } finally { cleanup(); }', english: 'try:\n    call `work` with no arguments\nfinally:\n    call `cleanup` with no arguments' },
    { name: 'throw', source: 'throw new Error("boom");', english: 'throw:\n    construct a new `Error`\n    with argument string "boom"' },
    { name: 'bare return', source: 'function f() { return; }', english: 'declare function `f`\nwith no parameters\nbody:\n    return' },
    { name: 'empty statement', source: ';', english: 'an empty statement' },
    { name: 'debugger', source: 'debugger;', english: 'trigger the debugger' },
    { name: 'with statement', source: 'with (scope) { read(); }', file: 'example.js', english: 'with scope from `scope`\nbody:\n    call `read` with no arguments' },
    { name: 'nested block', source: '{ inner(); }', english: 'block:\n    call `inner` with no arguments' },
  ])
})

describe('function declarations', () => {
  golden([
    { name: 'generator declaration with no body statements', source: 'function* gen() {}', english: 'declare generator function `gen`\nwith no parameters\nbody:\n    no statements' },
    { name: 'ambient function overload', source: 'declare function f(): void;', english: 'declare ambient function `f`\nwith no parameters\nreturn type:\n    void\nwith no body' },
    { name: 'default-export anonymous function', source: 'export default function () { run(); }', english: 'declare exported as default function\nwith no parameters\nbody:\n    call `run` with no arguments' },
  ])
})

describe('class members', () => {
  golden([
    {
      name: 'class with field variants',
      source: 'class C { a = 1; b?: string; c!: number; static d = 2; #secret = 3; ["computed"] = 4; }',
      english:
        'declare class `C`\nmembers:\n    field `a` and initialize it to number 1\n    optional field `b` with type string\n    field `c` asserted as definitely assigned with type number\n    static field `d` and initialize it to number 2\n    field `#secret` and initialize it to number 3\n    field named by string "computed" and initialize it to number 4',
    },
    {
      name: 'class with method variants',
      source: 'class C { async *stream?() {} static run() {} }',
      english:
        'declare class `C`\nmembers:\n    asynchronous generator optional method `stream`\n    with no parameters\n    body:\n        no statements\n    static method `run`\n    with no parameters\n    body:\n        no statements',
    },
    {
      name: 'class with accessors and constructor',
      source: 'declare class C { constructor(a: number); get x(): number; set x(v: number); }',
      english:
        'declare ambient class `C`\nmembers:\n    constructor\n    parameters:\n        parameter `a` with type number\n    with no body\n    getter `x`\n    return type:\n        number\n    with no body\n    setter `x`\n    parameters:\n        parameter `v` with type number\n    with no body',
    },
    {
      name: 'class with a static block and index signature',
      source: 'class C { static { seed(); } [key: string]: number; }',
      english:
        'declare class `C`\nmembers:\n    static initialization block\n    body:\n        call `seed` with no arguments\n    index signature key `key` of key type string with value type number',
    },
    {
      name: 'abstract class with heritage',
      source: 'abstract class Panel extends Base implements Sized, Named { abstract area(): number; }',
      english:
        'declare abstract class `Panel`\nextending `Base`\nimplementing:\n    `Sized`\n    `Named`\nmembers:\n    abstract method `area`\n    with no parameters\n    return type:\n        number\n    with no body',
    },
    {
      name: 'decorated class member and parameter',
      source: 'class C { @tracked() run(@inject dep: Dep) {} }',
      english:
        'declare class `C`\nmembers:\n    decorated with:\n        decorator:\n            call `tracked` with no arguments\n    method `run`\n    parameters:\n        decorated with:\n            decorator `inject`\n        parameter `dep`\n        with type `Dep`\n    body:\n        no statements',
    },
    { name: 'semicolon class member', source: 'class C { ; }', english: 'declare class `C`\nmembers:\n    an empty class member' },
  ])
})

describe('interfaces, aliases, enums and namespaces', () => {
  golden([
    {
      name: 'interface with member variants',
      source: 'interface Shape { readonly kind: string; area?(): number; get size(): number; set size(v: number); (input: string): boolean; new (input: string): Shape; }',
      english:
        'declare interface `Shape`\nmembers:\n    readonly property `kind` with type string\n    optional method `area`\n    with no parameters\n    return type:\n        number\n    getter `size`\n    return type:\n        number\n    with no body\n    setter `size`\n    parameters:\n        parameter `v` with type number\n    with no body\n    call signature\n    parameters:\n        parameter `input` with type string\n    return type:\n        boolean\n    construct signature\n    parameters:\n        parameter `input` with type string\n    return type:\n        `Shape`',
    },
    {
      name: 'interface with heritage and an optional property',
      source: 'interface A extends B, C { a?: string; }',
      english: 'declare interface `A`\nextending:\n    `B`\n    `C`\nmembers:\n    optional property `a` with type string',
    },
    { name: 'empty interface', source: 'interface Marker {}', english: 'declare interface `Marker`\nwith no members' },
    { name: 'untyped property signature', source: 'type Loose = { data };', english: 'declare type alias `Loose`\nas:\n    an object type with:\n        property `data`' },
    {
      name: 'type alias with a type parameter',
      source: 'type Box<T> = { value: T };',
      english: 'declare type alias `Box`\nwith type parameters:\n    type parameter `T`\nas:\n    an object type with:\n        property `value` with type `T`',
    },
    {
      name: 'constrained defaulted type parameter',
      source: 'type Pick2<T extends object = {}> = T;',
      english: 'declare type alias `Pick2`\nwith type parameters:\n    type parameter `T` constrained to object with default an empty object type\nas `T`',
    },
    { name: 'empty enum', source: 'enum Empty {}', english: 'declare enum `Empty`\nwith no members' },
    { name: 'const enum with values', source: 'const enum Direction { Up = 1, Down }', english: 'declare const enum `Direction`\nmembers:\n    member `Up` with value number 1\n    member `Down`' },
    {
      name: 'dotted namespace',
      source: 'namespace a.b { export const x = 1; }',
      english: 'declare namespace `a`\nbody:\n    declare namespace `b`\n    body:\n        declare exported constant `x` and initialize it to number 1',
    },
    {
      name: 'string module declaration',
      source: 'declare module "fs-extra" { export function copy(): void; }',
      english: 'declare ambient module string "fs-extra"\nbody:\n    declare exported function `copy`\n    with no parameters\n    return type:\n        void\n    with no body',
    },
    { name: 'module with no body', source: 'declare module "*.png";', english: 'declare ambient module string "*.png"\nwith no body' },
    {
      name: 'global augmentation',
      source: 'declare global { interface Window { canary: boolean; } } export {};',
      english: 'declare ambient global augmentation\nbody:\n    declare interface `Window`\n    members:\n        property `canary` with type boolean\nexport named bindings',
    },
  ])
})

describe('imports and exports', () => {
  golden([
    { name: 'default import', source: 'import React from "react";', english: 'import the default binding as `React` from string "react"' },
    { name: 'namespace import', source: 'import * as path from "path";', english: 'import the namespace as `path` from string "path"' },
    {
      name: 'default plus named imports',
      source: 'import base, { a, b as c } from "./mod";',
      english: 'import\nthe default binding as `base`\nnamed bindings:\n    `a`\n    `b` as `c`\nfrom string "./mod"',
    },
    { name: 'type-only import clause', source: 'import type { Config } from "./config";', english: 'import type\nnamed bindings:\n    `Config`\nfrom string "./config"' },
    { name: 'type-only specifier', source: 'import { type Config, load } from "./config";', english: 'import\nnamed bindings:\n    type-only `Config`\n    `load`\nfrom string "./config"' },
    {
      name: 'import with attributes',
      source: 'import data from "./data.json" with { type: "json" };',
      english: 'import\nthe default binding as `data`\nfrom string "./data.json"\nwith attributes:\n    attribute `type` set to string "json"',
    },
    { name: 'string import name', source: 'import { "kebab-name" as kebab } from "./mod";', english: 'import\nnamed bindings:\n    string "kebab-name" as `kebab`\nfrom string "./mod"' },
    {
      name: 'string-named import attribute',
      source: 'import d from "./x.json" with { "type": "json" };',
      english: 'import\nthe default binding as `d`\nfrom string "./x.json"\nwith attributes:\n    attribute string "type" set to string "json"',
    },
    {
      name: 'string module export name',
      source: 'const x = 1; export { x as "as-string" };',
      english: 'declare constant `x` and initialize it to number 1\nexport\nnamed bindings:\n    `x` as string "as-string"',
    },
    { name: 'side-effect import', source: 'import "./polyfill";', english: 'import for side effects from string "./polyfill"' },
    { name: 'import equals of an entity', source: 'import shortcut = a.b.c;', english: 'import `shortcut` as an alias for `a.b.c`' },
    { name: 'type-only import equals of a require', source: 'import type fs = require("fs");', english: 'import type `fs` as an alias for require of string "fs"' },
    { name: 'export star', source: 'export * from "./mod";', english: 'export everything from string "./mod"' },
    { name: 'export star as namespace', source: 'export * as helpers from "./helpers";', english: 'export the namespace as `helpers` from string "./helpers"' },
    { name: 'type-only named exports', source: 'export type { Config } from "./config";', english: 'export type\nnamed bindings:\n    `Config`\nfrom string "./config"' },
    {
      name: 'export default of an expression',
      source: 'const answer = 42; export default answer;',
      english: 'declare constant `answer` and initialize it to number 42\nexport as default `answer`',
    },
    { name: 'export equals', source: 'const api = {}; export = api;', english: 'declare constant `api` and initialize it to an empty object literal\nexport equals `api`' },
    { name: 'export as namespace', source: 'export as namespace CanaryLab;', file: 'example.d.ts', english: 'export as the global namespace `CanaryLab`' },
  ])
})

describe('comments become explicit comment lines', () => {
  golden([
    { name: 'line comment before a statement', source: '// setup\nconnect();', english: 'comment: // setup\ncall `connect` with no arguments' },
    { name: 'multi-line block comment', source: '/* first\n   second */\nconnect();', english: 'comment: /* first\ncomment: second */\ncall `connect` with no arguments' },
    { name: 'comment between statements', source: 'a();\n// pause here\nb();', english: 'call `a` with no arguments\ncomment: // pause here\ncall `b` with no arguments' },
    { name: 'trailing comment after the last statement', source: 'a();\n// done', english: 'call `a` with no arguments\ncomment: // done' },
    { name: 'comment-only file', source: '// nothing to run\n', english: 'comment: // nothing to run' },
    { name: 'empty file', source: '', english: 'no statements' },
  ])
})

describe('source-linked readable-tree projections', () => {
  it('projects branch headers and path labels from the canonical statement IR', () => {
    const { sourceFile } = parseSource('example.ts', `
if (ready) run(); else wait();
switch (mode) { case 'a': run(); break; default: wait(); }
`)
    const decision = sourceFile.statements[0]
    const selection = sourceFile.statements[1]
    if (!ts.isIfStatement(decision) || !ts.isSwitchStatement(selection)) throw new Error('Expected branch statements')

    expect(renderEnglish(statementHeaderEnglish(decision))).toBe('if `ready` is truthy')
    expect(renderEnglish(ifPathHeaderEnglish(decision, 'then'))).toBe('then')
    expect(renderEnglish(ifPathHeaderEnglish(decision, 'otherwise'))).toBe('otherwise')
    expect(renderEnglish(statementHeaderEnglish(selection))).toBe('switch on `mode`')
    expect(renderEnglish(switchPathHeaderEnglish(selection, 0))).toBe('when case matches string "a"')
    expect(renderEnglish(switchPathHeaderEnglish(selection, 1))).toBe('the default case')
  })

  it('projects every loop header without duplicating its body', () => {
    const { sourceFile } = parseSource('example.ts', `
for (let i = 0; i < 2; i++) run();
for (const key in record) run();
for (const item of items) run();
while (ready) run();
do { run(); } while (ready);
`)
    const headers = sourceFile.statements.map((statement) => {
      if (
        !ts.isForStatement(statement)
        && !ts.isForInStatement(statement)
        && !ts.isForOfStatement(statement)
        && !ts.isWhileStatement(statement)
        && !ts.isDoStatement(statement)
      ) {
        throw new Error('Expected a loop statement')
      }
      return renderEnglish(statementHeaderEnglish(statement))
    })

    expect(headers).toEqual([
      'for loop\nsetup:\n    declare variable `i` and initialize it to number 0\ncontinue while `i` is less than number 2\nafter each pass:\n    increment `i` and yield the previous value',
      'for each constant `key`\nfrom the enumerable keys of `record`',
      'for each constant `item`\nfrom iterable `items`',
      'while `ready` is truthy',
      'do\nthen repeat while `ready` is truthy',
    ])
  })

  it('projects block, try, catch, and finally headers', () => {
    const { sourceFile } = parseSource('example.ts', `
{ run(); }
try { run(); } catch (error) { recover(); } finally { close(); }
try { run(); } catch { recover(); }
`)
    const block = sourceFile.statements[0]
    const withBinding = sourceFile.statements[1]
    const withoutBinding = sourceFile.statements[2]
    if (!ts.isBlock(block) || !ts.isTryStatement(withBinding) || !ts.isTryStatement(withoutBinding)) {
      throw new Error('Expected block and try statements')
    }

    expect(renderEnglish(statementHeaderEnglish(block))).toBe('block')
    expect(renderEnglish(statementHeaderEnglish(withBinding))).toBe('try')
    expect(renderEnglish(catchHeaderEnglish(withBinding))).toBe('on error caught as `error`')
    expect(renderEnglish(finallyHeaderEnglish(withBinding))).toBe('finally')
    expect(renderEnglish(catchHeaderEnglish(withoutBinding))).toBe('catch')
  })
})
