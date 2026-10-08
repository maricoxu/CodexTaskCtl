import AppKit
import Carbon.HIToolbox

private func preferredList() -> String {
    if let list = ProcessInfo.processInfo.environment["CODEX_TASKCTL_CAPTURE_LIST"], !list.isEmpty {return list}
    let settings = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/remctl/desktop/settings.json")
    if let data = try? Data(contentsOf: settings),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let list = json["defaultList"] as? String, !list.isEmpty {return list}
    return "" // Omit --list: RemCTL/EventKit chooses the native default.
}
private let defaultList = preferredList()
private let maxImageBytes = 8 * 1024 * 1024
private let maxImageCount = 8
private let maxTotalImageBytes = 32 * 1024 * 1024
private let maxTitleCharacters = 1024
private let maxNotesCharacters = 16 * 1024
private let shortcutDefaultsKey = "globalShortcut"

struct CaptureShortcut: Codable, Equatable {
    var keyCode: UInt32
    var modifiers: UInt32
    var key: String

    static let `default` = CaptureShortcut(
        keyCode: UInt32(kVK_Space),
        modifiers: UInt32(cmdKey | shiftKey),
        key: "Space"
    )

    var display: String {
        var result = ""
        if modifiers & UInt32(controlKey) != 0 {result += "⌃"}
        if modifiers & UInt32(optionKey) != 0 {result += "⌥"}
        if modifiers & UInt32(shiftKey) != 0 {result += "⇧"}
        if modifiers & UInt32(cmdKey) != 0 {result += "⌘"}
        return result + key
    }
}

private func modifierMask(_ flags: NSEvent.ModifierFlags) -> UInt32 {
    var result: UInt32 = 0
    if flags.contains(.control) {result |= UInt32(controlKey)}
    if flags.contains(.option) {result |= UInt32(optionKey)}
    if flags.contains(.shift) {result |= UInt32(shiftKey)}
    if flags.contains(.command) {result |= UInt32(cmdKey)}
    return result
}

private func shortcutKeyName(_ event: NSEvent) -> String? {
    switch Int(event.keyCode) {
    case kVK_Space: return "Space"
    case kVK_Return: return "Return"
    case kVK_ANSI_KeypadEnter: return "Keypad Enter"
    case kVK_Tab: return "Tab"
    case kVK_Delete: return "Delete"
    case kVK_ForwardDelete: return "Forward Delete"
    case kVK_Escape: return "Escape"
    case kVK_LeftArrow: return "←"
    case kVK_RightArrow: return "→"
    case kVK_UpArrow: return "↑"
    case kVK_DownArrow: return "↓"
    case kVK_Home: return "Home"
    case kVK_End: return "End"
    case kVK_PageUp: return "Page Up"
    case kVK_PageDown: return "Page Down"
    case kVK_F1...kVK_F20: return "F\(Int(event.keyCode) - kVK_F1 + 1)"
    default:
        guard let characters = event.charactersIgnoringModifiers, !characters.isEmpty else {return nil}
        return characters.uppercased()
    }
}

private func loadShortcut() -> CaptureShortcut {
    guard let data = UserDefaults.standard.data(forKey: shortcutDefaultsKey),
          let shortcut = try? JSONDecoder().decode(CaptureShortcut.self, from: data),
          shortcut.modifiers != 0, !shortcut.key.isEmpty else {return .default}
    return shortcut
}

private func saveShortcut(_ shortcut: CaptureShortcut) {
    if let data = try? JSONEncoder().encode(shortcut) {
        UserDefaults.standard.set(data, forKey: shortcutDefaultsKey)
    }
}

