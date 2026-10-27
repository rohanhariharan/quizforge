// Attachment -> plain text (+ images for vision models).
// Everything runs in the webview so no native parsing crates are needed.

import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth/mammoth.browser.js';
import JSZip from 'jszip';
import { bytesToBase64 } from './bridge.js';
import { extOf } from './util.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_TEXT_CHARS = 320_000;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const KIND_BY_EXT = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  ipynb: 'notebook',
  html: 'html',
  htm: 'html',
  tex: 'tex',
  rtf: 'rtf',
};

export async function extractAttachment({ name, bytes }) {
  const ext = extOf(name);
  const warnings = [];
  let text = '';
  let pages = 0;
  let images = [];

  if (ext === 'pdf') {
    ({ text, pages } = await extractPdf(bytes, warnings));
  } else if (ext === 'docx') {
    text = await extractDocx(bytes, warnings);
  } else if (ext === 'pptx') {
    ({ text, pages } = await extractPptx(bytes, warnings));
  } else if (ext === 'ipynb') {
    text = extractNotebook(bytes, warnings);
  } else if (ext === 'html' || ext === 'htm') {
    text = extractHtml(bytes);
  } else if (ext === 'rtf') {
    text = extractRtf(bytes);
  } else if (IMAGE_EXT.has(ext)) {
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    images = [{ mime, data: bytesToBase64(bytes) }];
    warnings.push('Image attached — pick a vision-capable model to read it.');
  } else if (ext === 'doc') {
    throw new Error('Old .doc files are not supported. Save it as .docx or PDF first.');
  } else if (ext === 'xlsx' || ext === 'xls') {
    throw new Error('Spreadsheets are not supported yet. Export the sheet as CSV or PDF.');
  } else {
    text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  }

  text = cleanText(text);

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    warnings.push('The attachment is very long. Only the first part is used.');
  }

  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

  if (text.length < 25 && images.length === 0) {
    throw new Error(
      ext === 'pdf'
        ? 'No selectable text was found in this PDF. It may be scanned — try a screenshot of the pages, or a text-based version.'
        : 'No readable text was found in this attachment.',
    );
  }

  return {
    name,
    kind: KIND_BY_EXT[ext] || 'text',
    ext,
    size: bytes.length,
    text,
    pages,
    words,
    images,
    warnings,
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function extractPdf(bytes, warnings) {
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await task.promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(joinTextItems(content.items));
    page.cleanup?.();
  }
  const pages = doc.numPages;
  let text = pageTexts
    .map((pageText, index) => (pages > 1 ? `[page ${index + 1}]\n${pageText}` : pageText))
    .join('\n\n');

  const bare = text.replace(/\[page \d+\]/g, '').trim();
  if (bare.length < 150 && pages > 0) {
    warnings.push('This PDF has almost no selectable text — it may be a scan. Image-based pages need a vision model.');
  }

  await doc.destroy?.();
  return { text, pages };
}

function joinTextItems(items) {
  let out = '';
  let prevY = null;
  let prevEndX = null;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str) continue;
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    if (prevY !== null && Math.abs(y - prevY) > 2.5) {
      out += '\n';
      prevEndX = null;
    } else if (
      prevEndX !== null &&
      x - prevEndX > 2 &&
      !/\s$/.test(out) &&
      !/^[\s.,;:!?)\]]/.test(item.str)
    ) {
      out += ' ';
    }
    out += item.str;
    if (item.hasEOL) {
      out += '\n';
      prevY = null;
      prevEndX = null;
    } else {
      prevY = y;
      prevEndX = x + (item.width || 0);
    }
  }
  return out;
}

async function extractDocx(bytes, warnings) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await mammoth.extractRawText({ arrayBuffer });
  for (const message of result.messages || []) {
    if (message.type === 'warning' || message.type === 'error') {
      warnings.push(message.message);
    }
  }
  return result.value || '';
}

async function extractPptx(bytes, warnings) {
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slideFiles.length) {
    warnings.push('No slides were found in this file.');
    return { text: '', pages: 0 };
  }
  const chunks = [];
  for (const path of slideFiles) {
    const xml = await zip.file(path).async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const body = texts.filter(Boolean).join(' ');
    if (body) chunks.push(`[slide ${slideNumber(path)}]\n${body}`);
  }
  return { text: chunks.join('\n\n'), pages: slideFiles.length };
}

function slideNumber(path) {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m ? Number(m[1]) : 0;
}

function extractNotebook(bytes, warnings) {
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const cells = Array.isArray(data.cells) ? data.cells : [];
    return cells
      .map((cell) => {
        const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        return source.trim();
      })
      .filter(Boolean)
      .join('\n\n');
  } catch {
    warnings.push('This notebook could not be parsed as JSON.');
    return '';
  }
}

function extractHtml(bytes) {
  const html = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());
  return doc.body?.textContent || '';
}

function extractRtf(bytes) {
  const rtf = new TextDecoder().decode(bytes);
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*?[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}
