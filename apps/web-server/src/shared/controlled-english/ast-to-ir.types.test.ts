import { describe, expect, it } from 'vitest'
import { sourceFileEnglish } from './ast-to-ir'
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

// Exact whole-file goldens (spec Phase 9) for type syntax and JSX.

describe('type compositions', () => {
  golden([
    { name: 'union and intersection', source: 'let x: (A & B) | null;', english: 'declare variable `x` with type union type of (intersection type of `A` and `B`) and null' },
    { name: 'array and readonly operator', source: 'let x: readonly string[];', english: 'declare variable `x` with type readonly array type of string' },
    {
      name: 'tuple with named optional and rest members',
      source: 'let x: [first: string, second?: number, ...rest: boolean[]];',
      english:
        'declare variable `x`\nwith type:\n    tuple type of:\n        member `first` with type string\n        optional member `second` with type number\n        rest member `rest` with type array type of boolean',
    },
    {
      name: 'tuple with unnamed optional and rest',
      source: 'let x: [string?, ...number[]];',
      english: 'declare variable `x`\nwith type:\n    tuple type of:\n        optional string\n        rest of array type of number',
    },
    { name: 'empty tuple', source: 'let x: [];', english: 'declare variable `x` with type an empty tuple type' },
    { name: 'parenthesized structured type', source: 'let x: (A | B)[];', english: 'declare variable `x` with type array type of (union type of `A` and `B`)' },
    {
      name: 'literal types',
      source: 'let a: -1; let b: true; let c: null; let d: 10n; let e: "on";',
      english:
        'declare variable `a` with type negative number 1\ndeclare variable `b` with type true\ndeclare variable `c` with type null\ndeclare variable `d` with type bigint 10n\ndeclare variable `e` with type string "on"',
    },
  ])
})

describe('callable types', () => {
  golden([
    {
      name: 'function type with type parameters',
      source: 'let f: <T>(value: T) => T;',
      english:
        'declare variable `f`\nwith type:\n    function type\n    with type parameters:\n        type parameter `T`\n    parameters:\n        parameter `value` with type `T`\n    returning `T`',
    },
    {
      name: 'constructor type',
      source: 'let make: new (input: string) => Widget;',
      english: 'declare variable `make`\nwith type:\n    constructor type\n    parameters:\n        parameter `input` with type string\n    returning `Widget`',
    },
    { name: 'abstract constructor type', source: 'let make: abstract new () => Widget;', english: 'declare variable `make` with type abstract constructor type with no parameters returning `Widget`' },
    { name: 'typeof with a type argument', source: 'let g: typeof f<string>;', english: 'declare variable `g` with type the type of `f` with type argument string' },
  ])
})

describe('type operators and lookups', () => {
  golden([
    { name: 'unique symbol', source: 'declare const tag: unique symbol;', english: 'declare ambient constant `tag` with type unique symbol' },
    { name: 'keyof', source: 'type Keys = keyof Config;', english: 'declare type alias `Keys` as the keys of `Config`' },
    { name: 'indexed access', source: 'type Port = Config["port"];', english: 'declare type alias `Port` as indexed access of `Config` at string "port"' },
    {
      name: 'conditional type with infer and constraint',
      source: 'type Flat<T> = T extends Array<infer U extends object> ? U : never;',
      english:
        'declare type alias `Flat`\nwith type parameters:\n    type parameter `T`\nas:\n    conditional type: if `T`\n    extends:\n        type `Array`\n        with type argument:\n            infer type parameter `U` constrained to object\n    then:\n        `U`\n    otherwise:\n        never',
    },
    {
      name: 'this type',
      source: 'class C { self(): this { return this; } }',
      english: 'declare class `C`\nmembers:\n    method `self`\n    with no parameters\n    return type:\n        the `this` type\n    body:\n        return `this`',
    },
  ])
})

describe('mapped and template types', () => {
  golden([
    {
      name: 'mapped type with remapping and modifiers',
      source: 'type Getters<T> = { +readonly [K in keyof T as `get${string & K}`]-?: () => T[K] };',
      english:
        'declare type alias `Getters`\nwith type parameters:\n    type parameter `T`\nas:\n    mapped type with key `K`\n    in the keys of `T`\n    renamed as:\n        template string type joining:\n            text "get"\n            value of type intersection type of string and `K`\n    adding readonly\n    removing optionality\n    with value type function type with no parameters returning indexed access of `T` at `K`',
    },
    {
      name: 'mapped type with plain modifiers and no value type',
      source: 'type Loose<T> = { readonly [K in keyof T]? };',
      english: 'declare type alias `Loose`\nwith type parameters:\n    type parameter `T`\nas:\n    mapped type with key `K`\n    in the keys of `T`\n    marked readonly\n    marked optional',
    },
    {
      name: 'mapped type removing readonly',
      source: 'type T = { -readonly [K in keyof U]: U[K] };',
      english: 'declare type alias `T`\nas:\n    mapped type with key `K`\n    in the keys of `U`\n    removing readonly\n    with value type indexed access of `U` at `K`',
    },
    {
      name: 'mapped type adding optionality',
      source: 'type T = { [K in keyof U]+?: U[K] };',
      english: 'declare type alias `T`\nas:\n    mapped type with key `K`\n    in the keys of `U`\n    adding optionality\n    with value type indexed access of `U` at `K`',
    },
    {
      name: 'template literal type with several spans',
      source: 'type Route = `/${string}/${number}`;',
      english: 'declare type alias `Route`\nas:\n    template string type joining:\n        text "/"\n        value of type string\n        text "/"\n        value of type number',
    },
    {
      name: 'template literal type with an empty head',
      source: 'type Suffixed = `${Prefix}-end`;',
      english: 'declare type alias `Suffixed`\nas:\n    template string type joining:\n        value of type `Prefix`\n        text "-end"',
    },
  ])
})

