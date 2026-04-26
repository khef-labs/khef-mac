import AppKit
import SwiftUI

final class FloatingPanelController: NSWindowController {
    var isPanelVisible: Bool {
        window?.isVisible == true
    }

    init(viewModel: VoicePanelViewModel) {
        let rootView = VoicePanelView(viewModel: viewModel)
        let hostingController = NSHostingController(rootView: rootView)
        hostingController.sizingOptions = .preferredContentSize

        let defaultSize = NSSize(width: 440, height: 1200)

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: defaultSize),
            styleMask: [.titled, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentViewController = hostingController
        panel.minSize = NSSize(width: 400, height: 500)
        panel.maxSize = NSSize(width: 460, height: 1600)
        panel.setContentSize(defaultSize)
        panel.center()

        super.init(window: panel)
    }

    func showPanel() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hidePanel() {
        window?.orderOut(nil)
    }

    func togglePanel() {
        if isPanelVisible {
            hidePanel()
        } else {
            showPanel()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }
}
