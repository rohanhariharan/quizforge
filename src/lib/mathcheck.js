import { tryCompile } from './expression.js';

export function normalizeLatex(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\$\$?/, '')
    .replace(/\$\$?$/, '')
    .replace(/^\\\[/, '')
    .replace(/\\\]$/, '')
    .replace(/\s+/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\[dt]frac/g, '\\frac')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\,|\\;|\\!|\\quad|\\qquad/g, '')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^{}]*)\}/g, '$1')
    .toLowerCase();
}

export function latexToNumber(input) {
  let s = String(input ?? '');
  if (!s.trim()) return null;
  s = s
    .replace(/\$+/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\text\{[^{}]*\}/g, '')
    .replace(/\\mathrm\{[^{}]*\}/g, '')
    .replace(/\\,|\\;|\\!|\\quad|\\qquad/g, '')
    .replace(/\\%/g, '')
    .replace(/%/g, '')
    .replace(/\^\{?\\circ\}?/g, '')
    .replace(/\\pi/g, 'pi')
    .replace(/\\[dt]frac/g, '\\frac')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\sqrt/g, 'sqrt')
    .replace(/[−–—]/g, '-')
    .replace(/[\u00d7·]/g, '*')
    .replace(/\u00f7/g, '/')
    .replace(/(\d),(\d)/g, '$1$2');

  for (let i = 0; i < 8; i += 1) {
    const next = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '(($1)/($2))');
    if (next === s) break;
    s = next;
  }
  s = s
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\^\{([^{}]*)\}/g, '^($1)')
    .replace(/[{}]/g, '')
    .trim();

  if (!s) return null;
  if (/(^|[^a-z])x([^a-z]|$)/i.test(s)) return null;
  if (/[a-z]/i.test(s.replace(/sqrt|pi|e/gi, ''))) return null;

  const fn = tryCompile(s);
  if (!fn) return null;
  const value = fn(0);
  return Number.isFinite(value) ? value : null;
}

export function numericAnswer(latex) {
  const text = String(latex ?? '').trim();
  if (!text) return null;
  const equals = text.lastIndexOf('=');
  if (equals !== -1) {
    const left = text.slice(0, equals).trim();
    if (!/^[a-z](?:\([a-z]\))?$/i.test(left)) return null;
    const right = text.slice(equals + 1).trim();
    return latexToNumber(right);
  }
  return latexToNumber(text);
}

function cleanFinal(value) {
  let text = String(value ?? '').trim();
  text = text
    .replace(/^=+\s*/, '')
    .replace(/^[:\s]+/, '')
    .replace(/[.,;]+$/, '')
    .trim();
  if (!text || text.length > 160) return null;
  if (/\\begin|\\end/.test(text)) return null;
  if (/^(and|or|so|thus|therefore|hence)$/i.test(text)) return null;
  return text;
}

// Pull the value the worked solution actually lands on. This is the value the
// student sees at the end of the explanation, so it must count for grading.
export function solutionFinal(question) {
  const steps = Array.isArray(question?.solution) ? question.solution : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = String(steps[i] || '');
    const boxed = /\\boxed\s*\{([^{}]+)\}/.exec(step) || /\\fbox\s*\{([^{}]+)\}/.exec(step);
    if (boxed) {
      const value = cleanFinal(boxed[1]);
      if (value) return value;
    }
    const equals = step.lastIndexOf('=');
    if (equals !== -1) {
      const tail = step
        .slice(equals + 1)
        .split(/\$|\\approx|\\simeq|\\cong|\.\s|\.$|;|\n/)[0];
      const value = cleanFinal(tail);
      if (value) return value;
    }
  }
  return null;
}

export function alternateAnswer(question) {
  const latex = solutionFinal(question);
  if (!latex) return null;
  return { latex, value: numericAnswer(latex) };
}

// Returns the solution's value only when it *numerically* disagrees with the
// stored answer key. Symbolic/ambiguous answers are left alone.
export function answerKeyMismatch(question) {
  const alt = alternateAnswer(question);
  if (!alt) return null;
  const primaryLatex = question?.answer?.latex || '';
  if (!primaryLatex) return null;
  if (normalizeLatex(primaryLatex) === normalizeLatex(alt.latex)) return null;
  const primaryValue = numericAnswer(primaryLatex);
  if (primaryValue === null || alt.value === null) return null;
  const tolerance = Math.max(1e-9, Math.abs(primaryValue) * 1e-6);
  if (Math.abs(primaryValue - alt.value) <= tolerance) return null;
  return alt;
}

export function localVerdict(question, answerLatex) {
  const user = String(answerLatex ?? '').trim();
  if (!user) return { verdict: 'blank', detail: 'No answer given.' };

  const correct = question.answer || {};
  const userValue = latexToNumber(user);
  const mismatch = answerKeyMismatch(question);

  const targets = [{ latex: correct.latex, value: numericAnswer(correct.latex), primary: true }];
  if (mismatch) {
    targets.push({ latex: mismatch.latex, value: mismatch.value, primary: false });
  }

  for (const target of targets) {
    if (target.value !== null && Number.isFinite(target.value) && userValue !== null) {
      const tolerance = Math.max(1e-9, Math.abs(target.value) * 1e-6);
      if (Math.abs(userValue - target.value) <= tolerance) {
        return {
          verdict: 'correct',
          detail: target.primary
            ? 'Numerically equivalent.'
            : 'Matches the worked solution; the stored answer key was inconsistent.',
          matchedAlternate: !target.primary,
          keyMismatch: Boolean(mismatch),
        };
      }
    }
    if (normalizeLatex(user) === normalizeLatex(target.latex)) {
      return {
        verdict: 'correct',
        detail: target.primary
          ? 'Matches the expected expression.'
          : 'Matches the worked solution; the stored answer key was inconsistent.',
        matchedAlternate: !target.primary,
        keyMismatch: Boolean(mismatch),
      };
    }
  }

  if (mismatch) {
    return {
      verdict: 'review',
      detail: 'The stored answer key and the worked solution disagree; compare with the worked solution.',
      keyMismatch: true,
    };
  }

  if (userValue !== null && targets[0].value !== null && Number.isFinite(targets[0].value)) {
    return { verdict: 'incorrect', detail: 'The value differs from the expected answer.' };
  }

  return { verdict: 'review', detail: 'Compare the two forms by hand.' };
}

export function scoreOf(grades, total) {
  const values = Object.values(grades || {});
  const correct = values.filter((grade) => grade?.correct === true).length;
  const decided = values.filter((grade) => typeof grade?.correct === 'boolean').length;
  return { correct, decided, total, percent: total ? Math.round((correct / total) * 100) : 0 };
}
