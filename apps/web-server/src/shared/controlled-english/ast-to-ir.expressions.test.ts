import { describe, expect, it } from 'vitest'
import { sourceFileEnglish } from './ast-to-ir'
import { parseSource } from './compiler-context'
import { renderEnglish } from './english-renderer'

const english = (source: string, file = 'example.ts'): string => {
  const { sourceFile } = parseSource(file, source)
  return renderEnglish(sourceFileEnglish(sourceFile))
}

type Golden = { name: string; source: string; english: string }

const golden = (cases: readonly Golden[]) => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(english(c.source)).toBe(c.english)
  })
}

// Exact whole-file goldens (spec Phase 9): every operator and expression form
// pins its one canonical English rendering byte for byte.

describe('binary operators', () => {
  golden([
    { name: 'plus', source: 'a + b;', english: '`a` plus `b`' },
    { name: 'minus', source: 'a - b;', english: '`a` minus `b`' },
    { name: 'multiplied by', source: 'a * b;', english: '`a` multiplied by `b`' },
    { name: 'divided by', source: 'a / b;', english: '`a` divided by `b`' },
    { name: 'remainder', source: 'a % b;', english: '`a` remainder `b`' },
    { name: 'raised to the power of', source: 'a ** b;', english: '`a` raised to the power of `b`' },
    { name: 'strict equality', source: 'a === b;', english: '`a` is strictly equal to `b`' },
    { name: 'strict inequality', source: 'a !== b;', english: '`a` is strictly unequal to `b`' },
    { name: 'loose equality', source: 'a == b;', english: '`a` is loosely equal to `b`' },
    { name: 'loose inequality', source: 'a != b;', english: '`a` is loosely unequal to `b`' },
    { name: 'greater than', source: 'a > b;', english: '`a` is greater than `b`' },
    { name: 'greater or equal', source: 'a >= b;', english: '`a` is greater than or equal to `b`' },
    { name: 'less than', source: 'a < b;', english: '`a` is less than `b`' },
    { name: 'less or equal', source: 'a <= b;', english: '`a` is less than or equal to `b`' },
    { name: 'logical and', source: 'a && b;', english: '`a` and `b`' },
    { name: 'logical or', source: 'a || b;', english: '`a` or `b`' },
    { name: 'nullish coalescing', source: 'a ?? b;', english: '`a` or-if-nullish `b`' },
    { name: 'in', source: 'key in bag;', english: '`key` is a key in `bag`' },
    { name: 'instanceof', source: 'value instanceof Error;', english: '`value` is an instance of `Error`' },
    { name: 'bitwise and', source: 'a & b;', english: '`a` bitwise-AND `b`' },
    { name: 'bitwise or', source: 'a | b;', english: '`a` bitwise-OR `b`' },
    { name: 'bitwise xor', source: 'a ^ b;', english: '`a` bitwise-XOR `b`' },
    { name: 'shift left', source: 'a << b;', english: '`a` shifted left by `b`' },
    { name: 'shift right sign-preserving', source: 'a >> b;', english: '`a` shifted right (sign-preserving) by `b`' },
    { name: 'shift right zero-filling', source: 'a >>> b;', english: '`a` shifted right (zero-filling) by `b`' },
    { name: 'grouping preserved on the left', source: '(a + b) * c;', english: '(`a` plus `b`) multiplied by `c`' },
    { name: 'grouping implied by precedence', source: 'a + b * c;', english: '`a` plus (`b` multiplied by `c`)' },
  ])
})

describe('assignments and sequences', () => {
  golden([
    { name: 'simple assignment', source: 'x = y;', english: 'assign `x` the value `y`' },
    { name: 'assignment of a call', source: 'x = f();', english: 'assign `x`\nthe value:\n    call `f` with no arguments' },
    { name: 'add and assign', source: 'x += y;', english: 'add and assign to `x` the value `y`' },
    { name: 'subtract and assign', source: 'x -= y;', english: 'subtract and assign to `x` the value `y`' },
    { name: 'multiply and assign', source: 'x *= y;', english: 'multiply and assign to `x` the value `y`' },
    { name: 'divide and assign', source: 'x /= y;', english: 'divide and assign to `x` the value `y`' },
    { name: 'remainder and assign', source: 'x %= y;', english: 'take the remainder and assign to `x` the value `y`' },
    { name: 'power and assign', source: 'x **= y;', english: 'raise to the power and assign to `x` the value `y`' },
    { name: 'shift left and assign', source: 'x <<= y;', english: 'shift left and assign to `x` the value `y`' },
    { name: 'shift right and assign', source: 'x >>= y;', english: 'shift right (sign-preserving) and assign to `x` the value `y`' },
    { name: 'unsigned shift right and assign', source: 'x >>>= y;', english: 'shift right (zero-filling) and assign to `x` the value `y`' },
    { name: 'bitwise and and assign', source: 'x &= y;', english: 'bitwise-AND and assign to `x` the value `y`' },
    { name: 'bitwise or and assign', source: 'x |= y;', english: 'bitwise-OR and assign to `x` the value `y`' },
    { name: 'bitwise xor and assign', source: 'x ^= y;', english: 'bitwise-XOR and assign to `x` the value `y`' },
    { name: 'logical and assignment', source: 'x &&= y;', english: 'assign if truthy to `x` the value `y`' },
    { name: 'logical or assignment', source: 'x ||= y;', english: 'assign if falsy to `x` the value `y`' },
    { name: 'nullish assignment', source: 'x ??= y;', english: 'assign if nullish to `x` the value `y`' },
    { name: 'comma sequence', source: 'a, b;', english: 'evaluate and discard `a` then yield `b`' },
  ])
})

