#!/usr/bin/env python3
"""
Offline faster-whisper streaming transcription worker for Backbencher AI Copilot.

Drop-in replacement for transcribe.py (Vosk). It keeps the EXACT same contract so
the Node service (service.js) wires in unchanged:

    stdin :  raw 16-bit little-endian mono PCM @ 16 kHz (what the renderer already sends)
    stdout:  newline-delimited JSON
             {"type": "ready"}
             {"type": "partial", "text": "..."}
             {"type": "final",   "text": "..."}
             {"type": "error",   "message": "..."}

Whisper is far more accurate than Vosk on technical vocabulary ("deep learning",
"overfitting", "regularization"), which is exactly what was getting mangled
("eat learning", "over eating"). Whisper is not natively streaming, so we split
the incoming PCM into utterances with a lightweight RMS-based VAD: we accumulate
speech frames, and when we see a short pause after speech we transcribe the
buffered utterance and emit a `final`.

Transcription runs on a WORKER THREAD so the stdin reader never blocks (otherwise
the OS pipe would back up and audio would lag). Partial jobs are coalesced (only
the newest is kept) while finals are always transcribed.
"""

import argparse
import json
import os
import queue
import sys
import threading

import numpy as np

SAMPLE_RATE = 16000

# Whisper tends to hallucinate these on near-silence / noise. Drop them.
_HALLUCINATIONS = {
    "", ".", "you", "so", "bye.", "bye", "okay.", "ok.", "yeah.", "hmm.",
    "thank you.", "thank you", "thanks.", "thanks for watching.",
    "thanks for watching", "please subscribe.", "you're welcome.",
    "i'm sorry.", "sorry.", "the end.", "music", "[music]", "(music)",
}

# Bias Whisper's decoder toward interview / CS / ML vocabulary. This measurably
# reduces mishears of technical jargon at the source.
DEFAULT_PROMPT = (
    "Technical job interview conversation. Topics include software engineering, "
    "machine learning, deep learning, neural networks, overfitting, "
    "regularization, gradient descent, data structures, algorithms, complexity, "
    "databases, system design, Python, JavaScript, APIs, models, training, "
    "research, projects."
)


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def is_hallucination(text):
    return text.strip().lower() in _HALLUCINATIONS


def main():
    parser = argparse.ArgumentParser()
    # --model / --rate mirror the Vosk worker so service.js passes them unchanged.
    parser.add_argument("--model", default="base.en",
                        help="Whisper model size or path (e.g. base.en, small.en)")
    parser.add_argument("--rate", type=int, default=SAMPLE_RATE)
    # Default to the project-local models/whisper folder (portable across clones);
    # faster-whisper auto-downloads the model here on first run if missing.
    _project_whisper_dir = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "models", "whisper")
    )
    parser.add_argument("--download-root",
                        default=os.environ.get("WHISPER_MODELS", _project_whisper_dir))
    parser.add_argument("--compute-type", default=os.environ.get("WHISPER_COMPUTE", "int8"))
    parser.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cpu"))
    parser.add_argument("--silence-rms", type=float, default=320.0,
                        help="RMS below this (int16 scale) counts as silence")
    parser.add_argument("--silence-ms", type=int, default=650,
                        help="Trailing pause that ends an utterance")
    parser.add_argument("--min-speech-ms", type=int, default=250)
    parser.add_argument("--max-utter-ms", type=int, default=13000,
                        help="Force-cut an utterance this long even without a pause")
    parser.add_argument("--partial-ms", type=int, default=1500,
                        help="Emit a live partial every N ms of accumulated speech (0=off)")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - import guard
        emit({"type": "error", "message": f"Failed to import faster_whisper: {exc}"})
        return 1

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.download_root,
        )
    except Exception as exc:
        emit({"type": "error", "message": f"Failed to load whisper model '{args.model}': {exc}"})
        return 1

    # Prepend the user's interview topic (set in Settings) to the decoder prompt
    # so domain vocabulary is transcribed correctly at the SOURCE.
    topic_extra = os.environ.get("WHISPER_PROMPT_EXTRA", "").strip()
    initial_prompt = (f"Interview topic: {topic_extra}. {DEFAULT_PROMPT}"
                      if topic_extra else DEFAULT_PROMPT)

    def transcribe(pcm_int16):
        audio = pcm_int16.astype(np.float32) / 32768.0
        segments, _info = model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=False,            # we do our own RMS segmentation (stays fully offline)
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            temperature=0.0,
            initial_prompt=initial_prompt,
        )
        return "".join(seg.text for seg in segments).strip()

    # --- transcription worker thread -------------------------------------------
    job_q = queue.Queue()

    def worker():
        while True:
            job = job_q.get()
            if job is None:
                break
            kind, pcm = job
            # Coalesce partials: if a newer partial is already queued, skip this one.
            if kind == "partial":
                newer = False
                with job_q.mutex:
                    for item in job_q.queue:
                        if item and item[0] == "partial":
                            newer = True
                            break
                if newer:
                    continue
            try:
                text = transcribe(pcm)
            except Exception as exc:
                emit({"type": "error", "message": f"Transcribe failed: {exc}"})
                continue
            if text and not is_hallucination(text):
                emit({"type": kind, "text": text})

    worker_thread = threading.Thread(target=worker, daemon=True)
    worker_thread.start()

    emit({"type": "ready"})

    stdin = sys.stdin.buffer
    frame_bytes = int(args.rate * 0.1) * 2  # 100 ms frames

    buf = []                # int16 frames for the current utterance
    speech_ms = 0
    silence_ms = 0
    in_speech = False
    last_partial_ms = 0

    def enqueue_final():
        nonlocal buf, speech_ms, silence_ms, in_speech, last_partial_ms
        if buf and speech_ms >= args.min_speech_ms:
            job_q.put(("final", np.concatenate(buf)))
        buf = []
        speech_ms = 0
        silence_ms = 0
        in_speech = False
        last_partial_ms = 0

    try:
        while True:
            data = stdin.read(frame_bytes)
            if not data:
                break
            if len(data) % 2 == 1:
                data = data[:-1]
            frame = np.frombuffer(data, dtype=np.int16)
            if frame.size == 0:
                continue

            rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
            frame_ms = int(frame.size / args.rate * 1000)

            if rms >= args.silence_rms:
                buf.append(frame)
                speech_ms += frame_ms
                silence_ms = 0
                in_speech = True

                if args.partial_ms and (speech_ms - last_partial_ms) >= args.partial_ms:
                    last_partial_ms = speech_ms
                    job_q.put(("partial", np.concatenate(buf)))

                if speech_ms >= args.max_utter_ms:
                    enqueue_final()
            elif in_speech:
                buf.append(frame)  # keep trailing silence so word tails aren't clipped
                silence_ms += frame_ms
                if silence_ms >= args.silence_ms:
                    enqueue_final()
            # else: idle silence before any speech -> ignore
    except Exception as exc:
        emit({"type": "error", "message": f"Read loop failed: {exc}"})
        job_q.put(None)
        return 1

    enqueue_final()
    job_q.put(None)
    worker_thread.join(timeout=30)
    return 0


if __name__ == "__main__":
    sys.exit(main())
