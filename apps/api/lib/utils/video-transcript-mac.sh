#!/usr/bin/env bash

set -euo pipefail

main() {
  local force=0
  local file=""
  local outdir_override=""
  local locale="en-US"
  local on_device_only=1
  local chunk_seconds=8
  local overlap_seconds=1

  while [ $# -gt 0 ]; do
    case "$1" in
      -f|--force)
        force=1
        shift
        ;;
      --output-dir)
        outdir_override="$2"
        shift 2
        ;;
      --locale)
        locale="$2"
        shift 2
        ;;
      --allow-server)
        on_device_only=0
        shift
        ;;
      --chunk-seconds)
        chunk_seconds="$2"
        shift 2
        ;;
      --overlap-seconds)
        overlap_seconds="$2"
        shift 2
        ;;
      -h|--help)
        echo "Usage: video_transcript_mac [--force] [--output-dir DIR] [--locale en-US] [--allow-server] [--chunk-seconds 8] [--overlap-seconds 1] <media-file>" >&2
        echo "  Accepts common video and audio files such as .mp4, .mov, .m4a, .mp3, and .wav." >&2
        return 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        echo "Unknown option: $1" >&2
        return 2
        ;;
      *)
        file="$1"
        shift
        ;;
    esac
  done

  if [ -z "$file" ]; then
    echo "Usage: video_transcript_mac [--force] [--output-dir DIR] [--locale en-US] [--allow-server] [--chunk-seconds 8] [--overlap-seconds 1] <media-file>" >&2
    return 2
  fi

  if [ ! -f "$file" ]; then
    echo "File not found: $file" >&2
    return 1
  fi

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "video_transcript_mac only works on macOS" >&2
    return 1
  fi

  if ! command -v swift >/dev/null 2>&1; then
    echo "swift not found. Install Xcode Command Line Tools first." >&2
    return 127
  fi

  case "$chunk_seconds" in
    ''|*[!0-9]*)
      echo "--chunk-seconds must be a positive integer" >&2
      return 2
      ;;
  esac
  if [ "$chunk_seconds" -le 0 ]; then
    echo "--chunk-seconds must be greater than 0" >&2
    return 2
  fi
  case "$overlap_seconds" in
    ''|*[!0-9]*)
      echo "--overlap-seconds must be a non-negative integer" >&2
      return 2
      ;;
  esac
  if [ "$overlap_seconds" -ge "$chunk_seconds" ]; then
    echo "--overlap-seconds must be smaller than --chunk-seconds" >&2
    return 2
  fi

  local dir base outdir transcript_path timestamp_suffix
  dir="$(cd "$(dirname "$file")" && pwd -P)"
  base="$(basename "$file")"
  base="${base%.*}"
  outdir="$dir/transcripts"
  if [ -n "$outdir_override" ]; then
    outdir="$outdir_override"
  fi
  timestamp_suffix="$(date '+%m-%d-%y-%H%M')"

  mkdir -p "$outdir" || {
    echo "Failed to create transcripts dir: $outdir" >&2
    return 1
  }

  transcript_path="$outdir/${base}-${timestamp_suffix}.txt"
  if [ -f "$transcript_path" ] && [ $force -ne 1 ]; then
    echo "⏭️  Skipping existing transcript: $transcript_path"
    return 0
  fi

  local input_abs module_cache_dir temp_work_dir speech_input
  input_abs="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
  speech_input="$input_abs"
  module_cache_dir="$(mktemp -d "${TMPDIR:-/tmp}/video-transcript-swift-cache.XXXXXX")" || {
    echo "Failed to create temporary Swift module cache" >&2
    return 1
  }
  temp_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/video-transcript-work.XXXXXX")" || {
    rm -rf "$module_cache_dir"
    echo "Failed to create temporary work directory" >&2
    return 1
  }
  trap 'rm -rf "$module_cache_dir" "$temp_work_dir"' RETURN

  echo "🎧 Preparing Apple Speech transcription..."
  echo "   Input: $input_abs"
  echo "   Output: $transcript_path"
  echo "   Locale: $locale"
  echo "   Chunk size: ${chunk_seconds}s"
  echo "   Overlap: ${overlap_seconds}s"
  if [ "$on_device_only" -eq 1 ]; then
    echo "   Mode: on-device only"
  else
    echo "   Mode: allow Apple server fallback"
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    local normalized_audio
    normalized_audio="$temp_work_dir/normalized.wav"
    echo "   Audio prep: normalize to mono 16k PCM"
    if ffmpeg -v error -nostdin -y -i "$input_abs" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$normalized_audio"; then
      speech_input="$normalized_audio"
    else
      echo "   Audio prep fallback: using original media track" >&2
    fi
  fi

  if swift -suppress-warnings -module-cache-path "$module_cache_dir" - "$speech_input" "$transcript_path" "$locale" "$on_device_only" "$chunk_seconds" "$overlap_seconds" <<'SWIFT'
