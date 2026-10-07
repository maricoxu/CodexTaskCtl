import AppKit
import Carbon.HIToolbox

private let defaultList = ProcessInfo.processInfo.environment["CODEX_TASKCTL_CAPTURE_LIST"] ?? "收集箱"

final class CaptureField: NSTextField {
    var onImagePaste: ((NSImage) -> Void)?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "v",
           let image = NSImage(pasteboard: .general) {
            onImagePaste?(image)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class CaptureBar: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: NSPanel!
    private var titleField: CaptureField!
    private var listField: NSTextField!
    private var statusLabel: NSTextField!
    private var imageView: NSImageView!
    private var pastedImage: NSImage?
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        registerGlobalHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }

    private func buildWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 540, height: 210))
        titleField = CaptureField(string: "")
        titleField.placeholderString = "输入提醒内容；也可以直接粘贴截图"
        titleField.font = .systemFont(ofSize: 18)
        titleField.delegate = self
        titleField.translatesAutoresizingMaskIntoConstraints = false
        titleField.target = self
        titleField.action = #selector(addReminder)
        titleField.onImagePaste = { [weak self] image in
            self?.pastedImage = image
            self?.imageView.image = image
            self?.imageView.isHidden = false
            self?.statusLabel.stringValue = "已粘贴图片；提交后会作为提醒附件保存"
        }

        listField = NSTextField(string: defaultList)
        listField.placeholderString = "提醒事项清单"
        listField.translatesAutoresizingMaskIntoConstraints = false

        imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyDown
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 8
        imageView.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.isHidden = true

        statusLabel = NSTextField(labelWithString: "⌘⇧Space · 图片可直接从剪贴板粘贴")
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        let addButton = NSButton(title: "添加提醒", target: self, action: #selector(addReminder))
        addButton.keyEquivalent = "\r"
        addButton.translatesAutoresizingMaskIntoConstraints = false
        let cancelButton = NSButton(title: "取消", target: self, action: #selector(hideWindow))
        cancelButton.translatesAutoresizingMaskIntoConstraints = false

        [titleField, listField, imageView, statusLabel, addButton, cancelButton].forEach(content.addSubview(_:))
        NSLayoutConstraint.activate([
            titleField.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            titleField.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            titleField.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            titleField.heightAnchor.constraint(equalToConstant: 34),
            listField.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            listField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 12),
            listField.widthAnchor.constraint(equalToConstant: 190),
            listField.heightAnchor.constraint(equalToConstant: 28),
            imageView.leadingAnchor.constraint(equalTo: listField.trailingAnchor, constant: 12),
            imageView.trailingAnchor.constraint(equalTo: titleField.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: listField.topAnchor),
            imageView.heightAnchor.constraint(equalToConstant: 72),
            statusLabel.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            statusLabel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            cancelButton.trailingAnchor.constraint(equalTo: addButton.leadingAnchor, constant: -8),
            cancelButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
            addButton.trailingAnchor.constraint(equalTo: titleField.trailingAnchor),
            addButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
        ])

        window = NSPanel(contentRect: content.frame, styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
        window.title = "CodexTaskCtl 收集"
        window.contentView = content
        window.isFloatingPanel = true
        window.level = .floating
        window.hidesOnDeactivate = false
        window.center()
        window.delegate = self
    }

    private func registerGlobalHotKey() {
        var eventType = EventTypeSpec(eventClass: UInt32(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let bar = Unmanaged<CaptureBar>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { bar.toggleWindow() }
            return noErr
        }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
        let hotKeyID = EventHotKeyID(signature: OSType(0x43544342), id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    private func toggleWindow() { window.isVisible ? hideWindow() : showWindow() }
    private func showWindow() {
        if let screen = NSScreen.main { window.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - window.frame.width / 2, y: screen.visibleFrame.maxY - window.frame.height - 80)) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        titleField.selectText(nil)
    }

    @objc private func hideWindow() {
        window.orderOut(nil)
        pastedImage = nil
        imageView.image = nil
        imageView.isHidden = true
        statusLabel.stringValue = "⌘⇧Space · 图片可直接从剪贴板粘贴"
    }

    @objc private func addReminder() {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { statusLabel.stringValue = "请输入提醒内容"; return }
        var args = ["add", title, "--list", listField.stringValue.isEmpty ? defaultList : listField.stringValue, "--json"]
        var temporaryImageURL: URL?
        if let pastedImage, let png = pastedImage.pngData() {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("codextaskctl-\(UUID().uuidString).png")
            do { try png.write(to: url, options: .atomic); temporaryImageURL = url; args.insert(contentsOf: ["--private", "--image", url.path], at: 2) }
            catch { statusLabel.stringValue = "图片保存失败：\(error.localizedDescription)"; return }
        }
        statusLabel.stringValue = "正在添加…"
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("bin/remctl").path)
            process.arguments = args
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
            do {
                try process.run(); process.waitUntilExit()
                let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                DispatchQueue.main.async {
                    temporaryImageURL.flatMap { try? FileManager.default.removeItem(at: $0) }
                    if process.terminationStatus == 0 { self.titleField.stringValue = ""; self.hideWindow() }
                    else { self.statusLabel.stringValue = output.trimmingCharacters(in: .whitespacesAndNewlines).prefix(180).description }
                }
            } catch { DispatchQueue.main.async { self.statusLabel.stringValue = "调用 remctl 失败：\(error.localizedDescription)" } }
        }
    }

}

extension CaptureBar: NSWindowDelegate {}
private extension NSImage {
    func pngData() -> Data? { guard let tiff = tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }; return bitmap.representation(using: .png, properties: [:]) }
}

let app = NSApplication.shared
let delegate = CaptureBar()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
