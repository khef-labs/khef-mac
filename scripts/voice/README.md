# Voice

Voice messaging for khef. Uses native macOS speech recognition to capture voice input and send it to Claude Code sessions via khef live messages.

## Prerequisites

- macOS (uses `SFSpeechRecognizer`)
- Xcode Command Line Tools (`xcode-select --install`)
- khef API running (`npm run dev:api`)

## Setup

```bash
cd scripts/voice
make
```

Or install globally (adds `vs` alias):

```bash
npm run voice:install
```

On first run, macOS will prompt for Microphone and Speech Recognition permissions.

## Usage

### kf-voice

Dictate a message and send it to a running Claude Code session as a live message.

```bash
vs                        # Interactive — pick session from list
vs vicky                  # Direct — send to session by nickname
vs --debug vicky          # Debug mode
vs -f notes.txt           # Save transcripts to file
```

Flow:
1. Listens until you press **Enter**
2. Shows transcript for review
3. Choose: **s**end, **d**iscard, **a**ppend, **r**e-record, **f**ile, **q**uit
4. If sending: pick a session or use the one from the command line

The message arrives as a khef live message — the target session picks it up on its next prompt.

### Listen CLI

```bash
./listen                # Default: stops after 2s of silence
./listen -t 3           # 3s silence timeout
./listen -m             # Manual mode: listens until Enter is pressed
./listen -l en-GB       # British English
```

## Configuration

Set `KHEF_USER_NAME` to show your name in the recipient's inbox:

```bash
export KHEF_USER_NAME="Roger"  # Add to shell profile
```

## How It Works

1. `listen` (compiled from `listen.swift`) captures speech via macOS Speech framework, preferring on-device recognition
2. `kf-voice.sh` uses `listen -m` for open-ended dictation, then sends to sessions via the khef live message API
3. After sending, delivers an iTerm2 nudge to the target terminal pane so the session auto-reads the message
