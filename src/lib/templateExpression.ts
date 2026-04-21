// Safe expression language for `{{ ... }}` template bodies.
//
// Grammar (recursive descent, precedence low → high):
//   expr        = conditional
//   conditional = logicalOr ("?" expr ":" expr)?
//   logicalOr   = logicalAnd ("||" logicalAnd)*
//   logicalAnd  = equality ("&&" equality)*
//   equality    = comparison (("=="|"!="|"==="|"!==") comparison)*
//   comparison  = additive (("<"|"<="|">"|">=") additive)*
//   additive    = multiplicative (("+"|"-") multiplicative)*
//   multiplicative = unary (("*"|"/"|"%") unary)*
//   unary       = ("!"|"-") unary | postfix
//   postfix     = primary ("." name | "[" expr "]" | "(" args ")")*
//   primary     = number | string | "true"|"false"|"null"
//               | identifier => expr
//               | "(" identifier ")" "=>" expr
//               | identifier
//               | "(" expr ")"
//
// Security:
//   - NO `eval`, NO `new Function`.
//   - Identifier resolution only hits the explicit scope (`vault` + lambda
//     params). Unknown names throw.
//   - Member access rejects `__proto__`, `constructor`, `prototype`.
//   - Call targets must be functions or Collection methods the caller
//     exposed. Plain object members can't be invoked as methods.
//   - Eval has an op counter (MAX_OPS) to bound worst-case cost.

import { Collection, isCollection } from "./queryCollection";

// ---- Tokenizer ----

type TokenKind =
  | "num" | "str" | "ident" | "punct" | "kw" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const KEYWORDS = new Set(["true", "false", "null"]);