describe('type predicates', () => {
  golden([
    {
      name: 'type predicate forms',
      source: 'function isUser(value: unknown): value is User { return true; }',
      english: 'declare function `isUser`\nparameters:\n    parameter `value` with type unknown\nreturn type:\n    type predicate `value` is `User`\nbody:\n    return true',
    },
    {
      name: 'asserts predicate',
      source: 'function assertUser(value: unknown): asserts value is User {}',
      english: 'declare function `assertUser`\nparameters:\n    parameter `value` with type unknown\nreturn type:\n    asserts that `value` is `User`\nbody:\n    no statements',
    },
    {
      name: 'bare asserts',
      source: 'function assertOk(value: unknown): asserts value {}',
      english: 'declare function `assertOk`\nparameters:\n    parameter `value` with type unknown\nreturn type:\n    asserts `value`\nbody:\n    no statements',
    },
    {
      name: 'this predicate',
      source: 'class C { isReady(): this is Ready { return true; } }',
      english: 'declare class `C`\nmembers:\n    method `isReady`\n    with no parameters\n    return type:\n        type predicate `this` is `Ready`\n    body:\n        return true',
    },
  ])
})

describe('import types', () => {
  golden([
    { name: 'import type node', source: 'let config: import("./config").Config;', english: 'declare variable `config` with type type imported from string "./config" member `Config`' },
    {
      name: 'import type with typeof and attributes',
      source: 'let mod: typeof import("./data.json", { with: { type: "json" } });',
      english:
        'declare variable `mod`\nwith type:\n    the type of\n    type imported from string "./data.json"\n    with attributes:\n        attribute `type` set to string "json"',
    },
    { name: 'import type with type arguments', source: 'let box: import("./box").Box<string>;', english: 'declare variable `box` with type type imported from string "./box" member `Box` with type argument string' },
  ])
})

describe('parameters and assertions', () => {
  golden([
    {
      name: 'optional parameter and property defaults',
      source: 'function f(a?: string, b = 1, { c }: Opts = {}, ...rest: number[]) {}',
      english:
        'declare function `f`\nparameters:\n    optional parameter `a` with type string\n    parameter `b` with default number 1\n    parameter:\n        an object pattern binding:\n            bind property `c`\n    with type `Opts`\n    with default an empty object literal\n    rest parameter `rest` with type array type of number\nbody:\n    no statements',
    },
    {
      name: 'as and angle-bracket assertions',
      source: 'const a = value as User; const b = <User>value;',
      english: 'declare constant `a` and initialize it to `value` treated as type `User`\ndeclare constant `b` and initialize it to cast to type `User` the value `value`',
    },
    {
      name: 'const assertion and satisfies',
      source: 'const a = list as const; const b = cfg satisfies Config;',
      english: 'declare constant `a` and initialize it to `list` treated as type `const`\ndeclare constant `b` and initialize it to `cfg` checked to satisfy type `Config`',
    },
    { name: 'nested qualified type name', source: 'let x: a.b.C;', english: 'declare variable `x` with type `a.b.C`' },
  ])
})

describe('JSX', () => {
  golden([
    {
      name: 'element with attribute forms',
      source: 'const el = <a.b.C title="hi" count={n} {...rest} active />;',
      file: 'example.tsx',
      english:
        'declare constant `el`\nand initialize it to:\n    self-closing JSX element property `C` of property `b` of `a`\n    with attributes:\n        attribute `title` set to string "hi"\n        attribute `count` set to the expression `n`\n        spread attributes of `rest`\n        attribute `active`',
    },
    {
      name: 'namespaced tag and attribute',
      source: 'const el = <svg:rect svg:width="4" />;',
      file: 'example.tsx',
      english: 'declare constant `el`\nand initialize it to:\n    self-closing JSX element `svg:rect`\n    with attributes:\n        attribute `svg:width` set to string "4"',
    },
    {
      name: 'children with expressions and spread',
      source: 'const el = <ul>{first}<li>Item</li>{...items}</ul>;',
      file: 'example.tsx',
      english:
        'declare constant `el`\nand initialize it to:\n    JSX element `ul`\n    children:\n        the expression `first`\n        JSX element `li`\n        children:\n            text "Item"\n        the spread expression `items`',
    },
    { name: 'fragment with text', source: 'const el = <>Hello world</>;', file: 'example.tsx', english: 'declare constant `el`\nand initialize it to:\n    JSX fragment\n    children:\n        text "Hello world"' },
    {
      name: 'empty jsx expression',
      source: 'const el = <div>{/* note */}</div>;',
      file: 'example.tsx',
      english: 'declare constant `el`\nand initialize it to:\n    JSX element `div`\n    children:\n        an empty JSX expression',
    },
    {
      name: 'jsx element whose only child is whitespace',
      source: 'const el = <div>\n</div>;',
      file: 'example.tsx',
      english: 'declare constant `el`\nand initialize it to:\n    JSX element `div`',
    },
    {
      name: 'whitespace-only text is skipped',
      source: 'const el = (\n  <div>\n    <span />\n  </div>\n);',
      file: 'example.tsx',
      english: 'declare constant `el`\nand initialize it to:\n    group of:\n        JSX element `div`\n        children:\n            self-closing JSX element `span`',
    },
  ])
})
