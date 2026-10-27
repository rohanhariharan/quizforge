import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'mathquill/build/mathquill.css';

const MATH_RE = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\$([^$\n]*?)\$/g;

export function splitRich(text) {
  const source = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(MATH_RE)) {
    if (match.index > last) parts.push({ type: 'text', value: source.slice(last, match.index) });
    const display = match[1] !== undefined || match[2] !== undefined;
    const latex = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    parts.push({ type: 'math', value: latex, display });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) });
  return parts;
}

export function renderMath(host, latex, { display = false } = {}) {
  host.replaceChildren();
  const value = stripDelimiters(latex);
  if (!value.trim()) return;
  const span = document.createElement('span');
  span.className = display ? 'math math-display' : 'math math-inline';
  try {
    katex.render(value, span, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      errorColor: '#dc2626',
      output: 'html',
    });
  } catch {
    span.textContent = value;
    span.classList.add('math-error');
  }
  host.appendChild(span);
}

export function renderRich(host, text, { display = false } = {}) {
  host.replaceChildren();
  const parts = splitRich(text);

  // A field that is pure LaTeX without delimiters still renders.
  if (parts.length === 1 && parts[0].type === 'text' && /\\[a-zA-Z]+/.test(parts[0].value) && parts[0].value.length < 400) {
    const span = document.createElement('span');
    span.className = 'math math-inline';
    try {
      katex.render(parts[0].value, span, {
        displayMode: display,
        throwOnError: true,
        strict: 'ignore',
        trust: false,
        output: 'html',
      });
      host.appendChild(span);
      return;
    } catch {
      // fall through to plain text
    }
  }

  for (const part of parts) {
    if (part.type === 'math') {
      const span = document.createElement('span');
      span.className = part.display ? 'math math-display' : 'math math-inline';
      try {
        katex.render(part.value, span, {
          displayMode: part.display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          errorColor: '#dc2626',
          output: 'html',
        });
      } catch {
        span.textContent = part.value;
        span.classList.add('math-error');
      }
      host.appendChild(span);
      continue;
    }

    const lines = part.value.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) host.appendChild(document.createElement('br'));
      if (line) host.appendChild(document.createTextNode(line));
    });
  }
}

export function stripDelimiters(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
    .replace(/^\$([\s\S]*)\$$/, '$1')
    .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// MathQuill
// ---------------------------------------------------------------------------

let mqPromise = null;

export function loadMathQuill() {
  if (!mqPromise) {
    mqPromise = (async () => {
      const jqueryModule = await import('jquery');
      const $ = jqueryModule.default ?? jqueryModule;
      window.$ = $;
      window.jQuery = $;
      await import('mathquill/build/mathquill.min.js');
      const MQ = window.MathQuill?.getInterface(1);
      if (!MQ) throw new Error('MathQuill did not start.');
      return MQ;
    })();
  }
  return mqPromise;
}

export async function createMathField(host, { onChange, onSubmit, initial = '' } = {}) {
  const MQ = await loadMathQuill();
  host.innerHTML = '';
  let field = null;
  const instance = MQ.MathField(host, {
    spaceBehavesLikeTab: true,
    autoCommands: 'pi theta sqrt sum int infty',
    autoOperatorNames: 'sin cos tan log ln lim max min',
    handlers: {
      edit: () => {
        if (field) onChange?.(field.latex());
      },
      enter: () => onSubmit?.(),
    },
  });
  field = instance;
  if (initial) {
    try {
      field.latex(initial);
    } catch {
      field.latex('');
    }
  }

  const textarea = host.querySelector('textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onSubmit?.();
      }
    });
    textarea.setAttribute('aria-label', 'Your answer');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('spellcheck', 'false');
  }

  return field;
}

export const MATH_TOOLS = [
  { label: '√', title: 'Square root', cmd: '\\sqrt' },
  { label: 'a/b', title: 'Fraction', cmd: '\\frac' },
  { label: 'x²', title: 'Power', cmd: '^' },
  { label: 'π', title: 'Pi', cmd: '\\pi' },
  { label: '≤', title: 'Less than or equal', cmd: '\\le ' },
  { label: '×', title: 'Multiply', cmd: '\\cdot ' },
  { label: '∫', title: 'Integral', cmd: '\\int' },
  { label: '∑', title: 'Sum', cmd: '\\sum' },
];
