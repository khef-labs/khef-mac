// listen.swift — Native macOS speech-to-text CLI using SFSpeechRecognizer
//
// Build:  swiftc -O -framework Speech -framework AVFoundation -o listen listen.swift
// Usage:  ./listen [-t <seconds>]
//
// Captures speech from the default microphone, prints transcription to stdout.
// Status/progress goes to stderr so stdout stays clean for piping.
// Stops automatically after a silence timeout (default: 2s).
//
// First run will prompt for Microphone and Speech Recognition permissions.

import Foundation
import Speech
import AVFoundation

@available(macOS 10.15, *)
class SpeechListener {
    private let speechRecognizer: SFSpeechRecognizer
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var silenceTimer: DispatchSourceTimer?
    private var stdinSource: DispatchSourceRead?
    private var lastTranscription = ""
    private var lastNonEmptySegment = ""
    private var accumulatedText = ""
    private var hasFinished = false
    private var taskGeneration = 0
    private let silenceTimeout: TimeInterval
    private let manualStop: Bool

    init(locale: String = "en-US", silenceTimeout: TimeInterval = 2.0, manualStop: Bool = false) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
            fputs("Speech recognizer not available for locale: \(locale)\n", stderr)
            exit(1)
        }
        self.speechRecognizer = recognizer
        self.silenceTimeout = silenceTimeout
        self.manualStop = manualStop
    }

    func start() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    self.startListening()
                case .denied:
                    fputs("Speech recognition denied. Enable in System Settings > Privacy > Speech Recognition.\n", stderr)
                    exit(1)
                case .restricted:
                    fputs("Speech recognition restricted on this device.\n", stderr)
                    exit(1)
                case .notDetermined:
                    fputs("Speech recognition not determined.\n", stderr)
                    exit(1)
                @unknown default:
                    fputs("Unknown authorization status.\n", stderr)
                    exit(1)
                }
            }
        }

        // Keep the process alive for async callbacks
        dispatchMain()
    }

    private func startListening() {
        guard speechRecognizer.isAvailable else {
            fputs("Speech recognizer not available right now.\n", stderr)
            exit(1)
        }

        // Prefer on-device recognition (no network, faster, private)
        if #available(macOS 13.0, *), speechRecognizer.supportsOnDeviceRecognition {
            fputs("Using on-device recognition.\n", stderr)
        } else {
            fputs("Using server-based recognition.\n", stderr)
        }

        // Set up the first recognition request
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13.0, *), speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.recognitionRequest = request

        // Install ONE audio tap that always feeds self.recognitionRequest.
        // This tap stays for the lifetime of the listener — restarts just swap the request.
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            fputs("Audio engine failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }

        if manualStop {
            fputs("Listening... (press Enter to stop)\n", stderr)
            startStdinMonitor()
        } else {
            fputs("Listening... (speak now)\n", stderr)
        }

        // Start the recognition task with the already-configured request
        startRecognitionTaskWith(request)
    }

    private func startStdinMonitor() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in
            // Read and discard the input (the Enter keypress)
            var buf = [UInt8](repeating: 0, count: 256)
            let _ = read(STDIN_FILENO, &buf, 256)
            self?.finish()
        }
        source.resume()
        self.stdinSource = source
    }

    private func resetSilenceTimer() {
        silenceTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + silenceTimeout)
        timer.setEventHandler { [weak self] in
            self?.finish()
        }
        timer.resume()
        silenceTimer = timer
    }

    private func fullTranscription() -> String {
        if accumulatedText.isEmpty {
            return lastTranscription
        } else if lastTranscription.isEmpty {
            return accumulatedText
        } else {
            return accumulatedText + " " + lastTranscription
        }
    }

    private var isRestarting = false

    private func accumulateAndRestart() {
        guard !hasFinished, !isRestarting else { return }
        isRestarting = true
        // Bump generation so stale callbacks from the old task are ignored
        taskGeneration += 1
        // Save current segment — use lastNonEmptySegment as fallback
        let segment = !lastTranscription.isEmpty ? lastTranscription : lastNonEmptySegment
        if !segment.isEmpty {
            if accumulatedText.isEmpty {
                accumulatedText = segment
            } else {
                accumulatedText += " " + segment
            }
        }
        lastTranscription = ""
        lastNonEmptySegment = ""
        // Cancel the old task (but don't endAudio — tap keeps running)
        recognitionTask?.cancel()
        recognitionTask = nil
        // Delay restart to let stale callbacks from the cancelled task drain
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, !self.hasFinished else { return }
            self.isRestarting = false
            self.restartRecognitionTask()
        }
    }

    /// Restart just the recognition task. Audio engine and tap stay running.
    private func restartRecognitionTask() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13.0, *), speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        // Swap the request — the existing tap automatically feeds the new one
        self.recognitionRequest = request
        startRecognitionTaskWith(request)
    }

    /// Wire up the recognition task callback for a given request.
    private func startRecognitionTaskWith(_ request: SFSpeechAudioBufferRecognitionRequest) {
        let gen = self.taskGeneration
        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self, !self.hasFinished else { return }
            // Ignore callbacks from stale (cancelled) recognition tasks
            guard gen == self.taskGeneration else { return }

            if let result = result {
                let current = result.bestTranscription.formattedString

                // Detect recognizer internal reset: new text doesn't continue from old text.
                // Normal partial results share a common prefix (e.g., "Hello" → "Hello world").
                // A reset produces unrelated text (e.g., "Happy" → "Tuesday").
                let commonPrefix = current.commonPrefix(with: self.lastTranscription)
                if self.manualStop && !self.lastTranscription.isEmpty && !current.isEmpty
                    && self.lastTranscription.count >= 3 && commonPrefix.count < 3 {
                    // Save the previous segment before it's lost
                    if self.accumulatedText.isEmpty {
                        self.accumulatedText = self.lastTranscription
                    } else {
                        self.accumulatedText += " " + self.lastTranscription
                    }
                }

                self.lastTranscription = current
                if !current.isEmpty {
                    self.lastNonEmptySegment = current
                }
                let full = self.fullTranscription()
                fputs("\r\033[K> \(full)", stderr)

                if !self.manualStop {
                    self.resetSilenceTimer()
                }

                if result.isFinal {
                    if self.manualStop {
                        self.accumulateAndRestart()
                    } else {
                        self.finish()
                    }
                }
            }

            if let error = error {
                let code = (error as NSError).code
                // 216 = cancelled by us, ignore entirely
                if code == 216 { return }
                if code != 1110 {
                    fputs("\nRecognition error: \(error.localizedDescription)\n", stderr)
                }
                if self.manualStop {
                    self.accumulateAndRestart()
                } else if !self.lastTranscription.isEmpty {
                    self.finish()
                }
            }
        }
    }

    func stop() {
        finish()
    }

    private func finish() {
        guard !hasFinished else { return }
        hasFinished = true

        silenceTimer?.cancel()
        stdinSource?.cancel()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        fputs("\n", stderr)

        // Final transcription to stdout (clean, no decorations)
        let final = fullTranscription()
        print(final)
        exit(0)
    }
}

