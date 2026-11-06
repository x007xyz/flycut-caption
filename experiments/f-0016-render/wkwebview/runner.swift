// 在系统 WKWebView（与 Tauri macOS 端同一个 WebKit）里打开测试页面，执行一段异步 JS，把返回值（JSON 字符串）写到文件。
// 编译：swiftc -O wkwebview/runner.swift -o out/wkrunner
// 用法：out/wkrunner <url> <js-file> <out-json> [width height]
// js-file 的内容是一个异步函数体，必须 return 一个 JSON 字符串。
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 4 else { fputs("usage: wkrunner <url> <js-file> <out-json> [w h]\n", stderr); exit(2) }
let url = URL(string: args[1])!
let body = try! String(contentsOfFile: args[2], encoding: .utf8)
let outPath = args[3]
let w = args.count > 5 ? Double(args[4])! : 1000
let h = args.count > 5 ? Double(args[5])! : 760

final class Runner: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  init(w: Double, h: Double) {
    let cfg = WKWebViewConfiguration()
    cfg.mediaTypesRequiringUserActionForPlayback = []
    // 窗口不在前台时 WebKit 默认会节流渲染；测试要模拟用户正在看的预览，关掉节流
    if #available(macOS 14.0, *) { cfg.preferences.inactiveSchedulingPolicy = .none }
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: cfg)
    // 测试专用：关闭 WebKit 的窗口遮挡检测（内部开关 _windowOcclusionDetectionEnabled）。
    // 窗口不在当前 Space（例如前台是全屏应用）时，WebKit 会把页面当成 hidden 并停掉 rAF。
    let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if web.responds(to: sel), let m = class_getInstanceMethod(WKWebView.self, sel) {
      typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
      unsafeBitCast(method_getImplementation(m), to: SetBool.self)(web, sel, false)
      fputs("occlusion detection disabled\n", stderr)
    } else {
      fputs("occlusion SPI not available\n", stderr)
    }
    window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: w, height: h), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "F-0016 WKWebView runner"
    window.contentView = web
    super.init()
    web.navigationDelegate = self
    window.level = .floating // 置顶，避免被其他窗口遮挡而降频
    // 当前 Space 是全屏应用时，窗口也要显示在它上面，否则 WebKit 判定页面不可见（visibilityState=hidden，rAF 停止）
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    window.makeKeyAndOrderFront(nil)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { @MainActor in
      // 等页面里的 window.ready
      for _ in 0..<600 {
        let ready = try? await webView.evaluateJavaScript("window.ready === true") as? Bool
        if ready == true { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      do {
        let result = try await webView.callAsyncJavaScript(body, arguments: [:], contentWorld: .page)
        let text = (result as? String) ?? "null"
        try text.write(toFile: outPath, atomically: true, encoding: .utf8)
        print("ok \(outPath)")
        exit(0)
      } catch {
        fputs("js error: \(error)\n", stderr)
        exit(1)
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let runner = Runner(w: w, h: h)
DispatchQueue.main.async {
  // 应用启动完成后再显示窗口并激活，否则窗口可能没真正上屏
  app.activate(ignoringOtherApps: true)
  runner.window.orderFrontRegardless()
  runner.window.makeKey()
  runner.web.load(URLRequest(url: url))
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    fputs("window visible: \(runner.window.occlusionState.contains(.visible)), onActiveSpace: \(runner.window.isOnActiveSpace)\n", stderr)
  }
}
app.run()
