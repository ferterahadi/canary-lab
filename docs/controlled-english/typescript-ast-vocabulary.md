# TypeScript AST Vocabulary — Controlled English

**Generated file — do not edit by hand.** Regenerate it from the repository-owned tables with:

```sh
node --import tsx tools/gen-controlled-english-vocabulary.ts
```

Compiled against TypeScript **5.9.3** — the pinned grammar version
(`apps/web-server/src/shared/controlled-english/compiler-context.ts`). Every example below is a complete
program whose exact whole-file rendering is enforced byte-for-byte by `vocabulary.test.ts`.

## Kind inventory (Phase 1)

Every `ts.SyntaxKind` name is classified in `apps/web-server/src/shared/controlled-english/syntax-kinds.ts`:

| Disposition | Kinds | Meaning |
| --- | ---: | --- |
| translated | 131 | Has exactly one canonical English form (documented below) |
| keyword-token | 50 | A keyword token consumed by its owning construct |
| operator-token | 45 | Rendered through an operator phrase table, never as a node |
| jsdoc | 44 | JSDoc structure — trivia to the translator |
| structural-child | 38 | Never rendered alone — translated as part of its parent construct |
| punctuation | 19 | Pure syntax — carries no meaning of its own |
| modifier | 14 | Rendered through the modifier word table |
| compiler-internal | 12 | Synthetic/internal kinds a parsed source file never contains |
| trivia | 6 | Comments and whitespace — comments render as explicit `comment:` lines |

A kind outside this table (or a translated kind missing an implementation) throws
`UNSUPPORTED_SYNTAX_KIND: <kind>` — the engine never falls back to source code or silent prose (Phase 6).

## Binary operator phrases

One distinct phrase per operator — two different operators can never read alike.

| Operator token | English |
| --- | --- |
| `PlusToken` | plus |
| `MinusToken` | minus |
| `AsteriskToken` | multiplied by |
| `SlashToken` | divided by |
| `PercentToken` | remainder |
| `AsteriskAsteriskToken` | raised to the power of |
| `EqualsEqualsEqualsToken` | is strictly equal to |
| `ExclamationEqualsEqualsToken` | is strictly unequal to |
| `EqualsEqualsToken` | is loosely equal to |
| `ExclamationEqualsToken` | is loosely unequal to |
| `GreaterThanToken` | is greater than |
| `GreaterThanEqualsToken` | is greater than or equal to |
| `LessThanToken` | is less than |
| `LessThanEqualsToken` | is less than or equal to |
| `AmpersandAmpersandToken` | and |
| `BarBarToken` | or |
| `QuestionQuestionToken` | or-if-nullish |
| `InKeyword` | is a key in |
| `InstanceOfKeyword` | is an instance of |
| `AmpersandToken` | bitwise-AND |
| `BarToken` | bitwise-OR |
| `CaretToken` | bitwise-XOR |
| `LessThanLessThanToken` | shifted left by |
| `GreaterThanGreaterThanToken` | shifted right (sign-preserving) by |
| `GreaterThanGreaterThanGreaterThanToken` | shifted right (zero-filling) by |

Simple assignment (`=`) reads **assign X the value Y**, and the comma operator reads
**evaluate and discard X then yield Y** — both structured forms, not table rows.

## Compound assignment phrases

| Operator token | English |
| --- | --- |
| `PlusEqualsToken` | add and assign to |
| `MinusEqualsToken` | subtract and assign to |
| `AsteriskEqualsToken` | multiply and assign to |
| `SlashEqualsToken` | divide and assign to |
| `PercentEqualsToken` | take the remainder and assign to |
| `AsteriskAsteriskEqualsToken` | raise to the power and assign to |
| `LessThanLessThanEqualsToken` | shift left and assign to |
| `GreaterThanGreaterThanEqualsToken` | shift right (sign-preserving) and assign to |
| `GreaterThanGreaterThanGreaterThanEqualsToken` | shift right (zero-filling) and assign to |
| `AmpersandEqualsToken` | bitwise-AND and assign to |
| `BarEqualsToken` | bitwise-OR and assign to |
| `CaretEqualsToken` | bitwise-XOR and assign to |
| `AmpersandAmpersandEqualsToken` | assign if truthy to |
| `BarBarEqualsToken` | assign if falsy to |
| `QuestionQuestionEqualsToken` | assign if nullish to |

## Modifier words

Rendered in source order. The table is total over `ts.ModifierSyntaxKind` by type,
so a TypeScript upgrade that adds a modifier fails compilation.

| Modifier | English |
| --- | --- |
| `ConstKeyword` | const |
| `DefaultKeyword` | as default |
| `ExportKeyword` | exported |
| `InKeyword` | in |
| `PrivateKeyword` | private |
| `ProtectedKeyword` | protected |
| `PublicKeyword` | public |
| `StaticKeyword` | static |
| `AbstractKeyword` | abstract |
| `AccessorKeyword` | accessor |
| `AsyncKeyword` | asynchronous |
| `DeclareKeyword` | ambient |
| `OutKeyword` | out |
| `ReadonlyKeyword` | readonly |
| `OverrideKeyword` | override |

## Translated kinds — summary

131 kinds carry a canonical English form:

