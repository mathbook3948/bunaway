import UIKit
import WebKit

/// Exercises real WKWebView messages against the production host before the SDK checks.
final class RegressionHost: BunawayViewController {
  private var previousNonce: String?
  private var probed = false
  private var staleMessages = 0
  private var missingNavigation: WKNavigation?
  private var replacementNavigation: WKNavigation?
  private var navigationRecovery = false
  private var cacheRestored = false
  private var inputQueueClosed = false
  private var invalidMessagesClosed = false
  private var cancelledTask: WKURLSchemeTask?
  private var cancellationObserved = false
  private var cancelledNavigationRecovered = false
  private var replacementNavigationPreserved = false
  private var homeFailures = 0
  private var directConnected = false
  private var fallbackConnected = false
  private var nativeDataMessages = 0
  var testsFallback: Bool { ProcessInfo.processInfo.arguments.contains("--fallback") }
  var testsHomeFailure: Bool { ProcessInfo.processInfo.arguments.contains("--home-failure") }

  override func viewDidLoad() {
    super.viewDidLoad()
    (view as? WKWebView)?.configuration.userContentController.add(self, name: "regression")
  }

  override func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    if message.name == "regression", message.frameInfo.isMainFrame {
      switch message.body as? String {
      case "directConnected": directConnected = true
      case "fallbackConnected": fallbackConnected = true
      case "cacheRestored": cacheRestored = true
      case "inputQueueClosed": inputQueueClosed = true
      case "invalidMessagesClosed": invalidMessagesClosed = true
      case "cancelledNavigationRecovered":
        precondition(cancellationObserved, "No actual navigation cancellation occurred.")
        cancelledNavigationRecovered = true
      case "replacementNavigationPreserved": replacementNavigationPreserved = true
      default: fatalError("Unknown fixture regression message.")
      }
      recordRegressions()
      return
    }
    super.userContentController(controller, didReceive: message)
    guard message.frameInfo.isMainFrame,
      let body = message.body as? [String: String],
      let nonce = body["nonce"],
      let text = body["data"], let web = view as? WKWebView
    else { return }
    if text.first == "{",
      let payload = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      payload["kind"] as? String == "hello"
    {
      fallbackConnected = true
      nativeDataMessages += 1
    }
    guard text == "@bunaway-port:" + nonce else { return }

    if let previous = previousNonce, previous != nonce {
      // Use the real WebKit entrypoint. Malformed stale data must be discarded before parsing.
      web.evaluateJavaScript(
        "webkit.messageHandlers.bunaway.postMessage({nonce: '\(previous)', data: '{'});")
      staleMessages += 1
    }
    previousNonce = nonce

