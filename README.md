<div align="center">

# 🎓 Backbencher AI Copilot

**A real-time, on-screen AI copilot for interviews, vivas & meetings — 100% local, free, and private.**

Speaks your answers as *you*, understands your field, and stays hidden during screen-share.

*Developed by **Tauhidur Rahman Sakib***

`Electron` · `Ollama (local LLM)` · `faster-whisper (local speech-to-text)` · `Offline` · `No API keys`

</div>

---

## ✨ What it is

Backbencher AI Copilot listens to the interviewer through your system audio, transcribes the question locally, and instantly writes a strong, first-person answer in a small overlay window — using your own knowledge **and** any notes/resume you upload. Everything runs on **your machine**: no cloud, no API keys, no subscription, nothing leaves your computer.

> ⚠️ **Ethics & use:** This is an educational project — great for mock interviews, practice, live-meeting note-taking, and learning how a local LLM + speech pipeline fits together. Use it honestly and within the rules of any real assessment you take part in.

## 🚀 Features

- 🧠 **Local LLM answers** via [Ollama](https://ollama.com) — fast (~1–2s), fully offline.
- 🎙️ **Accurate speech-to-text** via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — nails technical jargon ("overfitting", "deep learning") that lighter engines mangle.
- 🎯 **Interview / Viva Topic setting** — tell it your field (e.g. *Machine Learning*, *Biology*) and it fixes mis-heard words to the right term **and** answers with that field's depth.
- 🗣️ **First-person answers** — it speaks as *you*, defends *your* decisions, and blends in your uploaded resume/notes (RAG).
- 📄 **Document Q&A** — drop in a PDF/DOCX and ask about it.
- 🖼️ **Screenshot understanding** — capture a coding problem/diagram and get an answer.
- 🫥 **Screen-share safe** — the window is hidden from screen capture; one hotkey fully hides it.
- ⚡ **Dynamic depth** — short answers by default, full detailed explanations on demand.

## 📋 Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Windows** | 10 / 11 | (macOS/Linux may work but the instructions below are for Windows) |
| **Node.js** | 18+ | <https://nodejs.org> |
| **Python** | 3.9+ | <https://python.org> — tick "Add python to PATH" during install |
| **Ollama** | latest | <https://ollama.com> — runs the local LLM |
| **GPU** | NVIDIA 4 GB+ (recommended) | Runs on CPU too, just slower |

> 💡 First-time setup downloads ~4 GB of models (one-time, needs internet). After that the app runs **fully offline**.

---

## ⚡ Quick Start (copy-paste PowerShell)

Open **PowerShell**, then run these blocks in order.

### 1. Clone the project

```powershell
git clone https://github.com/TauhidSakib/Backbencher-AI-Copilot-For-Viva.git
cd Backbencher-AI-Copilot-For-Viva
```

### 2. Run the automated setup

This installs everything (Node deps, the Python speech-to-text engine, the Whisper model, and the Ollama models):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

<details>
<summary>…or do it manually instead (click to expand)</summary>

```powershell
# Node dependencies
npm install

# Python speech-to-text engine
python -m pip install --upgrade faster-whisper numpy

# Download the Whisper model into the project (~140 MB, one-time)
python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root='models/whisper')"

# Local LLM models (Ollama must be installed)
ollama pull qwen2.5vl:3b
ollama pull nomic-embed-text
```
</details>

### 3. Make sure Ollama is running

In a **separate** PowerShell window (leave it open):

```powershell
ollama serve
```

> 🏎️ **Faster on a small GPU (optional but recommended):** let Ollama keep both models in memory so it never reloads them:
> ```powershell
> $env:OLLAMA_MAX_LOADED_MODELS = "2"
> ollama serve
> ```

### 4. Start the app

```powershell
npm start
```

That's it — the overlay appears. Press **Alt+Shift+T** to start listening, then **Alt+Shift+A** to answer the latest question.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+T` | Start / stop transcription |
| `Alt+Shift+A` | **Ask AI** — answer the latest question |
| `Alt+Shift+D` | Explain the previous answer in full detail |
| `Alt+Shift+S` | Capture a screenshot for the AI to read |
| `Alt+Shift+N` | Generate meeting notes |
| `Alt+Shift+I` | Conversation insights |
| `Alt+Shift+C` | Clear the chat |
| `Alt+Shift+H` | **Hide / show** the window (toggle — stays hidden until pressed again) |
| `Alt+Shift+←/→/↑/↓` | Move the window |
| `Alt+Shift+1…4` | Window size presets |

## ⚙️ Configuration

Open **Settings** (gear icon) in the app:

- **Interview / Viva Topic** — paste your subject (e.g. *"Machine Learning & Deep Learning — CNNs, overfitting, regularization"*). Set this **before** you start transcription for best speech accuracy. This is the single biggest quality lever.
- **Ollama model / base URL** — defaults to `qwen2.5vl:3b` at `http://localhost:11434`.
- **Programming language** — preferred language for code answers.
- **Window opacity** and **theme**.

### Handy environment overrides (optional)

| Variable | Purpose |
|----------|---------|
| `WHISPER_MODEL_PATH` | Use a Whisper model from a custom path (default: auto-downloads `base.en` into `models/whisper`) |
| `VOSK_PYTHON` | Python command used to launch the STT worker (default: `python`) |
| `OLLAMA_NUM_GPU` | Force GPU layers (default `99` = all on GPU; set `0` for CPU/auto) |
| `OLLAMA_NUM_CTX` / `OLLAMA_NUM_PREDICT` | Context / output token limits |

## 🧩 How it works

```
System audio ──► faster-whisper (local, CPU) ──► live transcript
                                                      │
Your resume / PDFs ──► embeddings (nomic) ──► RAG ────┤
                                                      ▼
                     Ollama LLM (qwen2.5vl:3b, GPU)  ──►  first-person answer in the overlay
```

- The **speech-to-text** worker (`src/services/vosk/transcribe_whisper.py`) runs on CPU so it never competes with the LLM for GPU memory.
- The **LLM** runs on the GPU via Ollama for ~1–2s answers.
- The **Interview Topic** biases both the transcriber's vocabulary and the LLM's prompt.

## 🛠️ Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Cannot connect to Ollama"** | Make sure `ollama serve` is running in another window. |
| **Answers are very slow / freeze** | Ensure Ollama is using the GPU. On a 4 GB GPU keep `OLLAMA_MAX_LOADED_MODELS=2`. The first answer after launch is slower (one-time model load). |
| **No transcription / STT worker error** | Confirm `python` is on PATH and `python -c "import faster_whisper"` works. Re-run `scripts/setup.ps1`. |
| **Model not found** | Run `ollama pull qwen2.5vl:3b` and `ollama pull nomic-embed-text`. |
| **Wrong technical words transcribed** | Set your **Interview / Viva Topic** in Settings before starting. |

## 🏗️ Build a standalone .exe (optional)

```powershell
npm run build:win
```

Output lands in `dist/`.

## 🙏 Credits


- Built with [Electron](https://electronjs.org), [Ollama](https://ollama.com), and [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

## 📄 License

[MIT](LICENSE) © 2026 Tauhidur Rahman Sakib
