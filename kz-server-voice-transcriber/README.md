# Chatter voice service

Authenticated local speech-to-text and text-to-speech service. It is designed for a small CPU-only server and serializes Whisper and TTS work so that expensive jobs do not run at the same time.

## Default speech engines

- Speech recognition: multilingual `whisper.cpp`, language detection set to `auto`.
- Russian TTS: Silero `v5_5_ru`, speaker `eugene`.
- English TTS: Piper with a locally installed medium voice.
- Edge TTS: optional endpoint/fallback; it is not required by the local default.

`POST /api/silero` is retained for backend compatibility. Despite the legacy name, it now routes Russian text to Silero and English text to Piper. Send `language: "ru"`, `"en"`, or `"auto"`; without it, the service detects Cyrillic versus Latin text and uses `TTS_DEFAULT_LANGUAGE` for text containing no letters.

## Installation

Install Node and Python dependencies:

```bash
npm ci
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

The host also needs `ffmpeg`, a built `whisper-cli`, and a multilingual Whisper model at the paths currently configured in `index.js`.

Download an English Piper voice into the ignored model directory:

```bash
mkdir -p models/piper
cd models/piper
python3 -m piper.download_voices en_US-lessac-medium
cd ../..
```

Create the runtime configuration and set a long random bearer token:

```bash
cp .env.example .env
```

Then start the service:

```bash
npm start
```

Piper is started lazily on the first English synthesis request and keeps its model in memory. TTS has a bounded FIFO queue, and a shared compute lock prevents it from competing with Whisper on a weak server.

## TTS request

```bash
curl -X POST http://127.0.0.1:3030/api/silero \
  -H "Authorization: Bearer $VOICE_TRANSCRIBE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from Chatter","language":"auto"}' \
  --output reply.wav
```

The response includes `X-TTS-Language` and `X-TTS-Provider` headers for diagnostics.

## Licensing note

Silero's regular Russian TTS models, including `v5_5_ru`, use a non-commercial model license. The current Piper engine is GPL-3.0, and every Piper voice can have its own dataset/model terms. Review and preserve the selected engine and voice licenses before redistributing a Docker image or enabling commercial use.