describe('unary operators', () => {
  golden([
    { name: 'not', source: '!ready;', english: 'not `ready`' },
    { name: 'negative', source: '-count;', english: 'negative `count`' },
    { name: 'positive', source: '+count;', english: 'positive `count`' },
    { name: 'bitwise NOT', source: '~mask;', english: 'bitwise-NOT `mask`' },
    { name: 'prefix increment', source: '++i;', english: 'increment `i` and yield the new value' },
    { name: 'prefix decrement', source: '--i;', english: 'decrement `i` and yield the new value' },
    { name: 'postfix increment', source: 'i++;', english: 'increment `i` and yield the previous value' },
    { name: 'postfix decrement', source: 'i--;', english: 'decrement `i` and yield the previous value' },
    { name: 'void of a literal', source: 'void 0;', english: 'evaluate number 0 and yield undefined' },
    { name: 'typeof', source: 'typeof value;', english: 'the type name of `value`' },
    { name: 'delete an element', source: 'delete cache[key];', english: 'delete element `key` of `cache`' },
  ])
})

describe('calls, construction and access', () => {
  golden([
    { name: 'optional element access', source: 'items?.[0];', english: 'optional element number 0 of `items`' },
    { name: 'optional call of a property', source: 'handler.run?.();', english: 'optionally call property `run` of `handler` with no arguments' },
    { name: 'call with several arguments', source: 'plot(x, y);', english: 'call `plot`\nwith arguments:\n    `x`\n    `y`' },
    { name: 'call with a structured argument', source: 'log(user.name);', english: 'call `log`\nwith argument:\n    property `name` of `user`' },
    { name: 'call with a spread argument', source: 'f(...items);', english: 'call `f`\nwith argument:\n    spread of `items`' },
    { name: 'call with plural type arguments', source: 'pair<string, number>(x);', english: 'call `pair`\nwith type arguments:\n    string\n    number\nwith argument `x`' },
    { name: 'zero-argument call with a type argument', source: 'make<string>();', english: 'call `make` with type argument string with no arguments' },
    { name: 'construct with no argument list', source: 'new Foo;', english: 'construct a new `Foo`' },
    { name: 'construct with an empty argument list', source: 'new Foo();', english: 'construct a new `Foo` with no arguments' },
    { name: 'construct with a type argument', source: 'new Box<string>(value);', english: 'construct a new `Box`\nwith type argument:\n    string\nwith argument `value`' },
    {
      name: 'iife groups the function',
      source: '(function () { run(); })();',
      english: 'call:\n    group of:\n        function expression\n        with no parameters\n        body:\n            call `run` with no arguments\nwith no arguments',
    },
    { name: 'new target meta-property', source: 'function f() { return new.target; }', english: 'declare function `f`\nwith no parameters\nbody:\n    return `new.target`' },
  ])
})

describe('await and yield', () => {
  golden([
    { name: 'await of a call', source: 'async function f() { await g(); }', english: 'declare asynchronous function `f`\nwith no parameters\nbody:\n    await:\n        call `g` with no arguments' },
    { name: 'bare yield', source: 'function* g() { yield; }', english: 'declare generator function `g`\nwith no parameters\nbody:\n    yield' },
    { name: 'yield each', source: 'function* g() { yield* inner; }', english: 'declare generator function `g`\nwith no parameters\nbody:\n    yield each value of `inner`' },
  ])
})

