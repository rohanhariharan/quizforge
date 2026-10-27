import {
  base64ToBytes,
  invoke,
  isTauri,
  openExternal,
  pickAttachment,
  loadState,
  saveState,
} from '../lib/bridge.js';
import { extractAttachment } from '../lib/extract.js';
import { generateQuiz } from '../lib/generate.js';
import { planFor } from '../lib/questions.js';
import {
  createMathField,
  loadMathQuill,
  MATH_TOOLS,
  renderMath,
  renderRich,
} from '../lib/rich.js';
import { renderGraph } from '../lib/graph.js';
import { localGrades, gradeWithAI } from '../lib/grade.js';
import { answerKeyMismatch, scoreOf } from '../lib/mathcheck.js';
import { bytesLabel, clamp, clockLabel, debounce, elapsedLabel, esc, sleep, uid } from '../lib/util.js';
import { icon } from './icons.js';
import { confirmDialog, toast } from './overlays.js';
import { openSettings } from './settings.js';

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'openai/gpt-5.4-mini',
  temperature: 0.7,
};

const app = document.getElementById('app');

const state = {
  view: 'welcome',
  settings: { ...DEFAULT_SETTINGS },
  session: null,
  pendingDoc: null,
  mode: 'quiz',
  loading: null,
  error: '',
  cancelled: false,
  sending: false,
  mathField: null,
  grading: false,
};

const persist = debounce(() => {
  saveState({ settings: state.settings, session: state.session }).catch(() => {});
}, 220);

function persistNow() {
  saveState({ settings: state.settings, session: state.session }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function boot() {
  const stored = await loadState().catch(() => null);
  if (stored?.settings) state.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  if (stored?.session?.questions?.length) state.session = stored.session;

  if (state.session?.submitted) {
    state.view = 'results';
  } else if (state.session) {
    const remaining = state.session.deadline - Date.now();
    if (remaining <= 0) {
      await submitSession(true);
    } else {
      state.view = 'quiz';
      state.session.index = clamp(Number(state.session.index) || 0, 0, state.session.questions.length - 1);
    }
  }

  render();
  window.setInterval(tick, 500);
  loadMathQuill().catch(() => {});
}

function tick() {
  if (state.view !== 'quiz' || !state.session || state.session.submitted) return;
  const remaining = Math.max(0, Math.ceil((state.session.deadline - Date.now()) / 1000));
  const timer = document.getElementById('timer');
  if (timer) {
    const text = timer.querySelector('.timer-text');
    if (text) text.textContent = clockLabel(remaining);
    timer.classList.toggle('urgent', remaining <= 300);
  }
  if (remaining <= 0) submitSession(true);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  state.mathField = null;
  switch (state.view) {
    case 'welcome':
      renderWelcome();
      break;
    case 'mode':
      renderMode();
      break;
    case 'loading':
      renderLoading();
      break;
    case 'quiz':
      renderQuiz();
      break;
    case 'results':
      renderResults();
      break;
    case 'error':
      renderError();
      break;
    default:
      renderWelcome();
  }
}

function hasKey() {
  return Boolean(state.settings.apiKey);
}

function renderKeyChip() {
  return `<button class="key-chip ${hasKey() ? 'ok' : ''}" id="key-chip" type="button" title="OpenRouter settings">
    ${icon('key', 15)}
    <span>${hasKey() ? esc(state.settings.model) : 'Add OpenRouter key'}</span>
  </button>`;
}

function renderWelcome() {
  app.innerHTML = `
    <main class="screen welcome-screen">
      <div class="welcome-top">
        <div class="wordmark"><span class="wordmark-mark">Σ</span> QuizForge</div>
        ${renderKeyChip()}
      </div>

      <div class="welcome-center">
        <button class="upload-card" id="upload-card" type="button" aria-label="Upload an attachment to make a quiz">
          <span class="plus-orb">${icon('plus', 30)}</span>
          <span class="upload-title">Upload an attachment<br />to make a quiz</span>
          <span class="upload-types">PDF · DOCX · PPTX · image · text</span>
        </button>
        <p class="welcome-foot">Every question is written for your attachment. Your key stays on this device.</p>
      </div>

      <div class="welcome-bottom">
        <span class="powered">Powered by ${icon('sparkle', 13)} OpenRouter</span>
        <span class="powered-dot">·</span>
        <span class="powered">LaTeX by KaTeX &amp; MathQuill</span>
      </div>
    </main>`;

  document.getElementById('upload-card').addEventListener('click', handleUpload);
  document.getElementById('key-chip').addEventListener('click', () => openSettingsFlow(false));
}

function renderMode() {
  const doc = state.pendingDoc;
  if (!doc) {
    state.view = 'welcome';
    return renderWelcome();
  }
  const quiz = planFor('quiz');
  const test = planFor('test');

  app.innerHTML = `
    <main class="screen mode-screen">
      <div class="welcome-top">
        <div class="wordmark"><span class="wordmark-mark">Σ</span> QuizForge</div>
        ${renderKeyChip()}
      </div>

      <div class="mode-card">
        <div class="file-row">
          <span class="file-orb">${icon(isImage(doc.name) ? 'image' : 'file', 22)}</span>
          <span class="file-info">
            <strong>${esc(doc.name)}</strong>
            <span>${bytesLabel(doc.size) || 'attachment'}${hasKey() ? ` · ${esc(state.settings.model)}` : ''}</span>
          </span>
          <button class="link" id="change-file" type="button">Change</button>
        </div>

        <h1>How long is this one?</h1>
        <p class="mode-sub">Pick a format. The timer starts as soon as the quiz is ready.</p>

        <div class="mode-options" role="radiogroup" aria-label="Quiz format">
          <button class="mode-option ${state.mode === 'quiz' ? 'selected' : ''}" data-mode="quiz" type="button" role="radio" aria-checked="${state.mode === 'quiz'}">
            <span class="mode-name">Quiz</span>
            <span class="mode-count">${quiz.total} questions</span>
            <span class="mode-time">${icon('clock', 14)} ${Math.round(quiz.seconds / 60)} minutes</span>
          </button>
          <button class="mode-option ${state.mode === 'test' ? 'selected' : ''}" data-mode="test" type="button" role="radio" aria-checked="${state.mode === 'test'}">
            <span class="mode-name">Test</span>
            <span class="mode-count">${test.total} questions</span>
            <span class="mode-time">${icon('clock', 14)} ${Math.round(test.seconds / 60)} minutes</span>
          </button>
        </div>

        <button class="btn primary wide lg" id="start-quiz" type="button">
          ${icon('sparkle', 17)} Generate ${state.mode === 'quiz' ? 'quiz' : 'test'}
        </button>
        <p class="fineprint center">Questions are written by ${hasKey() ? esc(state.settings.model) : 'OpenRouter'} from your attachment.</p>
      </div>
    </main>`;

  document.getElementById('key-chip').addEventListener('click', () => openSettingsFlow(false));
  document.getElementById('change-file').addEventListener('click', () => {
    state.pendingDoc = null;
    state.view = 'welcome';
    render();
  });
  for (const option of app.querySelectorAll('[data-mode]')) {
    option.addEventListener('click', () => {
      state.mode = option.dataset.mode;
      renderMode();
    });
  }
  document.getElementById('start-quiz').addEventListener('click', startGeneration);
}

function isImage(name) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(name || ''));
}