const BANNED_PROPS = new Set(["__proto__", "constructor", "prototype"]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Numbers
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i++;
      }
      out.push({ kind: "num", value: src.slice(start, i), pos: start });
      continue;
    }
    // Strings
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let value = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const next = src[i + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (src[i] !== quote) throw new ExprError(`Unterminated string at ${start}`);
      i++;
      out.push({ kind: "str", value, pos: start });
      continue;
    }
    // Identifiers / keywords
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < src.length && isIdentCont(src[i]!)) i++;
      const raw = src.slice(start, i);
      out.push({
        kind: KEYWORDS.has(raw) ? "kw" : "ident",
        value: raw,
        pos: start,
      });
      continue;
    }
    // Punctuation (multi-char first)
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === "===" || three === "!==") {
      out.push({ kind: "punct", value: three, pos: i });
      i += 3;
      continue;
    }
    if (
      two === "==" || two === "!=" || two === "<=" || two === ">=" ||
      two === "&&" || two === "||" || two === "=>"
    ) {
      out.push({ kind: "punct", value: two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*/%<>!.,()[]?:".includes(c)) {
      out.push({ kind: "punct", value: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}' at ${i}`);
  }
  out.push({ kind: "eof", value: "", pos: src.length });
  return out;
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}
function isIdentCont(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

// ---- AST ----

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "ident"; name: string }
  | { t: "member"; obj: Node; prop: string; computed: boolean; key?: Node }
  | { t: "call"; callee: Node; args: Node[] }
  | { t: "arrow"; param: string; body: Node }
  | { t: "unary"; op: "!" | "-"; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "cond"; test: Node; cons: Node; alt: Node };

// ---- Parser ----

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expr();
    if (this.peek().kind !== "eof") {
      throw new ExprError(`Unexpected '${this.peek().value}' at ${this.peek().pos}`);
    }
    return node;
  }

  private expr(): Node { return this.conditional(); }

  private conditional(): Node {
    const test = this.logicalOr();
    if (this.match("punct", "?")) {
      const cons = this.expr();
      this.expect("punct", ":");
      const alt = this.expr();
      return { t: "cond", test, cons, alt };
    }
    return test;
  }

  private logicalOr(): Node {
    let left = this.logicalAnd();
    while (this.match("punct", "||")) {
      const right = this.logicalAnd();
      left = { t: "bin", op: "||", l: left, r: right };
    }
    return left;
  }

  private logicalAnd(): Node {
    let left = this.equality();
    while (this.match("punct", "&&")) {
      const right = this.equality();
      left = { t: "bin", op: "&&", l: left, r: right };
    }
    return left;
  }

  private equality(): Node {
    let left = this.comparison();
    while (this.matchAny("punct", ["==", "!=", "===", "!=="])) {
      const op = this.previous().value;
      const right = this.comparison();
      left = { t: "bin", op, l: left, r: right };
    }
    return left;
  }

  private comparison(): Node {
    let left = this.additive();
    while (this.matchAny("punct", ["<", "<=", ">", ">="])) {
      const op = this.previous().value;
      const right = this.additive();
      left = { t: "bin", op, l: left, r: right };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.matchAny("punct", ["+", "-"])) {
      const op = this.previous().value;
      const right = this.multiplicative();
      left = { t: "bin", op, l: left, r: right };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.unary();
    while (this.matchAny("punct", ["*", "/", "%"])) {
      const op = this.previous().value;
      const right = this.unary();
      left = { t: "bin", op, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    if (this.match("punct", "!")) {
      return { t: "unary", op: "!", arg: this.unary() };
    }
    if (this.match("punct", "-")) {
      return { t: "unary", op: "-", arg: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    while (true) {
      if (this.match("punct", ".")) {
        const tok = this.expect("ident");
        if (BANNED_PROPS.has(tok.value)) {
          throw new ExprError(`Access to '${tok.value}' is not allowed`);
        }
        node = { t: "member", obj: node, prop: tok.value, computed: false };
      } else if (this.match("punct", "[")) {
        const key = this.expr();
        this.expect("punct", "]");
        node = { t: "member", obj: node, prop: "", computed: true, key };
      } else if (this.match("punct", "(")) {
        const args: Node[] = [];
        if (!this.match("punct", ")")) {
          args.push(this.expr());
          while (this.match("punct", ",")) args.push(this.expr());
          this.expect("punct", ")");
        }
        node = { t: "call", callee: node, args };
      } else {
        break;
      }
    }
    return node;
  }

  private primary(): Node {
    const tok = this.peek();
    // number
    if (tok.kind === "num") {
      this.advance();
      return { t: "num", v: Number(tok.value) };
    }
    // string
    if (tok.kind === "str") {
      this.advance();
      return { t: "str", v: tok.value };
    }
    // keywords
    if (tok.kind === "kw") {
      this.advance();
      if (tok.value === "true") return { t: "bool", v: true };
      if (tok.value === "false") return { t: "bool", v: false };
      return { t: "null" };
    }
    // identifier — maybe arrow `x => body`
    if (tok.kind === "ident") {
      // Look ahead: arrow form?
      if (this.tokens[this.pos + 1]?.kind === "punct" && this.tokens[this.pos + 1]?.value === "=>") {
        this.advance(); // param
        this.advance(); // =>
        const body = this.expr();
        return { t: "arrow", param: tok.value, body };
      }
      this.advance();
      return { t: "ident", name: tok.value };
    }
    // parenthesized or single-param arrow `(x) => body`
    if (tok.kind === "punct" && tok.value === "(") {
      const savedPos = this.pos;
      this.advance();
      // Speculative: try `(ident)` followed by `=>`
      const maybeIdent = this.peek();
      if (maybeIdent.kind === "ident") {
        const closer = this.tokens[this.pos + 1];
        const arrow = this.tokens[this.pos + 2];
        if (
          closer?.kind === "punct" && closer.value === ")" &&
          arrow?.kind === "punct" && arrow.value === "=>"
        ) {
          this.advance(); // ident
          this.advance(); // )
          this.advance(); // =>
          const body = this.expr();
          return { t: "arrow", param: maybeIdent.value, body };
        }
      }
      // Otherwise parenthesized expression
      this.pos = savedPos;
      this.advance(); // (
      const inner = this.expr();
      this.expect("punct", ")");
      return inner;
    }
    throw new ExprError(`Unexpected '${tok.value}' at ${tok.pos}`);
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private previous(): Token { return this.tokens[this.pos - 1]!; }
  private advance(): Token { return this.tokens[this.pos++]!; }

  private match(kind: TokenKind, value: string): boolean {
    const t = this.peek();
    if (t.kind === kind && t.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchAny(kind: TokenKind, values: string[]): boolean {
    const t = this.peek();
    if (t.kind === kind && values.includes(t.value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const t = this.peek();
    if (t.kind === kind && (value === undefined || t.value === value)) {
      this.advance();
      return t;
    }
    throw new ExprError(
      `Expected ${kind}${value !== undefined ? ` '${value}'` : ""} at ${t.pos}, got '${t.value}'`
    );
  }
}

// ---- Evaluator ----

export class ExprError extends Error {}

export interface EvalScope {
  [name: string]: unknown;
}

interface EvalCtx {
  scope: EvalScope;
  ops: { n: number };
}

const MAX_OPS = 10_000;

export function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

export function evaluate(src: string, scope: EvalScope): unknown {
  const node = parse(src);
  return evalNode(node, { scope, ops: { n: 0 } });
}

function evalNode(node: Node, ctx: EvalCtx): unknown {
  if (++ctx.ops.n > MAX_OPS) {
    throw new ExprError("Expression exceeded evaluation budget");
  }
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "null": return null;
    case "ident": {
      if (!(node.name in ctx.scope)) {
        throw new ExprError(`Unknown identifier '${node.name}'`);
      }
      return ctx.scope[node.name];
    }
    case "member": return evalMember(node, ctx);
    case "call": return evalCall(node, ctx);
    case "arrow": return makeArrow(node, ctx);
    case "unary": {
      const arg = evalNode(node.arg, ctx);
      if (node.op === "!") return !arg;
      return -(arg as number);
    }
    case "bin": return evalBinaryChain(node, ctx);
    case "cond":
      return evalNode(node.test, ctx)
        ? evalNode(node.cons, ctx)
        : evalNode(node.alt, ctx);
  }
}

function evalMember(
  node: Extract<Node, { t: "member" }>,
  ctx: EvalCtx,
): unknown {
  const obj = evalNode(node.obj, ctx);
  if (obj == null) {
    throw new ExprError(
      `Cannot read property on ${obj === null ? "null" : "undefined"}`,
    );
  }
  let key: string;
  if (node.computed) {
    const raw = evalNode(node.key!, ctx);
    key = typeof raw === "string" ? raw : String(raw);
  } else {
    key = node.prop;
  }
  return readProperty(obj, key);
}

// Whitelisted string methods exposed to expressions. Each entry builds a
// bound function over the receiver so `"abc".contains("b")` parses as a
// normal member-call through `readProperty` + `evalCall`. Argument coercion
// uses `String(...)` to mirror template-land's loose typing.
const STRING_METHODS: Record<string, (s: string) => (...args: unknown[]) => unknown> = {
  contains: (s) => (needle) => s.includes(String(needle)),
  startsWith: (s) => (prefix) => s.startsWith(String(prefix)),
  endsWith: (s) => (suffix) => s.endsWith(String(suffix)),
  toLowerCase: (s) => () => s.toLowerCase(),
  toUpperCase: (s) => () => s.toUpperCase(),
  trim: (s) => () => s.trim(),
};

// Reads a property while preventing prototype-pollution / Object.prototype
// method access. Own properties are always allowed. Prototype properties
// are allowed only when the prototype belongs to one of our own classes
// (i.e. is NOT `Object.prototype`) — this is what lets `Collection#count`
// dispatch while blocking `hasOwnProperty`, `toString`, etc.
//
// Unknown members throw (not silently undefined) — matches the allowlist
// semantics from the identifier path: expression errors must be surfaced
// so the live overlay can skip them and the inline-error renderer can
// point at the real problem.
function readProperty(obj: unknown, key: string): unknown {
  if (BANNED_PROPS.has(key)) {
    throw new ExprError(`Access to '${key}' is not allowed`);
  }
  if (typeof obj === "string") {
    if (key === "length") return obj.length;
    const m = STRING_METHODS[key];
    if (m) return m(obj);
    throw new ExprError(`Unknown member '${key}'`);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new ExprError(`Cannot read '${key}' on ${typeof obj}`);
  }
  // Own prop (includes Proxy.has-backed lookups like note.property.*).
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return (obj as Record<string, unknown>)[key];
  }
  // Prototype methods only when the prototype is not Object.prototype.
  const proto = Object.getPrototypeOf(obj);
  if (proto && proto !== Object.prototype) {
    if (Object.getOwnPropertyDescriptor(proto, key)) {
      return (obj as Record<string, unknown>)[key];
    }
  }
  throw new ExprError(`Unknown member '${key}'`);
}

function evalCall(node: Extract<Node, { t: "call" }>, ctx: EvalCtx): unknown {
  // Method call shape: member expr as callee → bind `this` to the object
  // and route through `readProperty` so the prototype-chain guard applies.
  if (node.callee.t === "member") {
    const obj = evalNode(node.callee.obj, ctx);
    if (obj == null) {
      throw new ExprError(
        `Cannot call on ${obj === null ? "null" : "undefined"}`,
      );
    }
    const key = node.callee.computed
      ? String(evalNode(node.callee.key!, ctx))
      : node.callee.prop;
    const fn = readProperty(obj, key);
    if (typeof fn !== "function") {
      throw new ExprError(`'${key}' is not callable`);
    }
    const args = node.args.map((a) => evalNode(a, ctx));
    return (fn as (...a: unknown[]) => unknown).apply(obj, args);
  }
  const fn = evalNode(node.callee, ctx);
  if (typeof fn !== "function") {
    throw new ExprError("Expression is not callable");
  }
  const args = node.args.map((a) => evalNode(a, ctx));
  return (fn as (...a: unknown[]) => unknown)(...args);
}

function makeArrow(
  node: Extract<Node, { t: "arrow" }>,
  ctx: EvalCtx,
): (arg: unknown) => unknown {
  // Closes over current scope; adds the lambda param on each invocation.
  return (arg: unknown): unknown => {
    return evalNode(node.body, {
      scope: { ...ctx.scope, [node.param]: arg },
      ops: ctx.ops,
    });
  };
}

// Evaluates a binary expression, flattening left-deep same-op chains so the
// JS call stack does not grow with expression length (`1 + 1 + ... + 1`
// parses into an N-deep left-associative tree but evaluates in O(N) frames).
function evalBinaryChain(
  node: Extract<Node, { t: "bin" }>,
  ctx: EvalCtx,
): unknown {
  // Short-circuit operators handle left first, then r only if needed.
  if (node.op === "&&" || node.op === "||") {
    const l = evalNode(node.l, ctx);
    if (node.op === "&&") return l ? evalNode(node.r, ctx) : l;
    return l ? l : evalNode(node.r, ctx);
  }
  const rhss: Node[] = [];
  let leaf: Node = node;
  while (leaf.t === "bin" && leaf.op === node.op && !isShortCircuit(leaf.op)) {
    rhss.push(leaf.r);
    leaf = leaf.l;
  }
  rhss.reverse();
  let acc: unknown = evalNode(leaf, ctx);
  for (const r of rhss) {
    acc = applyBinary(node.op, acc, evalNode(r, ctx));
  }
  return acc;
}

function isShortCircuit(op: string): boolean {
  return op === "&&" || op === "||";
}

function applyBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "+":
      if (typeof l === "string" || typeof r === "string") return String(l) + String(r);
      return (l as number) + (r as number);
    case "-": return (l as number) - (r as number);
    case "*": return (l as number) * (r as number);
    case "/": return (l as number) / (r as number);
    case "%": return (l as number) % (r as number);
    case "==": return l == r;
    case "!=": return l != r;
    case "===": return l === r;
    case "!==": return l !== r;
    case "<": return (l as number | string) < (r as number | string);
    case "<=": return (l as number | string) <= (r as number | string);
    case ">": return (l as number | string) > (r as number | string);
    case ">=": return (l as number | string) >= (r as number | string);
  }
  throw new ExprError(`Unknown operator '${op}'`);
}

// ---- Serialization ----

// Render an evaluated value as text. Primitives use String(). Collections
// render as `Collection<T>[n]` where T is inferred from the first element's
// __typeName if present. Unknown objects fall back to `<TypeName>(id)` style
// if they carry `__typeName` + `__id`, else to their JSON-ish form.
export function renderValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isCollection(v)) {
    const arr = v.toArray();
    const typeName = arr.length > 0 ? typeNameOf(arr[0]) : "?";
    return `Collection<${typeName}>[${arr.length}]`;
  }
  if (Array.isArray(v)) {
    // Plain arrays appear from e.g. `.toArray()` or `.select(...).toArray()`.
    return v.map(renderValue).join(", ");
  }
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const typeName = typeof rec["__typeName"] === "string"
      ? (rec["__typeName"] as string) : "Object";
    const id = rec["__id"];
    if (typeof id === "string" || typeof id === "number") {
      return `${typeName}(${JSON.stringify(id)})`;
    }
    return `<${typeName}>`;
  }
  return String(v);
}

function typeNameOf(v: unknown): string {
  if (v != null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec["__typeName"] === "string") return rec["__typeName"] as string;
  }
  return typeof v;
}

// Re-export for call-sites that need raw collection handling.
export { Collection };
