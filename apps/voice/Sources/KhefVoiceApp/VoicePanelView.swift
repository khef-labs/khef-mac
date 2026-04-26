import SwiftUI

struct VoicePanelView: View {
    @ObservedObject var viewModel: VoicePanelViewModel

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(nsColor: NSColor(white: 0.10, alpha: 1.0)))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(
                            viewModel.state == .recording
                                ? Color.purple.opacity(0.4)
                                : Color.white.opacity(0.08),
                            lineWidth: 1
                        )
                )

            VStack(alignment: .leading, spacing: 10) {
                dragHandle
                selectedTargetsBar
                sessionPicker
                recorderRow
                transcriptSection

                if viewModel.state == .sent {
                    sentBanner
                }

                actionButtons

                if let error = viewModel.errorMessage {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        // Controls actual window size (sizingOptions = .preferredContentSize)
        .frame(minWidth: 400, maxWidth: 460, minHeight: 800)
        .background(Color.black.opacity(0.001))
        .task {
            viewModel.onAppear()
        }
    }

    // MARK: - Drag handle

    private var dragHandle: some View {
        HStack {
            Spacer()
            Capsule()
                .fill(Color.white.opacity(0.12))
                .frame(width: 36, height: 4)
            Spacer()
            Button {
                NSApp.terminate(nil)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.3))
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Session bar

    private var sessionBar: some View {
        HStack(spacing: 6) {
            Text(viewModel.selectedTargets.count > 1 ? "To (\(viewModel.selectedTargets.count))" : "To")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            ForEach(viewModel.recentTargets) { session in
                SessionChip(
                    title: session.displayName,
                    isSelected: viewModel.selectedTargets.contains(session.nickname ?? "") || viewModel.selectedTargets.contains(session.sessionID),
                    isActive: session.isActive,
                    khefURL: session.dbID.flatMap { URL(string: "http://localhost:5174/sessions/\($0)") }
                ) {
                    viewModel.selectSession(session)
                }
            }

            Button {
                viewModel.toggleSessionPicker()
            } label: {
                Image(systemName: viewModel.isSessionPickerExpanded ? "rectangle.compress.vertical" : "list.bullet.rectangle")
                    .font(.system(size: 13))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(
                        viewModel.isSessionPickerExpanded ? Color.purple.opacity(0.15) : Color.white.opacity(0.04),
                        in: Capsule()
                    )
                    .foregroundStyle(viewModel.isSessionPickerExpanded ? Color.purple : .secondary)
            }
            .buttonStyle(.plain)

            Spacer()
        }
    }

    // MARK: - Session picker (expanded)

    // MARK: - Selected targets bar

    private var selectedTargetsBar: some View {
        HStack(spacing: 6) {
            Text("To")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            if viewModel.selectedTargets.isEmpty {
                Text("select sessions below")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.white.opacity(0.2))
            } else {
                FlowLayout(spacing: 5) {
                    ForEach(viewModel.sessions.filter({ s in
                        viewModel.selectedTargets.contains(s.nickname ?? "") || viewModel.selectedTargets.contains(s.sessionID)
                    })) { session in
                        SessionChip(
                            title: session.displayName,
                            isSelected: true,
                            isActive: session.isActive,
                            khefURL: session.dbID.flatMap { URL(string: "http://localhost:5174/sessions/\($0)") }
                        ) {
                            viewModel.selectSession(session)
                        }
                    }
                }
            }

            Spacer()
        }
    }

    // MARK: - Session picker (always visible)

    private var sessionPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                TextField("Filter sessions...", text: $viewModel.sessionSearch)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                if !viewModel.sessionSearch.isEmpty {
                    Button {
                        viewModel.sessionSearch = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.white.opacity(0.45))
                    }
                    .buttonStyle(.plain)
                    .help("Clear filter")
                }
            }
            .padding(6)
            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(viewModel.filteredSessionGroups) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(group.name)
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.secondary)
                                .textCase(.uppercase)

                            FlowLayout(spacing: 5) {
                                ForEach(group.sessions) { session in
                                    SessionChip(
                                        title: session.displayName,
                                        isSelected: viewModel.selectedTargets.contains(session.nickname ?? "") || viewModel.selectedTargets.contains(session.sessionID),
                                        isActive: session.isActive,
                                        khefURL: session.dbID.flatMap { URL(string: "http://localhost:5174/sessions/\($0)") }
                                    ) {
                                        viewModel.selectSession(session)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .frame(minHeight: 120, maxHeight: 300)
        }
        .padding(10)
        .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Recorder row (compact)

    private var recorderRow: some View {
        HStack(spacing: 10) {
            Button {
                if viewModel.state == .recording {
                    viewModel.stopRecording()
                } else {
                    viewModel.startRecording()
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(viewModel.state == .recording ? Color.purple.opacity(0.2) : Color.white.opacity(0.04))
                        .frame(width: 48, height: 48)
                    Circle()
                        .strokeBorder(
                            viewModel.state == .recording ? Color.purple.opacity(0.6) : Color.white.opacity(0.1),
                            lineWidth: 2
                        )
                        .frame(width: 48, height: 48)
                    Image(systemName: viewModel.state == .recording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(viewModel.state == .recording ? Color.purple : .secondary)
                }
            }
            .buttonStyle(.plain)

            if viewModel.state == .recording {
                WaveformView(levels: viewModel.audioLevels, isActive: true)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(viewModel.statusMessage)
                        .font(.system(size: 13))
                        .foregroundStyle(.primary)
                    if viewModel.state == .idle {
                        Text("\u{2303}\u{21E7}V from anywhere")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.white.opacity(0.3))
                    }
                }
            }

            Spacer()
        }
        .frame(height: 52)
    }

    // MARK: - Transcript (always visible)

    private var transcriptSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(viewModel.transcript.count) chars")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.3))
                Spacer()
                Button {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(viewModel.transcript, forType: .string)
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 9, weight: .bold))
                        Text("Copy")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.white.opacity(0.06), in: Capsule())
                    .foregroundStyle(Color.white.opacity(0.5))
                }
                .buttonStyle(.plain)
                .opacity(viewModel.state != .recording && !viewModel.transcript.isEmpty ? 1 : 0)
                .disabled(viewModel.state == .recording || viewModel.transcript.isEmpty)

                Button {
                    viewModel.transcript = ""
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                        Text("Clear")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.white.opacity(0.06), in: Capsule())
                    .foregroundStyle(Color.white.opacity(0.5))
                }
                .buttonStyle(.plain)
                .opacity(viewModel.state != .recording && !viewModel.transcript.isEmpty ? 1 : 0)
                .disabled(viewModel.state == .recording || viewModel.transcript.isEmpty)
            }

            if viewModel.state == .recording {
                // Read-only during recording — shows live text
                ScrollView {
                    Text(viewModel.transcript.isEmpty ? " " : viewModel.transcript)
                        .font(.system(size: 13))
                        .foregroundStyle(viewModel.transcript.isEmpty ? Color.white.opacity(0.2) : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(height: 200)
                .background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
            } else {
                // Editable when not recording
                TextEditor(text: $viewModel.transcript)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .frame(height: 200)
                    .background(Color.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
            }

        }
    }

    // MARK: - Sent banner

    private var sentBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.system(size: 14))
            Text(viewModel.statusMessage)
                .font(.system(size: 12))
                .foregroundStyle(.green)
            Spacer()
        }
        .padding(8)
        .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Action buttons (always visible, disabled during recording)

    private var actionButtons: some View {
        let isRecording = viewModel.state == .recording
        let isEmpty = viewModel.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let cantAct = isRecording || isEmpty

        return VStack(spacing: 6) {
            HStack(spacing: 6) {
                CompactButton(label: "Discard", icon: "xmark", style: .plain) {
                    viewModel.resetComposer()
                }
                .disabled(cantAct)

                CompactButton(label: "Append", icon: "plus", style: .green) {
                    viewModel.appendRecording()
                }
                .disabled(isRecording)

                if viewModel.state == .sent {
                    CompactButton(label: "Resend", icon: "arrow.counterclockwise", style: .accent) {
                        viewModel.send()
                    }
                    .disabled(cantAct || viewModel.isBusy)
                } else {
                    CompactButton(label: "Send", icon: "paperplane.fill", style: .accent) {
                        viewModel.send()
                    }
                    .disabled(cantAct || !viewModel.canSend || viewModel.isBusy)
                }
            }
            HStack(spacing: 6) {
                CompactButton(label: "Re-record", icon: "arrow.counterclockwise", style: .plain) {
                    viewModel.reRecord()
                }
                .disabled(isRecording)

                if viewModel.state == .sent {
                    CompactButton(label: "Send to\u{2026}", icon: "person.badge.plus", style: .plain) {
                        viewModel.toggleSessionPicker()
                    }
                    .disabled(isEmpty)

                    CompactButton(label: "New", icon: "mic", style: .plain) {
                        viewModel.resetComposer()
                    }
                } else {
                    CompactButton(label: "Save to file", icon: "doc", style: .plain) {
                        viewModel.saveToFile()
                    }
                    .disabled(cantAct)
                }
            }
        }
        .opacity(cantAct ? 0.4 : 1)
    }
}

