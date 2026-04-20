// Pure, DOM-free library that powers the visual template-expression builder
// (#301). A `BuilderChain` is a root scope followed by an ordered list of
// steps; each step references a member name from `vaultApiDescriptor.ts`.
// Method steps that take a lambda carry an additional `lambda` condition
// which renders as `x => x.<propertyPath> <op> <literal>`.
//
// `renderExpression` produces a string that the existing
// `templateExpression.parse()` evaluator accepts — the round-trip is pinned
// by the test suite so the builder can never emit a shape the live-preview
// engine rejects.

import {
  ROOT_SCOPE,
  membersOf,
  collectionElementType,
  type TypeRef,
} from "./vaultApiDescriptor";

export type BinaryOp = "==" | "!=" | ">" | "<" | ">=" | "<=";
export type LiteralKind = "string" | "number" | "boolean";

export interface BuilderLambda {
  /** Path traversed from the lambda parameter — e.g. `["property", "tags"]` for `n.property.tags`. */
  propertyPath: string[];
  op: BinaryOp;
  /** Raw literal value as typed by the user; `renderExpression` quotes it based on `literalKind`. */
  literal: string;
  literalKind: LiteralKind;
}

export interface BuilderStep {
  kind: "property" | "method";
  name: string;
  lambda?: BuilderLambda;
}

export interface BuilderChain {
  rootName: string;
  rootType: TypeRef;
  steps: BuilderStep[];
}

function rootScope(): { name: string; type: TypeRef } {
  const root = ROOT_SCOPE[0];
  if (!root) {
    throw new Error("vaultApiDescriptor.ROOT_SCOPE is empty");
  }
  return { name: root.name, type: root.returns };
}

export function emptyChain(): BuilderChain {
  const root = rootScope();
  return { rootName: root.name, rootType: root.type, steps: [] };
}

export function addStep(chain: BuilderChain, step: BuilderStep): BuilderChain {
  return { ...chain, steps: [...chain.steps, step] };
}

export function setStepLambda(
  chain: BuilderChain,
  stepIndex: number,
  lambda: BuilderLambda,
): BuilderChain {
  // stepIndex is 1-based (index 0 is the root); steps[] is 0-based, so we
  // translate here to match the test-facing API.
  const internal = stepIndex - 1;
  const next = chain.steps.slice();
  const existing = next[internal];
  if (!existing) throw new Error(`setStepLambda: no step at ${stepIndex}`);
  next[internal] = { ...existing, lambda };
  return { ...chain, steps: next };
}

/**
 * Truncate the chain at the given index in the *full* chain. Index 0 is the
 * root, 1 is the first step, etc. — so `removeStepsFrom(chain, 1)` collapses
 * to the bare root, and `removeStepsFrom(chain, 2)` keeps the root plus one
 * step.
 */
export function removeStepsFrom(
  chain: BuilderChain,
  stepIndex: number,
): BuilderChain {
  const keep = Math.max(0, stepIndex - 1);
  return { ...chain, steps: chain.steps.slice(0, keep) };
}

/**
 * Returns the current type at position `stepIndex`, where 0 is the root and
 * subsequent indices walk member types through the descriptor. Collection
 * methods with return type `T` expand via `collectionElementType`. Returns
 * `null` if the chain references an unknown member.
 */
export function chainTypeAt(chain: BuilderChain, stepIndex: number): TypeRef | null {
  let current: TypeRef = chain.rootType;
  for (let i = 0; i < stepIndex; i++) {
    const step = chain.steps[i];
    if (!step) return current;
    const members = membersOf(current);
    const match = members.find((m) => m.name === step.name);
    if (!match) return null;
    current = match.returns;
    // Lambda-taking methods that return `Collection<T>` — `membersOf`
    // already substitutes T when the receiver is a Collection, so `current`
    // is already the concrete element type for e.g. `first()` on `Collection<Note>`.
    void collectionElementType;
  }
  return current;
}

function quoteString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderLiteral(lit: BuilderLambda): string {
  switch (lit.literalKind) {
    case "string":
      return quoteString(lit.literal);
    case "number":
      return lit.literal;
    case "boolean":
      return lit.literal === "true" ? "true" : "false";
  }
}

/**
 * The parameter name used for the lambda in the rendered DSL. Varies by the
 * element type so the output matches conventional naming (`n` for notes,
 * `f` for folders, `t` for tags). Falls back to `x` for anything else.
 */
function lambdaParamName(elementType: TypeRef): string {
  if (elementType === "Note") return "n";
  if (elementType === "Folder") return "f";
  if (elementType === "Tag") return "t";
  return "x";
}

function renderStep(step: BuilderStep, elementType: TypeRef): string {
  if (step.kind === "property") return step.name;
  // method
  if (!step.lambda) return `${step.name}()`;
  const param = lambdaParamName(elementType);
  const path = step.lambda.propertyPath.length > 0
    ? `.${step.lambda.propertyPath.join(".")}`
    : "";
  return `${step.name}(${param} => ${param}${path} ${step.lambda.op} ${renderLiteral(step.lambda)})`;
}

export function renderExpression(chain: BuilderChain): string {
  let out = chain.rootName;
  let current: TypeRef = chain.rootType;
  for (const step of chain.steps) {
    // Element type of the *current* receiver, used to name the lambda param.
    const element = collectionElementType(current) ?? current;
    out += `.${renderStep(step, element)}`;
    const members = membersOf(current);
    const match = members.find((m) => m.name === step.name);
    current = match ? match.returns : current;
  }
  return out;
}

export function wrapAsTemplate(chain: BuilderChain): string {
  return `{{ ${renderExpression(chain)} }}`;
}
