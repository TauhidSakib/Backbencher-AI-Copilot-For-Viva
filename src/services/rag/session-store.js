// ============================================================================
// SESSION RAG STORE — Backbencher AI Copilot
// ============================================================================
// Per-session, fully in-memory retrieval store for uploaded documents.
//
// Design goals (from the product spec):
//  - Each session is isolated: its own Session ID and its own vector store.
//  - Uploaded files are TEMPORARY: parsed text + embeddings live only in RAM.
//    Nothing is written to disk, so ending a session = dropping the in-memory
//    arrays. There are no files, caches, or indexes to leave behind.
//  - RAG only: the base model is never trained or fine-tuned on uploads.
//  - Embeddings are computed locally via Ollama (nomic-embed-text).
// ============================================================================

const crypto = require('crypto');
const { extractText, isSupportedExtension } = require('./extract-text');

const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const CHUNK_SIZE = 1100;        // characters per chunk (~250-300 tokens)
const CHUNK_OVERLAP = 150;      // character overlap between chunks
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file guard

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function chunkText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);

    // Prefer to break on a paragraph/sentence boundary near the chunk end.
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf('\n')
      );
      if (breakAt > CHUNK_SIZE * 0.5) {
        end = start + breakAt + 1;
      }
    }

    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

function vectorNorm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function createSessionRag({
  getOllamaBaseUrl,
  embedModel = DEFAULT_EMBED_MODEL,
  emitDebug = () => {}
} = {}) {
  let sessionId = newId('sess');
  /** @type {Array<{id:string,fileId:string,fileName:string,chunkIndex:number,text:string,embedding:number[],norm:number}>} */
  let chunkStore = [];
  /** @type {Array<{fileId:string,name:string,size:number,chunks:number,addedAt:string}>} */
  let fileStore = [];

  function baseUrl() {
    const url = typeof getOllamaBaseUrl === 'function' ? getOllamaBaseUrl() : 'http://127.0.0.1:11434';
    // Force IPv4 loopback — Electron's fetch resolves "localhost" to ::1 where
    // Ollama isn't listening (ECONNREFUSED).
    return String(url || 'http://127.0.0.1:11434')
      .replace(/\/+$/, '')
      .replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
  }

  // nomic-embed-text requires task-instruction prefixes: "search_document:" for
  // stored chunks and "search_query:" for queries. Without them the vectors are
  // uncalibrated and relevant/irrelevant content scores nearly the same.
  function withPrefix(text, kind) {
    const value = String(text || '');
    if (!/nomic/i.test(embedModel)) return value;
    return kind === 'query' ? `search_query: ${value}` : `search_document: ${value}`;
  }

  async function embed(text, kind = 'document') {
    const response = await fetch(`${baseUrl()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: withPrefix(text, kind) })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Embedding request failed (${response.status}): ${detail}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.embedding)) {
      throw new Error('Embedding response missing vector. Is the embedding model installed? (ollama pull nomic-embed-text)');
    }
    return data.embedding;
  }

  // Permanently wipe everything for the current session.
  function wipe() {
    chunkStore.length = 0;
    fileStore.length = 0;
  }

  function getSessionId() {
    return sessionId;
  }

  function newSession() {
    wipe();
    sessionId = newId('sess');
    emitDebug({ event: 'session-new', sessionId });
    return sessionId;
  }

  // End / cancel / delete — purge all session data. New empty session id issued.
  function endSession() {
    const previous = sessionId;
    wipe();
    sessionId = newId('sess');
    emitDebug({ event: 'session-end', previous, sessionId });
    return { previousSessionId: previous, sessionId };
  }

  function listFiles() {
    return fileStore.map((file) => ({ ...file }));
  }

  function hasDocuments() {
    return chunkStore.length > 0;
  }

  async function addFile({ name, dataBase64 }) {
    if (!isSupportedExtension(name)) {
      throw new Error(`Unsupported file type: ${name}. Allowed: pdf, docx, pptx, xlsx, txt, md, csv.`);
    }

    const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
    if (buffer.length === 0) {
      throw new Error('Uploaded file is empty.');
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max 25 MB.`);
    }

    const text = await extractText(name, buffer);
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error(`No readable text found in ${name}.`);
    }

    const fileId = newId('file');
    let embedded = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const piece = chunks[index];
      // eslint-disable-next-line no-await-in-loop
      const embedding = await embed(piece, 'document');
      chunkStore.push({
        id: `${fileId}_${index}`,
        fileId,
        fileName: name,
        chunkIndex: index,
        text: piece,
        embedding,
        norm: vectorNorm(embedding)
      });
      embedded += 1;
    }

    const fileMeta = {
      fileId,
      name,
      size: buffer.length,
      chunks: embedded,
      addedAt: new Date().toISOString()
    };
    fileStore.push(fileMeta);

    emitDebug({ event: 'file-added', name, chunks: embedded, sessionId });
    return { ...fileMeta };
  }

  function removeFile(fileId) {
    const before = chunkStore.length;
    chunkStore = chunkStore.filter((chunk) => chunk.fileId !== fileId);
    fileStore = fileStore.filter((file) => file.fileId !== fileId);
    emitDebug({ event: 'file-removed', fileId, removedChunks: before - chunkStore.length });
    return { success: true };
  }

  /**
   * Retrieve the most relevant chunks for a query.
   * @returns {Promise<{chunks:Array<{text,fileName,score}>, topScore:number}>}
   */
  async function retrieve(query, { topK = 4, minScore = 0.45 } = {}) {
    const trimmed = String(query || '').trim();
    if (!trimmed || chunkStore.length === 0) {
      return { chunks: [], topScore: 0 };
    }

    const queryEmbedding = await embed(trimmed, 'query');
    const queryNorm = vectorNorm(queryEmbedding);

    const ranked = chunkStore
      .map((chunk) => {
        let dot = 0;
        for (let i = 0; i < queryEmbedding.length; i += 1) dot += queryEmbedding[i] * chunk.embedding[i];
        const denom = (queryNorm || 1) * (chunk.norm || 1);
        return { text: chunk.text, fileName: chunk.fileName, score: denom === 0 ? 0 : dot / denom };
      })
      .sort((a, b) => b.score - a.score);

    const top = ranked.slice(0, topK);
    const relevant = top.filter((item) => item.score >= minScore);

    emitDebug({
      event: 'retrieve',
      query: trimmed.slice(0, 80),
      topScore: top[0]?.score ?? 0,
      kept: relevant.length
    });

    return {
      chunks: relevant,
      topScore: top[0]?.score ?? 0,
      // Always return the single best chunk for "soft" blending even if below
      // threshold, so the model can lean on weak-but-present context.
      best: top[0] || null
    };
  }

  function dispose() {
    wipe();
  }

  return {
    getSessionId,
    newSession,
    endSession,
    addFile,
    removeFile,
    listFiles,
    hasDocuments,
    retrieve,
    dispose
  };
}

module.exports = {
  createSessionRag
};
