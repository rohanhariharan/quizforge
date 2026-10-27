import { normalizeGraphSpec } from './graph.js';
import { numericAnswer } from './mathcheck.js';
import { uid } from './util.js';

export const BATCH_SIZE = 4;

const QUIZ_TYPES = ['word', 'math', 'graph', 'math', 'word', 'math', 'graph', 'word', 'math', 'math'];
const QUIZ_DIFFICULTY = ['easy', 'medium', 'medium', 'medium', 'medium', 'hard', 'medium', 'medium', 'easy', 'hard'];

const TEST_TYPES = [
  'word', 'math', 'graph', 'math', 'word', 'graph', 'math', 'word', 'math', 'graph',
  'word', 'math', 'graph', 'math', 'word', 'math', 'word', 'math', 'word', 'math',
];
const TEST_DIFFICULTY = [
  'easy', 'medium', 'medium', 'hard', 'medium', 'medium', 'easy', 'medium', 'hard', 'medium',
  'medium', 'easy', 'medium', 'hard', 'medium', 'medium', 'hard', 'medium', 'medium', 'hard',
];

export function planFor(mode) {
  if (mode === 'test') {
    return { mode, total: 20, seconds: 40 * 60, types: TEST_TYPES, difficulties: TEST_DIFFICULTY };
  }
  return { mode: 'quiz', total: 10, seconds: 20 * 60, types: QUIZ_TYPES, difficulties: QUIZ_DIFFICULTY };
}

export function parseModelJson(text) {
  if (!text) return null;
  let source = String(text).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) source = fenced[1].trim();

  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  const firstBracket = source.indexOf('[');
  const lastBracket = source.lastIndexOf(']');

  let body = null;
  if (firstBrace !== -1 && lastBrace > firstBrace && (firstBracket === -1 || firstBrace < firstBracket)) {
    body = source.slice(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket > firstBracket) {
    body = source.slice(firstBracket, lastBracket + 1);
  }
  if (!body) return null;

  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the repaired version next
    }
  }
  return null;
}

const TYPE_MAP = {
  word: 'word',
  'word-problem': 'word',
  'word problem': 'word',
  wordproblem: 'word',
  math: 'math',
  maths: 'math',
  symbolic: 'math',
  expression: 'math',
  equation: 'math',
  graph: 'graph',
  graphing: 'graph',
  'graph-based': 'graph',
};

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function normalizeDifficulty(value, fallback = 'medium') {
  const raw = String(value ?? '').toLowerCase().trim();
  if (raw === 'easy' || raw === 'beginner' || raw === 'basic') return 'easy';
  if (raw === 'hard' || raw === 'advanced' || raw === 'challenging' || raw === 'olympiad') return 'hard';
  if (raw === 'medium' || raw === 'intermediate' || raw === 'moderate') return 'medium';
  return fallback;
}

function normalizeSteps(raw) {
  const value = raw?.solution ?? raw?.steps ?? raw?.workedSolution ?? raw?.worked_solution;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const steps = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string' || typeof item === 'number') {
      const parts = String(item).split(/\n+/);
      for (const part of parts) if (part.trim()) steps.push(part.trim());
    } else if (typeof item === 'object') {
      const combined = [item.text, item.explanation, item.step, item.content, item.working]
        .map(textOf)
        .filter(Boolean)
        .join(' ');
      if (combined) steps.push(combined);
    }
  }
  if (!steps.length && typeof value === 'string' && value.trim()) steps.push(value.trim());
  return steps.slice(0, 8);
}

