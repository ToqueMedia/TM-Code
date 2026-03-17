# Go Conventions

You are working in a Go project. Follow these conventions:

## Project Structure
- Follow standard Go project layout.
- `cmd/` for main applications, `internal/` for private packages, `pkg/` for public libraries.
- One package per directory. Package name matches directory name (lowercase, no underscores).
- `main.go` in `cmd/<app>/` is the entry point.

## Naming
- Exported names: PascalCase (`GetUser`, `UserService`).
- Unexported names: camelCase (`getUserByID`, `parseConfig`).
- Interfaces: name by behavior (`Reader`, `Writer`, `Stringer`), not `IReader`.
- Single-method interfaces: name after the method + `er` suffix.
- Acronyms: all caps (`HTTPClient`, `userID`, not `HttpClient`, `userId`).

## Error Handling
- Return errors as the last return value: `func Get() (Result, error)`.
- Check errors immediately: `if err != nil { return fmt.Errorf("context: %w", err) }`.
- Wrap errors with `%w` for error chain (`fmt.Errorf("failed to parse: %w", err)`).
- Use sentinel errors (`var ErrNotFound = errors.New("not found")`) for expected errors.
- Don't panic in libraries — only in main or initialization code.

## Concurrency
- Use goroutines for concurrent work, channels for communication.
- Always pass `context.Context` as first parameter for cancellable operations.
- Use `sync.WaitGroup` to wait for goroutine completion.
- Use `sync.Mutex` / `sync.RWMutex` for shared state.
- Prefer `errgroup.Group` for concurrent tasks with error propagation.

## Interfaces
- Define interfaces where they are consumed, not where they are implemented.
- Keep interfaces small (1-3 methods).
- Accept interfaces, return concrete types.
- Use `io.Reader`, `io.Writer`, `fmt.Stringer` from stdlib when possible.

## Testing
- Test files: `*_test.go` in the same package.
- Table-driven tests with `t.Run()` for subtests.
- Use `testify/assert` or `testify/require` for assertions if available.
- Use `httptest` for HTTP handler testing.
- Benchmark with `func BenchmarkX(b *testing.B)`.

## HTTP
- Use `http.ServeMux` (Go 1.22+) or popular routers (chi, gorilla/mux).
- Middleware pattern: `func(next http.Handler) http.Handler`.
- Use `http.HandlerFunc` adapter for functions.
- Always set timeouts on `http.Server` and `http.Client`.

## Dependencies
- Use Go modules (`go.mod`). Run `go mod tidy` after changes.
- Prefer stdlib over third-party when reasonable.
- Pin major versions in imports for v2+.

## Code Style
- Run `gofmt` / `goimports` on all code.
- No unused imports or variables — Go compiler enforces this.
- Use short variable names in small scopes (`i`, `n`, `err`), descriptive in larger scopes.