import Foundation
import AVFoundation
import Speech
import CoreMedia

enum TranscriptError: LocalizedError {
    case invalidArguments
    case missingInput(String)
    case recognizerUnavailable(String)
    case authorizationDenied(String)
    case emptyTranscript
    case unsupportedOnDevice(String)
    case recognitionTimedOut(Int)
    case invalidChunkLength(Int)
    case invalidOverlap(Int, Int)
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Invalid arguments."
        case .missingInput(let path):
            return "Input file not found: \(path)"
        case .recognizerUnavailable(let locale):
            return "Speech recognizer unavailable for locale \(locale)."
        case .authorizationDenied(let status):
            return "Speech recognition authorization failed: \(status)."
        case .emptyTranscript:
            return "Speech recognition completed, but no transcript was produced."
        case .unsupportedOnDevice(let locale):
            return "On-device speech recognition is unavailable for locale \(locale). Re-run with --allow-server to permit Apple's server-backed recognizer."
        case .recognitionTimedOut(let seconds):
            return "Speech recognition timed out after \(seconds)s."
        case .invalidChunkLength(let seconds):
            return "Chunk length must be greater than 0 seconds, got \(seconds)."
        case .invalidOverlap(let overlap, let chunk):
            return "Overlap must be at least 0 and smaller than chunk length (\(overlap) vs \(chunk))."
        case .exportFailed(let message):
            return "Audio extraction failed: \(message)"
        }
    }
}

func authorizeSpeechRecognition() throws {
    let semaphore = DispatchSemaphore(value: 0)
    var authorizationStatus: SFSpeechRecognizerAuthorizationStatus?

    SFSpeechRecognizer.requestAuthorization { status in
        authorizationStatus = status
        semaphore.signal()
    }

    semaphore.wait()

    guard let status = authorizationStatus else {
        throw TranscriptError.authorizationDenied("unknown")
    }

    guard status == .authorized else {
        let description: String
        switch status {
        case .notDetermined:
            description = "not determined"
        case .denied:
            description = "denied"
        case .restricted:
            description = "restricted"
        case .authorized:
            description = "authorized"
        @unknown default:
            description = "unknown (\(status.rawValue))"
        }
        throw TranscriptError.authorizationDenied(description)
    }
}

func transcribeChunk(at audioURL: URL, recognizer: SFSpeechRecognizer, onDeviceOnly: Bool) throws -> String {
    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = onDeviceOnly
    request.taskHint = .dictation
    if #available(macOS 13.0, *) {
        request.addsPunctuation = true
    }

    var bestTranscript: String?
    var recognitionError: Error?
    var isFinished = false
    let timeoutSeconds = 60
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))

    var task: SFSpeechRecognitionTask?
    task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            bestTranscript = result.bestTranscription.formattedString
            if result.isFinal {
                isFinished = true
                return
            }
        }

        if let error = error {
            recognitionError = error
            isFinished = true
        }
    }

    while !isFinished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
    }

    task?.cancel()

    if !isFinished {
        throw TranscriptError.recognitionTimedOut(timeoutSeconds)
    }

    if let transcript = bestTranscript?.trimmingCharacters(in: .whitespacesAndNewlines), !transcript.isEmpty {
        return transcript
    }

    if let recognitionError = recognitionError {
        throw recognitionError
    }

    throw TranscriptError.emptyTranscript
}

func normalizeWord(_ word: String) -> String {
    let lowered = word.lowercased()
    let filtered = lowered.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
    return String(String.UnicodeScalarView(filtered))
}

func wordOverlapScore(_ lhs: ArraySlice<String>, _ rhs: ArraySlice<String>) -> Double {
    let left = lhs.map(normalizeWord).filter { !$0.isEmpty }
    let right = rhs.map(normalizeWord).filter { !$0.isEmpty }
    guard !left.isEmpty, !right.isEmpty else {
        return 0
    }

    var matches = 0
    for (l, r) in zip(left, right) {
        if l == r {
            matches += 1
        }
    }
    return Double(matches) / Double(max(left.count, right.count))
}

