// Reviewed, non-personal educational excerpts only. No network, OCR, embeddings
// or model-selected file paths are involved in this first retrieval adapter.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 256 * 1024;
const focuses = ['balanced', 'language', 'creative', 'physical', 'discovery', 'social'];
const keywords = {
  language: ['language', 'story', 'stories', 'reading', 'literacy', 'speaking', 'listening'],
  creative: ['creative', 'art', 'music', 'drawing', 'dance', 'imagination'],
  physical: ['physical', 'movement', 'motor', 'balance', 'outdoor'],
  discovery: ['discovery', 'science', 'math', 'counting', 'explore', 'nature'],
  social: ['social', 'emotional', 'cooperation', 'sharing', 'feelings', 'friendship'],
  balanced: [],
};
function invalid() {
  return Object.assign(new Error('The local activity references need administrator review. You can keep using saved activities.'),
    { status: 424, code: 'AI_SOURCES_INVALID' });
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalid();
  return value.trim();
}
function validate(collection) {
  object(collection, ['version', 'sources']);
  if (collection.version !== 1 || !Array.isArray(collection.sources) || collection.sources.length > 100) throw invalid();
  const seen = new Set();
  return collection.sources.map(source => {
    object(source, ['id', 'title', 'publisher', 'version', 'section', 'kind', 'text', 'ageMinMonths', 'ageMaxMonths', 'superseded', 'topics']);
    const id = text(source.id, 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || seen.has(id)) throw invalid();
    seen.add(id);
    if (!['education', 'policy', 'regulation'].includes(source.kind) ||
      ![source.ageMinMonths, source.ageMaxMonths].every(n => Number.isInteger(n) && n >= 0 && n <= 216) || source.ageMaxMonths <= source.ageMinMonths ||
      (source.superseded !== undefined && typeof source.superseded !== 'boolean') ||
      (source.topics !== undefined && (!Array.isArray(source.topics) || source.topics.length > 6 || new Set(source.topics).size !== source.topics.length || source.topics.some(topic => !focuses.includes(topic))))) throw invalid();
    return { id, title: text(source.title, 160), publisher: text(source.publisher, 160), version: text(source.version, 80),
      section: text(source.section, 120), kind: source.kind, text: text(source.text, 1200),
      ageMinMonths: source.ageMinMonths, ageMaxMonths: source.ageMaxMonths, superseded: source.superseded === true, topics: source.topics || [] };
  });
}
async function read() {
  const file = process.env.SKAO_AI_SOURCES_FILE;
  if (!file) return [];
  let handle;
  try {
    if (!path.isAbsolute(file)) throw invalid();
    // Open a regular file once, reject a final symlink and bound reads even if
    // another process grows it between stat and read.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_BYTES) throw invalid();
    return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))));
  } catch { throw invalid(); }
  finally { await handle?.close(); }
}
// Regulations are deliberately excluded until license/program applicability and
// supersession handling are implemented in SKAO-91. A citation isn't a legal
// compliance check. There are no bundled, invented Title 22/course excerpts.
const eligible = source => !source.superseded && source.kind !== 'regulation';
async function status() {
  return { sourceCount: (await read()).filter(eligible).length };
}
async function retrieve({ ageMinMonths, ageMaxMonths, focus = 'balanced', theme = '' }) {
  if (!focuses.includes(focus) || ![ageMinMonths, ageMaxMonths].every(Number.isInteger) || ageMinMonths < 0 || ageMaxMonths > 216 || ageMaxMonths <= ageMinMonths) throw invalid();
  const terms = (theme.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 30);
  const ranked = (await read()).filter(source => eligible(source) && source.ageMinMonths <= ageMinMonths && source.ageMaxMonths >= ageMaxMonths)
    .map(source => {
      const content = [source.title, source.section, source.text].join(' ').toLowerCase();
      const relevance = terms.reduce((sum, term) => sum + (content.includes(term) ? 2 : 0), 0) +
        (keywords[focus].some(term => content.includes(term)) ? 1 : 0) + (source.topics.includes(focus) || source.topics.includes('balanced') ? 1 : 0);
      return { source, relevance };
    }).filter(({ relevance }) => (!terms.length && focus === 'balanced') || relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.source.id.localeCompare(b.source.id));
  return ranked.slice(0, 6).map(({ source }) => Object.fromEntries(['id', 'title', 'publisher', 'version', 'section', 'kind', 'text'].map(key => [key, source[key]])));
}
module.exports = { retrieve, status, validate };
