#!/usr/bin/env python3
"""
Offline Vosk streaming transcription worker for Backbencher AI Copilot.

Reads raw 16-bit little-endian mono PCM audio from stdin (the same format the
Electron renderer already produces: 16 kHz, mono, Int16) and emits newline
delimited JSON results on stdout:

    {"type": "ready"}
    {"type": "partial", "text": "..."}
    {"type": "final",   "text": "..."}
    {"type": "error",   "message": "..."}

One process is spawned per audio source (mic / system) by the Node service.
"""

import argparse
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to the Vosk model directory")
    parser.add_argument("--rate", type=int, default=16000, help="Input sample rate (Hz)")
    args = parser.parse_args()

    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
    except Exception as exc:  # pragma: no cover - import guard
        emit({"type": "error", "message": f"Failed to import vosk: {exc}"})
        return 1

    # Silence Vosk's verbose Kaldi logging (it would otherwise pollute stderr).
    SetLogLevel(-1)

    try:
        model = Model(args.model)
    except Exception as exc:
        emit({"type": "error", "message": f"Failed to load model at {args.model}: {exc}"})
        return 1

    recognizer = KaldiRecognizer(model, args.rate)
    recognizer.SetWords(False)

    emit({"type": "ready"})

    stdin = sys.stdin.buffer
    # ~100 ms of audio per read (1600 samples * 2 bytes); Vosk tolerates any size.
    read_size = 3200

    last_partial = ""

    try:
        while True:
            data = stdin.read(read_size)
            if not data:
                break

            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                text = (result.get("text") or "").strip()
                if text:
                    emit({"type": "final", "text": text})
                    last_partial = ""
            else:
                partial = json.loads(recognizer.PartialResult())
                text = (partial.get("partial") or "").strip()
                if text and text != last_partial:
                    last_partial = text
                    emit({"type": "partial", "text": text})
    except Exception as exc:
        emit({"type": "error", "message": f"Transcription loop failed: {exc}"})
        return 1

    # Flush whatever remains when the stream is closed.
    try:
        final = json.loads(recognizer.FinalResult())
        text = (final.get("text") or "").strip()
        if text:
            emit({"type": "final", "text": text})
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