func normalizedWords(_ text: String) -> [String] {
    text.split(separator: " ").map(String.init).map(normalizeWord).filter { !$0.isEmpty }
}

func lineSimilarity(_ lhs: String, _ rhs: String) -> Double {
    let left = normalizedWords(lhs)
    let right = normalizedWords(rhs)
    guard !left.isEmpty, !right.isEmpty else {
        return 0
    }

    let maxWindow = min(left.count, right.count, 16)
    var best = 0.0
    if maxWindow >= 2 {
        for width in stride(from: maxWindow, through: 2, by: -1) {
            best = max(
                best,
                wordOverlapScore(ArraySlice(left.suffix(width)), ArraySlice(right.prefix(width))),
                wordOverlapScore(ArraySlice(left.prefix(width)), ArraySlice(right.prefix(width)))
            )
            if best >= 0.95 {
                return best
            }
        }
    }

    let leftSet = Set(left)
    let rightSet = Set(right)
    let intersection = leftSet.intersection(rightSet).count
    let union = leftSet.union(rightSet).count
    if union > 0 {
        best = max(best, Double(intersection) / Double(union))
    }

    return best
}

func dedupeMergedTranscript(_ text: String) -> String {
    let rawLines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var cleaned: [String] = []
    cleaned.reserveCapacity(rawLines.count)

    for line in rawLines {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            if cleaned.last?.isEmpty == true {
                continue
            }
            cleaned.append("")
            continue
        }

        if let previousIndex = cleaned.lastIndex(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            let previous = cleaned[previousIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            let similarity = lineSimilarity(previous, trimmed)
            if similarity >= 0.88 {
                continue
            }

            let previousWords = normalizedWords(previous)
            let currentWords = normalizedWords(trimmed)
            let overlap = min(previousWords.count, currentWords.count, 12)
            if overlap >= 3 {
                let suffixScore = wordOverlapScore(ArraySlice(previousWords.suffix(overlap)), ArraySlice(currentWords.prefix(overlap)))
                if suffixScore >= 0.88 {
                    let remainingWords = Array(trimmed.split(separator: " ").dropFirst(overlap)).map(String.init)
                    if remainingWords.isEmpty {
                        continue
                    }
                    cleaned.append(remainingWords.joined(separator: " "))
                    continue
                }
            }
        }

        cleaned.append(trimmed)
    }

    while cleaned.last?.isEmpty == true {
        cleaned.removeLast()
    }

    return cleaned.joined(separator: "\n")
}

func isLikelySentenceBoundary(_ line: String) -> Bool {
    guard let last = line.trimmingCharacters(in: .whitespacesAndNewlines).last else {
        return false
    }
    return ".!?)]\"".contains(last)
}

func cleanupTranscriptForLLM(_ text: String) -> String {
    var lines = text
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

    var merged: [String] = []
    merged.reserveCapacity(lines.count)

    var index = 0
    while index < lines.count {
        let line = lines[index]
        if line.isEmpty {
            if merged.last?.isEmpty != true {
                merged.append("")
            }
            index += 1
            continue
        }

        let wordCount = line.split(separator: " ").count
        let isShortFragment = wordCount <= 5 && !isLikelySentenceBoundary(line)

        if isShortFragment, index + 1 < lines.count {
            let next = lines[index + 1]
            if !next.isEmpty {
                merged.append("\(line) \(next)")
                index += 2
                continue
            }
        }

        if let previous = merged.last, !previous.isEmpty, !isLikelySentenceBoundary(previous), wordCount <= 8 {
            merged[merged.count - 1] = "\(previous) \(line)"
        } else {
            merged.append(line)
        }

        index += 1
    }

    let normalized = merged
        .map { line -> String in
            guard !line.isEmpty else { return "" }
            var value = line.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            value = value.replacingOccurrences(of: "\\s+([,.;:!?])", with: "$1", options: .regularExpression)
            value = value.replacingOccurrences(of: "\\(\\s+", with: "(", options: .regularExpression)
            value = value.replacingOccurrences(of: "\\s+\\)", with: ")", options: .regularExpression)
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }

    var collapsed: [String] = []
    collapsed.reserveCapacity(normalized.count)
    for line in normalized {
        if line.isEmpty {
            if collapsed.last?.isEmpty != true {
                collapsed.append("")
            }
            continue
        }
        collapsed.append(line)
    }

    while collapsed.last?.isEmpty == true {
        collapsed.removeLast()
    }

    return collapsed.joined(separator: "\n")
}

