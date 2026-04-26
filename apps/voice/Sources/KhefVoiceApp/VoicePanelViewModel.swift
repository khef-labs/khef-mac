import AppKit
import Foundation
import CoreGraphics
import UniformTypeIdentifiers

@MainActor
final class VoicePanelViewModel: ObservableObject {
    private enum DefaultsKey {
        static let selectedTarget = "voice.selectedTarget"
        static let recentTargetIDs = "voice.recentTargetIDs"
    }

    @Published var state: VoiceComposerState = .idle
    @Published var transcript = ""
    @Published var draftTarget = ""
    @Published var selectedTargets: Set<String> = []
    @Published var sessions: [ActiveSession] = []
    @Published var recentTargets: [ActiveSession] = []
    @Published var isSessionPickerExpanded = false
    @Published var sessionSearch = ""
    @Published var isBusy = false
    @Published var statusMessage = "Tap to record"
    @Published var errorMessage: String?
    @Published var didJustSend = false
    @Published var audioLevels: [CGFloat] = Array(repeating: 0.08, count: 12)

    let senderName: String

    private let apiClient: KhefAPIClient
    private let speechClient: SpeechRecognizerClient
    private var recordingPrefix = ""
    private let defaults = UserDefaults.standard

    init(apiClient: KhefAPIClient, speechClient: SpeechRecognizerClient) {
        self.apiClient = apiClient
        self.speechClient = speechClient
        self.senderName = ProcessInfo.processInfo.environment["KHEF_USER_NAME"] ?? NSUserName()
        let saved = defaults.string(forKey: DefaultsKey.selectedTarget) ?? ""
        self.draftTarget = saved
        if !saved.isEmpty {
            self.selectedTargets = [saved]
        }
    }

    var selectedTarget: ActiveSession? {
        sessions.first(where: { $0.id == draftTarget || $0.nickname == draftTarget })
            ?? recentTargets.first(where: { $0.id == draftTarget || $0.nickname == draftTarget })
    }

    var canSend: Bool {
        !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !selectedTargets.isEmpty
    }

    var filteredSessionGroups: [SessionGroup] {
        let q = sessionSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = q.isEmpty
            ? sessions
            : sessions.filter {
                $0.displayName.lowercased().contains(q) || $0.projectName.lowercased().contains(q)
            }

        let grouped = Dictionary(grouping: filtered, by: \.projectName)
        return grouped.keys.sorted().map { key in
            SessionGroup(name: key, sessions: grouped[key, default: []].sorted { $0.displayName < $1.displayName })
        }
    }

    func onAppear() {
        Task { await refreshSessions() }
        startSessionPolling()
    }

