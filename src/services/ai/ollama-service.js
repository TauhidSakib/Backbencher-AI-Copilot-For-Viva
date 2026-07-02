// ============================================================================
// OLLAMA AI SERVICE - Backbencher AI Copilot
// ============================================================================
// Uses Ollama's OpenAI-compatible API for local LLM inference.
// Implements the same public interface as GeminiService so the runtime
// can swap providers transparently.
// ============================================================================

const {
  resolveProgrammingLanguage
} = require('../../config');
const {
  buildAnswerQuestionPrompt,
  buildAskAiSessionPrompt,
  buildFollowUpEmailPrompt,
  buildInsightsPrompt,
  buildMeetingNotesPrompt,
  buildScreenshotAnalysisPrompt,
  buildSuggestResponsePrompt,
  extractLatestHostUtterance,
  wantsDetailedAnswer,
  stripMetaPreamble
} = require('./prompts');

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
// The text model (e.g. llama3.2:3b) cannot see images, so requests that carry
// screenshots are auto-routed to a vision-capable model that ALSO receives the
// full session context + uploaded-doc RAG + the latest question, and answers
// step. On a 4 GB GPU (RTX 3050 Laptop) the 6 GB qwen2.5vl:7b spills to CPU and
// is unusably slow; moondream fits but can't OCR code/text (only vaguely
// describes images). qwen2.5vl:3b (~3.2 GB) fits the GPU AND reads code/text
// accurately, so it's the default OCR model for the hybrid pipeline. Override
// with OLLAMA_VISION_MODEL.
const DEFAULT_OLLAMA_VISION_MODEL = 'qwen2.5vl:3b';