struct TranscriptSegment {
    let start: Double
    let text: String
}

func mergeTranscriptSegments(_ segments: [TranscriptSegment], expectedOverlapWords: Int = 8) -> String {
    let orderedSegments = segments
        .sorted { lhs, rhs in
            if lhs.start == rhs.start {
                return lhs.text.count < rhs.text.count
            }
            return lhs.start < rhs.start
        }
        .map(\.text)

    guard var merged = orderedSegments.first?.trimmingCharacters(in: .whitespacesAndNewlines), !merged.isEmpty else {
        return ""
    }

    let overlapCap = max(expectedOverlapWords, 4)

    for rawSegment in orderedSegments.dropFirst() {
        let segment = rawSegment.trimmingCharacters(in: .whitespacesAndNewlines)
        if segment.isEmpty {
            continue
        }

        let mergedWords = merged.split(separator: " ").map(String.init)
        let segmentWords = segment.split(separator: " ").map(String.init)
        let maxOverlap = min(mergedWords.count, segmentWords.count, overlapCap)
        var bestOverlap = 0
        var bestScore = 0.0

        if maxOverlap >= 2 {
            for overlap in stride(from: maxOverlap, through: 2, by: -1) {
                let score = wordOverlapScore(mergedWords.suffix(overlap), segmentWords.prefix(overlap))
                if score >= 0.85 {
                    bestOverlap = overlap
                    bestScore = score
                    break
                }
            }
        }

        if bestOverlap == 0 {
            let minProbe = min(max(maxOverlap / 2, 3), maxOverlap)
            if minProbe <= maxOverlap {
                for probe in stride(from: maxOverlap, through: minProbe, by: -1) {
                    guard mergedWords.count >= probe, segmentWords.count >= probe else {
                        continue
                    }
                    let score = wordOverlapScore(mergedWords.suffix(probe), segmentWords.prefix(probe))
                    if score > bestScore && score >= 0.75 {
                        bestOverlap = probe
                        bestScore = score
                        break
                    }
                }
            }
        }

        if bestOverlap == 0 {
            let probeSizes = [min(maxOverlap, 4), min(maxOverlap, 3)]
            for probe in probeSizes where probe >= 2 {
                guard mergedWords.count >= probe, segmentWords.count >= probe else {
                    continue
                }
                let score = wordOverlapScore(mergedWords.suffix(probe), segmentWords.prefix(probe))
                if score > bestScore && score >= 0.85 {
                    bestOverlap = probe
                    bestScore = score
                    break
                }
            }
        }

        if bestOverlap > 0 {
            let remainderWords = Array(segmentWords.dropFirst(bestOverlap))
            if !remainderWords.isEmpty {
                merged += " " + remainderWords.joined(separator: " ")
            }
        } else {
            merged += "\n\n" + segment
        }
    }

    return merged.trimmingCharacters(in: .whitespacesAndNewlines)
}

func transcribePreparedChunk(
    sourceURL: URL,
    startSeconds: Double,
    durationSeconds: Double,
    chunkURL: URL,
    recognizer: SFSpeechRecognizer,
    onDeviceOnly: Bool
) throws -> String? {
    let ffmpegProcess = Process()
    ffmpegProcess.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    ffmpegProcess.arguments = [
        "ffmpeg",
        "-v", "error",
        "-nostdin",
        "-y",
        "-ss", String(format: "%.3f", startSeconds),
        "-t", String(format: "%.3f", durationSeconds),
        "-i", sourceURL.path,
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        chunkURL.path
    ]

    do {
        try ffmpegProcess.run()
    } catch {
        throw TranscriptError.exportFailed("failed to launch ffmpeg for chunk export: \(error.localizedDescription)")
    }
    ffmpegProcess.waitUntilExit()
    guard ffmpegProcess.terminationStatus == 0 else {
        throw TranscriptError.exportFailed("ffmpeg chunk export failed with status \(ffmpegProcess.terminationStatus)")
    }

    do {
        let chunkTranscript = try transcribeChunk(at: chunkURL, recognizer: recognizer, onDeviceOnly: onDeviceOnly)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return chunkTranscript.isEmpty ? nil : chunkTranscript
    } catch TranscriptError.emptyTranscript {
        return nil
    } catch {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.caseInsensitiveCompare("No speech detected") == .orderedSame {
            return nil
        }
        throw error
    }
}