// --- CLI argument parsing ---

func printUsage() {
    fputs("""
    Usage: listen [options]

    Options:
      -t, --timeout <seconds>  Silence timeout before stopping (default: 2.0)
      -m, --manual             Listen until Enter is pressed (no silence timeout)
      -l, --locale <code>      Speech locale (default: en-US)
      -h, --help               Show this help

    Captures speech from the microphone and prints transcription to stdout.
    Progress and status messages go to stderr.

    Examples:
      ./listen                    # Default: 2s silence timeout
      ./listen -t 3               # Wait 3s of silence before stopping
      ./listen -m                 # Listen until Enter is pressed
      ./listen -l en-GB           # British English
      ./listen | pbcopy           # Capture speech to clipboard

    """, stderr)
}

var silenceTimeout = 2.0
var locale = "en-US"
var manualStop = false
var args = Array(CommandLine.arguments.dropFirst())
var i = 0

while i < args.count {
    switch args[i] {
    case "--timeout", "-t":
        i += 1
        guard i < args.count, let t = Double(args[i]) else {
            fputs("Missing or invalid value for --timeout\n", stderr)
            exit(1)
        }
        silenceTimeout = t
    case "--manual", "-m":
        manualStop = true
    case "--locale", "-l":
        i += 1
        guard i < args.count else {
            fputs("Missing value for --locale\n", stderr)
            exit(1)
        }
        locale = args[i]
    case "--help", "-h":
        printUsage()
        exit(0)
    default:
        fputs("Unknown option: \(args[i])\n", stderr)
        printUsage()
        exit(1)
    }
    i += 1
}

let listener = SpeechListener(locale: locale, silenceTimeout: silenceTimeout, manualStop: manualStop)

// Handle SIGINT/SIGTERM so Ctrl+C properly stops the audio engine and releases the mic.
// Must use dispatch signal sources since dispatchMain() blocks the main thread.
// Retain references globally so they don't get deallocated.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN) // Ignore default handling so dispatch source receives it
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        listener.stop()
    }
    source.resume()
    signalSources.append(source)
}

listener.start()
