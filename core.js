const keywords = new Set(['let', 'in', 'fun', 'if', 'then', 'else', 'true', 'false']);
class Diagnostic extends Error {
  constructor(message, start, end, kind = 'syntax') {
    super(message);
    Object.assign(this, { start, end, kind });
  }
}
export function tokenize(source) {
  if (typeof source !== 'string' || source.length > 12000)
    throw new Diagnostic('Use at most 12,000 source characters.', 0, 0, 'limit');
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.slice(i, i + 2) === '--') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    const start = i,
      match = /^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9]+|->|==|[()+*,=\-])/.exec(source.slice(i));
    if (!match)
      throw new Diagnostic(`Unexpected character ${JSON.stringify(source[i])}.`, i, i + 1);
    const text = match[0];
    i += text.length;
    const kind = /^[0-9]/.test(text)
      ? 'int'
      : /^[A-Za-z_]/.test(text) && !keywords.has(text)
        ? 'id'
        : text;
    tokens.push({ kind, text, start, end: i });
    if (tokens.length > 1500) throw new Diagnostic('Use at most 1,500 tokens.', start, i, 'limit');
  }
  tokens.push({ kind: 'eof', text: '', start: i, end: i });
  return tokens;
}
export function parse(source) {
  const tokens = tokenize(source);
  let at = 0,
    depth = 0,
    nextId = 0;
  const peek = () => tokens[at],
    take = (kind) => {
      const t = peek();
      if (t.kind !== kind)
        throw new Diagnostic(
          `Expected ${kind}; found ${t.text || 'end of source'}.`,
          t.start,
          t.end,
        );
      at++;
      return t;
    };
  const node = (kind, start, end, props = {}) => {
    if (++nextId > 500)
      throw new Diagnostic('Use at most 500 expression nodes.', start, end, 'limit');
    return { id: nextId, kind, start, end, ...props };
  };
  function expression() {
    if (++depth > 80)
      throw new Diagnostic(
        'Expression nesting is limited to 80 levels.',
        peek().start,
        peek().end,
        'limit',
      );
    let result;
    if (peek().kind === 'let') {
      const s = take('let'),
        name = take('id');
      take('=');
      const value = expression();
      take('in');
      const body = expression();
      result = node('let', s.start, body.end, { name: name.text, value, body });
    } else if (peek().kind === 'fun') {
      const s = take('fun'),
        name = take('id');
      take('->');
      const body = expression();
      result = node('lambda', s.start, body.end, { name: name.text, body });
    } else if (peek().kind === 'if') {
      const s = take('if'),
        condition = expression();
      take('then');
      const yes = expression();
      take('else');
      const no = expression();
      result = node('if', s.start, no.end, { condition, yes, no });
    } else result = binary(0);
    depth--;
    return result;
  }
  const levels = [['=='], ['+', '-'], ['*']];
  function binary(level) {
    if (level === levels.length) return application();
    let left = binary(level + 1);
    while (levels[level].includes(peek().kind)) {
      const op = tokens[at++].kind,
        right = binary(level + 1);
      left = node('binary', left.start, right.end, { op, left, right });
    }
    return left;
  }
  function application() {
    let fn = atom();
    while (['id', 'int', 'true', 'false', '('].includes(peek().kind)) {
      const arg = atom();
      fn = node('apply', fn.start, arg.end, { fn, arg });
    }
    return fn;
  }
  function atom() {
    const t = peek();
    if (t.kind === 'id') {
      at++;
      return node('variable', t.start, t.end, { name: t.text });
    }
    if (t.kind === 'int') {
      at++;
      return node('integer', t.start, t.end, { literal: t.text });
    }
    if (t.kind === '-' && tokens[at + 1].kind === 'int') {
      at++;
      const n = take('int');
      return node('integer', t.start, n.end, { literal: '-' + n.text });
    }
    if (t.kind === 'true' || t.kind === 'false') {
      at++;
      return node('boolean', t.start, t.end, { value: t.kind === 'true' });
    }
    if (t.kind === '(') {
      at++;
      const first = expression();
      if (peek().kind === ',') {
        at++;
        const second = expression(),
          end = take(')');
        return node('pair', t.start, end.end, { first, second });
      }
      const end = take(')');
      return node('group', t.start, end.end, { body: first });
    }
    throw new Diagnostic(
      `Expected an expression; found ${t.text || 'end of source'}.`,
      t.start,
      t.end,
    );
  }
  const ast = expression();
  take('eof');
  return ast;
}
export function children(n) {
  return (
    {
      let: [n.value, n.body],
      lambda: [n.body],
      if: [n.condition, n.yes, n.no],
      binary: [n.left, n.right],
      apply: [n.fn, n.arg],
      pair: [n.first, n.second],
      group: [n.body],
    }[n.kind] || []
  );
}
export function analyze(source) {
  let ast = null,
    serial = 0,
    work = 0;
  const traces = [],
    bindings = [],
    typed = [],
    names = new Map();
  const fresh = () => ({ tag: 'var', id: serial++, link: null }),
    con = (tag) => ({ tag }),
    fn = (a, b) => ({ tag: 'fun', a, b }),
    pair = (a, b) => ({ tag: 'pair', a, b });
  const prune = (t) => {
    if (t.tag === 'var' && t.link) {
      t.link = prune(t.link);
      return t.link;
    }
    return t;
  };
  const label = (id, map) => {
    if (!map.has(id)) {
      const n = map.size;
      map.set(id, "'" + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : ''));
    }
    return map.get(id);
  };
  function format(t, map = names) {
    let count = 0;
    function visit(t, precedence = 0) {
      t = prune(t);
      if (++count > 160) return '…';
      if (t.tag === 'var') return label(t.id, map);
      if (t.tag === 'int' || t.tag === 'bool') return t.tag;
      const own = t.tag === 'fun' ? 1 : 2,
        text = visit(t.a, own + 1) + (t.tag === 'fun' ? ' → ' : ' × ') + visit(t.b, own);
      return own < precedence ? '(' + text + ')' : text;
    }
    return visit(t);
  }
  function free(t, set = new Set(), seen = new Set()) {
    t = prune(t);
    if (seen.has(t)) return set;
    seen.add(t);
    if (t.tag === 'var') set.add(t.id);
    else if (t.a) {
      free(t.a, set, seen);
      free(t.b, set, seen);
    }
    return set;
  }
  function generalize(t, env) {
    const vars = free(t);
    for (const scheme of env.values())
      for (const id of free(scheme.type)) if (!scheme.vars.has(id)) vars.delete(id);
    return { type: t, vars };
  }
  function instantiate(s) {
    const replacements = new Map([...s.vars].map((id) => [id, fresh()])),
      memo = new Map();
    function copy(t) {
      t = prune(t);
      if (t.tag === 'var') return replacements.get(t.id) || t;
      if (!t.a) return t;
      if (!memo.has(t)) memo.set(t, { tag: t.tag, a: copy(t.a), b: copy(t.b) });
      return memo.get(t);
    }
    return copy(s.type);
  }
  function schemeText(s) {
    const local = new Map(),
      type = format(s.type, local),
      vars = [...local].filter(([id]) => s.vars.has(id)).map(([, name]) => name);
    return (vars.length ? '∀ ' + vars.join(' ') + '. ' : '') + type;
  }
  function unify(left, right, n, reason) {
    const row = {
      step: traces.length + 1,
      reason,
      start: n.start,
      end: n.end,
      left: format(left),
      right: format(right),
      status: 'checking',
    };
    traces.push(row);
    function merge(a, b) {
      if (++work > 20000)
        throw new Diagnostic(
          'Type inference exceeded its 20,000-step work bound.',
          n.start,
          n.end,
          'limit',
        );
      a = prune(a);
      b = prune(b);
      if (a === b) return;
      if (a.tag === 'var') {
        if (free(b).has(a.id))
          throw new Diagnostic(
            `Infinite type: ${format(a)} occurs inside ${format(b)}.`,
            n.start,
            n.end,
            'occurs',
          );
        a.link = b;
        return;
      }
      if (b.tag === 'var') {
        merge(b, a);
        return;
      }
      if (a.tag !== b.tag)
        throw new Diagnostic(
          `Cannot unify ${format(a)} with ${format(b)}.`,
          n.start,
          n.end,
          'mismatch',
        );
      if (a.a) {
        merge(a.a, b.a);
        merge(a.b, b.b);
      }
    }
    try {
      merge(left, right);
      row.status = 'unified';
      row.result = format(left);
    } catch (e) {
      row.status = 'failed';
      throw e;
    }
  }
  function infer(n, env, depth = 0) {
    if (depth > 100)
      throw new Diagnostic('Inference nesting is limited to 100 levels.', n.start, n.end, 'limit');
    const go = (c, e = env) => infer(c, e, depth + 1);
    let t;
    if (n.kind === 'integer') t = con('int');
    else if (n.kind === 'boolean') t = con('bool');
    else if (n.kind === 'variable') {
      if (!env.has(n.name))
        throw new Diagnostic(`Unbound name: ${n.name}.`, n.start, n.end, 'unbound');
      t = instantiate(env.get(n.name));
    } else if (n.kind === 'group') t = go(n.body);
    else if (n.kind === 'lambda') {
      const a = fresh(),
        inner = new Map(env);
      inner.set(n.name, { type: a, vars: new Set() });
      t = fn(a, go(n.body, inner));
    } else if (n.kind === 'apply') {
      const f = go(n.fn),
        a = go(n.arg);
      t = fresh();
      unify(f, fn(a, t), n, 'Function application');
    } else if (n.kind === 'pair') t = pair(go(n.first), go(n.second));
    else if (n.kind === 'let') {
      const value = go(n.value),
        scheme = generalize(value, env),
        inner = new Map(env);
      inner.set(n.name, scheme);
      bindings.push({
        name: n.name,
        start: n.value.start,
        end: n.value.end,
        scheme: schemeText(scheme),
        quantified: scheme.vars.size,
      });
      t = go(n.body, inner);
    } else if (n.kind === 'if') {
      const condition = go(n.condition);
      unify(condition, con('bool'), n.condition, 'Conditional guard');
      const yes = go(n.yes),
        no = go(n.no);
      unify(yes, no, n, 'Conditional branches');
      t = yes;
    } else if (n.kind === 'binary') {
      const left = go(n.left),
        right = go(n.right);
      unify(left, con('int'), n.left, `Left operand of ${n.op}`);
      unify(right, con('int'), n.right, `Right operand of ${n.op}`);
      t = con(n.op === '==' ? 'bool' : 'int');
    }
    typed.push({ node: n, type: t });
    return t;
  }
  const env = new Map();
  for (const name of ['fst', 'snd']) {
    const a = fresh(),
      b = fresh();
    env.set(name, { type: fn(pair(a, b), name === 'fst' ? a : b), vars: new Set([a.id, b.id]) });
  }
  let principal = null,
    error = null;
  try {
    ast = parse(source);
    const t = infer(ast, env);
    principal = format(t, new Map());
  } catch (e) {
    if (!(e instanceof Diagnostic)) throw e;
    error = { message: e.message, start: e.start, end: e.end, kind: e.kind };
  }
  const nodes = typed.map(({ node: n, type }) => ({
    id: n.id,
    kind: n.kind,
    start: n.start,
    end: n.end,
    type: format(type),
    children: children(n).map((c) => c.id),
  }));
  return {
    source,
    ok: !error,
    principal,
    error,
    bindings,
    trace: traces,
    nodes,
    root: ast?.id ?? null,
    work,
    offsetUnit: 'UTF-16 code units',
  };
}
export const EXAMPLES = {
  polymorphism:
    '-- One definition, two independent instantiations.\nlet identity = fun x -> x in\n(identity 42, identity true)',
  composition: 'let compose = fun f -> fun g -> fun x -> f (g x) in\ncompose',
  captured:
    '-- A captured parameter stays monomorphic.\nfun x -> let captured = fun y -> x in\n(captured 1, captured true)',
  mismatch: 'let choose = fun flag -> if flag then 1 else false in\nchoose true',
  occurs: '-- Self-application would require an infinite type.\nfun x -> x x',
  lambda:
    '-- Lambda parameters cannot be generalized like let bindings.\n(fun f -> (f 1, f true)) (fun x -> x)',
};
export function validateSession(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'source,version' ||
    value.version !== 1 ||
    typeof value.source !== 'string' ||
    value.source.length > 12000
  )
    throw Error('Expected a version 1 session with source text (at most 12,000 characters).');
  return { version: 1, source: value.source };
}