enum SaveOutcome: Equatable {
    case saved(Int?)
    case needsCheck(String)
    static func decode(_ output: String, exitCode: Int32) -> SaveOutcome {
        let rows = output.split(separator: "\n").reversed()
        for row in rows {
            guard let data = row.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {continue}
            if exitCode == 0 && json["status"] as? String == "created" {
                let raw = json["numericId"] ?? json["id"]
                let id = (raw as? NSNumber)?.intValue ?? (raw as? String).flatMap(Int.init)
                return .saved(id)
            }
            let id = json["numericId"].map {String(describing: $0)} ?? json["id"].map {String(describing: $0)} ?? "未知"
            return .needsCheck("保存未完整确认（ID: \(id)）。请检查收集箱；草稿保留，避免重复创建。")
        }
        return .needsCheck("保存结果未确认。请检查收集箱后再建新提醒；草稿与图片已保留。")
    }
}
func createArguments(title: String, list: String, notes: String, images: [URL]) -> [String] {
    var args = ["add", "--json"]
    if !list.isEmpty {args += [Int(list) != nil ? "--list-id" : "--list", list]}
    if !notes.isEmpty {args += ["--notes", notes]}
    if !images.isEmpty {
        args.append("--private")
        for image in images {args += ["--image", image.path]}
    }
    return args + ["--", title] // Titles that start with '-' remain literal user text.
}
final class CaptureTextView: NSTextView {
    var onImage: ((NSImage) -> Void)?
    var onEscape: (() -> Void)?
    var onTab: ((Bool) -> Bool)?
    var onSubmit: (() -> Void)?
    var placeholderText = "输入提醒内容，⌘V 可粘贴图片"

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !hasMarkedText() else {return}
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? .systemFont(ofSize: 18),
            .foregroundColor: NSColor.placeholderTextColor,
        ]
        placeholderText.draw(in: bounds.insetBy(dx: 14, dy: 14), withAttributes: attributes)
    }

    private func imagesFromPasteboard() -> [NSImage] {
        let pasteboard = NSPasteboard.general
        if let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
           !images.isEmpty {return images}
        let types: [NSPasteboard.PasteboardType] = [
            .tiff,
            .png,
            NSPasteboard.PasteboardType("public.jpeg"),
            NSPasteboard.PasteboardType("public.heic"),
        ]
        for type in types {
            if let data = pasteboard.data(forType: type), let image = NSImage(data: data) {return [image]}
        }
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [NSURL] {
            let images = urls.compactMap {url -> NSImage? in
                guard let data = try? Data(contentsOf: url as URL) else {return nil}
                return NSImage(data: data)
            }
            if !images.isEmpty {return images}
        }
        return []
    }

    @discardableResult
    private func pasteImagesIfPresent() -> Bool {
        let images = imagesFromPasteboard()
        guard !images.isEmpty else {return false}
        for image in images {onImage?(image)}
        return true
    }

    override func paste(_ sender: Any?) {
        if !pasteImagesIfPresent() {super.paste(sender)}
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == UInt16(kVK_Tab), flags.isEmpty || flags == .shift {
            if onTab?(flags == .shift) == true {return}
        }
        if (event.keyCode == UInt16(kVK_Return) || event.keyCode == UInt16(kVK_ANSI_KeypadEnter)), flags.isEmpty, !hasMarkedText() {
            onSubmit?()
            return
        }
        if event.keyCode == UInt16(kVK_Escape), event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty {
            onEscape?()
            return
        }
        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == UInt16(kVK_ANSI_V), flags == .command, pasteImagesIfPresent() {return true}
        return super.performKeyEquivalent(with: event)
    }
}
final class ShortcutRecorder: NSTextField {
    var onShortcut: ((CaptureShortcut) -> Void)?