struct ChunkResult {
    let start: Double
    let duration: Double
    let transcript: String?
}

func buildGapRanges(from chunkResults: [ChunkResult], totalDuration: Double) -> [(start: Double, end: Double)] {
    var gaps: [(Double, Double)] = []
    var gapStart: Double?
    var gapEnd = 0.0

    for result in chunkResults {
        if let transcript = result.transcript, !transcript.isEmpty {
            if let start = gapStart {
                gaps.append((start, gapEnd))
                gapStart = nil
            }
            continue
        }

        if gapStart == nil {
            gapStart = result.start
        }
        gapEnd = max(gapEnd, result.start + result.duration)
    }

    if let start = gapStart {
        gaps.append((start, min(gapEnd, totalDuration)))
    }

    return gaps
}

func transcribeAudio(from mediaURL: URL, localeIdentifier: String, onDeviceOnly: Bool, chunkSeconds: Int, overlapSeconds: Int, temporaryDirectory: URL) throws -> String {
    fputs("Running speech recognition...\n", stderr)

    guard chunkSeconds > 0 else {
        throw TranscriptError.invalidChunkLength(chunkSeconds)
    }
    guard overlapSeconds >= 0 && overlapSeconds < chunkSeconds else {
        throw TranscriptError.invalidOverlap(overlapSeconds, chunkSeconds)
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
        throw TranscriptError.recognizerUnavailable(localeIdentifier)
    }

    if onDeviceOnly, #available(macOS 10.15, *), !recognizer.supportsOnDeviceRecognition {
        throw TranscriptError.unsupportedOnDevice(localeIdentifier)
    }

    let asset = AVURLAsset(url: mediaURL)
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    if !durationSeconds.isFinite || durationSeconds <= 0 {
        throw TranscriptError.exportFailed("unable to determine media duration")
    }

    let stepSeconds = chunkSeconds - overlapSeconds
    var chunkStarts: [Double] = []
    var currentStart = 0.0
    while currentStart < durationSeconds {
        chunkStarts.append(currentStart)
        currentStart += Double(stepSeconds)
    }

    let finalStart = max(0, durationSeconds - Double(chunkSeconds))
    if chunkStarts.isEmpty || abs((chunkStarts.last ?? 0) - finalStart) > 0.5 {
        chunkStarts.append(finalStart)
    }
    chunkStarts = Array(Set(chunkStarts.map { round($0 * 1000) / 1000 })).sorted()

    let totalChunks = max(1, chunkStarts.count)
    var transcripts: [TranscriptSegment] = []
    transcripts.reserveCapacity(totalChunks)
    var chunkResults: [ChunkResult] = []
    chunkResults.reserveCapacity(totalChunks)

    let sourceExtension = mediaURL.pathExtension.isEmpty ? "wav" : mediaURL.pathExtension
    let tailWindowSeconds = min(max(Double(chunkSeconds) * 3.0, 20.0), durationSeconds)
    let tailWindowStart = max(0, durationSeconds - tailWindowSeconds)
    let shouldRunTailRetry = tailWindowStart > 0.5

    for (chunkIndex, chunkStart) in chunkStarts.enumerated() {
        let remaining = max(0, durationSeconds - chunkStart)
        let thisChunkDuration = min(Double(chunkSeconds), remaining)
        if thisChunkDuration <= 0 {
            continue
        }

        let chunkURL = temporaryDirectory
            .appendingPathComponent(String(format: "chunk-%03d", chunkIndex + 1))
            .appendingPathExtension(sourceExtension)

        fputs("\r  Chunk \(chunkIndex + 1)/\(totalChunks)...", stderr)
        fflush(stderr)
        do {
            if let chunkTranscript = try transcribePreparedChunk(
                sourceURL: mediaURL,
                startSeconds: chunkStart,
                durationSeconds: thisChunkDuration,
                chunkURL: chunkURL,
                recognizer: recognizer,
                onDeviceOnly: onDeviceOnly
            ) {
                transcripts.append(TranscriptSegment(start: chunkStart, text: chunkTranscript))
                chunkResults.append(ChunkResult(start: chunkStart, duration: thisChunkDuration, transcript: chunkTranscript))
            } else {
                fputs("\r  Chunk \(chunkIndex + 1)/\(totalChunks)... no speech detected", stderr)
                fflush(stderr)
                chunkResults.append(ChunkResult(start: chunkStart, duration: thisChunkDuration, transcript: nil))
            }
        } catch {
            fputs("\n", stderr)
            throw error
        }
    }

    if shouldRunTailRetry {
        let tailChunkURL = temporaryDirectory
            .appendingPathComponent("chunk-tail-retry")
            .appendingPathExtension(sourceExtension)
        fputs("\r  Tail retry...", stderr)
        fflush(stderr)
        if let tailTranscript = try transcribePreparedChunk(
            sourceURL: mediaURL,
            startSeconds: tailWindowStart,
            durationSeconds: tailWindowSeconds,
            chunkURL: tailChunkURL,
            recognizer: recognizer,
            onDeviceOnly: onDeviceOnly
        ) {
            transcripts.append(TranscriptSegment(start: tailWindowStart, text: tailTranscript))
            chunkResults.append(ChunkResult(start: tailWindowStart, duration: tailWindowSeconds, transcript: tailTranscript))
        }
    }

    let gapRanges = buildGapRanges(from: chunkResults, totalDuration: durationSeconds)
    if !gapRanges.isEmpty {
        let retryRecognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
        let maxGapRetries = min(gapRanges.count, 4)
        for (gapIndex, gap) in gapRanges.prefix(maxGapRetries).enumerated() {
            guard let retryRecognizer else { break }
            let gapDuration = max(0, gap.end - gap.start)
            if gapDuration <= 0.5 {
                continue
            }

            let retryPadding = max(Double(overlapSeconds), 1.0)
            let retryDuration = min(max(gapDuration + retryPadding * 2.0, min(Double(chunkSeconds) * 3.0, 20.0)), durationSeconds)
            let retryStart = min(max(0, gap.start - retryPadding), max(0, durationSeconds - retryDuration))
            let retryChunkURL = temporaryDirectory
                .appendingPathComponent(String(format: "chunk-gap-retry-%02d", gapIndex + 1))
                .appendingPathExtension(sourceExtension)

            fputs("\r  Gap retry \(gapIndex + 1)/\(maxGapRetries)...", stderr)
            fflush(stderr)

            if let retryTranscript = try transcribePreparedChunk(
                sourceURL: mediaURL,
                startSeconds: retryStart,
                durationSeconds: retryDuration,
                chunkURL: retryChunkURL,
                recognizer: retryRecognizer,
                onDeviceOnly: onDeviceOnly
            ) {
                transcripts.append(TranscriptSegment(start: retryStart, text: retryTranscript))
            }
        }
    }

    fputs("\n", stderr)

    let estimatedWordsPerSecond = 3
    let combined = mergeTranscriptSegments(transcripts, expectedOverlapWords: max(overlapSeconds * estimatedWordsPerSecond, 3))
    let deduped = dedupeMergedTranscript(combined)
    let cleaned = cleanupTranscriptForLLM(deduped)
    if cleaned.isEmpty {
        throw TranscriptError.emptyTranscript
    }
    return cleaned
}

