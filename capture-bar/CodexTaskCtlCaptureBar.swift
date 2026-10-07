import AppKit
import Carbon.HIToolbox

private let defaultList = ProcessInfo.processInfo.environment["CODEX_TASKCTL_CAPTURE_LIST"] ?? "收集箱"
private let maxImageBytes = 8 * 1024 * 1024

enum SaveOutcome: Equatable {
    case saved
    case needsCheck(String)
    static func decode(_ output: String, exitCode: Int32) -> SaveOutcome {
        let rows = output.split(separator: "\n").reversed()
        for row in rows {
            guard let data = row.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {continue}
            if exitCode == 0 && json["status"] as? String == "created" {return .saved}
            let id = json["numericId"].map {String(describing: $0)} ?? json["id"].map {String(describing: $0)} ?? "未知"
            return .needsCheck("保存未完整确认（ID: \(id)）。请检查收集箱；草稿保留，避免重复创建。")
        }
        return .needsCheck("保存结果未确认。请检查收集箱后再建新提醒；草稿与图片已保留。")
    }
}
func createArguments(title: String, list: String, image: URL?) -> [String] {
    var args = ["add", "--list", list, "--json"]
    if let image {args += ["--private", "--image", image.path]}
    return args + ["--", title] // Titles that start with '-' remain literal user text.
}
final class ImageFieldEditor: NSTextView {
    var onImage: ((NSImage) -> Void)?
    override func paste(_ sender: Any?) {
        if let image = NSImage(pasteboard: .general) {onImage?(image)}
        else {super.paste(sender)}
    }
}
final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool {true}
}
final class CaptureBar: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: CapturePanel!
    private var titleField: NSTextField!
    private var listField: NSTextField!
    private var statusLabel: NSTextField!
    private var imageView: NSImageView!
    private var addButton: NSButton!
    private var removeImageButton: NSButton!
    private var newButton: NSButton!
    private var fieldEditor = ImageFieldEditor()
    private var imageData: Data?
    private var submitting = false
    private var blocked = false
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var statusItem: NSStatusItem!
    private let draftDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CodexTaskCtl/Capture")
    private var draftURL: URL {draftDirectory.appendingPathComponent("draft.json")}
    private var imageURL: URL {draftDirectory.appendingPathComponent("draft.png")}

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        buildMenu()
        restoreDraft()
        registerHotKey()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(); return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        try? persistDraft()
        if let hotKeyRef {UnregisterEventHotKey(hotKeyRef)}
        if let eventHandler {RemoveEventHandler(eventHandler)}
    }
    func windowWillReturnFieldEditor(_ sender: NSWindow, to client: Any?) -> Any? {fieldEditor}
    func windowShouldClose(_ sender: NSWindow) -> Bool {hideWindow(); return false}

    private func buildMenu() {
        let main = NSMenu()
        let edit = NSMenuItem(); edit.submenu = NSMenu(title: "Edit")
        for (name, action, key) in [("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
            edit.submenu?.addItem(withTitle: name, action: action, keyEquivalent: key)
        }
        main.addItem(edit); NSApp.mainMenu = main
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "plus.circle", accessibilityDescription: "CodexTaskCtl")
        let menu = NSMenu()
        let open = menu.addItem(withTitle: "快速添加  ⌘⇧Space", action: #selector(showWindow), keyEquivalent: "")
        open.target = self
        statusItem.menu = menu
    }
    private func buildWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 570, height: 260))
        titleField = NSTextField(string: "")
        titleField.placeholderString = "输入提醒内容，⌘V 可直接贴图"
        titleField.font = .systemFont(ofSize: 18)
        titleField.setAccessibilityLabel("提醒内容")
        listField = NSTextField(string: defaultList); listField.setAccessibilityLabel("清单")
        titleField.target = self; titleField.action = #selector(save)
        imageView = NSImageView(); imageView.imageScaling = .scaleProportionallyDown
        imageView.setAccessibilityLabel("待保存图片")
        statusLabel = NSTextField(wrappingLabelWithString: "⌘⇧Space 打开 · Esc 保留草稿并收起")
        statusLabel.textColor = .secondaryLabelColor
        addButton = NSButton(title: "添加提醒", target: self, action: #selector(save)); addButton.keyEquivalent = "\r"
        removeImageButton = NSButton(title: "移除图片", target: self, action: #selector(removeImage))
        let closeButton = NSButton(title: "收起", target: self, action: #selector(hideWindow)); closeButton.keyEquivalent = "\u{1b}"
        newButton = NSButton(title: "清空草稿", target: self, action: #selector(clearDraft))
        let views: [NSView] = [titleField, listField, imageView, statusLabel, addButton, removeImageButton, closeButton, newButton]
        for v in views {v.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(v)}
        NSLayoutConstraint.activate([
            titleField.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            titleField.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            titleField.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            titleField.heightAnchor.constraint(equalToConstant: 34),
            listField.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            listField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 16),
            listField.widthAnchor.constraint(equalToConstant: 220),
            imageView.leadingAnchor.constraint(equalTo: listField.trailingAnchor, constant: 16),
            imageView.trailingAnchor.constraint(equalTo: titleField.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: listField.topAnchor),
            imageView.heightAnchor.constraint(equalToConstant: 90),
            removeImageButton.leadingAnchor.constraint(equalTo: listField.leadingAnchor),
            removeImageButton.topAnchor.constraint(equalTo: listField.bottomAnchor, constant: 14),
            statusLabel.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: titleField.trailingAnchor),
            statusLabel.topAnchor.constraint(equalTo: imageView.bottomAnchor, constant: 12),
            statusLabel.bottomAnchor.constraint(lessThanOrEqualTo: addButton.topAnchor, constant: -10),
            newButton.leadingAnchor.constraint(equalTo: titleField.leadingAnchor),
            newButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            addButton.trailingAnchor.constraint(equalTo: titleField.trailingAnchor),
            addButton.bottomAnchor.constraint(equalTo: newButton.bottomAnchor),
            closeButton.trailingAnchor.constraint(equalTo: addButton.leadingAnchor, constant: -8),
            closeButton.bottomAnchor.constraint(equalTo: newButton.bottomAnchor),
        ])
        window = CapturePanel(contentRect: content.frame, styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
        window.title = "CodexTaskCtl 快速收集"
        window.contentView = content; window.delegate = self
        window.level = .floating; window.hidesOnDeactivate = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        fieldEditor.isFieldEditor = true
        fieldEditor.onImage = { [weak self] image in
            guard let self, !self.submitting, !self.blocked else {return}
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let data = bitmap.representation(using: .png, properties: [:]), data.count <= maxImageBytes else {
                self.statusLabel.stringValue = "图片需能转成 PNG 且不超过 8 MiB"; return
            }
            self.imageData = data; self.imageView.image = image
            self.statusLabel.stringValue = "图片已暂存；添加时保存为提醒事项附件"
            do {try self.persistDraft()} catch {self.statusLabel.stringValue = "草稿暂存失败：\(error.localizedDescription)"}
            self.updateControls()
        }
        updateControls()
    }
    private func registerHotKey() {
        var kind = EventTypeSpec(eventClass: UInt32(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), {_, _, ptr in
            guard let ptr else {return noErr}
            let delegate = Unmanaged<CaptureBar>.fromOpaque(ptr).takeUnretainedValue()
            DispatchQueue.main.async {delegate.toggle()}
            return noErr
        }, 1, &kind, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
        let code = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), EventHotKeyID(signature: 0x43544342, id: 1), GetApplicationEventTarget(), 0, &hotKeyRef)
        if installed != noErr || code != noErr {
            statusLabel.stringValue = "快捷键被占用或注册失败（\(code)），请从菜单栏打开"
            showWindow()
        }
    }
    private func toggle() {window.isVisible ? hideWindow() : showWindow()}
    @objc private func showWindow() {
        if let screen = NSScreen.main {
            window.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - window.frame.width/2, y: screen.visibleFrame.maxY - window.frame.height - 80))
        }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(titleField)
    }
    @objc private func hideWindow() {try? persistDraft(); window.orderOut(nil)}
    @objc private func removeImage() {
        guard !submitting, !blocked else {return}
        imageData = nil; imageView.image = nil; try? persistDraft(); updateControls()
    }
    @objc private func clearDraft() {
        guard !submitting else {return}
        if !titleField.stringValue.isEmpty || imageData != nil || blocked {
            let alert = NSAlert(); alert.messageText = "清空当前草稿？"
            alert.informativeText = "这不会删除已创建的提醒。若上次结果不确定，请先检查收集箱。"
            alert.addButton(withTitle: "清空"); alert.addButton(withTitle: "保留")
            if alert.runModal() != .alertFirstButtonReturn {return}
        }
        reset()
    }
    private func reset() {
        blocked = false; imageData = nil; imageView.image = nil; titleField.stringValue = ""
        statusLabel.stringValue = "⌘⇧Space 打开 · Esc 保留草稿并收起"
        try? persistDraft(); updateControls()
    }
    private func updateControls() {
        let editable = !submitting && !blocked
        titleField.isEnabled = editable; listField.isEnabled = editable
        addButton.isEnabled = editable
        newButton.isEnabled = !submitting
        removeImageButton.isEnabled = editable && imageData != nil
    }
    private func persistDraft() throws {
        try FileManager.default.createDirectory(at: draftDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let imageData {
            try imageData.write(to: imageURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: imageURL.path)
        } else if FileManager.default.fileExists(atPath: imageURL.path) {try FileManager.default.removeItem(at: imageURL)}
        let object: [String: Any] = ["title":titleField.stringValue, "list":listField.stringValue, "hasImage":imageData != nil, "needsCheck":blocked || submitting]
        try JSONSerialization.data(withJSONObject: object).write(to: draftURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: draftURL.path)
    }
    private func restoreDraft() {
        guard let data = try? Data(contentsOf: draftURL),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {return}
        titleField.stringValue = o["title"] as? String ?? ""; listField.stringValue = o["list"] as? String ?? defaultList
        blocked = o["needsCheck"] as? Bool ?? false
        if o["hasImage"] as? Bool == true {imageData = try? Data(contentsOf: imageURL); imageView.image = imageData.flatMap(NSImage.init(data:))}
        if blocked {statusLabel.stringValue = "上次保存结果未确认。请先检查收集箱，避免重复创建。"}
        updateControls()
    }
    @objc private func save() {
        guard !submitting, !blocked else {return}
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let list = listField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !list.isEmpty else {statusLabel.stringValue = "请填写提醒内容和清单"; return}
        let executable = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("bin/remctl")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {statusLabel.stringValue = "请先安装 RemCTL"; return}
        submitting = true; updateControls(); statusLabel.stringValue = "正在保存…"
        do {try persistDraft()} catch {submitting = false; updateControls(); statusLabel.stringValue = "草稿保存失败"; return}
        let args = createArguments(title: title, list: list, image: imageData == nil ? nil : imageURL)
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(); process.executableURL = executable; process.arguments = args
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
            do {
                try process.run()
                let timeout = DispatchWorkItem {if process.isRunning {process.terminate()}}
                DispatchQueue.global().asyncAfter(deadline: .now() + 180, execute: timeout)
                let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                process.waitUntilExit(); timeout.cancel()
                let result = SaveOutcome.decode(output, exitCode: process.terminationStatus)
                DispatchQueue.main.async {
                    self.submitting = false
                    switch result {
                    case .saved: self.reset(); self.hideWindow()
                    case .needsCheck(let reason): self.blocked = true; self.statusLabel.stringValue = reason; try? self.persistDraft(); self.updateControls()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.submitting = false; self.statusLabel.stringValue = "无法启动 RemCTL：\(error.localizedDescription)"
                    try? self.persistDraft(); self.updateControls()
                }
            }
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    precondition(createArguments(title:"--help", list:"A B", image:nil) == ["add","--list","A B","--json","--","--help"])
    precondition(SaveOutcome.decode("{\"status\":\"created\",\"numericId\":1}", exitCode:0) == .saved)
    if case .saved = SaveOutcome.decode("{\"status\":\"partial\",\"numericId\":1}", exitCode:1) {fatalError("Partial write accepted")}
    if case .saved = SaveOutcome.decode("not JSON", exitCode:0) {fatalError("Unconfirmed write accepted")}
    print("Capture save contract passed")
} else {
    let app = NSApplication.shared
    let delegate = CaptureBar()
    app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
}
