import Darwin
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Owns the single packaged view, its document session and the embedded Bun entry.
/// The process keeps Bun alive; only an explicit backend restart replaces its Worker.
/// Subclasses must call `super.viewDidLoad()` once to connect the packaged app.
/// Failures before Bun starts show an error view; control pipe failures afterward end the app.
open class BunawayViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate,
  WKURLSchemeHandler, WKUIDelegate
{
  private static var bunStarted = false
  // A new session needs an open frame and must still be able to enqueue its revocation.
  private static let DOCUMENT_CONTROL_RESERVE = 2
  private static let CHANNEL_PREFIX = "@bunaway-port:"
  private enum DocumentChannel {
    case unselected
    case requesting
    case direct
    case fallback
  }
  private var documentChannel = DocumentChannel.unselected
  private enum Phase {
    case starting
    case ready
    case restarting
    case failed
  }

  // Bun and its pipes outlive every document and backend Worker generation.
  private var phase = Phase.starting
  private var input: FileHandle!
  private var output: FileHandle!
  private let writes = DispatchQueue(label: "dev.bunaway.ios.control")
  private let runtimeId = UUID().uuidString
  private var generation = UUID().uuidString
  private var readBuffer = Data()
  private var queuedWrites = 0
  private var readyTimer: Timer?

  // Navigation and suspension revoke the document without stopping Bun.
  private var webView: WKWebView!
  private var bridgeScript = ""
  private var navigation: WKNavigation?
  private var context: String?
  private var nonce: String?
  private var recoveringNavigation = false
  private var suspended = false

  private var host: [String: Any] = [:]
  private var home: URL!
  private var assets: URL!

  // Generated from the protocol package by ios sync.
  private var maxMessageBytes = 0
  private var maxDepth = 0
  private var maxPending = 0
  private var startupTimeoutMs = 0
  private var messageSchema: [String: Any] = [:]
  private var messagePatterns: [String: NSRegularExpression] = [:]

  open override func viewDidLoad() {
    super.viewDidLoad()

    do {
      try loadConfiguration()
      try configureWebView()
      try connectRuntime()

      NotificationCenter.default.addObserver(
        self, selector: #selector(suspendDocument),
        name: UIApplication.didEnterBackgroundNotification, object: nil)
      NotificationCenter.default.addObserver(
        self, selector: #selector(resumeDocument),
        name: UIApplication.willEnterForegroundNotification, object: nil)

      // Wait for backend ready before loading the first document.
      boot()
    } catch {
      fail(error)
    }
  }

  // MARK: - Packaged configuration and startup

  /// Reads the generated host contract and maps its HTTPS home to packaged WebView assets.
  private func loadConfiguration() throws {
    guard let resource = Bundle.main.resourceURL else {
      throw HostError.invalidConfiguration
    }
    assets = resource.appendingPathComponent("bunaway-assets")
    host = try dictionary(Data(contentsOf: assets.appendingPathComponent("host.json")))

    guard let homeText = host["home"] as? String,
      let configuredHome = URL(string: homeText), configuredHome.scheme == "https",
      configuredHome.host != nil, configuredHome.port == nil,
      let limits = host["limits"] as? [String: Int],
      let bytes = limits["messageBytes"], let depth = limits["depth"],
      let pending = limits["pending"], let timeout = limits["startupTimeoutMs"],
      host["view"] is String, host["policy"] is [String: Any],
      host["protocol"] is [String: Int], host["ipc"] is [String: Int]
    else {
      throw HostError.invalidConfiguration
    }

    maxMessageBytes = bytes
    maxDepth = depth
    maxPending = pending
    startupTimeoutMs = timeout
    messageSchema = try dictionary(
      Data(contentsOf: assets.appendingPathComponent("message.schema.json")))
    try checkMessageSchema(messageSchema)

    var components = URLComponents(url: configuredHome, resolvingAgainstBaseURL: false)!
    components.scheme = "bunaway"
    home = components.url!
  }

  /// Configures asset routing and reads the bridge injected into each new main-frame document.
  private func configureWebView() throws {
    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(self, forURLScheme: "bunaway")

    let controller = configuration.userContentController
    controller.add(self, name: "bunaway")
    bridgeScript = try String(
      contentsOf: assets.appendingPathComponent("bridge.js"), encoding: .utf8
    )
    .replacingOccurrences(of: "__BUNAWAY_PORT_PREFIX__", with: Self.CHANNEL_PREFIX)

    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    view = webView
    title = host["title"] as? String
  }

  /// Starts the embedded entry with writable sandbox paths and observes its control output.
  private func connectRuntime() throws {
    let files = FileManager.default
    let documents = try files.url(
      for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let cache = try files.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let entry = assets.appendingPathComponent("backend/entry.js").path
    try startRuntime(entry: entry, home: documents.path, cache: cache.path)

    // Keep the pipe reader off main and wait for WebKit, not just UIKit frame dispatch.
    // At most one read batch is in flight; a slow renderer applies pipe backpressure.
    output.readabilityHandler = { [weak self] handle in
      let bytes = handle.availableData
      let finished = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        guard let self = self else {
          finished.signal()
          return
        }
        self.read(bytes) { finished.signal() }
      }
      finished.wait()
    }
  }

  /// Starts Bun once on the UIKit thread and transfers its control pipe handles to this host.
  /// Failed startup closes every untransferred descriptor and argument without changing stdio.
  private func startRuntime(entry: String, home: String, cache: String) throws {
    guard !Self.bunStarted else {
      throw HostError.runtimeAlreadyStarted
    }

    let initialized = BunEmbedInitialize()
    guard initialized == 0 else {
      throw HostError.runtimeStart(initialized)
    }
    guard setenv("HOME", home, 1) == 0, setenv("TMPDIR", cache, 1) == 0 else {
      throw HostError.runtimePipe(errno)
    }

    var incoming: [Int32] = [-1, -1]
    var outgoing: [Int32] = [-1, -1]
    defer {
      if !Self.bunStarted {
        for descriptor in incoming + outgoing where descriptor >= 0 {
          close(descriptor)
        }
      }
    }

    // These descriptors belong only to the control channel; Swift and SDK stdout stay unchanged.
    guard pipe(&incoming) == 0, pipe(&outgoing) == 0 else {
      throw HostError.runtimePipe(errno)
    }

    // Bun copies argv before returning. Keep every C string alive through that call.
    let arguments = [
      "bun", "--no-env-file", "run", entry, String(incoming[0]), String(outgoing[1]),
    ].map { strdup($0) }
    defer {
      for argument in arguments {
        free(argument)
      }
    }
    guard arguments.allSatisfy({ $0 != nil }) else {
      throw HostError.runtimePipe(ENOMEM)
    }
    let pointers = arguments.map { argument in argument.map { UnsafePointer($0) } }
    let result = pointers.withUnsafeBufferPointer { buffer in
      BunEmbedStart(Int32(buffer.count), buffer.baseAddress)
    }
    guard result == 0 else {
      throw HostError.runtimeStart(result)
    }

    // Entry owns its descriptor ends after startup. Closing them here would close Bun's pipes too.
    Self.bunStarted = true
    input = FileHandle(fileDescriptor: incoming[1], closeOnDealloc: true)
    output = FileHandle(fileDescriptor: outgoing[0], closeOnDealloc: true)
  }

  // MARK: - Backend lifecycle and control frames

  /// Stops Core and its sessions before replacing the backend Worker. Bun is never restarted.
  /// Startup or cleanup failure ends the app once Bun has started.
  /// Requests while starting, restarting or failed have no effect.
  public func restartBackend() {
    guard phase == .ready else {
      return
    }
    closeDocument()
    phase = .restarting
    send(["kind": "shutdown"])
    armTimeout()
  }

  /// Opens a Worker generation and completes the protocol handshake before loading the view.
  private func boot() {
    phase = .starting
    send([
      "kind": "boot",
      "payload": [
        "entrypoint": assets.appendingPathComponent("backend/backend.js").path,
        "buildId": "bunaway-ios",
        "backendContext": UUID().uuidString,
        "policy": host["policy"]!,
      ],
    ])
    send([
      "kind": "hello",
      "payload": [
        "kind": "hello",
        "protocol": host["protocol"]!,
        "features": [],
        "buildId": "bunaway-ios",
      ],
    ])
    armTimeout()
  }

  private func armTimeout() {
    readyTimer?.invalidate()
    readyTimer = Timer.scheduledTimer(
      withTimeInterval: Double(startupTimeoutMs) / 1000, repeats: false
    ) { [weak self] _ in
      self?.fail(HostError.runtimeTimeout)
    }
  }

  /// Writes JSON-lines in order, keeping blocking pipe I/O off the UIKit thread.
  /// Document input is bounded at its entrypoint, leaving room for lifecycle control frames.
  private func send(_ body: [String: Any]) {
    do {
      try enqueue(body)
    } catch {
      fail(error)
    }
  }

  /// Serialization failures belong to the caller; only an actual pipe write failure ends Bun.
  private func enqueue(_ body: [String: Any]) throws {
    guard phase != .failed else {
      return
    }

    var frame = body
    frame["ipc"] = host["ipc"]!
    frame["runtime"] = ["id": runtimeId, "generation": generation]
    guard validDepth(frame, depth: 0) else { throw HostError.invalidMessage }
    var bytes = try JSONSerialization.data(
      withJSONObject: frame, options: [.sortedKeys, .withoutEscapingSlashes])
    guard bytes.count <= maxMessageBytes else {
      throw HostError.invalidMessage
    }
    bytes.append(10)

    queuedWrites += 1
    writes.async { [weak self] in
      guard let self = self else {
        return
      }
      do {
        try self.input.write(contentsOf: bytes)
      } catch {
        DispatchQueue.main.async {
          self.fail(error)
        }
      }
      DispatchQueue.main.async {
        self.queuedWrites -= 1
      }
    }
  }

  /// Reassembles control frames and applies only the current Bun identity and Worker generation.
  /// Completes after the batch reaches WebKit so the I/O reader cannot outrun the renderer.
  /// An incomplete line stays buffered; EOF or an invalid frame ends the host connection.
  private func read(_ bytes: Data, completion: @escaping () -> Void) {
    guard phase != .failed else {
      completion()
      return
    }
    if bytes.isEmpty {
      completion()
      fail(HostError.controlClosed)
      return
    }
    readBuffer.append(bytes)
    var messages: [[Any]] = []

    do {
      while let newline = readBuffer.firstIndex(of: 10) {
        let line = readBuffer.prefix(upTo: newline)
        guard !line.isEmpty, line.count <= maxMessageBytes else {
          throw HostError.invalidMessage
        }
        let frame = try dictionary(Data(line))
        readBuffer.removeSubrange(...newline)

        guard let runtime = frame["runtime"] as? [String: Any],
          runtime["id"] as? String == runtimeId,
          runtime["generation"] as? String == generation,
          let kind = frame["kind"] as? String
        else {
          throw HostError.invalidMessage
        }

        switch kind {
        case "hello": break
        case "ready":
          guard phase == .starting else {
            throw HostError.invalidMessage
          }
          readyTimer?.invalidate()
          phase = .ready
          if !suspended {
            loadHome()
          }
        case "stopping":
          guard phase == .restarting else {
            throw HostError.invalidMessage
          }
          // Entry waits for this Worker to exit before accepting the next boot.
          generation = UUID().uuidString
          boot()
        case "channel-ready":
          try receiveChannel(frame, messages: &messages)
        case "web":
          if documentChannel == .fallback, frame["context"] as? String == context,
            let nonce = nonce,
            let payload = frame["payload"]
          {
            messages.append([nonce, payload])
          }
        case "host-request":
          guard let request = frame["requestId"], let source = frame["context"] else {
            throw HostError.invalidMessage
          }
          send([
            "kind": "host-response",
            "context": source,
            "requestId": request,
            "payload": [
              "kind": "error",
              "error": [
                "code": "UNSUPPORTED",
                "message": "iOS native plugins are not implemented.",
              ],
            ],
          ])
        case "host-cancel": break
        case "fatal": throw HostError.backendFailed
        default: throw HostError.invalidMessage
        }
      }
      guard readBuffer.count <= maxMessageBytes else {
        throw HostError.invalidMessage
      }
      deliver(messages, completion: completion)
    } catch {
      completion()
      fail(error)
    }
  }

  // MARK: - Document sessions and SDK bridge

  /// Accepts SDK messages only from this WebView's packaged main frame.
  /// Connection grants and fallback share the same native origin and document checks.
  public func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard phase == .ready, !suspended, message.webView === webView,
      message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == "bunaway",
      message.frameInfo.securityOrigin.host == home.host,
      message.frameInfo.securityOrigin.port == 0,
      let body = message.body as? [String: Any], body.count == 2,
      let documentNonce = body["nonce"] as? String,
      documentNonce == nonce,
      let text = body["data"] as? String, let bytes = text.data(using: .utf8)
    else {
      return
    }

    do {
      guard bytes.count <= maxMessageBytes else {
        throw HostError.invalidMessage
      }
      if text.hasPrefix(Self.CHANNEL_PREFIX) {
        try selectChannel(text, nonce: documentNonce)
        return
      }
      guard documentChannel == .fallback else { throw HostError.invalidMessage }
      let payload = try dictionary(bytes)
      guard matchesMessageSchema(messageSchema, payload),
        let kind = payload["kind"] as? String,
        ["hello", "invoke", "listen", "unlisten", "cancel", "close"].contains(kind)
      else {
        throw HostError.invalidMessage
      }
      // Reject only this document when its input outruns the pipe. Revocation must still fit.
      guard queuedWrites < maxPending - Self.DOCUMENT_CONTROL_RESERVE else {
        closeDocument()
        NSLog("Bunaway iOS document input queue full.")
        return
      }

      guard let context = context else {
        return
      }
      if kind == "close" {
        closeDocument()
        return
      }
      try enqueue(["kind": "web", "context": context, "payload": payload])
    } catch {
      closeDocument()
      NSLog("Bunaway iOS document rejected: %@", String(describing: error))
    }
  }

  /// Opens the Core session before requesting a one-use, document-bound loopback capability.
  private func openSession() {
    context = UUID().uuidString
    send(["kind": "session-open", "context": context!, "viewId": host["view"]!])
  }

  private func selectChannel(_ text: String, nonce: String) throws {
    if documentChannel == .unselected && text == Self.CHANNEL_PREFIX + nonce {
      documentChannel = .requesting
      openSession()
      // URLComponents preserves IPv6 authority brackets when serializing the policy origin.
      guard var origin = URLComponents(url: home, resolvingAgainstBaseURL: false) else {
        throw HostError.invalidConfiguration
      }
      origin.scheme = "https"
      origin.host = origin.host?.lowercased()
      origin.path = ""
      origin.query = nil
      origin.fragment = nil
      guard let policyOrigin = origin.string else { throw HostError.invalidConfiguration }
      send([
        "kind": "channel-open", "context": context!, "nonce": nonce,
        "origin": policyOrigin,
      ])
      return
    }
    guard documentChannel == .direct,
      text == Self.CHANNEL_PREFIX + "fallback:" + nonce,
      let previous = context
    else { throw HostError.invalidMessage }
    // No SDK message was sent before WebSocket open. Revoke the failed grant before fallback.
    send(["kind": "revoke", "context": previous])
    openSession()
    documentChannel = .fallback
    deliver([[nonce, Self.CHANNEL_PREFIX + "fallback:" + nonce]], completion: {})
  }

  /// Discards late grants and exposes only validated loopback endpoints to the current document.
  private func receiveChannel(_ frame: [String: Any], messages: inout [[Any]]) throws {
    guard documentChannel == .requesting, let nonce = nonce,
      frame["context"] as? String == context, frame["nonce"] as? String == nonce
    else { return }
    guard let endpoint = frame["url"] as? String else { throw HostError.invalidMessage }
    if endpoint.isEmpty {
      documentChannel = .fallback
      messages.append([nonce, Self.CHANNEL_PREFIX + "fallback:" + nonce])
      return
    }
    guard let url = URLComponents(string: endpoint), url.scheme == "ws",
      url.host == "127.0.0.1", let port = url.port, (1...65535).contains(port),
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.percentEncodedPath.count == 37, url.percentEncodedPath.hasPrefix("/"),
      UUID(uuidString: String(url.percentEncodedPath.dropFirst())) != nil
    else { throw HostError.invalidMessage }
    documentChannel = .direct
    messages.append([nonce, Self.CHANNEL_PREFIX + "socket:" + nonce + ":" + endpoint])
  }

  private func validDepth(_ value: Any, depth: Int) -> Bool {
    guard depth <= maxDepth else {
      return false
    }
    if let map = value as? [String: Any] {
      return map.values.allSatisfy { validDepth($0, depth: depth + 1) }
    }
    if let list = value as? [Any] {
      return list.allSatisfy { validDepth($0, depth: depth + 1) }
    }
    if let number = value as? NSNumber {
      return number.doubleValue.isFinite
    }
    return true
  }

  /// Accepts only the shared message schema subset and compiles identifier patterns once.
  /// New unsupported schema rules fail startup instead of silently weakening the boundary.
  private func checkMessageSchema(_ schema: [String: Any]) throws {
    let keywords: Set<String> = [
      "$schema", "type", "const", "enum", "anyOf", "properties", "required",
      "additionalProperties", "items", "minimum", "maximum", "minItems", "maxItems",
      "uniqueItems", "maxLength", "pattern",
    ]
    guard Set(schema.keys).isSubset(of: keywords),
      schema["const"] == nil || schema["const"] is String,
      schema["type"] == nil
        || ["object", "array", "string", "integer", "boolean"].contains(
          schema["type"] as? String ?? "")
    else { throw HostError.invalidConfiguration }
    let type = schema["type"] as? String
    for (requiredType, rules) in [
      "object": ["properties", "required", "additionalProperties"],
      "array": ["items", "minItems", "maxItems", "uniqueItems"],
      "string": ["pattern", "maxLength"],
      "integer": ["minimum", "maximum"],
    ] {
      if rules.contains(where: { schema[$0] != nil }), type != requiredType {
        throw HostError.invalidConfiguration
      }
    }
    if schema["uniqueItems"] as? Bool == true,
      (schema["items"] as? [String: Any])?["type"] as? String != "string"
    {
      throw HostError.invalidConfiguration
    }
    if let pattern = schema["pattern"] as? String {
      messagePatterns[pattern] = try NSRegularExpression(pattern: pattern)
    }
    for child in (schema["properties"] as? [String: [String: Any]] ?? [:]).values {
      try checkMessageSchema(child)
    }
    for child in schema["anyOf"] as? [[String: Any]] ?? [] {
      try checkMessageSchema(child)
    }
    if let child = schema["items"] as? [String: Any] { try checkMessageSchema(child) }
  }

  /// Applies the generated protocol rules to parsed JSON before it enters the control channel.
  private func matchesMessageSchema(_ schema: [String: Any], _ value: Any) -> Bool {
    if let constant = schema["const"] as? String, value as? String != constant { return false }
    if let options = schema["enum"] as? [String], !options.contains(value as? String ?? "") {
      return false
    }
    if let options = schema["anyOf"] as? [[String: Any]],
      !options.contains(where: { matchesMessageSchema($0, value) })
    {
      return false
    }

    switch schema["type"] as? String {
    case "object":
      guard let object = value as? [String: Any] else { return false }
      let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
      guard (schema["required"] as? [String] ?? []).allSatisfy({ object[$0] != nil }) else {
        return false
      }
      return object.allSatisfy { key, item in
        if let child = properties[key] { return matchesMessageSchema(child, item) }
        return schema["additionalProperties"] as? Bool != false
      }
    case "array":
      guard let array = value as? [Any],
        array.count >= (schema["minItems"] as? Int ?? 0),
        array.count <= (schema["maxItems"] as? Int ?? Int.max)
      else { return false }
      // The message schema uses uniqueness only for identifier strings.
      if schema["uniqueItems"] as? Bool == true {
        guard let strings = array as? [String], Set(strings).count == strings.count else {
          return false
        }
      }
      return array.allSatisfy { matchesMessageSchema(schema["items"] as? [String: Any] ?? [:], $0) }
    case "string":
      guard let string = value as? String,
        string.unicodeScalars.count <= (schema["maxLength"] as? Int ?? Int.max)
      else { return false }
      if let pattern = schema["pattern"] as? String {
        return messagePatterns[pattern]?.firstMatch(
          in: string, range: NSRange(string.startIndex..., in: string)) != nil
      }
      return true
    case "integer":
      guard let number = value as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID()
      else { return false }
      let integer = number.doubleValue
      let maxSafeInteger = 9_007_199_254_740_991.0
      return integer.isFinite && integer.rounded() == integer && abs(integer) <= maxSafeInteger
        && integer >= (schema["minimum"] as? Double ?? -Double.infinity)
        && integer <= (schema["maximum"] as? Double ?? Double.infinity)
    case "boolean":
      guard let number = value as? NSNumber else { return false }
      return CFGetTypeID(number) == CFBooleanGetTypeID()
    default: return true
    }
  }

  /// Delivers one pipe batch in one WebKit call and releases the reader on every completion path.
  /// A callback from a replaced document must not fail the newly connected session.
  private func deliver(_ messages: [[Any]], completion: @escaping () -> Void) {
    guard !messages.isEmpty else {
      completion()
      return
    }

    do {
      let data = try JSONSerialization.data(withJSONObject: messages)
      guard let json = String(data: data, encoding: .utf8) else {
        throw HostError.invalidMessage
      }

      // JSON stays data; WebKit applies it only to the matching document nonce.
      let documentNonce = messages.first?.first as? String
      webView.evaluateJavaScript(
        "for (const [nonce, payload] of \(json)) { globalThis.__bunawayReceive(nonce, typeof payload === 'string' ? payload : JSON.stringify(payload)); }"
      ) {
        [weak self] _, error in
        if let error = error, self?.nonce == documentNonce, self?.context != nil {
          self?.closeDocument()
          NSLog("Bunaway iOS document delivery failed: %@", String(describing: error))
        }
        completion()
      }
    } catch {
      completion()
      fail(error)
    }
  }

  /// Revokes input immediately, enqueues Core cleanup and notifies the matching JS bridge.
  private func closeDocument() {
    let documentNonce = nonce
    nonce = nil
    if let context = context {
      send(["kind": "revoke", "context": context])
    }
    context = nil
    documentChannel = .unselected
    if let documentNonce = documentNonce {
      // The host already revoked access. Closing JS is best effort and uses a host-generated UUID.
      webView.evaluateJavaScript("globalThis.__bunawayClose?.('\(documentNonce)')")
    }
  }

  /// Issues the next document identity before WebKit starts its scripts.
  /// Old callbacks cannot open a session or parse input after navigation revokes their token.
  private func prepareDocument() {
    closeDocument()
    navigation = nil
    let documentNonce = UUID().uuidString
    nonce = documentNonce
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    controller.addUserScript(
      WKUserScript(
        source: bridgeScript.replacingOccurrences(
          of: "__BUNAWAY_DOCUMENT_NONCE__", with: documentNonce),
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  // MARK: - UIKit and WebView lifecycle

  // Backgrounding revokes UI access while preserving the Worker and Core state.
  @objc private func suspendDocument() {
    suspended = true
    closeDocument()
  }

  @objc private func resumeDocument() {
    suspended = false
    if phase == .ready {
      loadHome()
    }
  }

  /// Issues an identity only for a new document, preserving SDK connections on hash navigation.
  /// Tracks the newest navigation so late failure callbacks cannot close its document.
  public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!)
  {
    prepareDocument()
    self.navigation = navigation
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if navigation === self.navigation {
      recoveringNavigation = false
      self.navigation = nil
    }
  }

  /// Restricts navigation to the packaged asset origin.
  public func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    // A nil target frame is a new-window request (window.open, target=_blank). The app is one
    // window, so it is cancelled rather than loaded here.
    guard action.targetFrame != nil else {
      decisionHandler(.cancel)
      return
    }
    let url = action.request.url
    guard url?.scheme == "bunaway", url?.host == home.host, url?.port == nil else {
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  /// Refuses new-window requests; the app has one WebView and one window.
  public func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    nil
  }

  /// Denies media access because this host exposes no native permission contract for it.
  public func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }

  /// Reconnects a fresh document after WebKit replaces its renderer process.
  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    closeDocument()
    if phase == .ready && !suspended {
      loadHome()
    }
  }

  /// Contains a failed current navigation without stopping the backend.
  public func webView(
    _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
  ) {
    navigationFailed(navigation, error: error)
  }

  /// Applies the same document-only failure contract before a navigation commits.
  public func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    navigationFailed(navigation, error: error)
  }

  private func navigationFailed(_ navigation: WKNavigation?, error: Error) {
    guard let navigation = navigation,
      navigation === self.navigation
    else {
      return
    }
    let failure = error as NSError
    // WebKit can cancel the old request before reporting the replacement's provisional start.
    if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled
      && webView.isLoading
    {
      return
    }
    closeDocument()
    self.navigation = nil
    NSLog("Bunaway iOS navigation failed: %@", String(describing: error))
    if recoveringNavigation {
      showNavigationError()
      return
    }
    recoveringNavigation = true
    webView.load(URLRequest(url: home))
  }

  /// Loads a fresh home document for startup, explicit retry or renderer recovery.
  @objc private func loadHome() {
    recoveringNavigation = false
    view = webView
    webView.load(URLRequest(url: home))
  }

  /// Stops automatic retries when home also fails; Bun stays alive for an explicit retry.
  private func showNavigationError() {
    let label = UILabel()
    label.text = "Bunaway could not load the app."
    label.textAlignment = .center
    let retry = UIButton(type: .system)
    retry.setTitle("Retry", for: .normal)
    retry.addTarget(self, action: #selector(loadHome), for: .touchUpInside)
    let content = UIStackView(arrangedSubviews: [label, retry])
    content.axis = .vertical
    content.spacing = 16
    content.alignment = .center
    let screen = UIView()
    screen.backgroundColor = .systemBackground
    screen.addSubview(content)
    content.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      content.centerXAnchor.constraint(equalTo: screen.centerXAnchor),
      content.centerYAnchor.constraint(equalTo: screen.centerYAnchor),
    ])
    view = screen
  }

  // MARK: - Packaged asset requests

  /// Serves GET requests only within the resolved web asset root, including symlink checks.
  public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    do {
      guard let url = task.request.url, url.scheme == "bunaway", url.host == home.host,
        url.port == nil, task.request.httpMethod == "GET"
      else {
        throw HostError.invalidResource
      }

      let root = assets.appendingPathComponent("web").resolvingSymlinksInPath().standardizedFileURL
      let path = url.path == "/" ? "/index.html" : url.path
      let file = root.appendingPathComponent(path).resolvingSymlinksInPath().standardizedFileURL
      guard file.path.hasPrefix(root.path + "/") else {
        throw HostError.invalidResource
      }

      let bytes = try Data(contentsOf: file)
      let mime =
        UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream"
      task.didReceive(
        URLResponse(
          url: url,
          mimeType: mime,
          expectedContentLength: bytes.count,
          textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil))
      task.didReceive(bytes)
      task.didFinish()
    } catch {
      task.didFailWithError(error)
    }
  }

  /// Asset reads complete synchronously, so no in-flight resource remains to cancel.
  public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  // MARK: - Validation and terminal failure

  private func dictionary(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw HostError.invalidMessage
    }
    return value
  }

  /// Contains startup failure before Bun exists, and ends the process after the control pipes open.
  /// Repeated callbacks after the first failure have no effect.
  private func fail(_ error: Error) {
    guard phase != .failed else {
      return
    }
    NSLog("Bunaway iOS host failed: %@", String(describing: error))
    phase = .failed
    readyTimer?.invalidate()
    context = nil
    nonce = nil
    output?.readabilityHandler = nil
    if input != nil {
      fatalError("Bunaway iOS host connection failed.")
    }

    let label = UILabel()
    label.text = "Bunaway could not start or connect the app."
    label.numberOfLines = 0
    label.textAlignment = .center
    label.backgroundColor = .systemBackground
    view = label
  }

  private enum HostError: Error {
    case runtimeStart(Int32)
    case runtimePipe(Int32)
    case invalidConfiguration
    case runtimeAlreadyStarted
    case runtimeTimeout
    case invalidMessage
    case controlClosed
    case backendFailed
    case invalidResource
  }
}