// MARK: - Compact button

private struct CompactButton: View {
    let label: String
    let icon: String
    let style: ButtonVariant
    let action: () -> Void

    enum ButtonVariant {
        case plain, accent, green
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text(label)
                    .font(.system(size: 11, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(foreground)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(borderColor, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var background: Color {
        switch style {
        case .accent: Color.purple.opacity(0.15)
        case .green: Color.green.opacity(0.08)
        case .plain: Color.white.opacity(0.04)
        }
    }

    private var foreground: Color {
        switch style {
        case .accent: Color.purple
        case .green: Color.green
        case .plain: .secondary
        }
    }

    private var borderColor: Color {
        switch style {
        case .accent: Color.purple.opacity(0.3)
        case .green: Color.green.opacity(0.15)
        case .plain: Color.white.opacity(0.08)
        }
    }
}

// MARK: - Session chip

private struct SessionChip: View {
    let title: String
    let isSelected: Bool
    let isActive: Bool
    var khefURL: URL?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Circle()
                    .fill(isActive ? Color.green : Color.gray)
                    .frame(width: 5, height: 5)
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                isSelected ? Color.purple.opacity(0.15) : Color.white.opacity(0.06),
                in: Capsule()
            )
            .overlay(
                Capsule().strokeBorder(
                    isSelected ? Color.purple.opacity(0.4) : Color.white.opacity(0.08),
                    lineWidth: 1
                )
            )
            .foregroundStyle(isSelected ? Color.purple : .secondary)
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let url = khefURL {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Text("Open in Khef")
                }
            }
        }
    }
}

// MARK: - Waveform

private struct WaveformView: View {
    let levels: [CGFloat]
    let isActive: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.purple.opacity(0.7))
                    .frame(width: 3, height: 4 + max(0, min(level, 1)) * 20)
            }
        }
        .animation(.easeOut(duration: 0.1), value: levels)
    }
}

// MARK: - Flow layout for wrapping chips

private struct FlowLayout: Layout {
    var spacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, subview) in subviews.enumerated() {
            guard index < result.positions.count else { break }
            subview.place(at: CGPoint(x: bounds.minX + result.positions[index].x, y: bounds.minY + result.positions[index].y), proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}
