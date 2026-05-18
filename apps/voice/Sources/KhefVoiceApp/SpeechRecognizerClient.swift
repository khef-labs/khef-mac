import AVFoundation
import Foundation
import Speech

@MainActor
final class SpeechRecognizerClient: NSObject {
    private let locale: String
    private let audioEngine = AVAudioEngine()

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var updateHandler: ((String) -> Void)?
    private var levelHandler: ((Float) -> Void)?

    // Accumulation state — mirrors listen.swift's proven approach.
    // `blocks` holds finalized paragraphs (one per manual break);
    // `accumulatedText` + `lastTranscription` hold the in-progress paragraph.
    private var blocks: [String] = []
    private var accumulatedText = ""
    private var lastTranscription = ""
    private var lastNonEmptySegment = ""
    private var taskGeneration = 0
    private var isRecording = false
    private var isRestarting = false

    init(locale: String = "en-US") {
        self.locale = locale
        super.init()
    }

    func startRecording(onUpdate: @escaping (String) -> Void, onLevel: @escaping (Float) -> Void) async throws {
        guard !isRecording else { return }

        try await requestPermissions()

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
            throw SpeechRecognizerError.recognizerUnavailable
        }
        guard recognizer.isAvailable else {
            throw SpeechRecognizerError.recognizerBusy
        }

        speechRecognizer = recognizer
        updateHandler = onUpdate
        levelHandler = onLevel
        blocks = []
        accumulatedText = ""
        lastTranscription = ""
        lastNonEmptySegment = ""
        taskGeneration = 0
        isRestarting = false

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13.0, *) {
            request.requiresOnDeviceRecognition = true
        }
        recognitionRequest = request

        installAudioTap(for: request)

        audioEngine.prepare()
        try audioEngine.start()
        isRecording = true

        startRecognitionTask(with: request)
    }

    func stopRecording() async throws -> String {
        guard isRecording else {
            return fullTranscription()
        }

        isRecording = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil

        let result = fullTranscription()
        updateHandler?(result)
        updateHandler = nil
        levelHandler?(0)
        levelHandler = nil
        return result
    }

    /// Finalizes the in-progress paragraph and starts a fresh one. Called while
    /// recording. The recognition task is restarted so the recognizer
    /// transcribes fresh from this point — without it the next partial would
    /// echo the whole paragraph back, since `bestTranscription.formattedString`
    /// is cumulative per task.
    func insertBreak() {
        guard isRecording else { return }

        let segment = !lastTranscription.isEmpty ? lastTranscription : lastNonEmptySegment
        let finalizedText = [accumulatedText, segment]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !finalizedText.isEmpty {
            blocks.append(finalizedText)
        }

        accumulatedText = ""
        lastTranscription = ""
        lastNonEmptySegment = ""

        restartRecognitionTask()
        updateHandler?(fullTranscription())
    }

    // MARK: - Recognition task (matches listen.swift approach)

    private func startRecognitionTask(with request: SFSpeechAudioBufferRecognitionRequest) {
        guard let recognizer = speechRecognizer else { return }
        let gen = taskGeneration

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.isRecording else { return }
                // Ignore callbacks from stale cancelled tasks
                guard gen == self.taskGeneration else { return }

                if let result {
                    let current = result.bestTranscription.formattedString

                    // Detect recognizer internal reset: new text shares no common prefix
                    // Normal partials: "Hello" → "Hello world" (shared prefix)
                    // Reset: "Happy" → "Tuesday" (no shared prefix)
                    let commonPrefix = current.commonPrefix(with: self.lastTranscription)
                    if !self.lastTranscription.isEmpty && !current.isEmpty
                        && self.lastTranscription.count >= 3 && commonPrefix.count < 3 {
                        // Save previous segment before it's lost
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
                    self.updateHandler?(self.fullTranscription())

                    if result.isFinal {
                        self.accumulateAndRestart()
                    }
                }

                if let error {
                    let code = (error as NSError).code
                    // 216 = cancelled by us, ignore
                    if code == 216 { return }
                    self.accumulateAndRestart()
                }
            }
        }
    }

    private func accumulateAndRestart() {
        guard isRecording, !isRestarting else { return }

        // Save current segment into the in-progress paragraph
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

        restartRecognitionTask()
    }

    /// Tears down the current recognition task/request and schedules a fresh
    /// one. Shared by the silence/timeout restart (`accumulateAndRestart`) and
    /// manual paragraph breaks (`insertBreak`).
    private func restartRecognitionTask() {
        guard isRecording, !isRestarting else { return }
        isRestarting = true

        // Bump generation so stale callbacks from the old task are ignored
        taskGeneration += 1

        // Remove the tap before tearing down the old request to prevent an
        // in-flight append(buffer:) call from racing with ARC release of the
        // old SFSpeechAudioBufferRecognitionRequest (SIGILL on its dispatch
        // queue otherwise).
        audioEngine.inputNode.removeTap(onBus: 0)

        // Cancel old task and drop the old request
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        // Delay restart to let stale callbacks drain
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self, self.isRecording else { return }
            self.isRestarting = false

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if #available(macOS 13.0, *), self.speechRecognizer?.supportsOnDeviceRecognition == true {
                request.requiresOnDeviceRecognition = true
            }
            self.recognitionRequest = request
            self.installAudioTap(for: request)
            self.startRecognitionTask(with: request)
        }
    }

    private func installAudioTap(for request: SFSpeechAudioBufferRecognitionRequest) {
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        // Capture the request directly in the closure. Reading
        // self.recognitionRequest from the audio thread would race with
        // the main-actor property swap during accumulateAndRestart.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self, weak request] buffer, _ in
            request?.append(buffer)
            let level = Self.normalizedAudioLevel(from: buffer)
            DispatchQueue.main.async {
                self?.levelHandler?(level)
            }
        }
    }

    private func fullTranscription() -> String {
        let currentText = [accumulatedText, lastTranscription]
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        return (blocks + [currentText])
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    // MARK: - Permissions

    private func requestPermissions() async throws {
        let speechAuthorized = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speechAuthorized else {
            throw SpeechRecognizerError.speechPermissionDenied
        }

        let audioAuthorized = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
        guard audioAuthorized else {
            throw SpeechRecognizerError.microphonePermissionDenied
        }
    }

    nonisolated private static func normalizedAudioLevel(from buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData?[0] else { return 0 }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0 }

        var sum: Float = 0
        for index in 0..<frameLength {
            let sample = channelData[index]
            sum += sample * sample
        }

        let rms = sqrt(sum / Float(frameLength))
        return min(max(rms * 12, 0), 1)
    }
}

enum SpeechRecognizerError: LocalizedError {
    case recognizerUnavailable
    case recognizerBusy
    case speechPermissionDenied
    case microphonePermissionDenied

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            "Speech recognizer is unavailable for the configured locale."
        case .recognizerBusy:
            "Speech recognizer is not available right now."
        case .speechPermissionDenied:
            "Speech recognition permission was denied."
        case .microphonePermissionDenied:
            "Microphone permission was denied."
        }
    }
}
