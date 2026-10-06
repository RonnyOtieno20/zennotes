import Cocoa
import OSLog
import Quartz
import WebKit

/// Implemented by the opener service bundled inside this extension. Quick
/// Look's sandbox lets a preview launch nothing, not even the app it ships
/// in; the service runs outside it.
@objc(ZenNotesQuickLookOpening) protocol ZenNotesQuickLookOpening {
    func openNote(atPath path: String, reply: @escaping (Bool) -> Void)
    func openLink(_ link: String, reply: @escaping (Bool) -> Void)
}

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ZenNotesQuickLook", category: "preview")

/// Space on a Markdown file in Finder: the note rendered the way ZenNotes
/// renders it, by the app's own Preview code loaded from this bundle, with an
/// Open in ZenNotes button.
@objc(PreviewViewController)
final class PreviewViewController: NSViewController, QLPreviewingController, WKNavigationDelegate, WKScriptMessageHandler, WKURLSchemeHandler {
    private var webView: WKWebView!
    private var preview: NotePreview?
    private var completion: ((Error?) -> Void)?
    private var opener: NSXPCConnection?

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(self, forURLScheme: NotePreview.scheme)
        configuration.userContentController.add(WeakMessageHandler(self), name: "zennotes")
        // Page errors reach the system log (Console.app), where a blank preview
        // can be diagnosed. A user script runs outside the page's own policy.
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.errorReporter, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        #if QUICKLOOK_SELFTEST
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif
        self.webView = webView
        view = webView
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        do {
            preview = try NotePreview(fileURL: url, viewer: Bundle.main.resourceURL!.appendingPathComponent("viewer"))
        } catch {
            log.error("cannot preview \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            handler(error)
            return
        }
        completion = handler
        webView.load(URLRequest(url: NotePreview.pageURL))
        // Quick Look shows the panel once the handler is called. The page calls
        // back when the note has rendered; one that never does must not hold
        // the panel empty.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.finishPreparing() }
    }

    private func finishPreparing() {
        guard let completion else { return }
        self.completion = nil
        completion(nil)
        #if QUICKLOOK_SELFTEST
        let summary = "JSON.stringify({ ready: document.readyState, root: document.getElementById('zen-quicklook-root')?.childElementCount ?? -1, zen: typeof window.zen, theme: document.documentElement.dataset.theme || '', images: [...document.images].map((i) => i.currentSrc.split('/').pop() + ':' + i.naturalWidth), katex: document.querySelectorAll('.katex').length, mermaid: document.querySelectorAll('svg[id^=mermaid], .mermaid svg').length, text: (document.body.innerText || '').slice(0, 120) })"
        webView.evaluateJavaScript(summary) { result, _ in
            log.error("selftest page: \(String(describing: result), privacy: .public)")
        }
        if preview?.markdown.contains("quicklook-selftest-open") == true {
            webView.evaluateJavaScript("document.querySelector('[data-quicklook-open]')?.click()")
        }
        if preview?.markdown.contains("quicklook-selftest-keys") == true {
            let keys = """
            const press = (key, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }))
            const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
            press('j'); press('j'); press('j'); await settle()
            const afterJ = window.scrollY
            press('G', { shiftKey: true }); await settle()
            const afterG = window.scrollY
            press('g'); press('g'); await settle()
            return JSON.stringify({ afterJ, afterG, afterGG: window.scrollY, height: document.documentElement.scrollHeight })
            """
            webView.callAsyncJavaScript(keys, arguments: [:], in: nil, in: .page) { result in
                log.error("selftest keys: \(String(describing: try? result.get()), privacy: .public)")
            }
        }
        #endif
    }

    // MARK: - Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "ready":
            finishPreparing()
        case "log":
            let text = String(describing: body["message"] ?? "").prefix(500)
            log.error("page: \(text, privacy: .public)")
        case "open":
            guard let path = preview?.fileURL.path else { return }
            openerProxy()?.openNote(atPath: path) { opened in
                log.info("open in ZenNotes: \(opened ? "done" : "refused", privacy: .public)")
            }
        case "openLink":
            guard let link = body["url"] as? String, NotePreview.isOutsideLink(link) else { return }
            openerProxy()?.openLink(link) { _ in }
        default:
            break
        }
    }

    private func openerProxy() -> ZenNotesQuickLookOpening? {
        if opener == nil, let identifier = Bundle.main.bundleIdentifier {
            let connection = NSXPCConnection(serviceName: identifier + ".Opener")
            connection.remoteObjectInterface = NSXPCInterface(with: ZenNotesQuickLookOpening.self)
            connection.invalidationHandler = { [weak self] in
                DispatchQueue.main.async { self?.opener = nil }
            }
            connection.resume()
            opener = connection
        }
        return opener?.remoteObjectProxyWithErrorHandler { error in
            log.error("opener unavailable: \(error.localizedDescription, privacy: .public)")
        } as? ZenNotesQuickLookOpening
    }

    // MARK: - Navigation

    /// The page never navigates: links go through the opener, so anything
    /// leaving the extension's own scheme is refused.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(navigationAction.request.url?.scheme == NotePreview.scheme ? .allow : .cancel)
    }

    // MARK: - zenql:// scheme

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let preview else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        do {
            let response = try preview.response(for: url, range: task.request.value(forHTTPHeaderField: "Range"))
            task.didReceive(response.head)
            task.didReceive(response.body)
            task.didFinish()
        } catch {
            task.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

extension PreviewViewController {
    /// Uncaught errors, failed loads (a script or stylesheet the page could not
    /// fetch) and rejected promises, forwarded to the extension's log.
    static let errorReporter = """
    (() => {
      const post = (message) => window.webkit?.messageHandlers?.zennotes?.postMessage({ action: 'log', message: String(message) })
      window.addEventListener('error', (event) => {
        const target = event.target
        if (target && target !== window && (target.src || target.href)) post('failed to load ' + (target.src || target.href))
        else post(event.message + ' at ' + event.filename + ':' + event.lineno)
      }, true)
      window.addEventListener('unhandledrejection', (event) => post('unhandled rejection: ' + ((event.reason && event.reason.stack) || event.reason)))
    })()
    """
}

/// The content controller keeps its message handlers alive, and the view
/// controller keeps the web view; a weak hop breaks that cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