    override func keyDown(with event: NSEvent) {
        let modifiers = modifierMask(event.modifierFlags.intersection(.deviceIndependentFlagsMask))
        guard modifiers != 0, let key = shortcutKeyName(event) else {
            NSSound.beep()
            return
        }
        onShortcut?(CaptureShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, key: key))
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        keyDown(with: event)
        return true
    }

    func setShortcut(_ shortcut: CaptureShortcut) {
        stringValue = shortcut.display
    }
}
final class CapturePanel: NSPanel {
    var onCommandShortcut: ((UInt16) -> Bool)?
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool {true}
    override func sendEvent(_ event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.type == .keyDown && flags.isEmpty && event.keyCode == UInt16(kVK_Escape) {
            onEscape?()
            return
        }
        super.sendEvent(event)
    }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.isEmpty && event.keyCode == UInt16(kVK_Escape) {onEscape?(); return true}
        if flags == .command && (event.keyCode == UInt16(kVK_ANSI_1) || event.keyCode == UInt16(kVK_ANSI_2)) {
            return onCommandShortcut?(event.keyCode) ?? true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// The title and body editors are both valid paste targets. Keep the image
/// callback wiring in one place so focusing the title field cannot silently
/// consume an image paste without adding it to the draft.
func attachImagePasteHandlers(
    titleField: CaptureTextView,
    bodyField: CaptureTextView,
    handler: @escaping (NSImage) -> Void
) {
    titleField.onImage = handler
    bodyField.onImage = handler
}

func removingImage(at index: Int, from images: [Data]) -> [Data]? {
    guard images.indices.contains(index) else {return nil}
    var remaining = images
    remaining.remove(at: index)
    return remaining
}

final class CaptureBar: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: CapturePanel!
    private var titleField: CaptureTextView!
    private var bodyField: CaptureTextView!
    private var statusLabel: NSTextField!
    private var imageStack: NSStackView!
    private var addButton: NSButton!
    private var newButton: NSButton!
    private var immediateButton: NSButton!
    private var imageData: [Data] = []
    private var submitting = false
    private var blocked = false
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var statusItem: NSStatusItem!
    private var shortcutMenuItem: NSMenuItem!
    private var previousApplication: NSRunningApplication?
    private var shownAt: Date?
    private var shortcut = CaptureShortcut.default
    private var settingsWindow: NSPanel?
    private var shortcutRecorder: ShortcutRecorder?
    private var pendingShortcut = CaptureShortcut.default
    private var dispatchImmediately = false
    private var localKeyMonitor: Any?
    private let draftDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CodexTaskCtl/Capture")
    private var draftURL: URL {draftDirectory.appendingPathComponent("draft.json")}
    private var imageDirectory: URL {draftDirectory.appendingPathComponent("images")}
    private var legacyImageURL: URL {draftDirectory.appendingPathComponent("draft.png")}
    private func imageURL(_ index: Int) -> URL {imageDirectory.appendingPathComponent("image-\(index).png")}

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        buildMenu()
        restoreDraft()
        shortcut = loadShortcut()
        updateShortcutUI()
        let result = registerHotKey(shortcut)
        if result != noErr {reportShortcutFailure(result)}
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.keyCode == UInt16(kVK_Escape), event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty,
                  self.window.isKeyWindow, !self.submitting else {return event}
            self.hideWindow()
            return nil
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(); return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        try? persistDraft()
        if let hotKeyRef {UnregisterEventHotKey(hotKeyRef)}
        if let eventHandler {RemoveEventHandler(eventHandler)}
        if let localKeyMonitor {NSEvent.removeMonitor(localKeyMonitor)}
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === settingsWindow {sender.orderOut(nil); return false}
        hideWindow(); return false
    }

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
        shortcutMenuItem = menu.addItem(withTitle: "", action: #selector(showWindow), keyEquivalent: "")
        shortcutMenuItem.target = self
        menu.addItem(.separator())
        let settings = menu.addItem(withTitle: "设置全局快捷键…", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self
        let resetShortcut = menu.addItem(withTitle: "恢复默认快捷键", action: #selector(resetShortcut), keyEquivalent: "")
        resetShortcut.target = self
        let quit = menu.addItem(withTitle: "退出 Capture Bar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        statusItem.menu = menu
        updateShortcutUI()
    }
    private func buildWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 660, height: 410))
        titleField = CaptureTextView(frame: NSRect(x: 0, y: 0, width: 616, height: 58))
        titleField.isRichText = false
        titleField.isEditable = true
        titleField.isSelectable = true
        // Do not rely on NSTextView's process/appearance default here. On some
        // macOS installations the default typing attributes inherit a
        // transparent or background-matching foreground, so AX sees the text
        // while the editor appears empty.
        titleField.textColor = .black
        titleField.insertionPointColor = .black
        titleField.typingAttributes = [
            .font: NSFont.systemFont(ofSize: 18),
            .foregroundColor: NSColor.black,
        ]
        titleField.isHorizontallyResizable = false
        titleField.isVerticallyResizable = false
        titleField.autoresizingMask = [.width]
        titleField.textContainer?.widthTracksTextView = true
        titleField.drawsBackground = true
        titleField.backgroundColor = .textBackgroundColor
        titleField.font = .systemFont(ofSize: 18)
        titleField.textContainerInset = NSSize(width: 12, height: 10)
        titleField.placeholderText = "输入提醒标题"
        titleField.setAccessibilityLabel("提醒标题")
        titleField.wantsLayer = true
        titleField.layer?.cornerRadius = 12
        titleField.layer?.borderWidth = 1
        titleField.layer?.borderColor = NSColor.separatorColor.cgColor
        let titleScroll = NSScrollView(frame: .zero)
        titleScroll.documentView = titleField
        titleScroll.hasVerticalScroller = false
        titleScroll.hasHorizontalScroller = false
        titleScroll.drawsBackground = false
        titleScroll.borderType = .noBorder

        bodyField = CaptureTextView(frame: NSRect(x: 0, y: 0, width: 616, height: 217))
        bodyField.isRichText = false
        bodyField.isEditable = true
        bodyField.isSelectable = true
        bodyField.textColor = .black
        bodyField.insertionPointColor = .black
        bodyField.typingAttributes = [
            .font: NSFont.systemFont(ofSize: 16),
            .foregroundColor: NSColor.black,
        ]
        bodyField.isHorizontallyResizable = false
        bodyField.isVerticallyResizable = true
        bodyField.autoresizingMask = [.width]
        bodyField.textContainer?.widthTracksTextView = true
        bodyField.drawsBackground = true
        bodyField.backgroundColor = .textBackgroundColor
        bodyField.font = .systemFont(ofSize: 16)
        bodyField.textContainerInset = NSSize(width: 12, height: 12)
        bodyField.placeholderText = "输入提醒正文\n\n⌘V 可直接粘贴图片"
        bodyField.setAccessibilityLabel("提醒正文")
        bodyField.wantsLayer = true
        bodyField.layer?.cornerRadius = 12
        bodyField.layer?.borderWidth = 1
        bodyField.layer?.borderColor = NSColor.separatorColor.cgColor
        let bodyScroll = NSScrollView(frame: .zero)
        bodyScroll.documentView = bodyField
        bodyScroll.hasVerticalScroller = true
        bodyScroll.hasHorizontalScroller = false
        bodyScroll.drawsBackground = false
        bodyScroll.borderType = .noBorder

        imageStack = NSStackView(frame: .zero)
        imageStack.orientation = .horizontal
        imageStack.alignment = .centerY
        imageStack.spacing = 6
        imageStack.detachesHiddenViews = true
        imageStack.setAccessibilityLabel("待保存图片")
        imageStack.isHidden = true

        statusLabel = NSTextField(wrappingLabelWithString: "")
        statusLabel.textColor = .secondaryLabelColor
        addButton = NSButton(title: "添加提醒", target: self, action: #selector(save))
        addButton.keyEquivalent = "\r"
        newButton = NSButton(title: "清空草稿", target: self, action: #selector(clearDraft))
        immediateButton = NSButton(title: "保存并立即交给 Codex", target: self, action: #selector(saveAndDispatch))
        immediateButton.bezelStyle = .rounded
        immediateButton.toolTip = "收起窗口，保存提醒后立即唤醒本机 Codex Dispatcher"
        let views: [NSView] = [titleScroll, bodyScroll, imageStack, statusLabel, addButton, newButton, immediateButton]
        for v in views {v.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(v)}
        NSLayoutConstraint.activate([
            titleScroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            titleScroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            titleScroll.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            titleScroll.heightAnchor.constraint(equalToConstant: 58),
            bodyScroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            bodyScroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            bodyScroll.topAnchor.constraint(equalTo: titleScroll.bottomAnchor, constant: 10),
            bodyScroll.heightAnchor.constraint(equalToConstant: 217),
            imageStack.trailingAnchor.constraint(equalTo: bodyScroll.trailingAnchor, constant: -14),
            imageStack.bottomAnchor.constraint(equalTo: bodyScroll.bottomAnchor, constant: -14),
            imageStack.heightAnchor.constraint(equalToConstant: 78),
            statusLabel.leadingAnchor.constraint(equalTo: bodyScroll.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: bodyScroll.trailingAnchor),
            statusLabel.topAnchor.constraint(equalTo: bodyScroll.bottomAnchor, constant: 10),
            statusLabel.heightAnchor.constraint(equalToConstant: 24),
            newButton.leadingAnchor.constraint(equalTo: bodyScroll.leadingAnchor),
            newButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            immediateButton.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            immediateButton.bottomAnchor.constraint(equalTo: newButton.bottomAnchor),
            addButton.trailingAnchor.constraint(equalTo: bodyScroll.trailingAnchor),
            addButton.bottomAnchor.constraint(equalTo: newButton.bottomAnchor),
        ])
        window = CapturePanel(contentRect: content.frame, styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
        window.onCommandShortcut = { [weak self] keyCode in
            guard let self else {return true}
            if keyCode == UInt16(kVK_ANSI_1) {self.clearDraft(); return true}
            if keyCode == UInt16(kVK_ANSI_2) {self.saveAndDispatch(); return true}
            return false
        }
        window.onEscape = { [weak self] in
            guard let self, !self.submitting else {return}
            self.hideWindow()
        }
        window.title = "CodexTaskCtl 快速收集"
        window.contentView = content; window.delegate = self
        window.level = .floating; window.hidesOnDeactivate = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        let handleImage: (NSImage) -> Void = { [weak self] image in
            guard let self, !self.submitting, !self.blocked else {return}
            guard self.imageData.count < maxImageCount else {
                self.statusLabel.stringValue = "最多暂存 \(maxImageCount) 张图片"; return
            }
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let data = bitmap.representation(using: .png, properties: [:]), data.count <= maxImageBytes else {
                self.statusLabel.stringValue = "图片需能转成 PNG 且不超过 8 MiB"; return
            }
            let total = self.imageData.reduce(0) {$0 + $1.count}
            guard total + data.count <= maxTotalImageBytes else {
                self.statusLabel.stringValue = "图片总大小不能超过 32 MiB"; return
            }
            self.imageData.append(data)
            self.rebuildImagePreviews()
            self.statusLabel.stringValue = "已暂存 \(self.imageData.count) 张图片；添加时保存为提醒事项附件"
            do {try self.persistDraft()} catch {self.statusLabel.stringValue = "草稿暂存失败：\(error.localizedDescription)"}
            self.titleField.needsDisplay = true
            self.updateControls()
        }
        attachImagePasteHandlers(titleField: titleField, bodyField: bodyField, handler: handleImage)
        titleField.onEscape = { [weak self] in
            guard let self, !self.submitting else {return}
            self.hideWindow()
        }
        bodyField.onEscape = { [weak self] in
            guard let self, !self.submitting else {return}
            self.hideWindow()
        }
        titleField.onSubmit = { [weak self] in self?.save() }
        bodyField.onSubmit = { [weak self] in self?.save() }
        titleField.onTab = { [weak self] backwards in
            guard let self else {return false}
            self.window.makeFirstResponder(backwards ? self.bodyField : self.bodyField)
            return true
        }
        bodyField.onTab = { [weak self] backwards in
            guard let self else {return false}
            self.window.makeFirstResponder(backwards ? self.titleField : self.addButton)
            return true
        }
        updateControls()
    }
    private func shortcutHint() -> String {"\(shortcut.display) 打开 · ⌘1 清空 · ⌘2 Codex · Return 添加 · Shift-Return 换行 · Esc 保留草稿并收起"}
    private func updateShortcutUI() {
        shortcutMenuItem?.title = "快速添加  \(shortcut.display)"
        if !submitting && !blocked {statusLabel?.stringValue = shortcutHint()}
        shortcutRecorder?.setShortcut(shortcut)
    }
    private func registerHotKey(_ shortcut: CaptureShortcut) -> OSStatus {
        var kind = EventTypeSpec(eventClass: UInt32(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        if eventHandler == nil {
            let installed = InstallEventHandler(GetApplicationEventTarget(), {_, _, ptr in
                guard let ptr else {return noErr}
                let delegate = Unmanaged<CaptureBar>.fromOpaque(ptr).takeUnretainedValue()
                DispatchQueue.main.async {delegate.toggle()}
                return noErr
            }, 1, &kind, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
            if installed != noErr {return installed}
        }
        return RegisterEventHotKey(
            shortcut.keyCode,
            shortcut.modifiers,
            EventHotKeyID(signature: 0x43544342, id: 1),
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }
    private func unregisterHotKey() {
        if let hotKeyRef {UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil}
    }
    private func reportShortcutFailure(_ code: OSStatus) {
        statusLabel.stringValue = "快捷键被占用或注册失败（\(code)），请从菜单栏打开或重新设置"
    }
    private func rebuildImagePreviews() {
        for view in imageStack.arrangedSubviews {
            imageStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for (index, data) in imageData.enumerated() {
            let container = NSView(frame: .zero)
            container.translatesAutoresizingMaskIntoConstraints = false
            let imageView = NSImageView(frame: .zero)
            imageView.image = NSImage(data: data)
            imageView.imageScaling = .scaleProportionallyDown
            imageView.imageAlignment = .alignCenter
            imageView.toolTip = "图片 \(index + 1)"
            imageView.wantsLayer = true
            imageView.layer?.cornerRadius = 8
            imageView.layer?.borderWidth = 1
            imageView.layer?.borderColor = NSColor.separatorColor.cgColor
            imageView.setAccessibilityLabel("图片 \(index + 1)")
            imageView.translatesAutoresizingMaskIntoConstraints = false

            let removeButton = NSButton(title: "×", target: self, action: #selector(removeImageAtPreview(_:)))
            removeButton.tag = index
            removeButton.toolTip = "删除图片 \(index + 1)"
            removeButton.setAccessibilityLabel("删除图片 \(index + 1)")
            removeButton.bezelStyle = .inline
            removeButton.isBordered = true
            removeButton.font = .systemFont(ofSize: 12, weight: .bold)
            removeButton.contentTintColor = .secondaryLabelColor
            removeButton.translatesAutoresizingMaskIntoConstraints = false

            container.addSubview(imageView)
            container.addSubview(removeButton)
            NSLayoutConstraint.activate([
                container.widthAnchor.constraint(equalToConstant: 72),
                container.heightAnchor.constraint(equalToConstant: 72),
                imageView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                imageView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                imageView.topAnchor.constraint(equalTo: container.topAnchor),
                imageView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                removeButton.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: 2),
                removeButton.topAnchor.constraint(equalTo: container.topAnchor, constant: -2),
                removeButton.widthAnchor.constraint(equalToConstant: 20),
                removeButton.heightAnchor.constraint(equalToConstant: 20),
            ])
            imageStack.addArrangedSubview(container)
        }
        imageStack.isHidden = imageData.isEmpty
    }
    @objc private func openSettings() {
        if settingsWindow == nil {buildSettingsWindow()}
        pendingShortcut = shortcut
        shortcutRecorder?.setShortcut(pendingShortcut)
        settingsWindow?.center()
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
        settingsWindow?.makeFirstResponder(shortcutRecorder)
    }
    private func buildSettingsWindow() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 430, height: 190))
        let title = NSTextField(labelWithString: "全局快速收集快捷键")
        let hint = NSTextField(wrappingLabelWithString: "点击输入框后按下新的组合键。至少包含一个修饰键，例如 ⌘⇧Space。")
        hint.textColor = .secondaryLabelColor
        let recorder = ShortcutRecorder(string: "")
        recorder.alignment = .center
        recorder.font = .systemFont(ofSize: 18, weight: .medium)
        recorder.isEditable = false
        recorder.isSelectable = false
        recorder.bezelStyle = .roundedBezel
        recorder.setAccessibilityLabel("全局快捷键")
        shortcutRecorder = recorder
        recorder.onShortcut = { [weak self] shortcut in
            self?.pendingShortcut = shortcut
            recorder.setShortcut(shortcut)
        }
        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelSettings))
        let save = NSButton(title: "保存", target: self, action: #selector(saveSettings))
        save.keyEquivalent = "\r"
        for view in [title, hint, recorder, cancel, save] {view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view)}
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            hint.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            hint.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            hint.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            recorder.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            recorder.trailingAnchor.constraint(equalTo: hint.trailingAnchor),
            recorder.topAnchor.constraint(equalTo: hint.bottomAnchor, constant: 18),
            recorder.heightAnchor.constraint(equalToConstant: 34),
            cancel.trailingAnchor.constraint(equalTo: save.leadingAnchor, constant: -8),
            cancel.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            save.trailingAnchor.constraint(equalTo: hint.trailingAnchor),
            save.bottomAnchor.constraint(equalTo: cancel.bottomAnchor),
        ])
        let panel = NSPanel(contentRect: content.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "CodexTaskCtl 设置"
        panel.contentView = content
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        settingsWindow = panel
    }
    @objc private func cancelSettings() {settingsWindow?.orderOut(nil)}
    @objc private func resetShortcut() {
        if settingsWindow == nil {buildSettingsWindow()}
        pendingShortcut = .default
        shortcutRecorder?.setShortcut(.default)
        settingsWindow?.center()
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
        settingsWindow?.makeFirstResponder(shortcutRecorder)
    }
    @objc private func saveSettings() {
        let previous = shortcut
        guard pendingShortcut.modifiers != 0 else {NSSound.beep(); return}
        unregisterHotKey()
        let result = registerHotKey(pendingShortcut)
        guard result == noErr else {
            _ = registerHotKey(previous)
            reportShortcutFailure(result)
            return
        }
        shortcut = pendingShortcut
        saveShortcut(shortcut)
        updateShortcutUI()
        settingsWindow?.orderOut(nil)
    }
    private func toggle() {window.isVisible ? hideWindow() : showWindow()}
    @objc private func showWindow() {
        let front = NSWorkspace.shared.frontmostApplication
        if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {previousApplication = front}
        shownAt = Date()
        let screen = NSScreen.screens.first(where: {NSMouseInRect(NSEvent.mouseLocation, $0.frame, false)}) ?? NSScreen.main
        if let screen {
            window.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - window.frame.width/2, y: screen.visibleFrame.maxY - window.frame.height - 80))
        }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(titleField)
    }
    @objc private func hideWindow() {
        do {try persistDraft()} catch {statusLabel.stringValue = "草稿保存失败，暂不收起"; return}
        let shouldReturn = NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        window.orderOut(nil)
        if shouldReturn {previousApplication?.activate(options: [])}
    }
    func windowDidResignKey(_ notification: Notification) {
        if (notification.object as? NSWindow) === settingsWindow {return}
        // Clicking elsewhere returns to work without stealing focus back.
        guard !submitting, let shownAt, Date().timeIntervalSince(shownAt) > 0.3 else {return}
        try? persistDraft(); window.orderOut(nil)
    }
    @objc private func removeImage() {
        guard !submitting, !blocked else {return}
        imageData.removeAll(); rebuildImagePreviews()
        try? persistDraft(); updateControls()
    }
    @objc private func removeImageAtPreview(_ sender: NSButton) {
        guard !submitting, !blocked, let remaining = removingImage(at: sender.tag, from: imageData) else {return}
        imageData = remaining
        rebuildImagePreviews()
        statusLabel.stringValue = imageData.isEmpty ? shortcutHint() : "已暂存 \(imageData.count) 张图片；添加时保存为提醒事项附件"
        try? persistDraft()
        updateControls()
    }
    @objc private func clearDraft() {
        guard !submitting else {return}
        // Clearing is an editing action: remove the current draft in place and
        // keep the capture window, selected list, and controls visible. Do not
        // show a confirmation dialog for content the user explicitly asked to
        // discard. An uncertain previous write remains blocked so clearing the
        // visible fields cannot accidentally permit a duplicate reminder.
        dispatchImmediately = false
        imageData.removeAll()
        rebuildImagePreviews()
        titleField.string = ""
        bodyField.string = ""
        titleField.needsDisplay = true
        bodyField.needsDisplay = true
        if !blocked {statusLabel.stringValue = shortcutHint()}
        try? persistDraft()
        updateControls()
    }
    @objc private func saveAndDispatch() {
        guard !submitting, !blocked else {return}
        dispatchImmediately = true
        save()
    }
    private func reset() {
        blocked = false; dispatchImmediately = false; imageData.removeAll(); rebuildImagePreviews(); titleField.string = ""; bodyField.string = ""
        titleField.needsDisplay = true; bodyField.needsDisplay = true
        statusLabel.stringValue = shortcutHint()
        try? persistDraft(); updateControls()
    }
    private func updateControls() {
        let editable = !submitting && !blocked
        titleField.isEditable = editable
        addButton.isEnabled = editable
        newButton.isEnabled = !submitting
        immediateButton.isEnabled = editable
    }
    private func persistDraft() throws {
        try FileManager.default.createDirectory(at: draftDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if imageData.isEmpty {
            if FileManager.default.fileExists(atPath: imageDirectory.path) {try FileManager.default.removeItem(at: imageDirectory)}
            if FileManager.default.fileExists(atPath: legacyImageURL.path) {try FileManager.default.removeItem(at: legacyImageURL)}
        } else {
            try FileManager.default.createDirectory(at: imageDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for (index, data) in imageData.enumerated() {
                let url = imageURL(index)
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            if let files = try? FileManager.default.contentsOfDirectory(at: imageDirectory, includingPropertiesForKeys: nil) {
                for file in files {
                    let name = file.deletingPathExtension().lastPathComponent
                    guard let index = Int(name.replacingOccurrences(of: "image-", with: "")), imageData.indices.contains(index) else {
                        try? FileManager.default.removeItem(at: file); continue
                    }
                }
            }
        }
        let object: [String: Any] = ["title":titleField.string, "body":bodyField.string, "list":defaultList, "imageCount":imageData.count, "hasImage":!imageData.isEmpty, "needsCheck":blocked || submitting, "dispatchImmediately":dispatchImmediately]
        try JSONSerialization.data(withJSONObject: object).write(to: draftURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: draftURL.path)
    }
    private func restoreDraft() {
        guard let data = try? Data(contentsOf: draftURL),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {return}
        titleField.string = o["title"] as? String ?? ""
        bodyField.string = o["body"] as? String ?? ""
        blocked = o["needsCheck"] as? Bool ?? false
        dispatchImmediately = o["dispatchImmediately"] as? Bool ?? false
        imageData.removeAll()
        if let count = o["imageCount"] as? Int, count > 0 {
            for index in 0..<min(count, maxImageCount) {
                if let data = try? Data(contentsOf: imageURL(index)), data.count <= maxImageBytes {imageData.append(data)}
            }
        } else if o["hasImage"] as? Bool == true, let data = try? Data(contentsOf: legacyImageURL), data.count <= maxImageBytes {
            imageData = [data]
        }
        rebuildImagePreviews()
        titleField.needsDisplay = true; bodyField.needsDisplay = true
        if blocked {statusLabel.stringValue = "上次保存结果未确认。请先检查收集箱，避免重复创建。"}
        updateControls()
    }
    @objc private func save() {
        guard !submitting, !blocked else {return}
        let title = titleField.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = bodyField.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let list = defaultList
        guard !title.isEmpty else {statusLabel.stringValue = "请填写提醒标题"; return}
        guard title.count <= maxTitleCharacters else {statusLabel.stringValue = "提醒标题不能超过 \(maxTitleCharacters) 个字符"; return}
        guard notes.count <= maxNotesCharacters else {statusLabel.stringValue = "提醒正文不能超过 \(maxNotesCharacters) 个字符"; return}
        let executable = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("bin/remctl")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {statusLabel.stringValue = "请先安装 RemCTL"; return}
        // Return while composing Chinese is handled by the input method first.
        if titleField.hasMarkedText() || bodyField.hasMarkedText() {return}
        submitting = true; updateControls(); statusLabel.stringValue = "正在保存…"
        do {try persistDraft()} catch {submitting = false; updateControls(); statusLabel.stringValue = "草稿保存失败"; return}
        let args = createArguments(title: title, list: list, notes: notes, images: imageData.indices.map {imageURL($0)})
        // Keep the window visible until RemCTL confirms the reminder. If the
        // write fails, the user must see the error and retain the draft.
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
                    case .saved(let reminderId):
                        if self.dispatchImmediately {
                            let dispatchError = reminderId.map { self.launchDispatcher(reminderId: $0) } ?? "未收到提醒 ID，请检查提醒事项。"
                            if let dispatchError {
                                self.blocked = true
                                self.statusLabel.stringValue = "提醒已保存（ID \(reminderId ?? 0)）。\(dispatchError)"
                                try? self.persistDraft(); self.updateControls(); return
                            }
                        }
                        self.reset(); self.hideWindow()
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
    private func dispatcherWorkspace() -> String? {
        if let value = ProcessInfo.processInfo.environment["CODEX_TASKCTL_WORKSPACE"], !value.isEmpty, FileManager.default.fileExists(atPath: value) {return value}
        let settings = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/remctl/desktop/settings.json")
        guard let data = try? Data(contentsOf: settings), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let value = json["dispatcherWorkspace"] as? String, !value.isEmpty, FileManager.default.fileExists(atPath: value) else {return nil}
        return value
    }
    private func launchDispatcher(reminderId: Int) -> String? {
        let failure = "立即交给 Codex 未能启动，请检查 Dispatcher；勿重复保存。"
        let home = FileManager.default.homeDirectoryForCurrentUser
        let script = ProcessInfo.processInfo.environment["CODEX_TASKCTL_DISPATCHER_PATH"].map(URL.init(fileURLWithPath:)) ?? home.appendingPathComponent(".local/share/CodexTaskCtl/current/codextaskctl-dispatcher.mjs")
        let nodePath = ProcessInfo.processInfo.environment["CODEX_TASKCTL_NODE"] ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first {FileManager.default.isExecutableFile(atPath: $0)}
        guard FileManager.default.isReadableFile(atPath: script.path), let nodePath else {return failure}
        let state = home.appendingPathComponent(".config/remctl/desktop/dispatcher-state.json")
        let process = Process(); process.executableURL = URL(fileURLWithPath: nodePath)
        // Queue directly instead of starting a second Dispatcher. The resident
        // LaunchAgent owns the App Server connection and consumes this request.
        process.arguments = [script.path, "--queue-immediate", String(reminderId), "--state", state.path]
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  let output = String(data: data, encoding: .utf8),
                  let row = output.split(separator: "\n").reversed().first,
                  let json = try? JSONSerialization.jsonObject(with: Data(row.utf8)) as? [String: Any] else {return failure}
            if json["status"] as? String == "disabled" {return "本机 Dispatcher 已关闭；开启后可对这条提醒重新发起分发，勿重复保存。"}
            return json["status"] as? String == "queued" ? nil : failure
        } catch {return failure}
    }
}

if CommandLine.arguments.contains("--self-test") {
    precondition(createArguments(title:"--help", list:"A B", notes:"", images:[]) == ["add","--json","--list","A B","--","--help"])
    precondition(SaveOutcome.decode("{\"status\":\"created\",\"numericId\":1}", exitCode:0) == .saved(1))
    if case .saved = SaveOutcome.decode("{\"status\":\"partial\",\"numericId\":1}", exitCode:1) {fatalError("Partial write accepted")}
    if case .saved = SaveOutcome.decode("not JSON", exitCode:0) {fatalError("Unconfirmed write accepted")}
    precondition(createArguments(title:"默认", list:"", notes:"", images:[]) == ["add","--json","--","默认"])
    precondition(createArguments(title:"列表 ID", list:"2", notes:"正文", images:[]) == ["add","--json","--list-id","2","--notes","正文","--","列表 ID"])
    precondition(createArguments(title:"多图", list:"", notes:"正文", images:[URL(fileURLWithPath:"/tmp/a.png"), URL(fileURLWithPath:"/tmp/b.png")]) == ["add","--json","--notes","正文","--private","--image","/tmp/a.png","--image","/tmp/b.png","--","多图"])
    let pasteView = CaptureTextView(frame: .zero)
    var capturedImageCount = 0
    let titlePasteView = CaptureTextView(frame: .zero)
    attachImagePasteHandlers(titleField: titlePasteView, bodyField: pasteView) {_ in capturedImageCount += 1}
    let fixture = NSImage(size: NSSize(width: 2, height: 2))
    fixture.lockFocus(); NSColor.systemBlue.setFill(); NSRect(x: 0, y: 0, width: 2, height: 2).fill(); fixture.unlockFocus()
    NSPasteboard.general.clearContents()
    precondition(NSPasteboard.general.writeObjects([fixture, fixture]))
    pasteView.paste(nil)
    titlePasteView.paste(nil)
    NSPasteboard.general.clearContents()
    precondition(capturedImageCount == 4, "Image paste contract failed for title/body fields")
    let imageBytes = [Data([1]), Data([2]), Data([3])]
    precondition(removingImage(at: 1, from: imageBytes) == [Data([1]), Data([3])], "Image delete contract failed")
    precondition(removingImage(at: -1, from: imageBytes) == nil, "Image delete bounds contract failed")
    precondition(removingImage(at: 3, from: imageBytes) == nil, "Image delete upper bounds contract failed")
    print("Capture save contract passed")
} else {
    let app = NSApplication.shared
    let delegate = CaptureBar()
    app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
}
