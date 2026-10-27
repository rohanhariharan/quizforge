// A tiny, CSP-safe expression engine for graph specs.
// Accepts plain math ("x^2 - 4", "2sin(x) + 1") and a little LaTeX.

const CACHE = new Map();

const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
};

function preprocess(source) {
  return String(source ?? '')
    .replace(/\$+/g, '')
    .replace(/\\left|\\right/gi, '')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '(($1)/($2))')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\\cdot|\\times/gi, '*')
    .replace(/\\div/gi, '/')
    .replace(/\\pi/gi, 'pi')
    .replace(/\\ln/gi, 'ln')
    .replace(/\\log/gi, 'log')
    .replace(/\^\{([^{}]*)\}/g, '^($1)')
    .replace(/_\{([^{}]*)\}/g, '')
    .replace(/[{}]/g, '')
    .replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/[\u00d7\u00b7]/g, '*')
    .replace(/\u00f7/g, '/')
    .trim();
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new Error('Bad number');
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const match = /^[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'ident', value: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${ch}"`);
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    const token = this.next();
    if (!token || token.type !== type) throw new Error(`Expected ${type}`);
  }

  parse(minBp = 0) {
    let left = this.prefix();
    for (;;) {
      const token = this.peek();
      if (!token) break;

      let op = token.type;
      let implicit = false;
      if (op === '(' || token.type === 'num' || token.type === 'ident') {
        op = '*';
        implicit = true;
      }

      const bp = op === '+' || op === '-' ? 10 : op === '*' || op === '/' ? 20 : op === '^' ? 31 : 0;
      if (!bp || bp <= minBp) break;

      if (!implicit) this.next();
      const right = this.parse(op === '^' ? bp - 1 : bp);
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  prefix() {
    const token = this.next();
    if (!token) throw new Error('Expression ended early');

    if (token.type === 'num') return { type: 'num', value: token.value };

    if (token.type === 'ident') {
      const name = token.value;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
        return { type: 'num', value: CONSTANTS[name] };
      }
      if (this.peek()?.type === '(') {
        this.next();
        const args = [];
        if (this.peek()?.type !== ')') {
          args.push(this.parse(0));
          while (this.peek()?.type === ',') {
            this.next();
            args.push(this.parse(0));
          }
        }
        this.expect(')');
        if (!FUNCTIONS[name]) throw new Error(`Unknown function ${name}`);
        return { type: 'call', name, args };
      }
      if (name === 'x') return { type: 'var' };
      throw new Error(`Unknown name "${name}"`);
    }

    if (token.type === '(') {
      const node = this.parse(0);
      this.expect(')');
      return node;
    }
    if (token.type === '-') return { type: 'unary', op: '-', value: this.parse(25) };
    if (token.type === '+') return this.parse(25);

    throw new Error('Unexpected token');
  }
}

function evaluate(node, x) {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var':
      return x;
    case 'unary':
      return -evaluate(node.value, x);
    case 'bin': {
      const a = evaluate(node.left, x);
      const b = evaluate(node.right, x);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return Math.pow(a, b);
        default:
          return NaN;
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      const args = node.args.map((arg) => evaluate(arg, x));
      return fn(...args);
    }
    default:
      return NaN;
  }
}

export function compileExpression(source) {
  const cleaned = preprocess(source);
  if (!cleaned) throw new Error('Empty expression');
  if (CACHE.has(cleaned)) {
    const cached = CACHE.get(cleaned);
    if (cached.error) throw new Error(cached.error);
    return cached.fn;
  }
  try {
    const tokens = tokenize(cleaned);
    const ast = new Parser(tokens).parse();
    if (!ast) throw new Error('Empty expression');
    const fn = (x) => evaluate(ast, x);
    CACHE.set(cleaned, { fn });
    return fn;
  } catch (error) {
    CACHE.set(cleaned, { error: error.message });
    throw error;
  }
}

export function tryCompile(source) {
  try {
    return compileExpression(source);
  } catch {
    return null;
  }
}

export function sampleFunction(fn, xMin, xMax, count = 720) {
  const points = [];
  const span = xMax - xMin;
  for (let i = 0; i <= count; i += 1) {
    const x = xMin + (span * i) / count;
    let y;
    try {
      y = fn(x);
    } catch {
      y = NaN;
    }
    points.push({ x, y: Number.isFinite(y) ? y : NaN });
  }
  return points;
}