| SyntaxKind | Category | Canonical English |
| --- | --- | --- |
| `NumericLiteral` | literal | number |
| `BigIntLiteral` | literal | bigint |
| `StringLiteral` | literal | string |
| `RegularExpressionLiteral` | literal | regular expression |
| `NoSubstitutionTemplateLiteral` | literal | template string |
| `Identifier` | name | backticked name |
| `PrivateIdentifier` | name | backticked name |
| `TrueKeyword` | keyword | true |
| `FalseKeyword` | keyword | false |
| `NullKeyword` | keyword | null |
| `ThisKeyword` | keyword | `this` |
| `SuperKeyword` | keyword | `super` |
| `ImportKeyword` | keyword | `import` |
| `QualifiedName` | name | dotted name |
| `AnyKeyword` | type | any |
| `UnknownKeyword` | type | unknown |
| `NeverKeyword` | type | never |
| `VoidKeyword` | keyword | void |
| `UndefinedKeyword` | type | undefined |
| `StringKeyword` | type | string |
| `NumberKeyword` | type | number |
| `BooleanKeyword` | type | boolean |
| `BigIntKeyword` | type | bigint |
| `SymbolKeyword` | type | symbol |
| `ObjectKeyword` | type | object |
| `IntrinsicKeyword` | type | intrinsic |
| `PropertyAccessExpression` | expression | property … of … |
| `ElementAccessExpression` | expression | element … of … |
| `CallExpression` | expression | call |
| `NewExpression` | expression | construct a new |
| `BinaryExpression` | expression | operator phrase between operands |
| `PrefixUnaryExpression` | expression | not / negative / positive / bitwise-NOT / increment / decrement |
| `PostfixUnaryExpression` | expression | increment / decrement … and yield the previous value |
| `ParenthesizedExpression` | expression | explicit grouping |
| `ConditionalExpression` | expression | if … then yield … otherwise yield … |
| `AwaitExpression` | expression | await |
| `YieldExpression` | expression | yield / yield each value of |
| `TypeOfExpression` | expression | the type name of |
| `VoidExpression` | expression | evaluate … and yield undefined |
| `DeleteExpression` | expression | delete |
| `SpreadElement` | expression | spread of |
| `TemplateExpression` | expression | template string joining |
| `TaggedTemplateExpression` | expression | call tag … with template … |
| `ObjectLiteralExpression` | expression | an object literal with |
| `ArrayLiteralExpression` | expression | an array literal of |
| `OmittedExpression` | expression | a hole |
| `ArrowFunction` | expression | arrow function |
| `FunctionExpression` | expression | function expression |
| `ClassExpression` | expression | class expression |
| `AsExpression` | expression | treated as type |
| `SatisfiesExpression` | expression | checked to satisfy type |
| `NonNullExpression` | expression | asserted non-null |
| `TypeAssertionExpression` | expression | cast to type … the value … |
| `ExpressionWithTypeArguments` | expression | with type argument(s) |
| `MetaProperty` | expression | meta-property name |
| `ObjectBindingPattern` | binding | an object pattern binding |
| `ArrayBindingPattern` | binding | an array pattern binding |
| `VariableStatement` | statement | declare … |
| `Parameter` | declaration | parameter |
| `Decorator` | declaration | decorator |
| `FunctionDeclaration` | declaration | declare function |
| `ClassDeclaration` | declaration | declare class |
| `PropertyDeclaration` | class-member | field |
| `MethodDeclaration` | class-member | method |
| `Constructor` | class-member | constructor |
| `GetAccessor` | class-member | getter |
| `SetAccessor` | class-member | setter |
| `ClassStaticBlockDeclaration` | class-member | static initialization block |
| `SemicolonClassElement` | class-member | an empty class member |
| `InterfaceDeclaration` | declaration | declare interface |
| `PropertySignature` | class-member | property (member) |
| `MethodSignature` | class-member | method (member) |
| `CallSignature` | class-member | call signature |
| `ConstructSignature` | class-member | construct signature |
| `IndexSignature` | class-member | index signature |
| `TypeAliasDeclaration` | declaration | declare type alias |
| `EnumDeclaration` | declaration | declare enum |
| `ModuleDeclaration` | declaration | declare namespace / module / global augmentation |
| `SourceFile` | statement | whole file |
| `ExpressionStatement` | statement | the expression itself |
| `Block` | statement | block |
| `EmptyStatement` | statement | an empty statement |
| `IfStatement` | statement | if / then / otherwise |
| `WhileStatement` | statement | while |
| `DoStatement` | statement | do / then repeat while |
| `ForStatement` | statement | for loop |
| `ForOfStatement` | statement | for each … from iterable |
| `ForInStatement` | statement | for each … from the enumerable keys of |
| `ContinueStatement` | statement | continue |
| `BreakStatement` | statement | break |
| `ReturnStatement` | statement | return |
| `WithStatement` | statement | with scope from |
| `SwitchStatement` | statement | switch on |
| `LabeledStatement` | statement | labeled |
| `ThrowStatement` | statement | throw |
| `TryStatement` | statement | try / on error caught as / catch / finally |
| `DebuggerStatement` | statement | trigger the debugger |
| `ImportDeclaration` | module | import |
| `ImportEqualsDeclaration` | module | import … as an alias for |
| `ExportDeclaration` | module | export |
| `ExportAssignment` | module | export as default / export equals |
| `NamespaceExportDeclaration` | module | export as the global namespace |
| `TypeParameter` | declaration | type parameter |
| `TypeReference` | type | type … with type argument(s) |
| `TypePredicate` | type | type predicate … is … |
| `FunctionType` | type | function type |
| `ConstructorType` | type | constructor type |
| `TypeQuery` | type | the type of |
| `TypeLiteral` | type | an object type with |
| `ArrayType` | type | array type of |
| `TupleType` | type | tuple type of |
| `NamedTupleMember` | type | member … with type … |
| `OptionalType` | type | optional |
| `RestType` | type | rest of |
| `UnionType` | type | union type of |
| `IntersectionType` | type | intersection type of |
| `ConditionalType` | type | conditional type: if … extends … then … otherwise … |
| `InferType` | type | infer type parameter |
| `ParenthesizedType` | type | explicit grouping |
| `ThisType` | type | the `this` type |
| `TypeOperator` | type | the keys of / unique / readonly |
| `IndexedAccessType` | type | indexed access of … at … |
| `MappedType` | type | mapped type with key |
| `LiteralType` | type | the literal itself |
| `TemplateLiteralType` | type | template string type joining |
| `ImportType` | type | type imported from |
| `JsxElement` | jsx | JSX element |
| `JsxSelfClosingElement` | jsx | self-closing JSX element |
| `JsxFragment` | jsx | JSX fragment |
| `JsxExpression` | jsx | the expression |
| `JsxText` | jsx | text |

## Translated kinds — full entries

### NumericLiteral

- **Node interface:** `ts.NumericLiteral`
- **Category:** literal
- **TypeScript-only:** no
- **Canonical English:** number
- **Template:** number {raw source text}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** Raw source text preserves numeric separators and radix.

Example:

```ts
const timeout = 60_000;
```

```text
declare constant `timeout` and initialize it to number 60_000
```

### BigIntLiteral

- **Node interface:** `ts.BigIntLiteral`
- **Category:** literal
- **TypeScript-only:** no
- **Canonical English:** bigint
- **Template:** bigint {text}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const big = 42n;
```

```text
declare constant `big` and initialize it to bigint 42n
```

### StringLiteral

- **Node interface:** `ts.StringLiteral`
- **Category:** literal
- **TypeScript-only:** no
- **Canonical English:** string
- **Template:** string {JSON-quoted text}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const greeting = "hi";
```

```text
declare constant `greeting` and initialize it to string "hi"
```

### RegularExpressionLiteral

