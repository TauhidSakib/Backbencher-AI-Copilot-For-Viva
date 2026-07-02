// Extracts plain text from uploaded documents entirely in memory (from a
// Buffer) — no temp files are written to disk, which keeps session deletion
// trivial and complete.

const path = require('path');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.text', '.rtf'
]);
const OFFICE_EXTENSIONS = new Set([
  '.pptx', '.xlsx', '.odt', '.odp', '.ods'
]);

async function extractPdf(buffer) {
  // unpdf ships a Node-compatible pdf.js build (no DOMMatrix / browser globals
  // required), which works inside Electron's main process. It is ESM-only, so
  // load it via dynamic import from this CommonJS module.
  const { getDocumentProxy, extractText: unpdfExtractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await unpdfExtractText(pdf, { mergePages: true });
  const text = result?.text;
  if (Array.isArray(text)) {
    return text.join('\n');
  }
  return typeof text === 'string' ? text : String(text || '');
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result?.value || '';
}

async function extractOffice(buffer, ext) {
  const { parseOffice } = require('officeparser');
  const fileType = ext.replace(/^\./, '');
  const text = await parseOffice(buffer, { fileType });
  return typeof text === 'string' ? text : (text?.toString?.() || '');
}

/**
 * @param {string} fileName  original filename (used to detect type)
 * @param {Buffer} buffer    raw file bytes
 * @returns {Promise<string>} extracted plain text
 */
async function extractText(fileName, buffer) {
  const ext = path.extname(String(fileName || '')).toLowerCase();

  if (ext === '.pdf') {
    return extractPdf(buffer);
  }
  if (ext === '.docx') {
    return extractDocx(buffer);
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return extractOffice(buffer, ext);
  }
  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    return buffer.toString('utf8');
  }

  // Unknown binary type — try office parser as a last resort, else treat as text.
  try {
    return await extractOffice(buffer, ext);
  } catch (_) {
    return buffer.toString('utf8');
  }
}

function isSupportedExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ext === '.pdf'
    || ext === '.docx'
    || OFFICE_EXTENSIONS.has(ext)
    || TEXT_EXTENSIONS.has(ext);
}

module.exports = {
  extractText,
  isSupportedExtension
};
