import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panelController: FloatingPanelController?
    private var viewModel: VoicePanelViewModel?
    private var statusItem: NSStatusItem?
    private var hotKeyController: HotKeyController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let apiBaseURL = URL(string: ProcessInfo.processInfo.environment["KHEF_API_URL"] ?? "http://localhost:3201")
            ?? URL(string: "http://localhost:3201")!
        let viewModel = VoicePanelViewModel(
            apiClient: KhefAPIClient(baseURL: apiBaseURL),
            speechClient: SpeechRecognizerClient()
        )

        let panelController = FloatingPanelController(viewModel: viewModel)
        installStatusItem()
        installHotKey()
        panelController.showPanel()
        self.panelController = panelController
        self.viewModel = viewModel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKeyController?.unregister()
    }

    @objc private func togglePanel(_ sender: Any?) {
        panelController?.togglePanel()
    }

    @objc private func toggleRecording(_ sender: Any?) {
        viewModel?.toggleRecordingFromMenuBar()
        panelController?.showPanel()
    }

    @objc private func refreshSessions(_ sender: Any?) {
        guard let viewModel else { return }
        Task { await viewModel.refreshSessions() }
    }

    @objc private func quitApp(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "mic.circle.fill", accessibilityDescription: "Khef Voice")
            button.imagePosition = .imageOnly
            button.toolTip = "Khef Voice (Ctrl+Shift+V)"
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "Show Voice Panel", action: #selector(togglePanel(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Start / Stop Recording", action: #selector(toggleRecording(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Refresh Sessions", action: #selector(refreshSessions(_:)), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quitApp(_:)), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        item.menu = menu
        statusItem = item
    }

    private func installHotKey() {
        let controller = HotKeyController { [weak self] in
            self?.toggleRecording(nil)
        }
        controller.registerDefaultHotKey()
        hotKeyController = controller
    }
}