do {
    guard CommandLine.arguments.count == 7 else {
        throw TranscriptError.invalidArguments
    }

    let inputPath = CommandLine.arguments[1]
    let outputPath = CommandLine.arguments[2]
    let localeIdentifier = CommandLine.arguments[3]
    let onDeviceOnly = CommandLine.arguments[4] == "1"
    let chunkSeconds = Int(CommandLine.arguments[5]) ?? 8
    let overlapSeconds = Int(CommandLine.arguments[6]) ?? 1

    let inputURL = URL(fileURLWithPath: inputPath)
    let outputURL = URL(fileURLWithPath: outputPath)

    guard FileManager.default.fileExists(atPath: inputURL.path) else {
        throw TranscriptError.missingInput(inputURL.path)
    }

    try authorizeSpeechRecognition()

    let temporaryDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporaryDirectory) }

    let transcript = try transcribeAudio(
        from: inputURL,
        localeIdentifier: localeIdentifier,
        onDeviceOnly: onDeviceOnly,
        chunkSeconds: chunkSeconds,
        overlapSeconds: overlapSeconds,
        temporaryDirectory: temporaryDirectory
    )

    try transcript.write(to: outputURL, atomically: true, encoding: .utf8)
    print(outputURL.path)
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    Foundation.exit(1)
}
SWIFT
  then
    echo "Transcript: $transcript_path"
  else
    return 1
  fi
}

main "$@"