    if replacementNavigation != nil, let previous = missingNavigation {
      // Deliver these callbacks after the replacement document has opened its SDK session.
      self.webView(
        web, didFailProvisionalNavigation: previous,
        withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      self.webView(
        web, didFailProvisionalNavigation: previous,
        withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
      replacementNavigation = nil
      missingNavigation = nil
      navigationRecovery = true
    }

    guard message.frameInfo.request.url?.query == "probe=1" else { return }
    DispatchQueue.main.async {
      if self.probed {
        web.load(URLRequest(url: URL(string: "bunaway://app.bunaway.local/")!))
        return
      }
      self.probed = true
      // Close the current session, then send another message before JS receives the close callback.
      web.evaluateJavaScript(
        """
        webkit.messageHandlers.bunaway.postMessage({nonce: '\(nonce)', data: '{'});
        webkit.messageHandlers.bunaway.postMessage({nonce: '\(nonce)', data: '{"kind":"invoke"}'});
        true;
        """
      ) { _, error in
        precondition(error == nil, "Document failure probe failed: \(String(describing: error))")
        self.missingNavigation = web.load(
          URLRequest(url: URL(string: "bunaway://app.bunaway.local/missing.html")!))
      }
    }
  }

  override func webView(
    _ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!
  ) {
    super.webView(webView, didStartProvisionalNavigation: navigation)
    // Intercept the actual browser constructor before the asynchronous native grant arrives.
    let probe =
      testsFallback
      ? "globalThis.WebSocket = class { constructor() { throw new Error('Fixture rejects initial socket'); } };"
      : """
      const BrowserSocket = globalThis.WebSocket;
      globalThis.WebSocket = class extends BrowserSocket {
        constructor(url) {
          super(url);
          this.addEventListener('open', () => webkit.messageHandlers.regression.postMessage('directConnected'));
        }
      };
      """
    webView.configuration.userContentController.addUserScript(
      WKUserScript(
        source: probe,
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    if let missing = missingNavigation, navigation !== missing {
      replacementNavigation = navigation
    }
  }

  override func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if (error as NSError).code == NSURLErrorCancelled, cancelledTask != nil {
      cancellationObserved = true
    }
    super.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    guard testsHomeFailure else { return }
    homeFailures += 1
    if homeFailures == 2 {
      precondition(!(view is WKWebView), "Failed home did not show a recovery screen.")
      let retry = view.subviews.flatMap { $0.subviews }.compactMap { $0 as? UIButton }.first
      precondition(retry != nil, "Recovery screen has no retry action.")
      retry?.sendActions(for: .touchUpInside)
    } else if homeFailures == 4 {
      precondition(!(view is WKWebView), "Explicit retry did not contain another home failure.")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        precondition(self.homeFailures == 4, "Home recovery kept navigating after its limit.")
        self.writeReport("ios-home-failure.json", ["failures": self.homeFailures, "retry": true])
      }
    } else {
      precondition(homeFailures < 4, "Home recovery loops indefinitely.")
    }
  }

  override func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    super.webView(webView, didFinish: navigation)
    guard webView.url?.path == "/", probed, staleMessages > 0 else { return }
    recordRegressions()
  }

  override func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    if ["/cancelled.html", "/replaced.html"].contains(task.request.url?.path ?? "") {
      // Keep a real provisional navigation pending, then let the production delegate recover it.
      cancelledTask = task
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        if task.request.url?.path == "/cancelled.html" {
          webView.stopLoading()
        } else {
          webView.load(
            URLRequest(url: URL(string: "bunaway://app.bunaway.local/index.html?replacement=1")!))
        }
      }
      return
    }
    super.webView(webView, start: task)
  }

  override func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    if task === cancelledTask {
      cancellationObserved = true
      cancelledTask = nil
    }
    super.webView(webView, stop: task)
  }

  private func recordRegressions() {
    writeReport(
      "ios-host-regressions.json",
      [
        "directConnected": directConnected, "fallbackConnected": fallbackConnected,
        "nativeDataMessages": nativeDataMessages,
        "documentFailure": probed, "staleMessages": staleMessages > 0, "rootNavigation": true,
        "cancelledNavigation": cancelledNavigationRecovered, "staleNavigation": navigationRecovery,
        "navigationRecovery": navigationRecovery, "cacheRestored": cacheRestored,
        "inputQueueClosed": inputQueueClosed,
        "invalidMessagesClosed": invalidMessagesClosed,
        "replacementNavigationPreserved": replacementNavigationPreserved,
      ])
  }

  private func writeReport(_ name: String, _ results: [String: Any]) {
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let report = directory.appendingPathComponent(name)
    do {
      let bytes = try JSONSerialization.data(withJSONObject: results)
      try bytes.write(to: report, options: .atomic)
    } catch {
      fatalError("Could not record host regression results: \(error)")
    }
  }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ app: UIApplication,
    didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let host = RegressionHost()
    window.rootViewController = host
    window.makeKeyAndVisible()
    self.window = window

    // Native stdout must remain outside the Bun control channel after viewDidLoad starts Bun.
    print("iOS Swift stdout is not a control frame.")
    if host.testsHomeFailure { return true }
    for seconds in [16.0, 30.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        print("iOS Swift restarts a Worker.")
        host.restartBackend()
      }
    }
    return true
  }
}