function renderLoading() {
  const doc = state.pendingDoc;
  app.innerHTML = `
    <main class="screen loading-screen">
      <div class="loading-card">
        <div class="loading-file">${icon('file', 16)} <span>${esc(doc?.name || 'Your attachment')}</span></div>
        <h1>Building your ${state.mode === 'test' ? 'test' : 'quiz'}</h1>
        <ol class="stages">
          <li data-stage="reading"><span class="stage-dot"></span><span class="stage-name">Reading the attachment</span><span class="stage-detail"></span></li>
          <li data-stage="planning"><span class="stage-dot"></span><span class="stage-name">Planning the questions</span><span class="stage-detail"></span></li>
          <li data-stage="writing"><span class="stage-dot"></span><span class="stage-name">Writing the questions</span><span class="stage-detail"></span></li>
          <li data-stage="assembling"><span class="stage-dot"></span><span class="stage-name">Assembling the quiz</span><span class="stage-detail"></span></li>
        </ol>
        <div class="load-track"><i id="load-bar-fill"></i><span class="load-shimmer"></span></div>
        <div class="load-meta"><span id="load-note">Opening the attachment…</span><span id="load-pct">0%</span></div>
        <button class="link center" id="cancel-load" type="button">Cancel</button>
      </div>
    </main>`;
  document.getElementById('cancel-load').addEventListener('click', () => {
    state.cancelled = true;
    const button = document.getElementById('cancel-load');
    if (button) {
      button.disabled = true;
      button.textContent = 'Stopping after this batch…';
    }
  });
  applyLoading();
}

