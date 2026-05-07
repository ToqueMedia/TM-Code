# Preview Integrado Nativo — Plano Futuro

> **OBSOLETO (2026-05-06).** Substituído por
> [`PLAN-PREVIEW-BROWSER-PARITY.md`](./PLAN-PREVIEW-BROWSER-PARITY.md),
> que resolve o mesmo problema com `NSAllowsLocalNetworking=YES` no
> `Info.plist` em vez de um WKWebView Swift nativo.
>
> A abordagem original aqui assumia que o WKWebView nunca aceitaria
> `http://localhost` sem código Swift custom. A spike (commit `547ee43`)
> validou que a flag de Info.plist desbloqueia o WKWebView do wry
> directamente — eliminando a necessidade de FFI Swift e do plano-B
> deste documento.
>
> Mantido como referência histórica caso a flag falhe num macOS futuro.

## Problema
Tauri WKWebView não permite carregar HTTP localhost em:
- iframes (cross-origin policy)
- child webviews via `add_child` (API unstable, #10011)
- `wry::build_as_child` (z-order: fica atrás do main webview)
- `WebviewWindow` separado (mesma restrição de navegação)

## Solução Actual (v0.1.3)
Preview abre no browser do sistema. Static HTML usa iframe com `srcDoc`.

## Solução Futura: Native Swift WKWebView
Como o Cmux (manaflow-ai/cmux), criar um WKWebView nativo via Swift:

### Abordagem
1. Criar um Swift package com uma classe `PreviewWebView`
2. Usar `WKWebViewConfiguration` sem restrições
3. Adicionar como NSView ao NSWindow do Tauri via `objc2`
4. Controlar z-order com `addSubview:positioned:relativeTo:` usando `NSWindowAbove`
5. Sincronizar posição/tamanho via Tauri commands

### Ficheiros necessários
- `src-tauri/swift/PreviewWebView.swift` — classe Swift com WKWebView
- `src-tauri/build.rs` — compilar Swift e linkar
- `src-tauri/src/preview.rs` — bridge Rust ↔ Swift via FFI

### API
```rust
// Rust FFI
extern "C" {
    fn preview_create(window: *mut c_void, url: *const c_char, x: f64, y: f64, w: f64, h: f64);
    fn preview_close();
    fn preview_resize(x: f64, y: f64, w: f64, h: f64);
    fn preview_navigate(url: *const c_char);
}
```

```swift
// Swift
class PreviewWebView {
    private var webView: WKWebView?

    func create(in window: NSWindow, url: URL, frame: NSRect) {
        let config = WKWebViewConfiguration()
        // No restrictions — loads any URL
        let wv = WKWebView(frame: frame, configuration: config)
        wv.load(URLRequest(url: url))

        // Add ON TOP of existing subviews
        window.contentView?.addSubview(wv, positioned: .above, relativeTo: nil)
        webView = wv
    }
}
```

### Referência
- Cmux: https://github.com/manaflow-ai/cmux (Swift/AppKit nativo)
- objc2-webkit: crate Rust para bindings WebKit