describe('condition forms', () => {
  golden([
    { name: 'negated condition stands alone', source: 'if (!ready) stop();', english: 'if not `ready`\nthen:\n    call `stop` with no arguments' },
    { name: 'non-predicate unary condition gets a truthiness test', source: 'if (-balance) alert();', english: 'if negative `balance` is truthy\nthen:\n    call `alert` with no arguments' },
    {
      name: 'block-shaped condition gets a truthiness block',
      source: 'async function f() { if (await check()) { proceed(); } }',
      english:
        'declare asynchronous function `f`\nwith no parameters\nbody:\n    if:\n        await:\n            call `check` with no arguments\n        is truthy\n    then:\n        call `proceed` with no arguments',
    },
    {
      name: 'private field presence check',
      source: 'class C { #x; has(o) { return #x in o; } }',
      english: 'declare class `C`\nmembers:\n    field `#x`\n    method `has`\n    parameters:\n        parameter `o`\n    body:\n        return `#x` is a key in `o`',
    },
  ])
})

describe('conditional expressions', () => {
  golden([
    { name: 'conditional with a predicate condition', source: 'a > b ? a : b;', english: 'if `a` is greater than `b` then yield `a` otherwise yield `b`' },
    {
      name: 'conditional yielding calls',
      source: 'ready ? start() : stop();',
      english: 'if `ready` is truthy\nthen yield:\n    call `start` with no arguments\notherwise yield:\n    call `stop` with no arguments',
    },
  ])
})

describe('templates and literals', () => {
  golden([
    {
      name: 'template with several values',
      source: 'const s = `${a}-${b}`;',
      english: 'declare constant `s`\nand initialize it to:\n    template string joining:\n        value of `a`\n        text "-"\n        value of `b`',
    },
    {
      name: 'tagged template with a substitution template',
      source: 'const q = sql`SELECT ${id}`;',
      english: 'declare constant `q`\nand initialize it to:\n    call tag `sql`\n    using:\n        template string joining:\n            text "SELECT "\n            value of `id`',
    },
    {
      name: 'object literal member forms',
      source: 'const o = { [key]: v, ...rest, "s": 1, 2: two };',
      english:
        'declare constant `o`\nand initialize it to:\n    an object literal with:\n        property named by `key` set to `v`\n        spread of `rest`\n        property string "s" set to number 1\n        property number 2 set to `two`',
    },
    {
      name: 'object literal with a method and accessors',
      source: 'const o = { m() { return 1; }, get x() { return 2; }, set x(v) {} };',
      english:
        'declare constant `o`\nand initialize it to:\n    an object literal with:\n        method `m`\n        with no parameters\n        body:\n            return number 1\n        getter `x`\n        body:\n            return number 2\n        setter `x`\n        parameters:\n            parameter `v`\n        body:\n            no statements',
    },
    { name: 'empty object literal', source: 'const o = {};', english: 'declare constant `o` and initialize it to an empty object literal' },
    { name: 'empty array literal', source: 'const a = [];', english: 'declare constant `a` and initialize it to an empty array literal' },
    {
      name: 'destructuring assignment with a default',
      source: '({ a = fallback } = source);',
      english: 'group of:\n    assign:\n        an object literal with:\n            shorthand property `a` with default `fallback`\n    the value `source`',
    },
  ])
})

describe('function-valued expressions', () => {
  golden([
    { name: 'arrow with no parameters', source: 'const f = () => 1;', english: 'declare constant `f`\nand initialize it to:\n    arrow function\n    with no parameters\n    returning number 1' },
    {
      name: 'async arrow with a block body',
      source: 'const f = async (a, b) => { return a; };',
      english: 'declare constant `f`\nand initialize it to:\n    asynchronous arrow function\n    parameter `a`\n    parameter `b`\n    body:\n        return `a`',
    },
    {
      name: 'arrow with a return type and type parameter',
      source: 'const f = <T>(value: T): T => value;',
      english:
        'declare constant `f`\nand initialize it to:\n    arrow function\n    with type parameters:\n        type parameter `T`\n    parameter `value` with type `T`\n    return type:\n        `T`\n    returning `value`',
    },
    {
      name: 'anonymous async generator function expression',
      source: 'const g = async function* () { yield 1; };',
      english: 'declare constant `g`\nand initialize it to:\n    asynchronous generator function expression\n    with no parameters\n    body:\n        yield number 1',
    },
    {
      name: 'class expression with a member',
      source: 'const C = class { run() {} };',
      english: 'declare constant `C`\nand initialize it to:\n    class expression\n    members:\n        method `run`\n        with no parameters\n        body:\n            no statements',
    },
  ])
})

describe('non-null assertions keep their target visible', () => {
  golden([
    { name: 'non-null on a property chain', source: 'user.name!;', english: '(property `name` of `user`) asserted non-null' },
    { name: 'non-null then property access', source: 'user!.name;', english: 'property `name` of `user` asserted non-null' },
  ])
})