function applyLoading() {
  const loading = state.loading || { phase: 'reading', percent: 4, written: 0, total: 0, note: '' };
  const order = ['reading', 'planning', 'writing', 'assembling'];
  const current = Math.max(0, order.indexOf(loading.phase));

  for (const row of app.querySelectorAll('[data-stage]')) {
    const index = order.indexOf(row.dataset.stage);
    row.classList.toggle('done', index < current);
    row.classList.toggle('active', index === current);
    row.classList.toggle('pending', index > current);
    const detail = row.querySelector('.stage-detail');
    if (detail) {
      detail.textContent =
        row.dataset.stage === 'writing' && loading.written != null
          ? `${loading.written} of ${loading.total || '?'}`
          : '';
    }
  }

  const fill = document.getElementById('load-bar-fill');
  if (fill) fill.style.width = `${clamp(loading.percent || 0, 0, 100)}%`;
  const pct = document.getElementById('load-pct');
  if (pct) pct.textContent = `${Math.round(clamp(loading.percent || 0, 0, 100))}%`;
  const note = document.getElementById('load-note');
  if (note && loading.note) note.textContent = loading.note;
}

function updateLoading(patch) {
  state.loading = { ...(state.loading || {}), ...patch };
  applyLoading();
}

function renderError() {
  const message = state.error || 'Something went wrong.';
  const keyIssue = /key|401|403|credit|model/i.test(message);
  const creditIssue = /402|credit|can only afford/i.test(message);
  app.innerHTML = `
    <main class="screen error-screen">
      <div class="error-card">
        <span class="error-orb">${icon('alert', 24)}</span>
        <h1>That didn’t work</h1>
        <p class="error-message">${esc(message)}</p>
        <div class="error-actions">
          <button class="btn primary" id="retry" type="button">Try again</button>
          <button class="btn ghost" id="another" type="button">Choose another file</button>
          ${keyIssue ? `<button class="btn ghost" id="open-key" type="button">Check key &amp; model</button>` : ''}
          ${creditIssue ? `<button class="btn ghost" id="open-credits" type="button">Add OpenRouter credits</button>` : ''}
        </div>
      </div>
    </main>`;

  document.getElementById('retry').addEventListener('click', () => {
    state.view = 'mode';
    render();
  });
  document.getElementById('another').addEventListener('click', () => {
    state.pendingDoc = null;
    state.view = 'welcome';
    render();
  });
  document.getElementById('open-key')?.addEventListener('click', () => openSettingsFlow(false));
  document.getElementById('open-credits')?.addEventListener('click', () => {
    openExternal('https://openrouter.ai/settings/credits').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

function currentQuestion() {
  const session = state.session;
  return session?.questions?.[session.index];
}

function answersCount() {
  const session = state.session;
  if (!session) return 0;
  return session.questions.filter((question) => Boolean(session.answers?.[question.id])).length;
}

function renderQuiz() {
  const session = state.session;
  if (!session || !session.questions.length) {
    state.view = 'welcome';
    return renderWelcome();
  }
  state.mathField = null;
  const question = currentQuestion();
  const remaining = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
  const answered = answersCount();

  const segments = session.questions
    .map((item, index) => {
      const isAnswered = Boolean(session.answers?.[item.id]);
      return `<button class="seg ${isAnswered ? 'answered' : ''} ${index === session.index ? 'current' : ''}" data-index="${index}" type="button" title="Question ${index + 1}${isAnswered ? ' — answered' : ''}" aria-label="Go to question ${index + 1}${isAnswered ? ', answered' : ', unanswered'}"></button>`;
    })
    .join('');

  app.innerHTML = `
    <main class="screen quiz-screen">
      <header class="quiz-head">
        <div class="quiz-title">
          <span class="mode-pill">${session.mode === 'test' ? 'Test' : 'Quiz'}</span>
          <span class="quiz-sub">${session.questions.length} questions${session.docName ? ` · ${esc(session.docName)}` : ''}</span>
        </div>
        <div class="timer ${remaining <= 300 ? 'urgent' : ''}" id="timer">
          ${icon('clock', 17)}
          <span class="timer-text">${clockLabel(remaining)}</span>
        </div>
        <div class="quiz-head-actions">
          <button class="btn primary submit-top" id="submit-quiz" type="button">Submit</button>
        </div>
      </header>

      <div class="segbar-wrap">
        <div class="segbar" id="segbar">${segments}</div>
        <div class="segmeta">
          <span>Question ${session.index + 1} of ${session.questions.length}</span>
          <span>${answered} answered · ${session.questions.length - answered} left</span>
        </div>
      </div>

      <div class="question-stage">
        <article class="question-card">
          <div class="question-meta">
            <span class="chip topic">${esc(question.topic)}</span>
            <span class="chip difficulty ${esc(question.difficulty)}">${esc(question.difficulty)}</span>
            <span class="chip ghost">${esc(typeLabel(question.type))}</span>
          </div>
          <div class="stem" id="stem"></div>
          <div class="graph-slot" id="graph-slot" hidden></div>

          <div class="answer-box" id="answer-box">
            <button class="send" id="send" type="button" title="Submit answer (Enter)" aria-label="Submit answer" disabled>${icon('send', 20)}</button>
            <div class="mq-host" id="mq"></div>
            <div class="latex-line">
              <span class="latex-tag">LaTeX</span>
              <code id="latex-live" class="empty">your answer appears here</code>
            </div>
            <div class="math-tools" id="math-tools">
              ${MATH_TOOLS.map((tool) => `<button type="button" class="tool" data-cmd="${esc(tool.cmd)}" title="${esc(tool.title)}">${esc(tool.label)}</button>`).join('')}
            </div>
          </div>

          <div class="question-actions">
            <button class="btn ghost" id="prev" type="button" ${session.index === 0 ? 'disabled' : ''}>${icon('arrowLeft', 16)} Previous</button>
            <div class="actions-right">
              ${question.hint ? `<button class="btn ghost" id="hint" type="button">Hint</button>` : ''}
              <button class="btn primary ${answered === session.questions.length ? 'ready' : ''}" id="next" type="button">
                ${session.index === session.questions.length - 1 ? 'Review &amp; submit' : 'Next'} ${icon('arrowRight', 16)}
              </button>
            </div>
          </div>
          <p class="hint-line" id="hint-line" hidden>${esc(question.hint || '')}</p>
        </article>
      </div>
    </main>`;

  renderRich(document.getElementById('stem'), question.stem);
  if (question.graph) {
    const slot = document.getElementById('graph-slot');
    slot.hidden = false;
    renderGraph(slot, question.graph);
  }

  mountAnswer(question);
  bindQuizEvents();
}

function mountAnswer(question) {
  const host = document.getElementById('mq');
  if (!host) return;
  const session = state.session;
  const initial = session.answers?.[question.id]?.latex ?? session.drafts?.[question.id] ?? '';
  updateLatexLine(initial);

  createMathField(host, {
    initial,
    onChange: (latex) => {
      session.drafts[question.id] = latex;
      updateLatexLine(latex);
      updateSendState();
      persist();
    },
    onSubmit: () => submitCurrentAnswer(),
  })
    .then((field) => {
      state.mathField = field;
      updateSendState();
      const textarea = host.querySelector('textarea');
      textarea?.focus({ preventScroll: true });
    })
    .catch((error) => {
      // Graceful fallback if the MathQuill bundle cannot start.
      console.warn('MathQuill unavailable, using a plain LaTeX input.', error);
      host.classList.remove('mq-editable-field', 'mq-math-mode', 'mq-focused');
      host.innerHTML = '';
      const input = document.createElement('input');
      input.className = 'plain-answer';
      input.placeholder = 'Type LaTeX, e.g. \\frac{1}{2}';
      input.value = initial;
      input.addEventListener('input', () => {
        session.drafts[question.id] = input.value;
        updateLatexLine(input.value);
        updateSendState();
        persist();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitCurrentAnswer();
        }
      });
      host.replaceChildren(input);
      state.mathField = { latex: () => input.value, cmd: () => {} };
      updateSendState();
      input.focus({ preventScroll: true });
    });
}

function updateLatexLine(latex) {
  const code = document.getElementById('latex-live');
  if (!code) return;
  const value = String(latex || '').trim();
  code.textContent = value || 'your answer appears here';
  code.classList.toggle('empty', !value);
}

function updateSendState() {
  const send = document.getElementById('send');
  if (!send) return;
  const value = state.mathField?.latex()?.trim() || '';
  send.disabled = !value;
}

function bindQuizEvents() {
  const session = state.session;

  for (const segment of app.querySelectorAll('.seg')) {
    segment.addEventListener('click', () => {
      stashDraft();
      session.index = Number(segment.dataset.index);
      persistNow();
      renderQuiz();
    });
  }

  document.getElementById('prev').addEventListener('click', () => {
    if (session.index === 0) return;
    stashDraft();
    session.index -= 1;
    persistNow();
    renderQuiz();
  });

  document.getElementById('next').addEventListener('click', () => {
    if (session.index === session.questions.length - 1) {
      requestSubmit();
      return;
    }
    stashDraft();
    session.index += 1;
    persistNow();
    renderQuiz();
  });

  document.getElementById('hint')?.addEventListener('click', () => {
    const line = document.getElementById('hint-line');
    if (!line) return;
    line.hidden = !line.hidden;
  });

  document.getElementById('send').addEventListener('click', () => submitCurrentAnswer());
  document.getElementById('submit-quiz').addEventListener('click', () => requestSubmit());

  for (const tool of app.querySelectorAll('.tool')) {
    tool.addEventListener('mousedown', (event) => event.preventDefault());
    tool.addEventListener('click', () => {
      state.mathField?.focus?.();
      state.mathField?.cmd?.(tool.dataset.cmd);
      const host = document.getElementById('mq');
      host?.querySelector('textarea')?.focus({ preventScroll: true });
      updateLatexLine(state.mathField?.latex() || '');
      updateSendState();
      persist();
    });
  }
}

function stashDraft() {
  const question = currentQuestion();
  if (!question || !state.mathField) return;
  state.session.drafts[question.id] = state.mathField.latex();
}

function markCurrentAnswered() {
  const segment = app.querySelector(`.seg[data-index="${state.session.index}"]`);
  segment?.classList.add('answered');
  const meta = document.querySelector('.segmeta span:last-child');
  const answered = answersCount();
  if (meta) meta.textContent = `${answered} answered · ${state.session.questions.length - answered} left`;
}

async function submitCurrentAnswer() {
  if (state.sending) return;
  const session = state.session;
  const question = currentQuestion();
  if (!session || !question) return;

  const latex = (state.mathField?.latex() || session.drafts?.[question.id] || '').trim();
  if (!latex) {
    const box = document.getElementById('answer-box');
    box?.classList.add('shake');
    window.setTimeout(() => box?.classList.remove('shake'), 420);
    return;
  }

  state.sending = true;
  session.answers[question.id] = { latex, at: Date.now() };
  session.drafts[question.id] = latex;
  markCurrentAnswered();
  persistNow();

  const send = document.getElementById('send');
  send?.classList.add('sent');
  const box = document.getElementById('answer-box');
  box?.classList.add('answered');

  const target = nextUnansweredAfter(session.index);
  await sleep(200);
  state.sending = false;
  if (state.view !== 'quiz' || session.submitted) return;

  if (target !== null) {
    session.index = target;
    persistNow();
    renderQuiz();
  } else {
    renderQuiz();
    if (answersCount() === session.questions.length) {
      toast('All questions answered — submit when you’re ready.');
    }
  }
}

function nextUnansweredAfter(index) {
  const session = state.session;
  for (let i = index + 1; i < session.questions.length; i += 1) {
    if (!session.answers?.[session.questions[i].id]) return i;
  }
  for (let i = 0; i < session.questions.length; i += 1) {
    if (i !== index && !session.answers?.[session.questions[i].id]) return i;
  }
  return null;
}

function typeLabel(type) {
  if (type === 'word') return 'Word problem';
  if (type === 'graph') return 'Graph';
  return 'Mathematics';
}

async function requestSubmit() {
  const session = state.session;
  if (!session || session.submitted) return;
  stashDraft();
  const unanswered = session.questions.length - answersCount();
  const confirmed = await confirmDialog({
    title: unanswered > 0 ? 'Submit with unanswered questions?' : 'Submit your quiz?',
    body:
      unanswered > 0
        ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} still unanswered. You can’t change answers after submitting.`
        : 'You answered every question. Ready to see how you did?',
    confirmLabel: unanswered > 0 ? 'Submit anyway' : 'Submit',
    cancelLabel: 'Keep working',
    danger: unanswered > 0,
  });
  if (confirmed) await submitSession(false);
}

async function submitSession(auto) {
  const session = state.session;
  if (!session || session.submitted) return;

  for (const overlay of document.querySelectorAll('.overlay')) overlay.remove();
  for (const toast of document.querySelectorAll('#toasts .toast')) toast.remove();
  session.submitted = true;
  session.submittedAt = Date.now();
  session.elapsedSeconds = Math.max(1, Math.round((session.submittedAt - session.startedAt) / 1000));
  session.autoSubmitted = Boolean(auto);
  session.grades = localGrades(session.questions, session.answers);
  session.aiGraded = false;
  state.mathField = null;
  state.view = 'results';
  persistNow();
  render();
  if (auto) toast('Time’s up — your quiz was submitted.', 'warn', 5200);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function renderResults() {
  const session = state.session;
  if (!session?.questions?.length) {
    state.view = 'welcome';
    return renderWelcome();
  }

  // Re-check old sessions with the current grading rules (the solution is
  // authoritative when the stored answer key disagrees with it).
  if (session.submitted) {
    const local = localGrades(session.questions, session.answers);
    if (!session.aiGraded) {
      session.grades = local;
    } else {
      const merged = { ...local, ...(session.grades || {}) };
      for (const [id, grade] of Object.entries(session.grades || {})) {
        if (local[id]?.correct === true && local[id].matchedAlternate && grade?.correct === false) {
          merged[id] = {
            correct: true,
            verdict: 'correct',
            detail: local[id].detail,
            source: 'ai',
            matchedAlternate: true,
            keyMismatch: true,
          };
        }
      }
      session.grades = merged;
    }
  }

  const score = scoreOf(session.grades, session.questions.length);
  const review = Object.values(session.grades || {}).filter((grade) => grade.correct === null).length;
  const unanswered = session.questions.length - answersCount();
  const hasKeyNow = hasKey();
  const canGrade = hasKeyNow && (review > 0 || unanswered > 0) && !state.grading;

  app.innerHTML = `
    <main class="screen results-screen">
      <div class="results-top">
        <div class="wordmark"><span class="wordmark-mark">Σ</span> QuizForge</div>
        ${renderKeyChip()}
      </div>

      <div class="results-inner">
        <section class="result-hero">
          <div class="score-ring" style="--value:${score.percent}">
            <div class="score-ring-inner">
              <strong>${score.percent}<span>%</span></strong>
              <span class="score-ring-label">${session.grades && session.aiGraded ? 'AI-graded' : 'auto-checked'}</span>
            </div>
          </div>
          <div class="result-copy">
            <div class="result-kicker">
              <span class="mode-pill">${session.mode === 'test' ? 'Test' : 'Quiz'}</span>
              ${session.autoSubmitted ? '<span class="chip warn">time expired</span>' : ''}
            </div>
            <h1>${score.correct} of ${session.questions.length} correct</h1>
            <p class="result-sub">
              ${review > 0 ? `${review} need${review === 1 ? 's' : ''} a closer look` : 'No answers need a second look'}
              ${unanswered > 0 ? ` · ${unanswered} unanswered` : ''}
              · ${elapsedLabel(session.elapsedSeconds || 0)} used
            </p>
            ${score.decided < session.questions.length && !session.aiGraded ? '<p class="result-note">Typed symbolic answers are compared literally. Use AI grading for a fairer check.</p>' : ''}
          </div>
          <div class="result-actions">
            ${hasKeyNow ? `<button class="btn ${canGrade ? 'primary' : 'ghost'}" id="grade-ai" type="button" ${state.grading ? 'disabled' : ''}>${icon('sparkle', 16)} ${state.grading ? 'Grading…' : session.aiGraded ? 'Re-grade with AI' : 'Grade with AI'}</button>` : ''}
            <button class="btn ghost" id="retake" type="button">${icon('refresh', 15)} Retake</button>
            <button class="btn ghost" id="new-quiz" type="button">New quiz</button>
          </div>
        </section>

        <div class="review-head">
          <h2>Review</h2>
          <span class="review-sub">${session.questions.length} questions · ${session.mode === 'test' ? '40 min test' : '20 min quiz'}${session.docName ? ` · ${esc(session.docName)}` : ''}</span>
        </div>
        <section class="review-list" id="review-list"></section>
      </div>
    </main>`;

  document.getElementById('key-chip').addEventListener('click', () => openSettingsFlow(false));
  document.getElementById('retake').addEventListener('click', retake);
  document.getElementById('new-quiz').addEventListener('click', newQuiz);
  document.getElementById('grade-ai')?.addEventListener('click', runAiGrading);

  const list = document.getElementById('review-list');
  session.questions.forEach((question, index) => {
    list.appendChild(reviewCard(question, index, session));
  });
}

function reviewCard(question, index, session) {
  const grade = session.grades?.[question.id];
  const answerLatex = session.answers?.[question.id]?.latex || '';
  const mismatch = answerKeyMismatch(question);
  let verdict = 'review';
  if (!answerLatex) verdict = 'blank';
  else if (grade?.correct === true) verdict = 'correct';
  else if (grade?.correct === false) verdict = 'incorrect';

  const verdictLabel = {
    correct: 'Correct',
    incorrect: 'Incorrect',
    review: 'Check',
    blank: 'No answer',
  }[verdict];

  const card = document.createElement('article');
  card.className = 'review-card';
  card.innerHTML = `
    <div class="review-head-row">
      <span class="review-number">${index + 1}</span>
      <span class="chip topic">${esc(question.topic)}</span>
      <span class="chip difficulty ${esc(question.difficulty)}">${esc(question.difficulty)}</span>
      <span class="verdict ${verdict}">${verdictLabel}</span>
    </div>
    <div class="review-stem"></div>
    <div class="review-graph"></div>
    <div class="answer-compare">
      <div class="answer-col">
        <span class="answer-label">Your answer</span>
        <div class="answer-value your-answer"></div>
      </div>
      <div class="answer-col">
        <span class="answer-label">${mismatch ? 'Answer · from solution' : 'Answer'}</span>
        <div class="answer-value correct-answer"></div>
      </div>
    </div>
    ${grade?.detail ? `<p class="grade-feedback">${esc(grade.detail)}</p>` : ''}
    <details class="solution">
      <summary>Worked solution</summary>
      <ol class="solution-steps"></ol>
    </details>`;

  renderRich(card.querySelector('.review-stem'), question.stem);
  if (question.graph) {
    renderGraph(card.querySelector('.review-graph'), question.graph);
  } else {
    card.querySelector('.review-graph')?.remove();
  }

  const your = card.querySelector('.your-answer');
  if (answerLatex) renderMath(your, answerLatex, { display: true });
  else your.innerHTML = '<span class="no-answer">—</span>';

  renderMath(card.querySelector('.correct-answer'), mismatch ? mismatch.latex : question.answer.latex, { display: true });

  if (mismatch) {
    const note = document.createElement('p');
    note.className = 'key-note';
    const stored = document.createElement('span');
    stored.className = 'key-note-math';
    renderMath(stored, question.answer.latex, { display: false });
    note.append(
      document.createTextNode('The stored answer key was '),
      stored,
      document.createTextNode(' — the worked solution gives the answer above. Either form is accepted.'),
    );
    card.querySelector('.answer-compare')?.after(note);
  }

  const steps = card.querySelector('.solution-steps');
  for (const step of question.solution || []) {
    const li = document.createElement('li');
    renderRich(li, step);
    steps.appendChild(li);
  }
  if (!question.solution?.length) card.querySelector('.solution')?.remove();

  return card;
}

async function runAiGrading() {
  if (state.grading) return;
  const session = state.session;
  if (!session) return;
  state.grading = true;
  renderResults();
  try {
    const local = localGrades(session.questions, session.answers);
    const grades = await gradeWithAI({
      questions: session.questions,
      answers: session.answers,
      settings: state.settings,
    });
    const merged = { ...local, ...grades };
    // Never let the AI flip an answer that matches the worked solution when the
    // stored key was the inconsistent one.
    for (const [id, grade] of Object.entries(grades)) {
      const localGrade = local[id];
      if (localGrade?.correct === true && localGrade.matchedAlternate && grade.correct === false) {
        merged[id] = {
          correct: true,
          verdict: 'correct',
          detail: localGrade.detail,
          source: 'ai',
          matchedAlternate: true,
          keyMismatch: true,
        };
      }
    }
    session.grades = merged;
    session.aiGraded = true;
    persistNow();
    const judged = Object.keys(grades).length;
    toast(`Graded ${judged} answer${judged === 1 ? '' : 's'} with AI.`);
  } catch (error) {
    toast(error?.message || 'AI grading failed.', 'error', 5600);
  } finally {
    state.grading = false;
    renderResults();
  }
}

function retake() {
  const session = state.session;
  if (!session) return;
  const plan = planFor(session.mode);
  session.answers = {};
  session.drafts = {};
  session.grades = null;
  session.aiGraded = false;
  session.submitted = false;
  session.submittedAt = null;
  session.autoSubmitted = false;
  session.elapsedSeconds = 0;
  session.startedAt = Date.now();
  session.deadline = Date.now() + plan.seconds * 1000;
  session.duration = plan.seconds;
  session.index = 0;
  session.retakes = (session.retakes || 0) + 1;
  state.view = 'quiz';
  persistNow();
  render();
}

async function newQuiz() {
  const ok = await confirmDialog({
    title: 'Start a new quiz?',
    body: 'This clears the current quiz and its answers. Your settings stay the same.',
    confirmLabel: 'Start over',
    cancelLabel: 'Stay',
    danger: true,
  });
  if (!ok) return;
  state.session = null;
  state.pendingDoc = null;
  state.view = 'welcome';
  state.grading = false;
  persistNow();
  render();
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

async function handleUpload() {
  let picked;
  try {
    picked = await pickAttachment();
  } catch (error) {
    toast(error?.message || 'Could not open that file.', 'error', 5000);
    return;
  }
  await acceptAttachment(picked);
}

async function acceptAttachment(picked) {
  if (!picked) return;
  if (picked.size > 40 * 1024 * 1024) {
    toast('That file is over 40 MB. Try a smaller attachment.', 'error', 5000);
    return;
  }

  if (!hasKey()) {
    const result = await openSettings({ settings: state.settings, required: true });
    if (!result.saved) {
      toast('Add an OpenRouter key to write questions.', 'warn', 4200);
      return;
    }
    state.settings = { ...state.settings, ...result.settings };
    persistNow();
  }

  state.pendingDoc = picked;
  state.mode = 'quiz';
  state.view = 'mode';
  render();
}

async function openSettingsFlow(required) {
  const result = await openSettings({ settings: state.settings, required });
  if (!result.saved) return false;
  state.settings = { ...state.settings, ...result.settings };
  persistNow();
  render();
  return true;
}

function createSession(questions, mode) {
  const plan = planFor(mode);
  return {
    id: uid('s'),
    docName: state.pendingDoc?.name || '',
    mode,
    questions,
    answers: {},
    drafts: {},
    index: 0,
    startedAt: Date.now(),
    deadline: Date.now() + plan.seconds * 1000,
    duration: plan.seconds,
    submitted: false,
    submittedAt: null,
    autoSubmitted: false,
    elapsedSeconds: 0,
    grades: null,
    aiGraded: false,
    retakes: 0,
  };
}

async function startGeneration() {
  if (!state.pendingDoc) return;
  if (!hasKey()) {
    const saved = await openSettingsFlow(true);
    if (!saved) return;
  }

  const plan = planFor(state.mode);
  state.cancelled = false;
  state.view = 'loading';
  state.loading = { phase: 'reading', percent: 5, written: 0, total: plan.total, note: 'Opening the attachment…' };
  render();

  try {
    await sleep(160);
    const doc = await extractAttachment(state.pendingDoc);
    updateLoading({
      phase: 'planning',
      percent: 14,
      note: `${doc.words ? `${doc.words.toLocaleString()} words` : 'Attachment'} read · choosing topics`,
    });
    await sleep(420);

    const result = await generateQuiz({
      doc,
      mode: state.mode,
      settings: state.settings,
      onProgress: (progress) => {
        const percent = 16 + Math.round((progress.written / Math.max(1, progress.total)) * 76);
        updateLoading({
          phase: 'writing',
          percent,
          written: progress.written,
          total: progress.total,
          note: progress.note || 'Writing questions…',
        });
      },
      shouldStop: () => state.cancelled,
    });

    if (state.cancelled) {
      state.view = 'mode';
      state.cancelled = false;
      render();
      toast('Generation cancelled.');
      return;
    }

    updateLoading({ phase: 'assembling', percent: 97, note: 'Putting the quiz together…' });
    await sleep(420);

    state.session = createSession(result.questions, state.mode);
    state.pendingDoc = null;
    state.view = 'quiz';
    persistNow();
    render();

    if (result.questions.length < plan.total) {
      toast(
        `Wrote ${result.questions.length} of ${plan.total} questions. Retake to try for more, or use a richer attachment.`,
        'warn',
        5600,
      );
    }
  } catch (error) {
    state.error = error?.message || String(error);
    if (state.cancelled) {
      state.cancelled = false;
      state.view = 'mode';
      render();
      toast('Generation cancelled.');
      return;
    }
    state.view = 'error';
    render();
  }
}

// Native drag-and-drop: dropping a file on the welcome screen starts the flow.
if (isTauri) {
  import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) => {
      getCurrentWebview().onDragDropEvent(async (event) => {
        const payload = event.payload || {};
        if (payload.type === 'enter' || payload.type === 'over') {
          document.body.classList.add('dragging');
          return;
        }
        document.body.classList.remove('dragging');
        if (payload.type !== 'drop') return;
        if (state.view !== 'welcome' || !payload.paths?.length) return;
        try {
          const file = await invoke('read_file_bytes', { path: payload.paths[0] });
          await acceptAttachment({
            name: file.name,
            size: file.size,
            bytes: base64ToBytes(file.data),
          });
        } catch (error) {
          toast(error?.message || 'Could not read that file.', 'error', 5000);
        }
      });
    })
    .catch(() => {});
}
