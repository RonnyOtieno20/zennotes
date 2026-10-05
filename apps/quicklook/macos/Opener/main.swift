import AppKit

/// Matches the protocol in the extension's PreviewViewController.swift.
@objc(ZenNotesQuickLookOpening) protocol ZenNotesQuickLookOpening {
    func openNote(atPath path: String, reply: @escaping (Bool) -> Void)
    func openLink(_ link: String, reply: @escaping (Bool) -> Void)
}

/// Hands a previewed note to the ZenNotes this service ships inside, and an
/// outside link to the browser. Quick Look's sandbox lets the preview itself
/// launch nothing. What it asks is checked here again: only an existing
/// Markdown file, only into this ZenNotes, and only web or mail links.
final class Opener: NSObject, ZenNotesQuickLookOpening {
    /// ZenNotes.app/Contents/PlugIns/<extension>.appex/Contents/XPCServices/<this>.xpc
    private static let app: URL? = {
        var url = Bundle.main.bundleURL
        for _ in 0..<6 { url.deleteLastPathComponent() }
        guard url.pathExtension == "app",
              let ownIdentifier = Bundle.main.bundleIdentifier,
              let appIdentifier = Bundle(url: url)?.bundleIdentifier,
              ownIdentifier.hasPrefix(appIdentifier + ".") else { return nil }
        return url
    }()

    func openNote(atPath path: String, reply: @escaping (Bool) -> Void) {
        let file = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        guard let app = Opener.app,
              ["md", "markdown"].contains(file.pathExtension.lowercased()),
              FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else {
            reply(false)
            return
        }
        // The same route as a double-click in Finder: a note inside a known
        // vault opens there, anything else in its own window.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([file], withApplicationAt: app, configuration: configuration) { _, error in
            reply(error == nil)
        }
    }

    func openLink(_ link: String, reply: @escaping (Bool) -> Void) {
        guard let url = URL(string: link.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else {
            reply(false)
            return
        }
        NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            reply(error == nil)
        }
    }
}

final class ServiceDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: ZenNotesQuickLookOpening.self)
        connection.exportedObject = Opener()
        connection.resume()
        return true
    }
}

let delegate = ServiceDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