    private func startSessionPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
                guard let self else { return }
                await self.refreshSessions()
            }
        }
    }

    func refreshSessions() async {
        isBusy = true
        defer { isBusy = false }

        do {
            let fetched = try await apiClient.fetchActiveSessions()
            let active = fetched
                .filter(\.isActive)
                .sorted { lhs, rhs in
                    if lhs.projectName == rhs.projectName {
                        return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
                    }
                    return lhs.projectName.localizedCaseInsensitiveCompare(rhs.projectName) == .orderedAscending
                }

            sessions = active
            restoreRecentTargets(from: active)
            // Prune stale selections that no longer match any active session
            let validKeys = Set(active.flatMap { [$0.nickname, $0.sessionID].compactMap { $0 } })
            selectedTargets = selectedTargets.intersection(validKeys)
            if !validKeys.contains(draftTarget) {
                draftTarget = selectedTargets.first ?? ""
            }
            if selectedTargets.isEmpty, let first = recentTargets.first ?? active.first {
                let key = first.nickname ?? first.sessionID
                draftTarget = key
                selectedTargets = [key]
            }
            statusMessage = active.isEmpty ? "No active sessions found" : "Tap to record"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            statusMessage = "Unable to load sessions"
        }
    }

    func toggleSessionPicker() {
        isSessionPickerExpanded.toggle()
    }

    func selectSession(_ session: ActiveSession) {
        let key = session.nickname ?? session.sessionID
        if selectedTargets.contains(key) {
            selectedTargets.remove(key)
            if draftTarget == key {
                draftTarget = selectedTargets.first ?? ""
            }
        } else {
            selectedTargets.insert(key)
            draftTarget = key
        }
        persistSelectedTarget()
        pushRecentTarget(session)
        didJustSend = false
    }

    func startRecording() {
        guard state != .recording else { return }
        errorMessage = nil
        didJustSend = false
        recordingPrefix = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        state = .recording
        statusMessage = "Recording\u{2026}"

        Task {
            do {
                try await speechClient.startRecording { [weak self] fullText in
                    guard let self else { return }
                    // The recognizer already accumulates across timeouts.
                    // We just prepend any existing transcript (for Append).
                    let prefix = self.recordingPrefix
                    if prefix.isEmpty {
                        self.transcript = fullText
                    } else if fullText.isEmpty {
                        self.transcript = prefix
                    } else {
                        self.transcript = "\(prefix) \(fullText)"
                    }
                } onLevel: { [weak self] level in
                    self?.pushAudioLevel(level)
                }
            } catch {
                self.state = .idle
                self.statusMessage = "Recording failed"
                self.errorMessage = error.localizedDescription
                self.resetAudioLevels()
            }
        }
    }

    func stopRecording() {
        guard state == .recording else { return }
        isBusy = true

        Task {
            defer { self.isBusy = false }

            do {
                let text = try await speechClient.stopRecording()
                let prefix = self.recordingPrefix
                if prefix.isEmpty {
                    self.transcript = text
                } else if text.isEmpty {
                    self.transcript = prefix
                } else {
                    self.transcript = "\(prefix) \(text)"
                }
                self.state = .review
                self.statusMessage = "Review transcript"
                self.resetAudioLevels()
            } catch {
                self.state = .idle
                self.statusMessage = "Recording failed"
                self.errorMessage = error.localizedDescription
                self.resetAudioLevels()
            }
        }
    }

    func resetComposer() {
        transcript = ""
        recordingPrefix = ""
        state = .idle
        didJustSend = false
        statusMessage = "Tap to record"
        errorMessage = nil
        resetAudioLevels()
    }

    func reRecord() {
        transcript = ""
        recordingPrefix = ""
        state = .idle
        startRecording()
    }

    func appendRecording() {
        startRecording()
    }

    func saveToFile() {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let panel = NSSavePanel()
        panel.title = "Save Transcript"
        panel.nameFieldStringValue = defaultFileName()
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true

        // Default to tmp/voice/ in the project
        let projectRoot = ProcessInfo.processInfo.environment["KHEF_PROJECT_ROOT"]
            ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/projects/khef")
        let voiceDir = "\(projectRoot)/tmp/voice"
        try? FileManager.default.createDirectory(atPath: voiceDir, withIntermediateDirectories: true)
        panel.directoryURL = URL(fileURLWithPath: voiceDir)

        let response = panel.runModal()
        guard response == .OK, let url = panel.url else { return }
        do {
            try (text + "\n").write(to: url, atomically: true, encoding: .utf8)
            statusMessage = "Saved to \(url.lastPathComponent)"
            errorMessage = nil
        } catch {
            errorMessage = "Save failed: \(error.localizedDescription)"
        }
    }

    private func defaultFileName() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let timestamp = formatter.string(from: Date())
        let target = draftTarget.isEmpty ? "transcript" : draftTarget
        return "\(target)-\(timestamp).txt"
    }

    func send() {
        guard canSend else { return }
        isBusy = true
        errorMessage = nil

        let targets = Array(selectedTargets)
        let body = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer {
                Task { @MainActor in
                    self.isBusy = false
                }
            }

            var delivered: [String] = []
            var lastError: Error?
            for target in targets {
                do {
                    _ = try await apiClient.sendMessage(transcript: body, to: target, from: senderName)
                    delivered.append(target)
                } catch {
                    lastError = error
                }
            }

            await MainActor.run {
                if delivered.isEmpty, let error = lastError {
                    self.errorMessage = error.localizedDescription
                    self.statusMessage = "Send failed"
                } else {
                    self.state = .sent
                    self.didJustSend = true
                    if delivered.count == 1 {
                        self.statusMessage = "Sent to \(delivered[0])"
                    } else {
                        self.statusMessage = "Sent to \(delivered.count) sessions"
                    }
                    if let error = lastError {
                        self.errorMessage = "Partial send: \(error.localizedDescription)"
                    }
                }
            }
        }
    }

    private func pushRecentTarget(_ session: ActiveSession) {
        let unique = [session] + recentTargets.filter { $0.id != session.id }
        recentTargets = Array(unique.prefix(3))
        defaults.set(recentTargets.map(\.sessionID), forKey: DefaultsKey.recentTargetIDs)
    }

    func toggleRecordingFromMenuBar() {
        if state == .recording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    private func pushAudioLevel(_ level: Float) {
        let mapped = CGFloat(max(0.08, min(level, 1)))
        audioLevels.removeFirst()
        audioLevels.append(mapped)
    }

    private func resetAudioLevels() {
        audioLevels = Array(repeating: 0.08, count: 12)
    }

    private func persistSelectedTarget() {
        defaults.set(draftTarget, forKey: DefaultsKey.selectedTarget)
    }

    private func restoreRecentTargets(from active: [ActiveSession]) {
        let savedIDs = defaults.stringArray(forKey: DefaultsKey.recentTargetIDs) ?? []
        // Match by sessionID or nickname for resilience
        let byID = Dictionary(uniqueKeysWithValues: active.map { ($0.sessionID, $0) })
        let byNick = Dictionary(active.compactMap { s in s.nickname.map { ($0, s) } }, uniquingKeysWith: { first, _ in first })
        recentTargets = savedIDs.compactMap { byID[$0] ?? byNick[$0] }
        // If no persisted recents, seed with the first few active sessions
        if recentTargets.isEmpty {
            recentTargets = Array(active.prefix(3))
        }
        if !draftTarget.isEmpty, selectedTarget == nil, let session = active.first(where: { $0.nickname == draftTarget }) {
            draftTarget = session.nickname ?? session.sessionID
            persistSelectedTarget()
        }
    }
}
