import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parse, tokenize, EXAMPLES, validateSession } from '../core.js';
const type = (source, expected) => {
  const r = analyze(source);
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.equal(r.principal, expected);
  return r;
};
test('literals, arithmetic precedence, and integer comparison', () => {
  type('1 + 2 * 3', 'int');
  type('(1 + 2) == 3', 'bool');
  type('-12', 'int');
  type('true', 'bool');
  const ast = parse('1 + 2 * 3');
  assert.equal(ast.op, '+');
  assert.equal(ast.right.op, '*');
  assert.equal(analyze('true == false').error.kind, 'mismatch');
});
test('identity, constant functions, and composition have principal polymorphic types', () => {
  type('fun x -> x', "'a → 'a");
  type('fun x -> fun y -> x', "'a → 'b → 'a");
  type(EXAMPLES.composition, "('a → 'b) → ('c → 'a) → 'c → 'b");
});
test('let generalization instantiates independently at every use', () => {
  const r = type(EXAMPLES.polymorphism, 'int × bool');
  assert.equal(r.bindings[0].quantified, 1);
  type('let id = fun x -> x in id id', "'a → 'a");
  type(
    'let pair = fun x -> fun y -> (x,y) in (pair 1 true, pair false 2)',
    '(int × bool) × bool × int',
  );
});
test('lambda-bound variables are monomorphic', () => {
  assert.equal(analyze(EXAMPLES.lambda).error.kind, 'mismatch');
  type('fun f -> (f 1, f 2)', "(int → 'a) → 'a × 'a");
});
test('captured environment variables never become quantified', () => {
  const r = type(EXAMPLES.captured, "'a → 'a × 'a");
  assert.equal(r.bindings[0].quantified, 1);
  assert.equal(analyze('fun f -> let g = f in (g 1, g true)').error.kind, 'mismatch');
  type('fun f -> let g = fun x -> f x in (g 1, g 2)', "(int → 'a) → 'a × 'a");
});
test('environment substitutions are applied before generalization', () => {
  assert.equal(
    analyze('fun f -> let a = f 1 in let g = fun x -> a x in (g 1, g true)').error.kind,
    'mismatch',
  );
  type('fun f -> let a = f 1 in let g = fun x -> a in (g 1,g true)', "(int → 'a) → 'a × 'a");
});
test('occurs check rejects direct and indirect infinite types', () => {
  assert.equal(analyze(EXAMPLES.occurs).error.kind, 'occurs');
  assert.equal(analyze('fun x -> fun y -> let a = x y in y x').error.kind, 'occurs');
  const r = analyze(EXAMPLES.occurs);
  assert.equal(r.trace.at(-1).status, 'failed');
  assert.equal(r.source.slice(r.error.start, r.error.end), 'x x');
});
test('prelude projections instantiate independently and respect shadowing', () => {
  type('(fst (1,true),fst (false,2))', 'int × bool');
  type('snd (1, fun x -> x)', "'a → 'a");
  type('let fst = fun x -> x + 1 in fst 4', 'int');
  assert.equal(analyze('fst 1').error.kind, 'mismatch');
});
test('conditionals constrain guards and both branch types', () => {
  type('fun flag -> if flag then (fun x -> x) else (fun y -> y)', "bool → 'a → 'a");
  assert.equal(analyze('if 1 then 2 else 3').error.kind, 'mismatch');
  assert.equal(analyze(EXAMPLES.mismatch).error.kind, 'mismatch');
});
test('lexical scope, nonrecursive lets, and reserved words', () => {
  type('let x = true in let x = 2 in x', 'int');
  assert.equal(analyze('let x = x in x').error.kind, 'unbound');
  assert.equal(analyze('let true = 1 in true').error.kind, 'syntax');
  assert.equal(analyze('(let x = 1 in x) + x').error.kind, 'unbound');
});
test('application is left associative and arrows bind more weakly than pairs', () => {
  const a = parse('f x y');
  assert.equal(a.fn.kind, 'apply');
  type('fun x -> (x, fun y -> y)', "'a → 'a × ('b → 'b)");
  type('fun f -> f (1,true)', "(int × bool → 'a) → 'a");
});
test('comments and exact source spans survive CRLF and Unicode in comments', () => {
  const source = '-- 🐚 comment\r\nlet id = fun x -> x in\r\nid true';
  const r = type(source, 'bool');
  assert.equal(r.offsetUnit, 'UTF-16 code units');
  for (const row of r.trace) assert.ok(source.slice(row.start, row.end).length > 0);
  assert.equal(tokenize(source)[0].start, source.indexOf('let'));
  assert.equal(analyze('1 @ 2').error.start, 2);
  assert.equal(analyze('').error.kind, 'syntax');
});
test('trace and node reports preserve successful constraints and final inferred types', () => {
  const r = type('let id = fun x -> x in id 2', 'int');
  assert.ok(r.trace.every((x) => x.status === 'unified'));
  assert.equal(r.nodes.find((x) => x.id === r.root).type, 'int');
  for (const n of r.nodes) for (const id of n.children) assert.ok(r.nodes.some((c) => c.id === id));
  assert.doesNotThrow(() => JSON.stringify(r));
});
test('independently generated ground programs agree with a compositional type oracle', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  function make(kind, depth) {
    if (!depth) return kind === 'int' ? String(rand(30)) : rand(2) ? 'true' : 'false';
    const choice = rand(4);
    if (choice === 0) return `(let value = ${make(kind, depth - 1)} in value)`;
    if (choice === 1)
      return `(if ${make('bool', depth - 1)} then ${make(kind, depth - 1)} else ${make(kind, depth - 1)})`;
    if (choice === 2) return `((fun x -> x) ${make(kind, depth - 1)})`;
    return kind === 'int'
      ? `(${make('int', depth - 1)} + ${make('int', depth - 1)})`
      : `(${make('int', depth - 1)} == ${make('int', depth - 1)})`;
  }
  for (let i = 0; i < 200; i++) {
    const kind = rand(2) ? 'int' : 'bool';
    type(make(kind, 3), kind);
  }
});
test('source, token, AST, nesting, and session limits fail explicitly', () => {
  assert.equal(analyze('x'.repeat(12001)).error.kind, 'limit');
  assert.equal(analyze('('.repeat(90) + '1' + ')'.repeat(90)).error.kind, 'limit');
  assert.equal(analyze(Array(260).fill('1').join('+')).error.kind, 'limit');
  assert.equal(analyze(Array(800).fill('1').join('+')).error.kind, 'limit');
  assert.deepEqual(validateSession({ source: 'fun x -> x', version: 1 }), {
    source: 'fun x -> x',
    version: 1,
  });
  for (const x of [
    null,
    { source: 1, version: 1 },
    { source: 'x', version: 2 },
    { source: 'x', version: 1, extra: 0 },
  ])
    assert.throws(() => validateSession(x));
});
