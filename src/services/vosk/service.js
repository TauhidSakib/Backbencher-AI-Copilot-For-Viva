const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const {
  createSttHistoryManager,
  normalizeSttSource
} = require('../assembly-ai/stt-history');

const VOSK_SAMPLE_RATE = 16000;

/**
 * Offline transcription service backed by Vosk. It is a drop-in replacement for
 * the AssemblyAI service: it exposes the same public methods and emits the same
 * `vosk-*` renderer events, but instead of streaming audio to a cloud WebSocket
 * it spawns one local Python worker per source (mic / system) and feeds it the
 * raw PCM chunks the renderer already produces.
 */
function createVoskService({
  desktopCapturer,
  getGeminiService,
  sendToRenderer,
  modelPath,
  pythonPath = 'py',
  pythonPrefixArgs = ['-3.14'],
  scriptPath,
  getInterviewTopic = null
}) {
  // One spawned Python process per source.
  const procs = { mic: null, system: null };
  const streaming = { mic: false, system: false };

  const sttChunkCounters = { mic: 0, system: 0 };
  const sttDroppedChunkCounters = { mic: 0, system: 0 };

  const resolvedScriptPath = scriptPath || path.join(__dirname, 'transcribe.py');

  function emitSttDebug({ source = null, level = 'info', event = 'event', message = '', meta = null } = {}) {
    sendToRenderer('stt-debug', {
      ts: new Date().toISOString(),
      source: source === 'mic' || source === 'system' ? source : null,
      level,
      event,
      message,
      meta
    });
  }

  const sttHistoryManager = createSttHistoryManager({
    getGeminiService,
    emitSttDebug,
    mergeWindowMs: 3500
  });

  function killProc(source) {
    const proc = procs[source];
    if (!proc) return;

    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    } catch (_) {
      // no-op
    }

    try {
      proc.kill();
    } catch (_) {
      // no-op
    }

    procs[source] = null;
  }

  function resetSourceState(source) {
    const resolvedSource = normalizeSttSource(source);
    sttChunkCounters[resolvedSource] = 0;
    sttDroppedChunkCounters[resolvedSource] = 0;
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);
    streaming[resolvedSource] = false;
    procs[resolvedSource] = null;
  }

  function handleWorkerMessage(resolvedSource, msg) {
    switch (msg.type) {
      case 'ready':
        streaming[resolvedSource] = true;
        emitSttDebug({
          source: resolvedSource,
          event: 'worker-ready',
          message: 'Vosk model loaded'
        });
        sendToRenderer('vosk-status', {
          source: resolvedSource,
          status: 'listening',
          message: `Listening (${resolvedSource === 'system' ? 'Host' : 'You'})...`
        });
        break;

      case 'partial':
        if (msg.text) {
          sendToRenderer('vosk-partial', { source: resolvedSource, text: msg.text });
        }
        break;

      case 'final':
        if (msg.text) {
          emitSttDebug({
            source: resolvedSource,
            event: 'turn-final',
            message: 'Final transcript received',
            meta: { chars: msg.text.length }
          });
          sendToRenderer('vosk-final', { source: resolvedSource, text: msg.text });
          sttHistoryManager.queueSttHistorySegment(resolvedSource, msg.text);
        }
        break;

      case 'error':
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'worker-error',
          message: msg.message || 'Vosk worker error'
        });
        sendToRenderer('vosk-error', {
          source: resolvedSource,
          error: `Transcription error (${resolvedSource}): ${msg.message || 'unknown'}`
        });
        break;

      default:
        emitSttDebug({
          source: resolvedSource,
          event: 'worker-message',
          message: `Unknown worker message: ${msg.type}`
        });
    }
  }

  // Named startAssemblyAiStream so the existing IPC layer wires in unchanged.
  function startAssemblyAiStream(source) {
    const resolvedSource = normalizeSttSource(source);

    if (streaming[resolvedSource] || procs[resolvedSource]) {
      emitSttDebug({
        source: resolvedSource,
        event: 'start-skipped',
        message: 'Start requested while source is already streaming'
      });
      return {
        success: true,
        message: resolvedSource === 'system' ? 'System audio already streaming' : 'Mic already streaming'
      };
    }

    sttChunkCounters[resolvedSource] = 0;
    sttDroppedChunkCounters[resolvedSource] = 0;
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);

    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'loading',
      message: `Loading model (${resolvedSource})...`
    });

    emitSttDebug({
      source: resolvedSource,
      event: 'start-request',
      message: 'Spawning Vosk worker',
      meta: { modelPath, scriptPath: resolvedScriptPath }
    });

    try {
      const args = [
        ...pythonPrefixArgs,
        resolvedScriptPath,
        '--model', modelPath,
        '--rate', String(VOSK_SAMPLE_RATE)
      ];

      // Bias the Whisper decoder toward the current interview topic's
      // vocabulary (read fresh at spawn). Harmless to the Vosk worker, which
      // ignores env it doesn't read.
      let interviewTopic = '';
      if (typeof getInterviewTopic === 'function') {
        try {
          interviewTopic = String(getInterviewTopic() || '').trim();
        } catch (_) {
          interviewTopic = '';
        }
      }

      const proc = spawn(pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, WHISPER_PROMPT_EXTRA: interviewTopic }
      });

      procs[resolvedSource] = proc;

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          handleWorkerMessage(resolvedSource, JSON.parse(trimmed));
        } catch (_) {
          emitSttDebug({
            source: resolvedSource,
            event: 'worker-stdout',
            message: trimmed
          });
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          emitSttDebug({
            source: resolvedSource,
            level: 'error',
            event: 'worker-stderr',
            message: text
          });
        }
      });

      proc.on('error', (error) => {
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'spawn-error',
          message: error.message
        });
        sendToRenderer('vosk-error', {
          source: resolvedSource,
          error: `Could not start Vosk worker (${resolvedSource}): ${error.message}. Is Python + the vosk package installed?`
        });
        resetSourceState(resolvedSource);
      });

      proc.on('close', (code) => {
        emitSttDebug({
          source: resolvedSource,
          event: 'worker-close',
          message: `Vosk worker exited (code ${code})`
        });
        if (streaming[resolvedSource] || procs[resolvedSource]) {
          sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'worker-close');
          resetSourceState(resolvedSource);
          sendToRenderer('vosk-stopped', { source: resolvedSource });
        }
      });

      return { success: true };
    } catch (error) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'start-failed',
        message: error.message
      });
      resetSourceState(resolvedSource);
      return { success: false, error: error.message };
    }
  }

  function handleAudioChunk({ source, data } = {}) {
    const resolvedSource = normalizeSttSource(source);
    const proc = procs[resolvedSource];

    if (proc && proc.stdin && proc.stdin.writable) {
      try {
        proc.stdin.write(Buffer.from(data));
      } catch (error) {
        sttDroppedChunkCounters[resolvedSource] += 1;
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'chunk-write-failed',
          message: error.message
        });
        return;
      }

      sttChunkCounters[resolvedSource] += 1;
      if (sttChunkCounters[resolvedSource] % 50 === 0) {
        emitSttDebug({
          source: resolvedSource,
          event: 'chunk-heartbeat',
          message: 'Streaming audio chunks',
          meta: {
            chunks: sttChunkCounters[resolvedSource],
            dropped: sttDroppedChunkCounters[resolvedSource]
          }
        });
      }
      return;
    }

    sttDroppedChunkCounters[resolvedSource] += 1;
    if (sttDroppedChunkCounters[resolvedSource] % 25 === 0) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'chunk-dropped',
        message: 'Audio chunk dropped because Vosk worker is not ready',
        meta: { dropped: sttDroppedChunkCounters[resolvedSource] }
      });
    }
  }

  function stopVoiceRecognition({ source } = {}) {
    emitSttDebug({
      source: source === 'system' || source === 'mic' ? source : null,
      event: 'ipc-stop',
      message: `Stop requested for ${source || 'default'}`
    });

    const stopSource = (src) => {
      const resolvedSource = normalizeSttSource(src);

      sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-request');
      killProc(resolvedSource);
      streaming[resolvedSource] = false;
      sttChunkCounters[resolvedSource] = 0;
      sttDroppedChunkCounters[resolvedSource] = 0;

      sendToRenderer('vosk-status', {
        source: resolvedSource,
        status: 'stopped',
        message: 'Stopped'
      });
      sendToRenderer('vosk-stopped', { source: resolvedSource });

      emitSttDebug({
        source: resolvedSource,
        event: 'stop-issued',
        message: 'Vosk worker stopped'
      });
    };

    if (source === 'all') {
      stopSource('mic');
      stopSource('system');
    } else {
      stopSource(source === 'system' ? 'system' : 'mic');
    }

    return { success: true };
  }

  async function getDesktopSources() {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      return sources.map((source) => ({ id: source.id, name: source.name }));
    } catch (error) {
      console.error('Error getting desktop sources:', error.message);
      return [];
    }
  }

  async function transcribeAudio() {
    // One-shot file transcription is an AssemblyAI-only feature; the offline
    // Vosk pipeline only handles live streaming PCM, so report it gracefully.
    return {
      success: false,
      error: 'Offline Vosk mode supports live transcription only (no file upload).'
    };
  }

  function dispose() {
    killProc('mic');
    killProc('system');
    sttHistoryManager.flushAllSttHistoryBuffers('cleanup');
    sttHistoryManager.dispose();
  }

  function resetSttHistoryBuffers() {
    sttHistoryManager.resetSttHistoryBuffer('mic');
    sttHistoryManager.resetSttHistoryBuffer('system');
  }

  return {
    dispose,
    emitSttDebug,
    flushAllSttHistoryBuffers: sttHistoryManager.flushAllSttHistoryBuffers,
    getDesktopSources,
    handleAudioChunk,
    resetSttHistoryBuffers,
    startAssemblyAiStream,
    stopVoiceRecognition,
    transcribeAudio
  };
}

module.exports = {
  createVoskService
};
