# Go Conventions

You are working in a Go project. Standard layout (`cmd/`, `internal/`, `pkg/`), `gofmt`/`goimports`, error-as-last-return-value, `context.Context` as first param — these are assumed knowledge. The rules below cover footguns and decisions where models drift from idiomatic Go.

## Patterns to Avoid

- **Don't use `panic` for control flow.** Panic is reserved for unrecoverable programmer errors (nil pointer in init, impossible state). For expected failures (file not found, network down, validation failed), return an `error`. A library that panics crashes the host process.
- **Don't ignore errors with `_`.** `result, _ := json.Marshal(x)` swallows the failure mode. Either handle it or document the explicit decision (`_ = file.Close() // best-effort cleanup`).
- **Don't return `nil` interface values that are non-nil at the type level.** A `*MyError` that is nil but typed as `error` returns a non-nil interface — `if err != nil` evaluates true unexpectedly. Either return `nil` directly or assign through an `error` variable first.
- **Don't compare error values with `==`.** Use `errors.Is()` for sentinel errors and `errors.As()` for typed unwrapping. Direct `==` breaks when the error is wrapped with `fmt.Errorf("%w", ...)`.
- **Don't reuse loop variables in goroutines without capturing** (Go < 1.22). `for _, x := range items { go func() { use(x) }() }` captures by reference — all goroutines see the last value. Capture via parameter: `go func(x T) { use(x) }(x)`. Go 1.22+ fixed this — check the project's Go version.
- **Don't store `context.Context` as a struct field.** Pass it as the first function argument, every call. Storing it ties operation lifetime to struct lifetime, defeating cancellation.
- **Don't use `time.Sleep` for synchronization.** Use channels, `sync.WaitGroup`, or `context.WithTimeout`. Sleep-based sync is a race waiting to happen.
- **Don't ignore `io.Closer` errors silently for critical writes.** `defer file.Close()` may indicate buffered writes were lost. For logs/save files, check the close error explicitly.
- **Don't use `interface{}` / `any` when a typed parameter works.** It defeats Go's type system. Reserve `any` for genuinely polymorphic code (encoding/json, reflection-based libraries).
- **Don't import third-party for stdlib.** `slices`, `maps`, `cmp` (Go 1.21+) cover most needs. `net/http` is production-grade. Reach for routers (chi, gorilla/mux) only when stdlib doesn't suffice.
- **Don't block on unbuffered channels in single-goroutine code.** A send without a concurrent receiver deadlocks. Either buffer the channel or use `select` with `default`.
- **Don't forget to close response bodies.** `defer resp.Body.Close()` after `http.Get` — leaks file descriptors otherwise. Same for `sql.Rows`, `*os.File`.

## Convention reminders (often missed)

- **Acronyms stay all caps**: `HTTPClient`, `userID`, `parseURL` — NOT `HttpClient`/`userId`/`parseUrl`.
- **Interfaces named by behavior**: `Reader`, `Writer`, `Stringer` — NOT `IReader` / `ReaderInterface`.
- **Accept interfaces, return concrete types** — keeps callers loosely coupled while letting your package guarantee the implementation shape.
- **Always set timeouts on `http.Server` AND `http.Client`** — defaults are unbounded.