- **Node interface:** `ts.RegularExpressionLiteral`
- **Category:** literal
- **TypeScript-only:** no
- **Canonical English:** regular expression
- **Template:** regular expression {raw literal}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const pattern = /ab+c/gi;
```

```text
declare constant `pattern` and initialize it to regular expression /ab+c/gi
```

### NoSubstitutionTemplateLiteral

- **Node interface:** `ts.NoSubstitutionTemplateLiteral`
- **Category:** literal
- **TypeScript-only:** no
- **Canonical English:** template string
- **Template:** template string {JSON-quoted text}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** Distinct wording from string so backtick and quote literals never read the same.

Example:

```ts
const plain = `plain`;
```

```text
declare constant `plain` and initialize it to template string "plain"
```

### Identifier

- **Node interface:** `ts.Identifier`
- **Category:** name
- **TypeScript-only:** no
- **Canonical English:** backticked name
- **Template:** `{text}`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** Names remain names: no prose is invented around an identifier.

Example:

```ts
order;
```

```text
`order`
```

### PrivateIdentifier

- **Node interface:** `ts.PrivateIdentifier`
- **Category:** name
- **TypeScript-only:** no
- **Canonical English:** backticked name
- **Template:** `#{text}`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
class Vault { #secret = 1; }
```

```text
declare class `Vault`
members:
    field `#secret` and initialize it to number 1
```

### TrueKeyword

- **Node interface:** `ts.TrueLiteral`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** true
- **Template:** true
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const flag = true;
```

```text
declare constant `flag` and initialize it to true
```

### FalseKeyword

- **Node interface:** `ts.FalseLiteral`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** false
- **Template:** false
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const flag = false;
```

```text
declare constant `flag` and initialize it to false
```

### NullKeyword

- **Node interface:** `ts.NullLiteral`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** null
- **Template:** null
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const empty = null;
```

```text
declare constant `empty` and initialize it to null
```

### ThisKeyword

- **Node interface:** `ts.ThisExpression`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** `this`
- **Template:** `this`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
function self() { return this; }
```

```text
declare function `self`
with no parameters
body:
    return `this`
```

### SuperKeyword

- **Node interface:** `ts.SuperExpression`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** `super`
- **Template:** `super`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
class Child extends Base { constructor() { super(); } }
```

```text
declare class `Child`
extending `Base`
members:
    constructor
    with no parameters
    body:
        call `super` with no arguments
```

### ImportKeyword

- **Node interface:** `ts.ImportExpression`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** `import`
- **Template:** `import`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** A dynamic import is a call whose callee is `import`.

Example:

```ts
const mod = await import("./m");
```

```text
declare constant `mod`
and initialize it to:
    await:
        call `import`
        with argument string "./m"
```

### QualifiedName

- **Node interface:** `ts.QualifiedName`
- **Category:** name
- **TypeScript-only:** no
- **Canonical English:** dotted name
- **Template:** `{left}.{right}`
- **Children:** left, right
- **Evaluation order:** left, then right
- **Semantic info required:** none
- **Notes:** A dotted entity name renders as one backticked path.

Example:

```ts
let wait: ns.Duration;
```

```text
declare variable `wait` with type `ns.Duration`
```

### AnyKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** any
- **Template:** any
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let loose: any;
```

```text
declare variable `loose` with type any
```

### UnknownKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** unknown
- **Template:** unknown
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let mystery: unknown;
```

```text
declare variable `mystery` with type unknown
```

### NeverKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** never
- **Template:** never
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let impossible: never;
```

```text
declare variable `impossible` with type never
```

### VoidKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** keyword
- **TypeScript-only:** no
- **Canonical English:** void
- **Template:** void
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** The void *type*; the void operator is VoidExpression.

Example:

```ts
function log(): void {}
```

```text
declare function `log`
with no parameters
return type:
    void
body:
    no statements
```

### UndefinedKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** undefined
- **Template:** undefined
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let missing: undefined;
```

```text
declare variable `missing` with type undefined
```

### StringKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** string
- **Template:** string
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let name: string;
```

```text
declare variable `name` with type string
```

### NumberKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** number
- **Template:** number
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let count: number;
```

```text
declare variable `count` with type number
```

### BooleanKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** boolean
- **Template:** boolean
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let ready: boolean;
```

```text
declare variable `ready` with type boolean
```

### BigIntKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** bigint
- **Template:** bigint
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let big: bigint;
```

```text
declare variable `big` with type bigint
```

### SymbolKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** symbol
- **Template:** symbol
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let token: symbol;
```

```text
declare variable `token` with type symbol
```

### ObjectKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** object
- **Template:** object
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
let box: object;
```

```text
declare variable `box` with type object
```

### IntrinsicKeyword

- **Node interface:** `ts.KeywordTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** intrinsic
- **Template:** intrinsic
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
type Upper = intrinsic;
```

```text
declare type alias `Upper` as intrinsic
```

### PropertyAccessExpression

- **Node interface:** `ts.PropertyAccessExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** property … of …
- **Template:** (property | optional property) `{name}` of {expression}
- **Children:** name, expression
- **Evaluation order:** object expression evaluates first; the name is static
- **Semantic info required:** none
- **Notes:** `?.` reads "optional property" so foo.bar and foo?.bar never match.

Example:

```ts
user.email;
```

```text
property `email` of `user`
```

### ElementAccessExpression

- **Node interface:** `ts.ElementAccessExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** element … of …
- **Template:** (element | optional element) {argumentExpression} of {expression}
- **Children:** argumentExpression, expression
- **Evaluation order:** object expression, then index expression
- **Semantic info required:** none
- **Notes:** Distinct from property access so foo.bar and foo["bar"] never read the same.

Example:

```ts
items[0];
```

```text
element number 0 of `items`
```

### CallExpression

- **Node interface:** `ts.CallExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** call
- **Template:** (call | optionally call) {expression} [with type argument(s) …] (with no arguments | with argument … | with arguments: …)
- **Children:** expression (callee), typeArguments, arguments
- **Evaluation order:** callee, then arguments left to right
- **Semantic info required:** none
- **Notes:** Any call with arguments is a block; nested calls stay visibly nested.

Example:

```ts
processPayment(order);
```

```text
call `processPayment`
with argument `order`
```

### NewExpression

- **Node interface:** `ts.NewExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** construct a new
- **Template:** construct a new {expression} [with type argument(s) …] [with no arguments | with argument … | with arguments: …]
- **Children:** expression (constructor), typeArguments, arguments
- **Evaluation order:** constructor expression, then arguments left to right
- **Semantic info required:** none
- **Notes:** `new Foo` (no argument list) carries no argument segment, distinct from `new Foo()`.

Example:

```ts
const failure = new Error("boom");
```

```text
declare constant `failure`
and initialize it to:
    construct a new `Error`
    with argument string "boom"
```

### BinaryExpression

- **Node interface:** `ts.BinaryExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** operator phrase between operands
- **Template:** {left} {operator phrase} {right} — assignments read "assign {left} the value {right}"
- **Children:** left, operatorToken, right
- **Evaluation order:** left, then right (assignment targets are named first)
- **Semantic info required:** none
- **Notes:** Every operator has exactly one phrase (see BINARY_OPERATOR_PHRASES / COMPOUND_ASSIGNMENT_PHRASES); nested binary operands are explicitly grouped.

Example:

```ts
const total = price * quantity;
```

```text
declare constant `total` and initialize it to `price` multiplied by `quantity`
```

### PrefixUnaryExpression

- **Node interface:** `ts.PrefixUnaryExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** not / negative / positive / bitwise-NOT / increment / decrement
- **Template:** {operator phrase} {operand}
- **Children:** operand
- **Evaluation order:** operand only
- **Semantic info required:** none
- **Notes:** ++x/--x read "increment/decrement … and yield the new value".

Example:

```ts
const negated = -count;
```

```text
declare constant `negated` and initialize it to negative `count`
```

### PostfixUnaryExpression

- **Node interface:** `ts.PostfixUnaryExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** increment / decrement … and yield the previous value
- **Template:** increment|decrement {operand} and yield the previous value
- **Children:** operand
- **Evaluation order:** operand only
- **Semantic info required:** none
- **Notes:** The yielded-value wording is what separates x++ from ++x.

Example:

```ts
count++;
```

```text
increment `count` and yield the previous value
```

### ParenthesizedExpression

- **Node interface:** `ts.ParenthesizedExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** explicit grouping
- **Template:** ({expression}) inline, or "group of:" as a block
- **Children:** expression
- **Evaluation order:** inner expression only
- **Semantic info required:** none
- **Notes:** Grouping is preserved so (a + b) * c and a + b * c can never read the same.

Example:

```ts
const total = (base + tax) * 2;
```

```text
declare constant `total` and initialize it to (`base` plus `tax`) multiplied by number 2
```

### ConditionalExpression

- **Node interface:** `ts.ConditionalExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** if … then yield … otherwise yield …
- **Template:** if {condition} then yield {whenTrue} otherwise yield {whenFalse}
- **Children:** condition, whenTrue, whenFalse
- **Evaluation order:** condition, then exactly one branch at runtime
- **Semantic info required:** none

Example:

```ts
const label = isActive ? "on" : "off";
```

```text
declare constant `label`
and initialize it to:
    if `isActive` is truthy then yield string "on" otherwise yield string "off"
```

### AwaitExpression

- **Node interface:** `ts.AwaitExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** await
- **Template:** await {expression}
- **Children:** expression
- **Evaluation order:** operand evaluates, then the result is awaited
- **Semantic info required:** none

Example:

```ts
const user = await findUser();
```

```text
declare constant `user`
and initialize it to:
    await:
        call `findUser` with no arguments
```

### YieldExpression

- **Node interface:** `ts.YieldExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** yield / yield each value of
- **Template:** yield [{expression}] | yield each value of {expression}
- **Children:** expression
- **Evaluation order:** operand evaluates, then the generator suspends
- **Semantic info required:** none
- **Notes:** `yield*` reads "yield each value of", distinct from plain yield.

Example:

```ts
function* count() { yield 1; }
```

```text
declare generator function `count`
with no parameters
body:
    yield number 1
```

### TypeOfExpression

- **Node interface:** `ts.TypeOfExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** the type name of
- **Template:** the type name of {expression}
- **Children:** expression
- **Evaluation order:** operand only
- **Semantic info required:** none
- **Notes:** Runtime typeof; the type-position typeof is TypeQuery.

Example:

```ts
const kind = typeof value;
```

```text
declare constant `kind` and initialize it to the type name of `value`
```

### VoidExpression

- **Node interface:** `ts.VoidExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** evaluate … and yield undefined
- **Template:** evaluate {expression} and yield undefined
- **Children:** expression
- **Evaluation order:** operand only
- **Semantic info required:** none

Example:

```ts
void promise;
```

```text
evaluate `promise` and yield undefined
```

### DeleteExpression

- **Node interface:** `ts.DeleteExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** delete
- **Template:** delete {expression}
- **Children:** expression
- **Evaluation order:** operand only
- **Semantic info required:** none

Example:

```ts
delete cache.entry;
```

```text
delete property `entry` of `cache`
```

### SpreadElement

- **Node interface:** `ts.SpreadElement`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** spread of
- **Template:** spread of {expression}
- **Children:** expression
- **Evaluation order:** operand only
- **Semantic info required:** none

Example:

```ts
const all = [...head, tail];
```

```text
declare constant `all`
and initialize it to:
    an array literal of:
        spread of `head`
        `tail`
```

### TemplateExpression

- **Node interface:** `ts.TemplateExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** template string joining
- **Template:** template string joining: text …, value of …, …
- **Children:** head, templateSpans
- **Evaluation order:** chunks in source order
- **Semantic info required:** none

Example:

```ts
const message = `Hello ${name}!`;
```

```text
declare constant `message`
and initialize it to:
    template string joining:
        text "Hello "
        value of `name`
        text "!"
```

### TaggedTemplateExpression

- **Node interface:** `ts.TaggedTemplateExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** call tag … with template …
- **Template:** call tag {tag} with template {template}
- **Children:** tag, template
- **Evaluation order:** tag, then the template parts
- **Semantic info required:** none

Example:

```ts
const query = sql`SELECT 1`;
```

```text
declare constant `query`
and initialize it to:
    call tag `sql` using template string "SELECT 1"
```

### ObjectLiteralExpression

- **Node interface:** `ts.ObjectLiteralExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** an object literal with
- **Template:** an empty object literal | an object literal with: {properties}
- **Children:** properties
- **Evaluation order:** properties in source order
- **Semantic info required:** none
- **Notes:** Shorthand `{ y }` reads "shorthand property", distinct from `{ y: y }`.

Example:

```ts
const point = { x: 1, y };
```

```text
declare constant `point`
and initialize it to:
    an object literal with:
        property `x` set to number 1
        shorthand property `y`
```

### ArrayLiteralExpression

- **Node interface:** `ts.ArrayLiteralExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** an array literal of
- **Template:** an empty array literal | an array literal of: {elements}
- **Children:** elements
- **Evaluation order:** elements in source order
- **Semantic info required:** none

Example:

```ts
const list = [1, 2, 3];
```

```text
declare constant `list` and initialize it to an array literal of number 1, number 2 and number 3
```

### OmittedExpression

- **Node interface:** `ts.OmittedExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** a hole
- **Template:** a hole
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const sparse = [1, , 3];
```

```text
declare constant `sparse` and initialize it to an array literal of number 1, a hole and number 3
```

### ArrowFunction

- **Node interface:** `ts.ArrowFunction`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** arrow function
- **Template:** arrow function / {parameters} / (returning {expression} | body: {statements})
- **Children:** typeParameters, parameters, type, body
- **Evaluation order:** parameters bind when called; the body runs per call
- **Semantic info required:** none
- **Notes:** A concise body reads "returning"; a block body reads "body:" — the two source forms stay distinct.

Example:

```ts
const ids = items.map(item => item.id);
```

```text
declare constant `ids`
and initialize it to:
    call property `map` of `items`
    with argument:
        arrow function
        parameter `item`
        returning property `id` of `item`
```

### FunctionExpression

- **Node interface:** `ts.FunctionExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** function expression
- **Template:** [asynchronous] [generator] function expression [`{name}`] / {parameters} / body: {statements}
- **Children:** name, typeParameters, parameters, type, body
- **Evaluation order:** parameters bind when called; the body runs per call
- **Semantic info required:** none

Example:

```ts
const run = function runner() { return 1; };
```

```text
declare constant `run`
and initialize it to:
    function expression `runner`
    with no parameters
    body:
        return number 1
```

### ClassExpression

- **Node interface:** `ts.ClassExpression`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** class expression
- **Template:** class expression [`{name}`] / … class body …
- **Children:** name, typeParameters, heritageClauses, members
- **Evaluation order:** heritage evaluates first, then members in source order
- **Semantic info required:** none

Example:

```ts
const Base = class Named {};
```

```text
declare constant `Base`
and initialize it to:
    class expression `Named`
    with no members
```

### AsExpression

- **Node interface:** `ts.AsExpression`
- **Category:** expression
- **TypeScript-only:** yes
- **Canonical English:** treated as type
- **Template:** {expression} treated as type {type}
- **Children:** expression, type
- **Evaluation order:** expression only; the assertion is compile-time
- **Semantic info required:** none

Example:

```ts
const id = value as string;
```

```text
declare constant `id` and initialize it to `value` treated as type string
```

### SatisfiesExpression

- **Node interface:** `ts.SatisfiesExpression`
- **Category:** expression
- **TypeScript-only:** yes
- **Canonical English:** checked to satisfy type
- **Template:** {expression} checked to satisfy type {type}
- **Children:** expression, type
- **Evaluation order:** expression only; the check is compile-time
- **Semantic info required:** none

Example:

```ts
const config = { port: 1 } satisfies Config;
```

```text
declare constant `config`
and initialize it to:
    an object literal with:
        property `port` set to number 1
    checked to satisfy type `Config`
```

### NonNullExpression

- **Node interface:** `ts.NonNullExpression`
- **Category:** expression
- **TypeScript-only:** yes
- **Canonical English:** asserted non-null
- **Template:** {expression} asserted non-null
- **Children:** expression
- **Evaluation order:** expression only; the assertion is compile-time
- **Semantic info required:** none

Example:

```ts
const name = account!.name;
```

```text
declare constant `name` and initialize it to property `name` of `account` asserted non-null
```

### TypeAssertionExpression

- **Node interface:** `ts.TypeAssertion`
- **Category:** expression
- **TypeScript-only:** yes
- **Canonical English:** cast to type … the value …
- **Template:** cast to type {type} the value {expression}
- **Children:** type, expression
- **Evaluation order:** expression only; the assertion is compile-time
- **Semantic info required:** none
- **Notes:** Angle-bracket assertions keep their own wording, distinct from `as`.

Example:

```ts
const port = <number>raw;
```

```text
declare constant `port` and initialize it to cast to type number the value `raw`
```

### ExpressionWithTypeArguments

- **Node interface:** `ts.ExpressionWithTypeArguments`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** with type argument(s)
- **Template:** {expression} with type argument(s) {typeArguments}
- **Children:** expression, typeArguments
- **Evaluation order:** expression only
- **Semantic info required:** none

Example:

```ts
class List extends Collection<string> {}
```

```text
declare class `List`
extending `Collection` with type argument string
with no members
```

### MetaProperty

- **Node interface:** `ts.MetaProperty`
- **Category:** expression
- **TypeScript-only:** no
- **Canonical English:** meta-property name
- **Template:** `new.target` | `import.meta`
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
const here = import.meta;
```

```text
declare constant `here` and initialize it to `import.meta`
```

### ObjectBindingPattern

- **Node interface:** `ts.ObjectBindingPattern`
- **Category:** binding
- **TypeScript-only:** no
- **Canonical English:** an object pattern binding
- **Template:** an object pattern binding: bind property …[ to …][ with default …] / bind the remaining properties to …
- **Children:** elements
- **Evaluation order:** properties read left to right
- **Semantic info required:** none
- **Notes:** Shorthand `{ name }` has no "to" clause; `{ age: years }` binds property `age` to `years`.

Example:

```ts
const { name, age: years } = user;
```

```text
declare constant:
    an object pattern binding:
        bind property `name`
        bind property `age` to `years`
and initialize it to `user`
```

### ArrayBindingPattern

- **Node interface:** `ts.ArrayBindingPattern`
- **Category:** binding
- **TypeScript-only:** no
- **Canonical English:** an array pattern binding
- **Template:** an array pattern binding: bind element {i} to … / skip element {i} / bind the remaining elements to …
- **Children:** elements
- **Evaluation order:** elements read left to right by position
- **Semantic info required:** none

Example:

```ts
const [first, , ...rest] = items;
```

```text
declare constant:
    an array pattern binding:
        bind element 0 to `first`
        skip element 1
        bind the remaining elements to `rest`
and initialize it to `items`
```

### VariableStatement

- **Node interface:** `ts.VariableStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** declare …
- **Template:** declare (constant | variable | function-scoped variable | disposable constant | asynchronously disposable constant) …; several declarators wrap in "in one declaration statement:"
- **Children:** declarationList
- **Evaluation order:** declarators left to right
- **Semantic info required:** none
- **Notes:** The multi-declarator wrapper keeps `let a, b` distinct from two statements.

Example:

```ts
let count = 0, step = 1;
```

```text
in one declaration statement:
    declare variable `count` and initialize it to number 0
    declare variable `step` and initialize it to number 1
```

### Parameter

- **Node interface:** `ts.ParameterDeclaration`
- **Category:** declaration
- **TypeScript-only:** no
- **Canonical English:** parameter
- **Template:** [modifier words] (parameter | optional parameter | rest parameter) {name} [with type {type}] [with default {initializer}]
- **Children:** modifiers, name, type, initializer
- **Evaluation order:** defaults evaluate at call time, left to right
- **Semantic info required:** none

Example:

```ts
function greet(name: string) {}
```

```text
declare function `greet`
parameters:
    parameter `name` with type string
body:
    no statements
```

### Decorator

- **Node interface:** `ts.Decorator`
- **Category:** declaration
- **TypeScript-only:** no
- **Canonical English:** decorator
- **Template:** decorated with: decorator {expression}
- **Children:** expression
- **Evaluation order:** decorator expressions evaluate before the decorated declaration is finalized
- **Semantic info required:** none

Example:

```ts
@sealed class Config {}
```

```text
decorated with:
    decorator `sealed`
declare class `Config`
with no members
```

### FunctionDeclaration

- **Node interface:** `ts.FunctionDeclaration`
- **Category:** declaration
- **TypeScript-only:** no
- **Canonical English:** declare function
- **Template:** declare [modifier words] [generator] function `{name}` / [with type parameters:] / (parameters: | with no parameters) / [return type:] / (body: | with no body)
- **Children:** modifiers, name, typeParameters, parameters, type, body
- **Evaluation order:** parameters bind when called; the body runs per call
- **Semantic info required:** none

Example:

```ts
async function getUser(id: string): Promise<User> {
  return repository.find(id);
}
```

```text
declare asynchronous function `getUser`
parameters:
    parameter `id` with type string
return type:
    type `Promise` with type argument `User`
body:
    return:
        call property `find` of `repository`
        with argument `id`
```

### ClassDeclaration

- **Node interface:** `ts.ClassDeclaration`
- **Category:** declaration
- **TypeScript-only:** no
- **Canonical English:** declare class
- **Template:** declare [modifier words] class [`{name}`] / [decorated with:] / [extending …] / [implementing:] / (members: | with no members)
- **Children:** decorators, modifiers, name, typeParameters, heritageClauses, members
- **Evaluation order:** heritage evaluates first, then member initializers in source order
- **Semantic info required:** none

Example:

```ts
export class User extends Base implements Named {}
```

```text
declare exported class `User`
extending `Base`
implementing:
    `Named`
with no members
```

### PropertyDeclaration

- **Node interface:** `ts.PropertyDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** field
- **Template:** [modifier words] (field | optional field) {name} [asserted as definitely assigned] [with type {type}] [and initialize it to {initializer}]
- **Children:** decorators, modifiers, name, type, initializer
- **Evaluation order:** initializers run per construction, in member order
- **Semantic info required:** none

Example:

```ts
class User { readonly name = "anon"; }
```

```text
declare class `User`
members:
    readonly field `name` and initialize it to string "anon"
```

### MethodDeclaration

- **Node interface:** `ts.MethodDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** method
- **Template:** [modifier words] [generator] (method | optional method) {name} / … signature and body …
- **Children:** decorators, modifiers, name, typeParameters, parameters, type, body
- **Evaluation order:** parameters bind when called; the body runs per call
- **Semantic info required:** none

Example:

```ts
class Repo { find(id: string) { return id; } }
```

```text
declare class `Repo`
members:
    method `find`
    parameters:
        parameter `id` with type string
    body:
        return `id`
```

### Constructor

- **Node interface:** `ts.ConstructorDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** constructor
- **Template:** constructor / (parameters: | with no parameters) / (body: | with no body)
- **Children:** parameters, body
- **Evaluation order:** runs once per construction
- **Semantic info required:** none
- **Notes:** Parameter-property modifiers (private name: …) render as modifier words on the parameter.

Example:

```ts
class User { constructor(name: string) {} }
```

```text
declare class `User`
members:
    constructor
    parameters:
        parameter `name` with type string
    body:
        no statements
```

### GetAccessor

- **Node interface:** `ts.GetAccessorDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** getter
- **Template:** [modifier words] getter {name} / [return type:] / (body: | with no body)
- **Children:** modifiers, name, type, body
- **Evaluation order:** runs on property read
- **Semantic info required:** none

Example:

```ts
class User { get name() { return "anon"; } }
```

```text
declare class `User`
members:
    getter `name`
    body:
        return string "anon"
```

### SetAccessor

- **Node interface:** `ts.SetAccessorDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** setter
- **Template:** [modifier words] setter {name} / parameters: / (body: | with no body)
- **Children:** modifiers, name, parameters, body
- **Evaluation order:** runs on property write
- **Semantic info required:** none

Example:

```ts
class User { set name(value: string) {} }
```

```text
declare class `User`
members:
    setter `name`
    parameters:
        parameter `value` with type string
    body:
        no statements
```

### ClassStaticBlockDeclaration

- **Node interface:** `ts.ClassStaticBlockDeclaration`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** static initialization block
- **Template:** static initialization block / body: {statements}
- **Children:** body
- **Evaluation order:** runs once when the class is evaluated
- **Semantic info required:** none

Example:

```ts
class Config { static { setup(); } }
```

```text
declare class `Config`
members:
    static initialization block
    body:
        call `setup` with no arguments
```

### SemicolonClassElement

- **Node interface:** `ts.SemicolonClassElement`
- **Category:** class-member
- **TypeScript-only:** no
- **Canonical English:** an empty class member
- **Template:** an empty class member
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
class Empty { ; }
```

```text
declare class `Empty`
members:
    an empty class member
```

### InterfaceDeclaration

- **Node interface:** `ts.InterfaceDeclaration`
- **Category:** declaration
- **TypeScript-only:** yes
- **Canonical English:** declare interface
- **Template:** declare [modifier words] interface `{name}` / [with type parameters:] / [extending:] / (members: | with no members)
- **Children:** modifiers, name, typeParameters, heritageClauses, members
- **Evaluation order:** declaration only; nothing evaluates
- **Semantic info required:** none

Example:

```ts
interface User extends Named { age: number; }
```

```text
declare interface `User`
extending:
    `Named`
members:
    property `age` with type number
```

### PropertySignature

- **Node interface:** `ts.PropertySignature`
- **Category:** class-member
- **TypeScript-only:** yes
- **Canonical English:** property (member)
- **Template:** [readonly] (property | optional property) {name} [with type {type}]
- **Children:** modifiers, name, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
interface User { name: string; }
```

```text
declare interface `User`
members:
    property `name` with type string
```

### MethodSignature

- **Node interface:** `ts.MethodSignature`
- **Category:** class-member
- **TypeScript-only:** yes
- **Canonical English:** method (member)
- **Template:** (method | optional method) {name} / … signature …
- **Children:** name, typeParameters, parameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
interface Repo { find(id: string): void; }
```

```text
declare interface `Repo`
members:
    method `find`
    parameters:
        parameter `id` with type string
    return type:
        void
```

### CallSignature

- **Node interface:** `ts.CallSignatureDeclaration`
- **Category:** class-member
- **TypeScript-only:** yes
- **Canonical English:** call signature
- **Template:** call signature / … signature …
- **Children:** typeParameters, parameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
interface Callable { (input: string): void; }
```

```text
declare interface `Callable`
members:
    call signature
    parameters:
        parameter `input` with type string
    return type:
        void
```

### ConstructSignature

- **Node interface:** `ts.ConstructSignatureDeclaration`
- **Category:** class-member
- **TypeScript-only:** yes
- **Canonical English:** construct signature
- **Template:** construct signature / … signature …
- **Children:** typeParameters, parameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
interface Factory { new (input: string): Widget; }
```

```text
declare interface `Factory`
members:
    construct signature
    parameters:
        parameter `input` with type string
    return type:
        `Widget`
```

### IndexSignature

- **Node interface:** `ts.IndexSignatureDeclaration`
- **Category:** class-member
- **TypeScript-only:** yes
- **Canonical English:** index signature
- **Template:** [modifier words] index signature key {name} of key type {keyType} with value type {type}
- **Children:** modifiers, parameter, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
interface Bag { [key: string]: number; }
```

```text
declare interface `Bag`
members:
    index signature key `key` of key type string with value type number
```

### TypeAliasDeclaration

- **Node interface:** `ts.TypeAliasDeclaration`
- **Category:** declaration
- **TypeScript-only:** yes
- **Canonical English:** declare type alias
- **Template:** declare [modifier words] type alias `{name}` [with type parameters:] as {type}
- **Children:** modifiers, name, typeParameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Result<T> = T | Error;
```

```text
declare type alias `Result`
with type parameters:
    type parameter `T`
as union type of `T` and `Error`
```

### EnumDeclaration

- **Node interface:** `ts.EnumDeclaration`
- **Category:** declaration
- **TypeScript-only:** yes
- **Canonical English:** declare enum
- **Template:** declare [modifier words] enum `{name}` / (members: | with no members) — member `{name}` [with value {initializer}]
- **Children:** modifiers, name, members
- **Evaluation order:** member initializers evaluate top to bottom
- **Semantic info required:** none

Example:

```ts
const enum Direction { Up, Down = 2 }
```

```text
declare const enum `Direction`
members:
    member `Up`
    member `Down` with value number 2
```

### ModuleDeclaration

- **Node interface:** `ts.ModuleDeclaration`
- **Category:** declaration
- **TypeScript-only:** yes
- **Canonical English:** declare namespace / module / global augmentation
- **Template:** declare [modifier words] (namespace `{name}` | module {string} | global augmentation) / (body: | with no body)
- **Children:** modifiers, name, body
- **Evaluation order:** body statements run top to bottom when the module evaluates
- **Semantic info required:** none

Example:

```ts
namespace app { export const port = 1; }
```

```text
declare namespace `app`
body:
    declare exported constant `port` and initialize it to number 1
```

### SourceFile

- **Node interface:** `ts.SourceFile`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** whole file
- **Template:** statements top to bottom; each leading comment renders as its own "comment:" line
- **Children:** statements
- **Evaluation order:** top to bottom
- **Semantic info required:** none
- **Notes:** Comments are reproduced as explicit comment lines, never converted into program facts.

Example:

```ts
// entry point
run();
```

```text
comment: // entry point
call `run` with no arguments
```

### ExpressionStatement

- **Node interface:** `ts.ExpressionStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** the expression itself
- **Template:** {expression}
- **Children:** expression
- **Evaluation order:** expression evaluates for its effects
- **Semantic info required:** none

Example:

```ts
notify();
```

```text
call `notify` with no arguments
```

### Block

- **Node interface:** `ts.Block`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** block
- **Template:** block: / {statements}
- **Children:** statements
- **Evaluation order:** top to bottom
- **Semantic info required:** none
- **Notes:** A standalone block statement; function bodies render under "body:" instead.

Example:

```ts
{ setup(); }
```

```text
block:
    call `setup` with no arguments
```

### EmptyStatement

- **Node interface:** `ts.EmptyStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** an empty statement
- **Template:** an empty statement
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
;
```

```text
an empty statement
```

### IfStatement

- **Node interface:** `ts.IfStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** if / then / otherwise
- **Template:** if {condition} / then: {statements} [/ otherwise: {statements}]
- **Children:** expression, thenStatement, elseStatement
- **Evaluation order:** condition, then exactly one branch
- **Semantic info required:** none
- **Notes:** A non-predicate condition is spelled "… is truthy".

Example:

```ts
if (ready) {
  start();
} else {
  waitMore();
}
```

```text
if `ready` is truthy
then:
    call `start` with no arguments
otherwise:
    call `waitMore` with no arguments
```

### WhileStatement

- **Node interface:** `ts.WhileStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** while
- **Template:** while {condition} / body: {statements}
- **Children:** expression, statement
- **Evaluation order:** condition before every pass
- **Semantic info required:** none

Example:

```ts
while (queue.length > 0) {
  drain();
}
```

```text
while property `length` of `queue` is greater than number 0
body:
    call `drain` with no arguments
```

### DoStatement

- **Node interface:** `ts.DoStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** do / then repeat while
- **Template:** do: {statements} / then repeat while {condition}
- **Children:** statement, expression
- **Evaluation order:** body first, condition after every pass
- **Semantic info required:** none

Example:

```ts
do {
  poll();
} while (pending);
```

```text
do:
    call `poll` with no arguments
then repeat while `pending` is truthy
```

### ForStatement

- **Node interface:** `ts.ForStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** for loop
- **Template:** for loop / [setup: …] / [continue while …] / [after each pass: …] / body: {statements}
- **Children:** initializer, condition, incrementor, statement
- **Evaluation order:** setup once; then condition, body, incrementor per pass
- **Semantic info required:** none

Example:

```ts
for (let i = 0; i < 3; i++) {
  step(i);
}
```

```text
for loop
setup:
    declare variable `i` and initialize it to number 0
continue while `i` is less than number 3
after each pass:
    increment `i` and yield the previous value
body:
    call `step`
    with argument `i`
```

### ForOfStatement

- **Node interface:** `ts.ForOfStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** for each … from iterable
- **Template:** (for each | for await each) {binding} from iterable {expression} / body: {statements}
- **Children:** awaitModifier, initializer, expression, statement
- **Evaluation order:** iterable evaluates once; the binding re-binds per pass
- **Semantic info required:** none

Example:

```ts
for await (const chunk of stream) {
  write(chunk);
}
```

```text
for await each constant `chunk`
from iterable `stream`
body:
    call `write`
    with argument `chunk`
```

### ForInStatement

- **Node interface:** `ts.ForInStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** for each … from the enumerable keys of
- **Template:** for each {binding} from the enumerable keys of {expression} / body: {statements}
- **Children:** initializer, expression, statement
- **Evaluation order:** object evaluates once; keys enumerate per pass
- **Semantic info required:** none

Example:

```ts
for (const key in config) {
  print(key);
}
```

```text
for each constant `key`
from the enumerable keys of `config`
body:
    call `print`
    with argument `key`
```

### ContinueStatement

- **Node interface:** `ts.ContinueStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** continue
- **Template:** continue [to label `{label}`]
- **Children:** label
- **Evaluation order:** transfers control immediately
- **Semantic info required:** none

Example:

```ts
while (busy) {
  continue;
}
```

```text
while `busy` is truthy
body:
    continue
```

### BreakStatement

- **Node interface:** `ts.BreakStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** break
- **Template:** break [to label `{label}`]
- **Children:** label
- **Evaluation order:** transfers control immediately
- **Semantic info required:** none

Example:

```ts
while (busy) {
  break;
}
```

```text
while `busy` is truthy
body:
    break
```

### ReturnStatement

- **Node interface:** `ts.ReturnStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** return
- **Template:** return [{expression}]
- **Children:** expression
- **Evaluation order:** operand evaluates, then the function returns
- **Semantic info required:** none

Example:

```ts
function stop() {
  return;
}
```

```text
declare function `stop`
with no parameters
body:
    return
```

### WithStatement

- **Node interface:** `ts.WithStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** with scope from
- **Template:** with scope from {expression} / body: {statements}
- **Children:** expression, statement
- **Evaluation order:** scope object evaluates once
- **Semantic info required:** none

Example:

```ts
with (Math) {
  round(1);
}
```

```text
with scope from `Math`
body:
    call `round`
    with argument number 1
```

### SwitchStatement

- **Node interface:** `ts.SwitchStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** switch on
- **Template:** switch on {expression} / when case matches … [/ body: …] / the default case [/ body: …]
- **Children:** expression, caseBlock
- **Evaluation order:** discriminant once, then case tests top to bottom
- **Semantic info required:** none
- **Notes:** A case with no body has no body line — fall-through stays visible.

Example:

```ts
switch (status) {
  case "open":
    handle();
    break;
  default:
    ignore();
}
```

```text
switch on `status`
when case matches string "open"
body:
    call `handle` with no arguments
    break
the default case
body:
    call `ignore` with no arguments
```

### LabeledStatement

- **Node interface:** `ts.LabeledStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** labeled
- **Template:** labeled `{label}` / {statement}
- **Children:** label, statement
- **Evaluation order:** the labeled statement runs normally
- **Semantic info required:** none

Example:

```ts
outer: for (const row of rows) {
  break outer;
}
```

```text
labeled `outer`
for each constant `row`
from iterable `rows`
body:
    break to label `outer`
```

### ThrowStatement

- **Node interface:** `ts.ThrowStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** throw
- **Template:** throw {expression}
- **Children:** expression
- **Evaluation order:** operand evaluates, then control unwinds
- **Semantic info required:** none

Example:

```ts
throw new Error("boom");
```

```text
throw:
    construct a new `Error`
    with argument string "boom"
```

### TryStatement

- **Node interface:** `ts.TryStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** try / on error caught as / catch / finally
- **Template:** try: {statements} [/ on error caught as {binding} / catch: {statements}] [/ finally: {statements}]
- **Children:** tryBlock, catchClause, finallyBlock
- **Evaluation order:** try first; catch only on a throw; finally always
- **Semantic info required:** none

Example:

```ts
try {
  risky();
} catch (failure) {
  report(failure);
} finally {
  cleanup();
}
```

```text
try:
    call `risky` with no arguments
on error caught as `failure`
catch:
    call `report`
    with argument `failure`
finally:
    call `cleanup` with no arguments
```

### DebuggerStatement

- **Node interface:** `ts.DebuggerStatement`
- **Category:** statement
- **TypeScript-only:** no
- **Canonical English:** trigger the debugger
- **Template:** trigger the debugger
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
debugger;
```

```text
trigger the debugger
```

### ImportDeclaration

- **Node interface:** `ts.ImportDeclaration`
- **Category:** module
- **TypeScript-only:** no
- **Canonical English:** import
- **Template:** (import | import type) / [the default binding as …] / [the namespace as …] / [named bindings: …] / from {module} [/ with attributes: …] — or "import for side effects from …"
- **Children:** importClause, moduleSpecifier, attributes
- **Evaluation order:** declaration only; the module loads before the file body runs
- **Semantic info required:** none

Example:

```ts
import { readFile as read } from "fs";
```

```text
import
named bindings:
    `readFile` as `read`
from string "fs"
```

### ImportEqualsDeclaration

- **Node interface:** `ts.ImportEqualsDeclaration`
- **Category:** module
- **TypeScript-only:** yes
- **Canonical English:** import … as an alias for
- **Template:** (import | import type) `{name}` as an alias for ({entity name} | require of {module})
- **Children:** name, moduleReference
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
import fs = require("fs");
```

```text
import `fs` as an alias for require of string "fs"
```

### ExportDeclaration

- **Node interface:** `ts.ExportDeclaration`
- **Category:** module
- **TypeScript-only:** no
- **Canonical English:** export
- **Template:** (export | export type) [everything] [the namespace as …] [named bindings: …] [from {module}] [with attributes: …]
- **Children:** exportClause, moduleSpecifier, attributes
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
export { helper } from "./util";
```

```text
export
named bindings:
    `helper`
from string "./util"
```

### ExportAssignment

- **Node interface:** `ts.ExportAssignment`
- **Category:** module
- **TypeScript-only:** no
- **Canonical English:** export as default / export equals
- **Template:** (export as default | export equals) {expression}
- **Children:** expression
- **Evaluation order:** expression evaluates when the module evaluates
- **Semantic info required:** none
- **Notes:** `export =` reads "export equals", distinct from a default export.

Example:

```ts
export default config;
```

```text
export as default `config`
```

### NamespaceExportDeclaration

- **Node interface:** `ts.NamespaceExportDeclaration`
- **Category:** module
- **TypeScript-only:** yes
- **Canonical English:** export as the global namespace
- **Template:** export as the global namespace `{name}`
- **Children:** name
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
export as namespace MyLib;
```

```text
export as the global namespace `MyLib`
```

### TypeParameter

- **Node interface:** `ts.TypeParameterDeclaration`
- **Category:** declaration
- **TypeScript-only:** yes
- **Canonical English:** type parameter
- **Template:** [modifier words] type parameter `{name}` [constrained to {constraint}] [with default {default}]
- **Children:** modifiers, name, constraint, default
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
function identity<T>(value: T): T {
  return value;
}
```

```text
declare function `identity`
with type parameters:
    type parameter `T`
parameters:
    parameter `value` with type `T`
return type:
    `T`
body:
    return `value`
```

### TypeReference

- **Node interface:** `ts.TypeReferenceNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** type … with type argument(s)
- **Template:** `{typeName}` alone, or type `{typeName}` with type argument(s) {typeArguments}
- **Children:** typeName, typeArguments
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let pending: Promise<User>;
```

```text
declare variable `pending` with type type `Promise` with type argument `User`
```

### TypePredicate

- **Node interface:** `ts.TypePredicateNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** type predicate … is …
- **Template:** type predicate {parameterName} is {type} | asserts {parameterName} | asserts that {parameterName} is {type}
- **Children:** assertsModifier, parameterName, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
function isUser(value: unknown): value is User {
  return true;
}
```

```text
declare function `isUser`
parameters:
    parameter `value` with type unknown
return type:
    type predicate `value` is `User`
body:
    return true
```

### FunctionType

- **Node interface:** `ts.FunctionTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** function type
- **Template:** function type / (parameters: | with no parameters) / returning {type}
- **Children:** typeParameters, parameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let handler: (event: string) => void;
```

```text
declare variable `handler`
with type:
    function type
    parameters:
        parameter `event` with type string
    returning void
```

### ConstructorType

- **Node interface:** `ts.ConstructorTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** constructor type
- **Template:** [abstract] constructor type / (parameters: | with no parameters) / returning {type}
- **Children:** modifiers, typeParameters, parameters, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let factory: new () => User;
```

```text
declare variable `factory` with type constructor type with no parameters returning `User`
```

### TypeQuery

- **Node interface:** `ts.TypeQueryNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** the type of
- **Template:** the type of `{exprName}`
- **Children:** exprName, typeArguments
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let sibling: typeof origin;
```

```text
declare variable `sibling` with type the type of `origin`
```

### TypeLiteral

- **Node interface:** `ts.TypeLiteralNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** an object type with
- **Template:** an empty object type | an object type with: {members}
- **Children:** members
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let point: { x: number; y: number };
```

```text
declare variable `point`
with type:
    an object type with:
        property `x` with type number
        property `y` with type number
```

### ArrayType

- **Node interface:** `ts.ArrayTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** array type of
- **Template:** array type of {elementType}
- **Children:** elementType
- **Evaluation order:** declaration only
- **Semantic info required:** none
- **Notes:** Distinct from a `type \`Array\` with type argument …` reference, mirroring the two source spellings.

Example:

```ts
let names: string[];
```

```text
declare variable `names` with type array type of string
```

### TupleType

- **Node interface:** `ts.TupleTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** tuple type of
- **Template:** an empty tuple type | tuple type of: {elements}
- **Children:** elements
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let pair: [string, number];
```

```text
declare variable `pair` with type tuple type of string and number
```

### NamedTupleMember

- **Node interface:** `ts.NamedTupleMember`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** member … with type …
- **Template:** (member | optional member | rest member) `{name}` with type {type}
- **Children:** name, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let pair: [name: string, age: number];
```

```text
declare variable `pair`
with type:
    tuple type of:
        member `name` with type string
        member `age` with type number
```

### OptionalType

- **Node interface:** `ts.OptionalTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** optional
- **Template:** optional {type}
- **Children:** type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let pair: [string, number?];
```

```text
declare variable `pair`
with type:
    tuple type of:
        string
        optional number
```

### RestType

- **Node interface:** `ts.RestTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** rest of
- **Template:** rest of {type}
- **Children:** type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let row: [string, ...number[]];
```

```text
declare variable `row`
with type:
    tuple type of:
        string
        rest of array type of number
```

### UnionType

- **Node interface:** `ts.UnionTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** union type of
- **Template:** union type of: {types}
- **Children:** types
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let id: string | null;
```

```text
declare variable `id` with type union type of string and null
```

### IntersectionType

- **Node interface:** `ts.IntersectionTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** intersection type of
- **Template:** intersection type of: {types}
- **Children:** types
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let both: Named & Aged;
```

```text
declare variable `both` with type intersection type of `Named` and `Aged`
```

### ConditionalType

- **Node interface:** `ts.ConditionalTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** conditional type: if … extends … then … otherwise …
- **Template:** conditional type: if {checkType} extends {extendsType} then: {trueType} otherwise: {falseType}
- **Children:** checkType, extendsType, trueType, falseType
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type IsString<T> = T extends string ? true : false;
```

```text
declare type alias `IsString`
with type parameters:
    type parameter `T`
as:
    conditional type: if `T`
    extends string
    then:
        true
    otherwise:
        false
```

### InferType

- **Node interface:** `ts.InferTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** infer type parameter
- **Template:** infer type parameter `{name}` [constrained to …]
- **Children:** typeParameter
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Unwrap<T> = T extends Promise<infer U> ? U : T;
```

```text
declare type alias `Unwrap`
with type parameters:
    type parameter `T`
as:
    conditional type: if `T`
    extends:
        type `Promise`
        with type argument:
            infer type parameter `U`
    then:
        `U`
    otherwise:
        `T`
```

### ParenthesizedType

- **Node interface:** `ts.ParenthesizedTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** explicit grouping
- **Template:** ({type}) inline, or "group of:" as a block
- **Children:** type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let handlers: (() => void)[];
```

```text
declare variable `handlers` with type array type of (function type with no parameters returning void)
```

### ThisType

- **Node interface:** `ts.ThisTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** the `this` type
- **Template:** the `this` type
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none

Example:

```ts
class Builder { self(): this { return this; } }
```

```text
declare class `Builder`
members:
    method `self`
    with no parameters
    return type:
        the `this` type
    body:
        return `this`
```

### TypeOperator

- **Node interface:** `ts.TypeOperatorNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** the keys of / unique / readonly
- **Template:** (the keys of | unique | readonly) {type}
- **Children:** type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Keys = keyof User;
```

```text
declare type alias `Keys` as the keys of `User`
```

### IndexedAccessType

- **Node interface:** `ts.IndexedAccessTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** indexed access of … at …
- **Template:** indexed access of {objectType} at {indexType}
- **Children:** objectType, indexType
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Name = User["name"];
```

```text
declare type alias `Name` as indexed access of `User` at string "name"
```

### MappedType

- **Node interface:** `ts.MappedTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** mapped type with key
- **Template:** mapped type with key `{name}` / in {constraint} [/ renamed as {nameType}] [/ adding|removing|marked readonly] [/ adding|removing|marked optional] / with value type {type}
- **Children:** typeParameter, nameType, readonlyToken, questionToken, type
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Clone<T> = { [K in keyof T]: T[K] };
```

```text
declare type alias `Clone`
with type parameters:
    type parameter `T`
as:
    mapped type with key `K`
    in the keys of `T`
    with value type indexed access of `T` at `K`
```

### LiteralType

- **Node interface:** `ts.LiteralTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** the literal itself
- **Template:** {literal}
- **Children:** literal
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let mode: "dark";
```

```text
declare variable `mode` with type string "dark"
```

### TemplateLiteralType

- **Node interface:** `ts.TemplateLiteralTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** template string type joining
- **Template:** template string type joining: text …, value of type …, …
- **Children:** head, templateSpans
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
type Route = `/api/${string}`;
```

```text
declare type alias `Route`
as:
    template string type joining:
        text "/api/"
        value of type string
```

### ImportType

- **Node interface:** `ts.ImportTypeNode`
- **Category:** type
- **TypeScript-only:** yes
- **Canonical English:** type imported from
- **Template:** [the type of] type imported from {module} [member `{qualifier}`] [with type argument(s) …]
- **Children:** argument, qualifier, typeArguments
- **Evaluation order:** declaration only
- **Semantic info required:** none

Example:

```ts
let logger: import("./log").Logger;
```

```text
declare variable `logger` with type type imported from string "./log" member `Logger`
```

### JsxElement

- **Node interface:** `ts.JsxElement`
- **Category:** jsx
- **TypeScript-only:** no
- **Canonical English:** JSX element
- **Template:** JSX element {tagName} / [with attributes: …] / [children: …]
- **Children:** openingElement, children, closingElement
- **Evaluation order:** attributes left to right, then children in order
- **Semantic info required:** none

Example (`example.tsx`):

```tsx
const el = <section title="intro">Hello {name}</section>;
```

```text
declare constant `el`
and initialize it to:
    JSX element `section`
    with attributes:
        attribute `title` set to string "intro"
    children:
        text "Hello "
        the expression `name`
```

### JsxSelfClosingElement

- **Node interface:** `ts.JsxSelfClosingElement`
- **Category:** jsx
- **TypeScript-only:** no
- **Canonical English:** self-closing JSX element
- **Template:** self-closing JSX element {tagName} / [with attributes: …]
- **Children:** tagName, attributes
- **Evaluation order:** attributes left to right
- **Semantic info required:** none
- **Notes:** A bare attribute (no value) has no "set to" clause.

Example (`example.tsx`):

```tsx
const el = <input disabled />;
```

```text
declare constant `el`
and initialize it to:
    self-closing JSX element `input`
    with attributes:
        attribute `disabled`
```

### JsxFragment

- **Node interface:** `ts.JsxFragment`
- **Category:** jsx
- **TypeScript-only:** no
- **Canonical English:** JSX fragment
- **Template:** JSX fragment / [children: …]
- **Children:** children
- **Evaluation order:** children in order
- **Semantic info required:** none

Example (`example.tsx`):

```tsx
const el = <><Item /></>;
```

```text
declare constant `el`
and initialize it to:
    JSX fragment
    children:
        self-closing JSX element `Item`
```

### JsxExpression

- **Node interface:** `ts.JsxExpression`
- **Category:** jsx
- **TypeScript-only:** no
- **Canonical English:** the expression
- **Template:** the expression {expression} | the spread expression {expression}
- **Children:** expression
- **Evaluation order:** evaluates where it appears
- **Semantic info required:** none

Example (`example.tsx`):

```tsx
const el = <div>{count}</div>;
```

```text
declare constant `el`
and initialize it to:
    JSX element `div`
    children:
        the expression `count`
```

### JsxText

- **Node interface:** `ts.JsxText`
- **Category:** jsx
- **TypeScript-only:** no
- **Canonical English:** text
- **Template:** text {JSON-quoted text}
- **Children:** none
- **Evaluation order:** leaf
- **Semantic info required:** none
- **Notes:** Whitespace-only JSX text between elements is formatting and is omitted.

Example (`example.tsx`):

```tsx
const el = <p>Hello</p>;
```

```text
declare constant `el`
and initialize it to:
    JSX element `p`
    children:
        text "Hello"
```