export function normalizeQuestion(raw, context = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'Not an object' };

  const rawType = String(raw.type ?? raw.kind ?? '').toLowerCase().trim();
  let type = TYPE_MAP[rawType] || 'math';

  const stem = textOf(raw.stem ?? raw.question ?? raw.prompt ?? raw.text ?? raw.problem);
  if (stem.length < 15) return { ok: false, reason: 'Stem too short' };

  const topic = (textOf(raw.topic) || 'General').slice(0, 48);
  const difficulty = normalizeDifficulty(raw.difficulty);

  let graph = null;
  if (type === 'graph') {
    graph = normalizeGraphSpec(raw.graph);
    if (!graph) return { ok: false, reason: 'Graph question without a drawable graph' };
  }

  const rawAnswer = raw.answer ?? raw.correctAnswer ?? raw.correct_answer ?? raw.answerLatex;
  let answerObject = rawAnswer;
  if (typeof rawAnswer === 'string' || typeof rawAnswer === 'number') answerObject = { latex: String(rawAnswer) };
  if (!answerObject || typeof answerObject !== 'object') return { ok: false, reason: 'Missing answer' };

  let latex = textOf(
    answerObject.latex ?? answerObject.expression ?? answerObject.value ?? answerObject.result,
  );
  const numeric = numericAnswer(latex);
  const value = numeric === null ? undefined : numeric;
  if (!latex && value !== undefined) latex = String(value);
  if (!latex) return { ok: false, reason: 'Answer has no LaTeX' };

  const answerText = textOf(answerObject.text ?? answerObject.explanation ?? raw.answerText);
  const solution = normalizeSteps(raw);
  const hint = textOf(raw.hint ?? raw.nudge).slice(0, 320);

  return {
    ok: true,
    value: {
      id: uid('q'),
      docId: context.docId || '',
      number: 0,
      type,
      topic,
      difficulty,
      stem,
      graph,
      answer: { latex, value, text: answerText },
      solution,
      hint,
      origin: {
        mode: context.mode || '',
        provider: 'openrouter',
        model: context.model || '',
      },
      createdAt: Date.now(),
    },
  };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'which', 'when',
  'where', 'how', 'its', 'are', 'was', 'were', 'has', 'have', 'had', 'not',
  'but', 'you', 'your', 'can', 'will', 'would', 'should', 'could', 'into',
  'than', 'then', 'them', 'they', 'there', 'their', 'about', 'after', 'before',
  'over', 'under', 'between', 'each', 'more', 'most', 'some', 'such', 'only',
  'also', 'just', 'very', 'use', 'using', 'given', 'following', 'below',
  'above', 'evaluate', 'solve', 'find', 'calculate', 'determine', 'compute',
  'write', 'express', 'answer', 'value', 'values', 'question', 'shown',
]);

function tokensOf(stem) {
  const raw = String(stem)
    .toLowerCase()
    .replace(/\\(left|right|,|;|!|quad|qquad)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(raw.split(' ').filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

function fingerprint(stem) {
  return String(stem)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9+\-*/=^<>()[\]]/g, '');
}

function templateTokens(stem) {
  const normalized = String(stem)
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\\(left|right|cdot|times|div|frac|sqrt|sin|cos|tan|sec|csc|cot|pi|theta|alpha|beta|gamma|log|ln)/g, ' ')
    .replace(/[^a-z#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new Set(normalized.split(' ').filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

function graphKey(graph) {
  if (!graph) return '';
  const round = (value) => Number(Number(value).toFixed(3));
  return JSON.stringify({
    bounds: [round(graph.xMin), round(graph.xMax), round(graph.yMin), round(graph.yMax)],
    functions: (graph.functions || []).map((fn) => String(fn.expr).toLowerCase().replace(/\s+/g, '')),
    points: (graph.points || []).map((point) => [round(point.x), round(point.y)]),
    segments: (graph.segments || []).map((segment) => [round(segment.x1), round(segment.y1), round(segment.x2), round(segment.y2)]),
  });
}

function topicKey(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function isDuplicate(question, existing) {
  const fingerprintA = fingerprint(question.stem);
  const tokensA = tokensOf(question.stem);
  const templateA = templateTokens(question.stem);
  const graphA = graphKey(question.graph);
  const topicA = topicKey(question.topic);
  let sameTopic = 0;

  for (const other of existing) {
    if (!other) continue;

    if (fingerprintA && fingerprintA === fingerprint(other.stem)) return true;
    if (graphA && graphA === graphKey(other.graph)) return true;
    if (topicA && topicA === topicKey(other.topic)) sameTopic += 1;

    if (fingerprintA.length < 60) continue;
    if (similarity(tokensA, tokensOf(other.stem)) >= 0.9) return true;
    if (similarity(templateA, templateTokens(other.stem)) >= 0.8) return true;
  }

  // Four questions with the same subject label means the generator is stuck.
  if (topicA && topicA !== 'general' && sameTopic >= 3) return true;
  return false;
}

export function coveredList(questions) {
  return questions.map((question) => ({
    topic: question.topic,
    stem: `${question.stem.replace(/\s+/g, ' ').slice(0, 130)}${question.stem.length > 130 ? '…' : ''}`,
  }));
}
