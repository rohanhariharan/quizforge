import { chat } from './llm.js';
import { SYSTEM_PROMPT, TOPIC_SYSTEM, batchPrompt, topicPrompt } from './prompts.js';
import {
  BATCH_SIZE,
  coveredList,
  isDuplicate,
  normalizeQuestion,
  parseModelJson,
  planFor,
} from './questions.js';
import { sleep } from './util.js';

const MAX_SOURCES = 8;
const CHUNK_CHARS = 8200;

function chunkText(text) {
  const clean = String(text || '').trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
        chunks.push(paragraph.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }
    if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

function buildSources(doc) {
  if (Array.isArray(doc.images) && doc.images.length) {
    return [{ text: doc.text || '', images: doc.images }];
  }
  const chunks = chunkText(doc.text);
  if (!chunks.length) return [{ text: '', images: [] }];
  if (chunks.length <= MAX_SOURCES) return chunks.map((text) => ({ text, images: [] }));

  const sampled = [];
  for (let i = 0; i < MAX_SOURCES; i += 1) {
    const index = Math.floor((i * chunks.length) / MAX_SOURCES);
    sampled.push({ text: chunks[index], images: [] });
  }
  return sampled;
}

function fatal(message) {
  return /HTTP (401|403)/.test(message) || /API key/i.test(message) || /No model/i.test(message);
}

// A compact sample of the source, used only to map topics. The generation
// batches never see the source's own questions, so they cannot copy them.
function planSource(doc) {
  if (Array.isArray(doc.images) && doc.images.length) {
    return { text: doc.text || '', images: doc.images };
  }
  const chunks = chunkText(doc.text);
  if (!chunks.length) return { text: '', images: [] };
  const picks =
    chunks.length <= 4
      ? chunks
      : [
          chunks[0],
          chunks[Math.floor(chunks.length / 3)],
          chunks[Math.floor((2 * chunks.length) / 3)],
          chunks[chunks.length - 1],
        ];
  let text = picks
    .map((chunk, index) => `[part ${index + 1} of ${picks.length}]\n${chunk}`)
    .join('\n\n');
  if (text.length > 18_000) text = text.slice(0, 18_000);
  return { text, images: [] };
}

async function buildTopicPlan({ doc, settings, shouldStop, mode, total }) {
  if (shouldStop?.()) return null;
  const source = planSource(doc);
  const reply = await chat({
    settings,
    system: TOPIC_SYSTEM,
    user: topicPrompt({ docName: doc.name, source, mode, total }),
    maxTokens: 3000,
    images: source.images,
  });
  if (shouldStop?.()) return null;

  const parsed = parseModelJson(reply.text);
  const topics = (Array.isArray(parsed?.topics) ? parsed.topics : [])
    .map((topic) => {
      const facts = topic?.keyFacts ?? topic?.key_facts;
      return {
        name: String(topic?.name ?? '').trim(),
        skills: (Array.isArray(topic?.skills) ? topic.skills : [])
          .map((skill) => String(skill).trim())
          .filter(Boolean)
          .slice(0, 4),
        keyFacts: (Array.isArray(facts) ? facts : [])
          .map((fact) => String(fact).trim())
          .filter(Boolean)
          .slice(0, 4),
      };
    })
    .filter((topic) => topic.name)
    .slice(0, 16);

  if (!topics.length) throw new Error('The topic map came back empty.');
  return {
    subject: String(parsed?.subject || doc.name).slice(0, 80),
    level: String(parsed?.level || '').slice(0, 40),
    topics,
  };
}

function stateStopped(shouldStop) {
  return Boolean(shouldStop?.());
}

export async function generateQuiz({ doc, mode, settings, onProgress, shouldStop }) {
  const plan = planFor(mode);
  const accepted = [];
  const notes = [];
  let rejected = 0;
  let cursor = 0;
  let stagnant = 0;
  let calls = 0;

  onProgress?.({ phase: 'planning', note: 'Mapping the topics in the source' });

  let topicPlan = null;
  try {
    topicPlan = await buildTopicPlan({ doc, settings, shouldStop, mode, total: plan.total });
  } catch (error) {
    notes.push(`Topic map unavailable: ${error?.message || error}`);
  }
  if (stateStopped(shouldStop)) return { questions: [], notes, rejected, stopped: true, requested: plan.total, seconds: plan.seconds };

  const sources = topicPlan ? [{ text: '', images: [] }] : buildSources(doc);
  if (topicPlan) {
    onProgress?.({
      phase: 'planning',
      note: `${topicPlan.topics.length} topics mapped — writing new questions`,
    });
  }

  const maxCalls = Math.ceil(plan.total / BATCH_SIZE) + 9;

  onProgress?.({
    phase: 'writing',
    written: 0,
    total: plan.total,
    batch: 0,
    note: 'Starting the first batch',
  });

  while (accepted.length < plan.total && calls < maxCalls) {
    if (shouldStop?.()) break;

    const want = Math.min(BATCH_SIZE, plan.total - accepted.length);
    const types = plan.types.slice(accepted.length, accepted.length + want);
    const difficulties = plan.difficulties.slice(accepted.length, accepted.length + want);
    const source = sources[cursor % sources.length];
    cursor += 1;

    const prompt = batchPrompt({
      docName: doc.name,
      source,
      sourceIndex: source.index ?? ((cursor - 1) % sources.length),
      sourceCount: sources.length,
      types,
      difficulties,
      covered: coveredList(accepted),
      mode,
      hasImages: Boolean(source.images?.length),
      plan: topicPlan,
    });

    let text = null;
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (shouldStop?.()) break;
      try {
        const reply = await chat({
          settings,
          system: SYSTEM_PROMPT,
          user: prompt,
          images: source.images,
        });
        text = reply.text;
        break;
      } catch (error) {
        lastError = error;
        if (fatal(error.message || '')) throw error;
        if (/429/.test(error.message || '')) await sleep(3500);
        else await sleep(1200);
      }
    }

    calls += 1;

    if (!text) {
      if (accepted.length === 0) throw lastError || new Error('The model did not answer.');
      notes.push(lastError?.message || 'One batch failed.');
      stagnant += 1;
      if (stagnant >= 2) break;
      continue;
    }

    const parsed = parseModelJson(text);
    const rows = Array.isArray(parsed?.questions)
      ? parsed.questions
      : Array.isArray(parsed)
        ? parsed
        : [];

    let added = 0;
    const cap = Math.min(plan.total, accepted.length + want);
    for (const row of rows) {
      if (accepted.length >= cap) break;

      const normalized = normalizeQuestion(row, {
        docId: doc.id,
        mode,
        model: settings.model,
      });
      if (!normalized.ok) {
        rejected += 1;
        continue;
      }
      const question = normalized.value;
      if (isDuplicate(question, accepted)) {
        rejected += 1;
        continue;
      }
      accepted.push(question);
      added += 1;
    }

    stagnant = added === 0 ? stagnant + 1 : 0;

    onProgress?.({
      phase: 'writing',
      written: accepted.length,
      total: plan.total,
      batch: calls,
      note:
        added === 0
          ? 'Refining the next batch'
          : `${accepted.length} of ${plan.total} questions written`,
    });

    if (stagnant >= 3) break;
  }

  accepted.forEach((question, index) => {
    question.number = index + 1;
  });

  if (!accepted.length) {
    throw new Error('The model did not produce any usable questions. Try a clearer attachment or another model.');
  }

  return {
    questions: accepted,
    notes,
    rejected,
    stopped: Boolean(shouldStop?.()),
    requested: plan.total,
    seconds: plan.seconds,
  };
}
