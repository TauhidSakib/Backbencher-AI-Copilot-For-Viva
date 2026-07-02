# ==========================================================================
# Backbencher AI Copilot - one-shot setup (Windows / PowerShell)
# Run from the project root:   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
# ==========================================================================
$ErrorActionPreference = "Stop"

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Yellow }

Write-Host "=== Backbencher AI Copilot - setup ===" -ForegroundColor Cyan

# --- sanity checks --------------------------------------------------------
Write-Host "`nChecking prerequisites..." -ForegroundColor Cyan
foreach ($cmd in @("node","npm","python")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "  MISSING: '$cmd' is not installed or not on PATH." -ForegroundColor Red
    Write-Host "  Install it first (see README Requirements), then re-run this script." -ForegroundColor Red
    exit 1
  }
  Write-Host ("  OK  {0,-7} {1}" -f $cmd, ((& $cmd --version) 2>&1 | Select-Object -First 1))
}
$hasOllama = [bool](Get-Command ollama -ErrorAction SilentlyContinue)
if ($hasOllama) { Write-Host "  OK  ollama  $((ollama --version) 2>&1 | Select-Object -First 1)" }
else { Write-Host "  WARN ollama not found - install from https://ollama.com (needed to run the app)." -ForegroundColor DarkYellow }

# --- 1. Node dependencies -------------------------------------------------
Step "1/4" "Installing Node dependencies (npm install)..."
npm install

# --- 2. Python speech-to-text dependencies --------------------------------
Step "2/4" "Installing Python speech-to-text deps (faster-whisper, numpy)..."
python -m pip install --upgrade pip
python -m pip install --upgrade faster-whisper numpy

# --- 3. Download the Whisper model into the project -----------------------
Step "3/4" "Downloading Whisper model (base.en, ~140 MB, one-time)..."
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root='models/whisper'); print('Whisper model ready.')"

# --- 4. Pull the local LLM models -----------------------------------------
Step "4/4" "Pulling Ollama models (qwen2.5vl:3b + nomic-embed-text)..."
if ($hasOllama) {
  ollama pull qwen2.5vl:3b
  ollama pull nomic-embed-text
} else {
  Write-Host "  Skipped - Ollama not installed. After installing, run:" -ForegroundColor DarkYellow
  Write-Host "    ollama pull qwen2.5vl:3b" -ForegroundColor DarkYellow
  Write-Host "    ollama pull nomic-embed-text" -ForegroundColor DarkYellow
}

Write-Host "`n=== Setup complete! ===" -ForegroundColor Green
Write-Host "Make sure Ollama is running (ollama serve), then start the app:" -ForegroundColor Green
Write-Host "    npm start" -ForegroundColor White