// Electron's Node fetch resolves "localhost" to IPv6 (::1), but Ollama listens
// on IPv4 (127.0.0.1) by default — which yields ECONNREFUSED ::1:11434. Force
// the IPv4 loopback so local requests always connect.
function normalizeBaseUrl(value) {
  return String(value || DEFAULT_OLLAMA_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}

class OllamaService {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.modelName = String(options.modelName || DEFAULT_OLLAMA_MODEL).trim();
    this.visionModel = String(options.visionModel || process.env.OLLAMA_VISION_MODEL || DEFAULT_OLLAMA_VISION_MODEL).trim();
    this.programmingLanguage = resolveProgrammingLanguage(options.programmingLanguage);
    // The interview / viva subject (e.g. "Machine Learning & Deep Learning").
    // Used as domain context so the model resolves speech-to-text mishearings to
    // the right term ("overeating" -> "overfitting") and answers in-field.
    this.interviewTopic = String(options.interviewTopic || '').trim();

    // Speed/stability tuning for a 4 GB GPU. 4096 is the floor that still works:
    // a screenshot request is ~3300 tokens (vision images are token-heavy) and
    // this Ollama build HARD-ERRORS (400 exceed_context_size) instead of
    // truncating when the prompt overflows num_ctx. 4096 fits the model ~80% on
    // GPU (fast) while leaving room for the image + a 512-token answer. Capped
    // output prevents runaway generations. Override via env if needed.
    this.numCtx = Number(process.env.OLLAMA_NUM_CTX) || 6144;
    this.numPredict = Number(process.env.OLLAMA_NUM_PREDICT) || 220;
    // When the question explicitly asks for depth ("explain", "in detail",
    // "from scratch", …) we raise the output cap so the answer isn't cut short.
    // Kept within num_ctx headroom (prompt ~3k + this ≤ 6144).
    this.numPredictDetailed = Number(process.env.OLLAMA_NUM_PREDICT_DETAILED) || 1400;
    // CRITICAL on this 4 GB GPU: Ollama's auto VRAM estimate is too conservative
    // for the vision model and dumps it ~97% onto the CPU (→ 130s+ per answer)
    // even though nvidia-smi shows the 3.2 GB model fits in the ~3.9 GB free.
    // Forcing all layers onto the GPU (num_gpu=99) loads it 100% on GPU → warm
    // text ~2s, screenshot ~5s. Set OLLAMA_NUM_GPU=0 to fall back to auto/CPU.
    this.numGpu = process.env.OLLAMA_NUM_GPU !== undefined
      ? Number(process.env.OLLAMA_NUM_GPU)
      : 99;

    // Truthy `model` marker so the shared IPC handlers (which guard on
    // `service.model`) treat this local service as initialized.
    this.model = this.modelName || 'ollama';

    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = 500;
    this.maxRetries = 2;
    this.isProcessing = false;

    this.conversationHistory = [];
    this.maxHistoryLength = 20;

    // Unused but kept for interface compatibility with GeminiService
    this.dailyTokenCount = 0;
    this.maxDailyTokens = Infinity;
    this.lastResetTime = Date.now();
    this.apiKey = '';

    console.log('OllamaService initialized:', this.modelName, 'at', this.baseUrl);
  }

  updateConfiguration(options = {}) {
    const previousProgrammingLanguage = this.programmingLanguage;
    const nextBaseUrl = normalizeBaseUrl(options.baseUrl ?? this.baseUrl);
    const nextModelName = String(options.modelName ?? this.modelName).trim();
    const nextProgrammingLanguage = resolveProgrammingLanguage(
      options.programmingLanguage ?? this.programmingLanguage
    );

    const baseUrlChanged = nextBaseUrl !== this.baseUrl;
    const modelChanged = nextModelName !== this.modelName;
    const programmingLanguageChanged = nextProgrammingLanguage !== previousProgrammingLanguage;

    this.baseUrl = nextBaseUrl;
    this.modelName = nextModelName;
    this.model = nextModelName || 'ollama';
    this.programmingLanguage = nextProgrammingLanguage;
    if (options.interviewTopic !== undefined) {
      this.interviewTopic = String(options.interviewTopic || '').trim();
    }

    return {
      apiKeyChanged: baseUrlChanged,
      modelChanged,
      programmingLanguageChanged
    };
  }

  isQuotaExhaustedError() {
    return false;
  }

  isAuthenticationError() {
    return false;
  }

  isRetryableError(error) {
    const message = String(error?.message || '');
    return (
      message.includes('ECONNREFUSED') ||
      message.includes('ECONNRESET') ||
      message.includes('fetch failed') ||
      message.includes('500') ||
      message.includes('503')
    );
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();

      try {
        await this.waitForRateLimit();
        const result = await this._executeRequest(request);
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessing = false;
  }

  async _executeRequest(request, retryCount = 0) {
    try {
      const prompt = typeof request.data === 'string'
        ? request.data
        : this._extractTextFromParts(request.data);
      const images = this._extractImagesFromParts(request.data);

      if (typeof request.onChunk === 'function') {
        return await this._streamChat(prompt, request, images);
      }

      return await this._chat(prompt, images, request.numPredict);
    } catch (error) {
      console.error(`Ollama request error (attempt ${retryCount + 1}):`, error.message);

      if (request._firstChunkSent) {
        throw error;
      }

      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        const backoffTime = Math.pow(2, retryCount) * 1000;
        console.log(`Retrying Ollama request in ${backoffTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return this._executeRequest(request, retryCount + 1);
      }

      throw error;
    }
  }

  _extractTextFromParts(data) {
    if (typeof data === 'string') {
      return data;
    }

    if (Array.isArray(data)) {
      const textParts = data
        .filter((part) => typeof part === 'string' || part?.text)
        .map((part) => (typeof part === 'string' ? part : part.text));
      return textParts.join('\n');
    }

    return String(data || '');
  }

  // Collects base64 image payloads from Gemini-style multimodal parts so they
  // can be forwarded to a vision-capable Ollama model (e.g. moondream/llava).
  _extractImagesFromParts(data) {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .map((part) => part?.inlineData?.data || part?.inline_data?.data || null)
      .filter((value) => typeof value === 'string' && value.length > 0);
  }

  _buildMessages(prompt, images = []) {
    const userMessage = { role: 'user', content: prompt };
    if (Array.isArray(images) && images.length > 0) {
      userMessage.images = images;
    }

    return [
      { role: 'system', content: 'You are a helpful AI assistant.' },
      userMessage
    ];
  }

  async _chat(prompt, images = [], numPredict) {
    const url = `${this.baseUrl}/api/chat`;
    const messages = this._buildMessages(prompt, images);
    const predict = Number(numPredict) > 0 ? Number(numPredict) : this.numPredict;
    // Text uses the configured model; screenshots route to the vision model.
    // If both are the same (e.g. qwen2.5vl:3b for everything) there is NO swap —
    // the fastest, most consistent setup on this 4 GB GPU. If the text model is
    // a text-only one (e.g. llama3.2), a screenshot triggers a one-time swap to
    // the vision model (slower, but screenshots are the secondary priority).
    const model = images && images.length > 0 ? this.visionModel : this.modelName;

    console.log(`[Ollama API] Non-streaming request started (model: ${model}, images: ${images.length})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_ctx: this.numCtx, num_predict: predict, num_gpu: this.numGpu }
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    const responseText = result.message?.content || '';

    console.log(`[Ollama API] Non-streaming request completed (${responseText.length} chars)`);
    return responseText;
  }

  async _streamChat(prompt, request, images = []) {
    const url = `${this.baseUrl}/api/chat`;
    const messages = this._buildMessages(prompt, images);
    // Text uses the configured model; screenshots route to the vision model.
    // If both are the same (e.g. qwen2.5vl:3b for everything) there is NO swap —
    // the fastest, most consistent setup on this 4 GB GPU. If the text model is
    // a text-only one (e.g. llama3.2), a screenshot triggers a one-time swap to
    // the vision model (slower, but screenshots are the secondary priority).
    const model = images && images.length > 0 ? this.visionModel : this.modelName;
    const predict = Number(request?.numPredict) > 0 ? Number(request.numPredict) : this.numPredict;

    console.log(`[Ollama API] Streaming request started (model: ${model}, images: ${images.length}, num_predict: ${predict})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_ctx: this.numCtx, num_predict: predict, num_gpu: this.numGpu }
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    let fullText = '';
    let chunkIndex = 0;
    const reader = response.body;

    // Node.js fetch returns a ReadableStream; iterate with async for-of on the body
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });

      // Each line is a JSON object separated by newlines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          const content = parsed.message?.content || '';
          if (content) {
            fullText += content;
            chunkIndex += 1;
            if (!request._firstChunkSent) {
              request._firstChunkSent = true;
            }
            request.onChunk({ text: content, index: chunkIndex });
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        const content = parsed.message?.content || '';
        if (content) {
          fullText += content;
          chunkIndex += 1;
          request.onChunk({ text: content, index: chunkIndex });
        }
      } catch {
        // skip
      }
    }

    console.log(`[Ollama API] Streaming request completed (${chunkIndex} chunks, ${fullText.length} chars)`);
    return fullText;
  }

  // Fire-and-forget: load the model into VRAM at startup so the FIRST real
  // question doesn't pay the ~10s cold-load. Sends a 1-token request.
  async warmUp() {
    try {
      await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          messages: [{ role: 'user', content: 'ok' }],
          stream: false,
          options: { num_ctx: this.numCtx, num_predict: 1, num_gpu: this.numGpu }
        })
      });
      console.log('[Ollama] warm-up complete for', this.modelName);
    } catch (error) {
      console.log('[Ollama] warm-up skipped:', error.message);
    }
  }

  addToHistory(role, content) {
    this.conversationHistory.push({ role, content });

    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getContextString() {
    return this.conversationHistory
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n\n');
  }

  async generateText(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const request = {
        type: 'text',
        data: prompt,
        resolve,
        reject,
        numPredict: options.numPredict,
        onChunk: typeof options.onChunk === 'function' ? options.onChunk : null
      };

      this.requestQueue.push(request);
      this.processQueue();
    });
  }

  async generateMultimodal(parts, options = {}) {
    // Ollama doesn't support inline image data the same way Gemini does.
    // We extract text parts and pass them as a text-only prompt.
    return new Promise((resolve, reject) => {
      const request = {
        type: 'multimodal',
        data: parts,
        resolve,
        reject,
        numPredict: options.numPredict,
        onChunk: typeof options.onChunk === 'function' ? options.onChunk : null
      };

      this.requestQueue.push(request);
      this.processQueue();
    });
  }

  async analyzeScreenshots(imageParts, additionalContext = '', options = {}) {
    const contextString = typeof options.contextStringOverride === 'string'
      ? options.contextStringOverride
      : this.getContextString();
    const prompt = buildScreenshotAnalysisPrompt({
      contextString,
      additionalContext,
      programmingLanguage: this.programmingLanguage
    });

    // Forward the screenshots to the model. With a vision-capable model
    // (e.g. moondream / llava) Ollama will actually read the images; text-only
    // models simply ignore the images array.
    const parts = [{ text: prompt }, ...imageParts];
    const result = await this.generateMultimodal(parts, { onChunk: options.onChunk });

    this.addToHistory('assistant', `Screenshot analysis: ${result}`);
    return result;
  }

  async analyzeScreenshot(imageBase64, additionalContext = '') {
    return this.analyzeScreenshots(
      [{ inlineData: { mimeType: 'image/png', data: imageBase64 } }],
      additionalContext
    );
  }

  async askAiWithSessionContext(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildAskAiSessionPrompt({
      contextString,
      transcriptContext: options.transcriptContext || '',
      sessionSummary: options.sessionSummary || '',
      documentContext: options.documentContext || '',
      interviewTopic: this.interviewTopic,
      screenshotCount: options.screenshotCount || 0,
      mode: options.mode || 'best-next-answer'
    });

    // Longer token budget when I ask for depth ("explain", "in detail",
    // "from scratch", …) or when the caller forces it (Explain-in-Detail shortcut).
    const detailed = options.forceDetailed
      || wantsDetailedAnswer(extractLatestHostUtterance(options.transcriptContext || ''));
    const streamOptions = {
      onChunk: options.onChunk,
      numPredict: detailed ? this.numPredictDetailed : this.numPredict
    };
    const raw = await this.generateText(prompt, streamOptions);
    const result = stripMetaPreamble(raw);
    this.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  // Screenshots: a single multimodal model (qwen2.5vl:3b) reads the image AND
  // answers in ONE inference. Because the SAME model serves text questions too,
  // it stays resident/warm on the GPU — there is no model swap, so screenshots
  // are fast (no cold load) and the 4 GB GPU is never asked to hold two models.
  async askAiWithSessionContextAndScreenshots(imageParts, options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildAskAiSessionPrompt({
      contextString,
      transcriptContext: options.transcriptContext || '',
      sessionSummary: options.sessionSummary || '',
      documentContext: options.documentContext || '',
      interviewTopic: this.interviewTopic,
      screenshotCount: options.screenshotCount || imageParts.length,
      mode: options.mode || 'best-next-answer'
    });

    const detailed = options.forceDetailed
      || wantsDetailedAnswer(extractLatestHostUtterance(options.transcriptContext || ''));
    const parts = [{ text: prompt }, ...imageParts];
    const raw = await this.generateMultimodal(parts, {
      onChunk: options.onChunk,
      numPredict: detailed ? this.numPredictDetailed : this.numPredict
    });
    const result = stripMetaPreamble(raw);

    this.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  async suggestResponse(context, options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    const prompt = buildSuggestResponsePrompt({
      contextString,
      context
    });

    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async generateMeetingNotes(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    if (!contextString.trim()) {
      return 'No conversation history to summarize.';
    }
    const prompt = buildMeetingNotesPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async generateFollowUpEmail(options = {}) {
    if (this.conversationHistory.length === 0) {
      return 'No conversation history to create email from.';
    }

    const contextString = this.getContextString();
    const prompt = buildFollowUpEmailPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }

  async answerQuestion(question, options = {}) {
    const contextString = this.getContextString();
    const prompt = buildAnswerQuestionPrompt({
      contextString,
      question,
      programmingLanguage: this.programmingLanguage
    });

    const streamOptions = { onChunk: options.onChunk };
    const result = await this.generateText(prompt, streamOptions);
    this.addToHistory('user', question);
    this.addToHistory('assistant', result);
    return result;
  }

  async getConversationInsights(options = {}) {
    const contextString = typeof options.contextString === 'string'
      ? options.contextString
      : this.getContextString();
    if (!contextString.trim()) {
      return 'Not enough conversation data for insights.';
    }
    const prompt = buildInsightsPrompt({ contextString });
    const streamOptions = { onChunk: options.onChunk };
    return this.generateText(prompt, streamOptions);
  }
}

module.exports = OllamaService;
