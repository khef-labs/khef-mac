# Khef Voice App

Native macOS scaffold for the `kf-voice` replacement: a menu-bar voice-control panel that listens, transcribes, and routes prompts into the active Claude Code or Codex CLI session.

## Current Scope

This scaffold includes:

- Swift Package Manager app target
- floating `NSPanel` host with SwiftUI content
- recent session chips + searchable session picker
- transcript review area
- real session fetch and live-message send calls against the khef API
- global hotkey (`Ctrl+Shift+V`) to start/stop recording
- live microphone capture + speech recognition
- waveform driven by live input levels
- menu bar utility entry
- developer `.app` bundle script

Not implemented yet:

- persisted window position / settings
- polished waveform animation
- code signing / notarization / installer packaging

## Run

```bash
cd apps/voice
swift run
```

Or from the repo root:

```bash
npm run voice:app:run
```

## Bundle As `.app`

```bash
npm run voice:app:bundle
open "apps/voice/dist/Khef Voice.app"
```

The app uses `KHEF_API_URL` if present and otherwise defaults to `http://localhost:3201`.

## Structure

```text
apps/voice/
├── Package.swift
├── README.md
└── Sources/KhefVoiceApp/
    ├── AppDelegate.swift
    ├── FloatingPanelController.swift
    ├── KhefAPIClient.swift
    ├── KhefVoiceApp.swift
    ├── Models.swift
    ├── SpeechRecognizerClient.swift
    ├── VoicePanelView.swift
    └── VoicePanelViewModel.swift
```

## Next Steps

1. Replace `SpeechRecognizerClient` placeholder methods with the existing `SFSpeechRecognizer` flow from [scripts/voice/listen.swift](../../scripts/voice/listen.swift).
2. Add iTerm2 nudge delivery after successful send, matching [scripts/voice/kf-voice.sh](../../scripts/voice/kf-voice.sh).
3. Add a menu bar extra and global hotkey once the core recording flow is stable.
