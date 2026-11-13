import { EXAMPLES, validateSession } from './core.js';
const $ = (id) => document.getElementById(id),
  el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
let source = EXAMPLES.polymorphism,
  result = null,
  worker = null,
  busy = false,
  revision = 0,
  step = 0;
function status(s) {
  $('status').textContent = s;
}
function controls() {
  for (const n of document.querySelectorAll('button,input,select,textarea')) n.disabled = busy;
  $('cancel').disabled = !busy;
  if (!busy) {
    $('previous').disabled = !result?.trace.length || step === 0;
    $('next').disabled = !result?.trace.length || step === result.trace.length - 1;
    $('step').disabled = !result?.trace.length;
  }
}
function clear() {
  revision++;
  worker?.terminate();
  worker = null;
  busy = false;
  result = null;
  $('evidence').hidden = true;
  $('principal').textContent = '—';
  $('verdict-label').textContent = 'PRINCIPAL TYPE';
  $('explanation').textContent = 'Infer the updated expression to refresh its evidence.';
  $('counts').textContent = '';
  $('diagnostic').hidden = true;
  document.querySelector('.verdict').classList.remove('error');
  controls();
}
function location(start, end) {
  const before = source.slice(0, start),
    line = before.split('\n').length,
    col = start - (before.lastIndexOf('\n') + 1) + 1;
  return `Line ${line}, column ${col} · offsets [${start}, ${end}) in UTF-16 code units`;
}
function highlight(start, end) {
  const pre = $('excerpt'),
    mark = el('mark', source.slice(start, end) || '∅');
  pre.replaceChildren(
    document.createTextNode(source.slice(0, start)),
    mark,
    document.createTextNode(source.slice(end)),
  );
  $('location').textContent = location(start, end);
}
function showStep() {
  if (!result) return;
  const row = result.trace[step];
  $('step').max = Math.max(0, result.trace.length - 1);
  $('step').value = step;
  $('step-label').textContent = result.trace.length
    ? `${step + 1} / ${result.trace.length}`
    : 'none';
  if (row) {
    $('reason').textContent = row.reason;
    $('equation').textContent = `${row.left} ≐ ${row.right}`;
    $('resolution').textContent =
      row.status === 'unified'
        ? `Unified as ${row.result}. Names reflect the state at this constraint.`
        : result.error.message;
    highlight(row.start, row.end);
  } else if (result.error) {
    $('reason').textContent = result.error.kind + ' diagnostic';
    $('equation').textContent = result.error.message;
    $('resolution').textContent =
      'No unification constraints were completed before this diagnostic.';
    highlight(result.error.start, result.error.end);
  } else {
    $('reason').textContent = 'No constraints needed';
    $('equation').textContent = result.principal;
    $('resolution').textContent = 'This expression can be typed without a unification equation.';
    highlight(0, source.length);
  }
  controls();
}
function inspectNode(n) {
  $('reason').textContent = `Expression / ${n.kind}`;
  $('equation').textContent = n.type;
  $('resolution').textContent = result.ok
    ? 'Final inferred type for this expression.'
    : 'Partial type from work completed before the diagnostic.';
  highlight(n.start, n.end);
}
function showDiagnostic() {
  if (!result?.error) return;
  $('reason').textContent = result.error.kind + ' diagnostic';
  $('equation').textContent = result.error.message;
  $('resolution').textContent =
    'The highlighted expression is where analysis stopped. Use the constraint controls to review earlier reasoning.';
  highlight(result.error.start, result.error.end);
}
$('diagnostic').addEventListener('click', showDiagnostic);
function render() {
  $('evidence').hidden = false;
  $('diagnostic').hidden = result.ok;
  document.querySelector('.verdict').classList.toggle('error', !result.ok);
  $('verdict-label').textContent = result.ok ? 'PRINCIPAL TYPE' : 'TYPE DIAGNOSTIC';
  $('principal').textContent = result.ok
    ? result.principal
    : {
        occurs: 'An infinite type.',
        mismatch: 'Types disagree.',
        unbound: 'A missing name.',
        syntax: 'Check the syntax.',
        limit: 'A smaller expression.',
      }[result.error.kind] || 'Analysis stopped.';
  $('explanation').textContent = result.ok
    ? 'The most general type inferred for this expression. No values were evaluated.'
    : result.error.message + ' ' + location(result.error.start, result.error.end);
  $('counts').textContent =
    `${result.nodes.length} completed expressions · ${result.trace.length} constraints · ${result.bindings.length} let bindings`;
  $('binding-count').textContent = `/ ${result.bindings.length}`;
  $('node-count').textContent = `/ ${result.nodes.length}`;
  $('bindings').replaceChildren();
  for (const b of result.bindings) {
    const row = el('tr');
    for (const v of [b.name, b.scheme, b.quantified, location(b.start, b.end)])
      row.append(el('td', v));
    $('bindings').append(row);
  }
  if (!result.bindings.length) {
    const row = el('tr'),
      cell = el('td', 'No let bindings completed.');
    cell.colSpan = 4;
    row.append(cell);
    $('bindings').append(row);
  }
  $('nodes').replaceChildren();
  for (const n of [...result.nodes].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const row = el('tr'),
      cell = el('td'),
      button = el('button', source.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 110));
    button.title = 'Inspect this expression';
    button.addEventListener('click', () => inspectNode(n));
    cell.append(button);
    row.append(cell, el('td', n.kind), el('td', n.type));
    $('nodes').append(row);
  }
  step = result.ok ? 0 : Math.max(0, result.trace.length - 1);
  showStep();
  if (result.error) showDiagnostic();
  status(
    result.ok
      ? 'Inference complete. Inspect a constraint or save the folio.'
      : 'Analysis stopped at the first diagnostic. Earlier evidence remains inspectable.',
  );
}
function run() {
  clear();
  const ticket = revision,
    w = new Worker('worker.js', { type: 'module' });
  worker = w;
  busy = true;
  controls();
  status('Inferring types…');
  w.onmessage = ({ data }) => {
    if (ticket !== revision) return;
    w.terminate();
    worker = null;
    busy = false;
    if (data.error) {
      controls();
      status(data.error);
      return;
    }
    result = data.result;
    render();
  };
  w.onerror = () => {
    if (ticket !== revision) return;
    w.terminate();
    worker = null;
    busy = false;
    controls();
    status('Inference worker failed. Try a smaller expression.');
  };
  w.postMessage(source);
}
$('source').value = source;
$('source').addEventListener('input', () => {
  source = $('source').value;
  clear();
  status('Source changed. Infer again to update the evidence.');
});
$('infer').addEventListener('click', run);
$('cancel').addEventListener('click', () => {
  clear();
  status('Inference cancelled.');
});
$('example').addEventListener('change', () => {
  source = EXAMPLES[$('example').value];
  $('source').value = source;
  run();
});
$('step').addEventListener('input', () => {
  step = Number($('step').value);
  showStep();
});
$('previous').addEventListener('click', () => {
  step = Math.max(0, step - 1);
  showStep();
});
$('next').addEventListener('click', () => {
  step = Math.min(result.trace.length - 1, step + 1);
  showStep();
});
function download(name, value) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save').addEventListener('click', () => download('type-folio.json', { version: 1, source }));
$('report').addEventListener('click', () => download('type-evidence.json', result));
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  const ticket = ++revision;
  busy = true;
  controls();
  try {
    if (f.size > 100000) throw Error('Folio files are limited to 100 KB.');
    const value = validateSession(JSON.parse(await f.text()));
    if (ticket !== revision) return;
    source = value.source;
    $('source').value = source;
    run();
  } catch (e) {
    if (ticket === revision) {
      busy = false;
      controls();
      status(`Import rejected: ${e.message}`);
    }
  } finally {
    $('file').value = '';
  }
});
run();
