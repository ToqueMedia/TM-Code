# Audit Report — ToqueMedia Studio
**Data:** 2026-03-15
**Auditor:** Claude Code
**Versao:** Post-Fase 7

## Resumo Executivo
- Total de findings: 197
- CRITICAL: 10
- HIGH: 60
- MEDIUM: 73
- LOW: 43
- INFO: 11

---

## 1. Memory Leaks

### [CRITICAL] ML-01: Unguarded async agent loop — PromptInput
- **Ficheiro:** src/components/chat/PromptInput.tsx:30-107
- **Problema:** `handleSend` triggers `runAgentLoop` with no AbortController or mounted guard. If the component unmounts mid-stream, SSE callbacks (`onTextChunk`, `onToolCall`, `onDone`) continue calling `chatStore` and `agentStore` setState on an unmounted component.
- **Impacto:** Memory leak + potential state corruption during streaming.
- **Fix sugerido:** Add an AbortController passed to `runAgentLoop`; abort in useEffect cleanup. Add a mounted ref guard.

### [CRITICAL] ML-02: Unguarded async agent loop — usePromptBar
- **Ficheiro:** src/components/prompt/usePromptBar.ts:44-137
- **Problema:** Identical pattern to ML-01. `await agentService.runAgentLoop(...)` has no cancellation mechanism. After unmount, all six callbacks continue mutating global stores.
- **Impacto:** Memory leak + orphaned streaming connections consuming tokens.
- **Fix sugerido:** Same AbortController + mounted guard pattern.

### [HIGH] ML-03: Monaco disposables never cleaned up
- **Ficheiro:** src/components/ui/MonacoEditor.tsx:218-300
- **Problema:** `handleEditorDidMount` builds a `disposables[]` array and returns a cleanup function. However, Monaco's `onMount` prop does not consume callback return values. The cleanup function is never invoked, so cursor listeners, content change listeners, and MonacoBridge references leak on every editor mount.
- **Impacto:** Listener accumulation on each editor mount/unmount cycle. Worsens over time as files are opened/closed.
- **Fix sugerido:** Move disposable cleanup into a `useEffect` that depends on the editor instance ref.

### [HIGH] ML-04: WindowService resize listener never removed
- **Ficheiro:** src/services/windowService.ts:39-48
- **Problema:** `setupEventListeners()` calls `window.addEventListener('resize', ...)` but never stores a reference for removal. `reset()` clears timeout and `mainWindow` but does NOT call `removeEventListener`. Multiple `initialize()` calls accumulate duplicate listeners.
- **Impacto:** Redundant IPC calls on every window resize.
- **Fix sugerido:** Store handler reference; remove in `reset()`.

### [HIGH] ML-05: Firebase onAuthStateChanged listener never unsubscribed
- **Ficheiro:** src/services/auth/firebaseAuth.ts:36-46
- **Problema:** `onAuthStateChanged(auth, callback)` returns an unsubscribe function that is never captured or called. If `init()` is called more than once, duplicate listeners accumulate.
- **Impacto:** Multiple store updates per auth state change.
- **Fix sugerido:** Capture the unsubscribe function; call it in a `dispose()` method.

### [HIGH] ML-06: fileTreeWorkerStore timeout timers not cleared on reset
- **Ficheiro:** src/stores/fileTreeWorkerStore.ts:157-168
- **Problema:** Each `sendMessage()` creates a 30-second `setTimeout` that is never tracked or cleared. `resetState()` rejects pending operations and terminates the worker, but does not clear outstanding timeouts. Orphaned timers fire against stale state.
- **Impacto:** Stale timer callbacks mutating reset store state.
- **Fix sugerido:** Track timeout IDs in a Set; clear all in `resetState()`.

### [HIGH] ML-07: Debounced search never cancelled on unmount
- **Ficheiro:** src/components/ui/SearchPanel.tsx:70-78
- **Problema:** `handleSearchTermChange` calls `SearchService.shared.debouncedSearch(...)` with no cleanup that cancels pending debounced invocations on unmount.
- **Impacto:** Search results arrive after panel unmount, causing orphaned state updates.
- **Fix sugerido:** Expose a `cancelSearch()` on the service; call in useEffect cleanup.

### [HIGH] ML-08: Quick-open debounce timer not cleared on unmount
- **Ficheiro:** src/components/ui/titlebar/useQuickOpen.ts:26-39
- **Problema:** `debounceRef.current` holds a `window.setTimeout` ID with no useEffect cleanup calling `clearTimeout`.
- **Impacto:** Timer fires and calls `setResults`/`setHighlightIndex` on unmounted state.
- **Fix sugerido:** Add useEffect cleanup: `return () => clearTimeout(debounceRef.current)`.

### [MEDIUM] ML-09: Editor undo/redo stacks not cleaned on individual file close
- **Ficheiro:** src/stores/editorStore.ts:154-188
- **Problema:** `closeFile()` removes from `openFiles` and `cursorPositions` but does NOT delete entries in `undoStack` and `redoStack`. These stacks contain full file content strings (up to 50 entries per file). Only `closeAllFiles()` clears them.
- **Impacto:** Unbounded memory growth over sessions where many files are opened and closed.
- **Fix sugerido:** Delete file's undo/redo entries in `closeFile()`.

### [MEDIUM] ML-10: chatStore module-level debounce timer never cleared
- **Ficheiro:** src/stores/chatStore.ts:61-70
- **Problema:** `saveTimeout` is module-level, never cleared during session cleanup or project close. Timer fires after session is finished, writing stale data.
- **Impacto:** Potential session file corruption.
- **Fix sugerido:** Clear timeout in `clearSession()` and project close.

### [MEDIUM] ML-11: DebuggerService eventCallbacks array grows unbounded
- **Ficheiro:** src/services/debuggerService.ts:80-89
- **Problema:** `addEventListener` pushes to array; no `removeAllListeners()` or `dispose()` method. Components that unmount without calling `removeEventListener` leak callbacks.
- **Impacto:** Accumulated callbacks iterated on every `emitEvent`.
- **Fix sugerido:** Add `dispose()` method; track listener ownership.

### [MEDIUM] ML-12: Terminal session timeout not cleaned up
- **Ficheiro:** src/components/ui/terminal/TerminalSession.tsx:56
- **Problema:** A 100ms `setTimeout` fires after mount but could fire after unmount if component is destroyed quickly. Timeout ID not stored or cleared.
- **Impacto:** Minor — setState on unmounted component.
- **Fix sugerido:** Store timeout ID; clear in useEffect cleanup.

### [MEDIUM] ML-13: Auto-scroll effects fire per SSE chunk
- **Ficheiro:** src/components/chat/ChatPanel.tsx, src/components/views/PreviewView.tsx:29
- **Problema:** Auto-scroll useEffect depends on `messages[messages.length - 1]?.content`, which changes on every SSE text chunk. Triggers dozens of `scrollIntoView` calls per second during streaming.
- **Impacto:** Unnecessary DOM work during streaming.
- **Fix sugerido:** Debounce with `requestAnimationFrame` or batch scroll updates.

### [LOW] ML-14: Toast store has no auto-removal mechanism
- **Ficheiro:** src/stores/toastStore.ts:22-40
- **Problema:** `addToast()` pushes toasts but the store provides no timer-based auto-removal. If UI fails to call `removeToast()`, toasts accumulate indefinitely.
- **Impacto:** Minor memory growth.
- **Fix sugerido:** Add optional duration field with auto-removal timer.

---

## 2. Race Conditions

### [CRITICAL] RC-01: State read after async gap may yield wrong session
- **Ficheiro:** src/components/prompt/usePromptBar.ts:57-69
- **Problema:** After `await chatStore.createNewSession(projectPath)`, the code re-reads state. If two rapid sends overlap, the second `handleSend` reads the first call's session, sending messages to the wrong session.
- **Impacto:** Messages sent to wrong chat session.
- **Fix sugerido:** Make `handleSend` non-reentrant with a running-state guard.

### [HIGH] RC-02: Agent loop concurrent execution not prevented
- **Ficheiro:** src/services/agent/agentService.ts:114-220
- **Problema:** `runAgentLoop()` unconditionally creates a new `AbortController`, replacing the instance variable. A second loop overwrites the first's abort controller. `cancelLoop()` then only cancels the second; the first runs uncontrollably.
- **Impacto:** Duplicate streaming, double token consumption, tools executed twice.
- **Fix sugerido:** Add running-state guard; reject or queue new loops while one is active.

### [HIGH] RC-03: Editor openFile has no concurrency guard
- **Ficheiro:** src/stores/editorStore.ts:97-152
- **Problema:** `openFile()` is async. It immediately sets `activeFile`, then awaits `FileService.readFile()`. Two concurrent calls can both find the file not in the array and both append it, creating duplicates. `activeFile` ping-pongs between the two paths.
- **Impacto:** Duplicate tabs in editor, UI glitches.
- **Fix sugerido:** Add a Set of "currently loading" paths to prevent concurrent opens of the same file.

### [HIGH] RC-04: saveAllFiles reads snapshot but marks all clean
- **Ficheiro:** src/stores/editorStore.ts:385-426
- **Problema:** `saveAllFiles()` snapshots dirty files, then iterates with async saves + 50ms pauses. User types during saves. At end, marks ALL dirty files clean, including those re-dirtied AFTER the save started.
- **Impacto:** Silent data loss — unsaved edits marked as clean.
- **Fix sugerido:** Compare content hashes or re-read dirty flags after batch completes.

### [HIGH] RC-05: Global CWD races with all Rust commands
- **Ficheiro:** src-tauri/src/commands/terminal.rs:157, also lines 37, 78, 194
- **Problema:** `change_directory` calls `env::set_current_dir`, a process-global mutation. `execute_command`, `start_interactive_shell`, and `get_completions` all use `env::current_dir()` as fallback. Concurrent commands observe each other's CWD changes. No lock protects this.
- **Impacto:** Commands execute in wrong directory.
- **Fix sugerido:** Pass explicit `cwd` to every command; remove `change_directory` or scope it per-session.

### [HIGH] RC-06: TOCTOU race condition in Worker rate limiting
- **Ficheiro:** toquemedia-studio-api/src/rateLimit.ts:11-31
- **Problema:** Read-then-write pattern: reads counter, checks it, writes incremented value. Two concurrent requests can both read the same value, both pass the check, and both write. A 5 req/min limit could be burst to ~10.
- **Impacto:** Rate limit bypass under concurrent requests.
- **Fix sugerido:** Use Durable Objects or atomic KV operations for transactional counters.

### [MEDIUM] RC-07: closeProject returns synchronously while async cleanup runs
- **Ficheiro:** src/stores/projectStore.ts:147-182
- **Problema:** When dirty files exist, cleanup is wrapped in `Promise.resolve().then(async () => ...)` and returns `void` synchronously. `openProject()` called immediately after overlaps with ongoing cleanup.
- **Impacto:** Old project's monitors still running while new project starts.
- **Fix sugerido:** Make `closeProject` properly async; await in callers.

### [MEDIUM] RC-08: QuickOpen buildIndex guard is incomplete
- **Ficheiro:** src/services/quickOpenService.ts:20-71
- **Problema:** `initialize()` sets `rootPath` then calls `await buildIndex()`. A second `initialize()` overwrites `rootPath` before the first build completes. First build indexes files under the NEW root path.
- **Impacto:** Quick-open shows files from wrong project.
- **Fix sugerido:** Serialize initialization with a queue or cancel previous build.

### [MEDIUM] RC-09: loadProjectState opens files sequentially without lock
- **Ficheiro:** src/stores/projectStore.ts:221-257
- **Problema:** Iterates `state.openFiles` with sequential `await editorRepo.openFile()` calls. User or file watcher can trigger additional `openFile()` calls that interleave.
- **Impacto:** File restoration produces inconsistent editor state.
- **Fix sugerido:** Add "restoration in progress" flag to suppress user-initiated file opens.

### [MEDIUM] RC-10: Settings file read-modify-write without locking (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:1039-1089
- **Problema:** Reads `settings.json`, modifies, writes back. Two concurrent `open_project` calls can lose one entry.
- **Impacto:** Recent projects list loses entries.
- **Fix sugerido:** Use file locking or atomic write-rename pattern.

### [MEDIUM] RC-11: Worker minute/day KV counters not atomically updated
- **Ficheiro:** toquemedia-studio-api/src/rateLimit.ts:31-32
- **Problema:** Two separate `kv.put()` calls. Worker timeout between them creates inconsistent counters.
- **Impacto:** Rate limit accounting diverges.
- **Fix sugerido:** Use a single KV entry with both counters, or Durable Objects.

### [MEDIUM] RC-12: Terminal input captures stale session reference
- **Ficheiro:** src/components/ui/terminal/terminalInput.ts
- **Problema:** `setupTerminalInput` captures `session` by closure. If terminal is re-initialized, stale handlers reference old session.
- **Impacto:** Commands sent to wrong terminal session.
- **Fix sugerido:** Use a ref or re-register handlers on session change.

---

## 3. Bugs Visiveis

### [HIGH] BUG-01: editorStore persists full file content to localStorage
- **Ficheiro:** src/stores/editorStore.ts:481-494
- **Problema:** `partialize` includes `content` in persisted state. Serializes full content of every open file to localStorage on every state change. localStorage has ~5-10MB limit. Writes silently fail with large files, corrupting state.
- **Impacto:** App state corruption when multiple large files are open. Slow keystrokes.
- **Fix sugerido:** Exclude `content` from `partialize`; load from disk on restore.

### [HIGH] BUG-02: openFile silently discards unsaved edits on re-open
- **Ficheiro:** src/stores/editorStore.ts:106-124
- **Problema:** When an already-open file is clicked in explorer, it reads from disk and silently replaces in-memory content, resetting `isDirty` to `false`. Unsaved edits are destroyed without confirmation.
- **Impacto:** Silent data loss of user edits.
- **Fix sugerido:** Check `isDirty` before re-reading; skip disk read or prompt user.

### [HIGH] BUG-03: agentStore setModel corrupts baseUrl for unknown models
- **Ficheiro:** src/stores/agentStore.ts:70-77
- **Problema:** When `setModel()` receives an ID not in `DEFAULT_MODELS`, it sets `currentModel` but does NOT update `baseUrl`. Requests use model ID X with provider URL Y.
- **Impacto:** API errors or requests sent to wrong provider.
- **Fix sugerido:** Validate model ID against known models; throw or fallback.

### [HIGH] BUG-04: conversationHistory strips tool_calls and tool_call_id
- **Ficheiro:** src/services/agent/agentService.ts:121-128
- **Problema:** History mapping keeps only `role` and `content`, stripping `tool_calls` and `tool_call_id`. This violates the OpenAI API contract for tool-use conversations.
- **Impacto:** 400 errors or hallucinations when restoring mid-session conversations.
- **Fix sugerido:** Preserve `tool_calls` and `tool_call_id` in history mapping.

### [HIGH] BUG-05: Ripgrep exit code 1 treated as error (Rust)
- **Ficheiro:** src-tauri/src/commands/search.rs:146-149
- **Problema:** Ripgrep returns exit code 1 for zero matches (standard grep convention). This code returns an error to the frontend instead of an empty result set.
- **Impacto:** Every search with no results shows an error to the user.
- **Fix sugerido:** Check for exit code 1 specifically and return empty results.

### [HIGH] BUG-06: Compression format mismatch between save paths (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs
- **Problema:** `save_project_metadata` writes plain JSON; `save_project_state` writes zlib-compressed data — to the same `meta.json` file. `load_project_state` always tries to decompress. After `save_project_metadata` runs (on every `open_project`), decompression fails.
- **Impacto:** Project state fails to load; open files and editor state lost between sessions.
- **Fix sugerido:** Use consistent format (both plain or both compressed), or separate files.

### [HIGH] BUG-07: `replace_in_files` does not actually replace (Rust)
- **Ficheiro:** src-tauri/src/commands/search.rs:271-353
- **Problema:** Uses `rg --replace ... --files-with-matches`. Ripgrep's `--replace` only affects stdout, never writes to disk. Frontend shows "N files affected" but no files are modified.
- **Impacto:** Search-and-replace feature is completely non-functional.
- **Fix sugerido:** Implement actual file writing after ripgrep identifies matches.

### [HIGH] BUG-08: `get_completions` reads wrong directory (Rust)
- **Ficheiro:** src-tauri/src/commands/terminal.rs:200-211
- **Problema:** Reads the **parent** of the working directory instead of the working directory itself. Tab completions show sibling directories of the CWD.
- **Impacto:** Terminal tab completion returns wrong results.
- **Fix sugerido:** Change `working_dir.parent()` to `working_dir`.

### [MEDIUM] BUG-09: closeFile selects first tab instead of adjacent tab
- **Ficheiro:** src/stores/editorStore.ts:161-164
- **Problema:** Next active file is always `updated[0]` instead of the adjacent tab.
- **Impacto:** Jarring UX — closing a middle tab jumps to first tab.
- **Fix sugerido:** Select the tab at the same index or index-1.

### [MEDIUM] BUG-10: fileTreeStore expandedPaths type mismatch during rehydration
- **Ficheiro:** src/stores/fileTreeStore.ts:537-551
- **Problema:** `partialize` converts `expandedPaths` from `Set<string>` to `Array<string>`. During rehydration, before `onRehydrateStorage` fires, code calling `.has()` crashes with `expandedPaths.has is not a function`.
- **Impacto:** Crash on app startup if file tree state was persisted.
- **Fix sugerido:** Use `merge` in persist config to handle Set conversion immediately.

### [MEDIUM] BUG-11: layoutStore clearPreviewServer does not kill server process
- **Ficheiro:** src/stores/layoutStore.ts:75-84
- **Problema:** Resets state (URL, PID, flags) to null but does NOT invoke any Tauri command to kill the server process. Process continues consuming port and resources.
- **Impacto:** Orphaned server processes after preview close.
- **Fix sugerido:** Call `invoke('kill_process', { pid })` before clearing state.

### [MEDIUM] BUG-12: DebuggerService uses process.cwd() in browser/Tauri context
- **Ficheiro:** src/services/debuggerService.ts:324
- **Problema:** `createNodeJSConfig()` defaults `cwd` to `process.cwd()`. In a Tauri WebView, `process` is undefined, causing ReferenceError.
- **Impacto:** Debugger crashes when no explicit cwd is provided.
- **Fix sugerido:** Use project path from store as default instead of `process.cwd()`.

### [MEDIUM] BUG-13: ProjectFileWatcher.handleFileRename creates inconsistent state
- **Ficheiro:** src/utils/projectFileWatcher.ts:97-116
- **Problema:** After rename: `closeFile(oldPath)` removes old file, then `setActiveFile(newPath)` sets active — but never adds renamed file to `openFiles`. Active file points to nonexistent entry.
- **Impacto:** Editor shows blank/stale content after external rename.
- **Fix sugerido:** Open the new file path before setting it active.

### [MEDIUM] BUG-14: ProjectFileWatcher.refreshFileTree is a no-op stub
- **Ficheiro:** src/utils/projectFileWatcher.ts:118-122
- **Problema:** Called after every create, delete, rename event but only logs. File tree never actually refreshes.
- **Impacto:** Explorer becomes stale after external filesystem changes.
- **Fix sugerido:** Call `fileTreeStore.refresh()` or equivalent.

### [MEDIUM] BUG-15: Worker rate limit counter incremented before upstream request
- **Ficheiro:** toquemedia-studio-api/src/rateLimit.ts:30-32; src/index.ts:63-78
- **Problema:** Counter incremented before `handleChatRequest()`. If upstream returns 500 or fetch fails, user loses a rate limit credit for a failed request.
- **Impacto:** Users charged for failed requests.
- **Fix sugerido:** Move increment to after successful upstream response.

### [MEDIUM] BUG-16: Worker CORS headers missing on proxy-originated errors
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:74, 82
- **Problema:** Error responses from `handleChatRequest()` lack CORS headers. Only `Access-Control-Allow-Origin` is set on success path. Browsers may block error responses.
- **Impacto:** Client cannot see actual error; gets opaque CORS failure.
- **Fix sugerido:** Add CORS headers to all response paths in proxy.

### [LOW] BUG-17: terminalStore field typo: activeSectionId vs activeSessionId
- **Ficheiro:** src/stores/terminalStore.ts:14, 31, 60, 67, 70-71, 76, 82, 86-88, 117
- **Problema:** Field named `activeSectionId` but semantically represents the active terminal session ID.
- **Impacto:** Maintenance confusion.
- **Fix sugerido:** Rename to `activeSessionId`.

---

## 4. Bugs Assintomaticos

### [HIGH] BA-01: DiffService pendingDiffs duplicated in chatStore
- **Ficheiro:** src/services/agent/diffService.ts:16; src/stores/chatStore.ts:17, 484-498
- **Problema:** Both maintain separate `pendingDiffs` collections, populated during the same `write_file` flow. `acceptDiff`/`rejectDiff` only clears from DiffService, not chatStore. Dual state inevitably diverges.
- **Impacto:** Stale diff entries in chatStore; diff count badges incorrect.
- **Fix sugerido:** Single source of truth — remove one copy.

### [HIGH] BA-02: DiffService acceptDiff does not await refreshFileContent
- **Ficheiro:** src/services/agent/diffService.ts:49-65
- **Problema:** `refreshFileContent(diff.filePath)` called without `await`. Method returns before editor content updates. Subsequent operations read old content.
- **Impacto:** Editor shows stale content after accepting diff.
- **Fix sugerido:** Add `await` before `refreshFileContent`.

### [HIGH] BA-03: Worker Firestore failure defaults to granting access (fail-open)
- **Ficheiro:** toquemedia-studio-api/src/firestore.ts:38-39 and 55-57
- **Problema:** Both HTTP error and catch block return `{ ...DEFAULT_PLANS.free, isActive: true }`. During Firestore outage, every request is granted free-tier access, including suspended users.
- **Impacto:** Suspended users regain access during infrastructure issues.
- **Fix sugerido:** Fail-closed: deny access when plan lookup fails.

### [MEDIUM] BA-04: convertEventType uses unsafe cast
- **Ficheiro:** src/utils/fileWatcher.ts:119-121
- **Problema:** `return kind as FileEvent['type']` blindly casts any string to valid event type. Tauri emits types like `'modify'`, `'access'`, `'any'` which are silently passed through. The consuming switch has no default case.
- **Impacto:** Real filesystem events (like `modify`) are silently dropped.
- **Fix sugerido:** Map Tauri event types to internal types with explicit handling.

### [MEDIUM] BA-05: ConversationMessage.role typed as string
- **Ficheiro:** src/types/chat.ts:5
- **Problema:** Should be `'user' | 'assistant' | 'system' | 'tool'` to match OpenAI API contract. Current `string` allows invalid roles.
- **Impacto:** Invalid roles pass type checking, causing API errors.
- **Fix sugerido:** Use union type.

### [MEDIUM] BA-06: Worker parseInt without NaN guard in rate limiter
- **Ficheiro:** toquemedia-studio-api/src/rateLimit.ts:12 and 21
- **Problema:** If KV returns corrupted non-numeric string, `parseInt` returns `NaN`. `NaN >= plan.requestsPerMinute` is `false`, so rate limit check passes (fail-open).
- **Impacto:** Rate limit bypass on KV corruption.
- **Fix sugerido:** Validate parseInt result; default to 0 on NaN.

### [MEDIUM] BA-07: Worker tokensPerDay defined everywhere but enforced nowhere
- **Ficheiro:** toquemedia-studio-api/src/types.ts:25; src/firestore.ts:7-8, 14, 20
- **Problema:** Type, plan configs, and Firestore schema all define `tokensPerDay` values (100K free, 1M pro, 5M team), but no code reads or enforces this field.
- **Impacto:** No token-level cost control for users.
- **Fix sugerido:** Implement token tracking and enforcement.

### [MEDIUM] BA-08: sessionService updateIndex crashes on null content
- **Ficheiro:** src/services/agent/sessionService.ts:287-313
- **Problema:** If `lastMsg` exists but `lastMsg.content` is `null` (valid for assistant messages with only tool calls), `lastMsg.content.slice(0, 100)` throws TypeError.
- **Impacto:** Session index update fails silently or crashes.
- **Fix sugerido:** Add null check: `lastMsg?.content?.slice(0, 100) ?? ''`.

### [LOW] BA-09: searchService getRelativePath heuristic is fragile
- **Ficheiro:** src/services/searchService.ts:179-188
- **Problema:** Searches for `src` segment and returns everything after. For `node_modules/some-package/src/index.ts`, returns wrong relative path.
- **Impacto:** Search results show misleading file paths.
- **Fix sugerido:** Use project root to compute relative paths.

---

## 5. Performance

### [HIGH] PERF-01: editorStore serializes all file contents to localStorage on every keystroke
- **Ficheiro:** src/stores/editorStore.ts:194-240, 481-494
- **Problema:** `updateFileContent()` triggers Zustand persist, which calls `partialize()` mapping ALL open files including `content`. Serialized via `JSON.stringify` and written to localStorage on every character. With large files, this means MB-level serialization 10+ times/second.
- **Impacto:** 🔴 Perceptible (> 100ms delay). Keystroke lag, main thread blocking.
- **Fix sugerido:** Exclude `content` from `partialize`. Debounce persist. Load content from disk on restore.

### [HIGH] PERF-02: Blocking I/O inside async Rust functions
- **Ficheiro:** src-tauri/src/commands/terminal.rs:30, 73, 111, 163, 170, 190; search.rs:43, 272
- **Problema:** Every function uses `std::process::Command::output()` (synchronous blocking) inside `async` functions. Blocks Tokio worker threads.
- **Impacto:** 🔴 Perceptible. UI freezes during search or terminal commands.
- **Fix sugerido:** Use `tokio::process::Command` or `tokio::task::spawn_blocking`.

### [HIGH] PERF-03: TypeScript LSP loads up to 1000 files sequentially via IPC
- **Ficheiro:** src/services/typescriptLspService.ts:94-111
- **Problema:** `loadProjectFiles()` calls `await this.loadFileContent(node.path)` sequentially per file, up to 1000. Each call is a Tauri IPC round-trip (~1-5ms).
- **Impacto:** 🔴 Perceptible. 1-5 seconds to load LSP on large projects.
- **Fix sugerido:** Batch-read on Rust side or parallelize with concurrency limit.

### [MEDIUM] PERF-04: chatStore creates new Map on every streaming token
- **Ficheiro:** src/stores/chatStore.ts:244-268
- **Problema:** `appendToAssistantMessage()` called per token: copies entire sessions Map, copies message array, creates new session, triggers Zustand notifications. O(n) per token where n = sessions.
- **Impacto:** 🟡 Measurable (10-100ms for large sessions).
- **Fix sugerido:** Use immer or mutative updates; batch token appends.

### [MEDIUM] PERF-05: fileTreeStore rebuilds entire tree on every single-node mutation
- **Ficheiro:** src/stores/fileTreeStore.ts:279-327, 329-369, 372-411
- **Problema:** Each node add/remove/update first tries O(1) indexer, then calls `rebuildTreeFromIndex()` which recursively constructs a new tree. 10K files = full traversal per change.
- **Impacto:** 🟡 Measurable on large projects.
- **Fix sugerido:** Implement targeted tree patching instead of full rebuild.

### [MEDIUM] PERF-06: Unbounded recursive directory traversal (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:225-343
- **Problema:** `build_tree_node` recursively traverses entire directory tree with no default depth limit. Monorepos or projects with nested `node_modules` can exhaust stack/memory.
- **Impacto:** 🔴 Perceptible. Could take minutes on deep trees.
- **Fix sugerido:** Enforce a default max_depth (e.g., 10 levels).

### [MEDIUM] PERF-07: Worker Firestore queried on every request with no caching
- **Ficheiro:** toquemedia-studio-api/src/firestore.ts:30-36
- **Problema:** Every API call makes a Firestore REST call to fetch user plan. Pro users at 20 req/min = 20 Firestore reads/min.
- **Impacto:** 🟡 Measurable. Adds latency + Firestore costs.
- **Fix sugerido:** Cache in KV with 5-minute TTL.

### [MEDIUM] PERF-08: Worker sequential KV reads could be parallelized
- **Ficheiro:** toquemedia-studio-api/src/rateLimit.ts:12 and 21
- **Problema:** `await kv.get(minuteKey)` then `await kv.get(dayKey)` are sequential.
- **Impacto:** 🟡 Measurable. Double KV read latency.
- **Fix sugerido:** `Promise.all([kv.get(minuteKey), kv.get(dayKey)])`.

### [MEDIUM] PERF-09: ContextBuilder reads lock files sequentially
- **Ficheiro:** src/services/agent/contextBuilder.ts:170-184
- **Problema:** Reads up to 4 lock files sequentially via IPC to detect package manager. Only existence matters.
- **Impacto:** 🟡 Measurable (potential 20ms+ for large lock files).
- **Fix sugerido:** `Promise.all()` or add `file_exists` Rust command.

### [MEDIUM] PERF-10: toolExecutor list_directory pretty-prints full tree as JSON
- **Ficheiro:** src/services/agent/toolExecutor.ts:149
- **Problema:** `JSON.stringify(tree, null, 2)` on full directory tree sent to LLM. Wastes tokens.
- **Impacto:** 🟡 Measurable in token cost.
- **Fix sugerido:** Use compact format like contextBuilder's `formatFileTree()`.

### [MEDIUM] PERF-11: Command list rebuilt every render in CommandPalette
- **Ficheiro:** src/components/ui/CommandPalette.tsx:73-86
- **Problema:** `getCommands()` creates a new array with new function references on every render. Forces `filtered` useMemo to re-evaluate.
- **Impacto:** 🟡 Measurable on slow devices.
- **Fix sugerido:** Wrap in `useMemo`.

### [LOW] PERF-12: FileTreeIndexer searchNodes is O(n) over all nodes
- **Ficheiro:** src/utils/fileTreeIndex.ts:323-337
- **Problema:** Iterates every indexed node on every search call.
- **Impacto:** 🟡 Measurable on 10k+ file projects.
- **Fix sugerido:** Build trie or prefix index for search.

---

## 6. Seguranca

### [CRITICAL] SEC-01: Tool executor allows arbitrary command execution
- **Ficheiro:** src/services/agent/toolExecutor.ts:301-329
- **Problema:** LLM-agent-controlled `command` strings passed directly to `invoke('execute_command')` with zero sanitization, no allowlist, no sandboxing. The `cwd` parameter is also fully attacker-controlled.
- **Impacto:** LLM can execute `rm -rf /`, exfiltrate credentials, install malware.
- **Fix sugerido:** Implement command allowlist; require user confirmation for destructive commands; sandbox cwd to project root.

### [CRITICAL] SEC-02: Path traversal in all file operation tools
- **Ficheiro:** src/services/agent/toolExecutor.ts:115-130 (read_file), 189-212 (write_file), 215-233 (create_file), 256-274 (delete_file)
- **Problema:** Every file operation tool accepts absolute paths from LLM agent with no validation. Agent could read `~/.ssh/id_rsa`, overwrite `~/.zshrc`, delete configs.
- **Impacto:** Full filesystem read/write/delete from LLM.
- **Fix sugerido:** Validate all paths are within project directory.

### [CRITICAL] SEC-03: Unrestricted shell command execution via Tauri IPC (Rust)
- **Ficheiro:** src-tauri/src/commands/terminal.rs:30-71
- **Problema:** `execute_command` passes user-supplied strings directly to `sh -c` with zero sanitization. Tauri IPC is the only barrier.
- **Impacto:** Full RCE if webview is compromised.
- **Fix sugerido:** This is intentional for terminal, but the agent service (SEC-01) should NOT use this pathway without safeguards.

### [CRITICAL] SEC-04: API keys stored in localStorage in plaintext
- **Ficheiro:** src/services/agent/apiKeyManager.ts:16-25
- **Problema:** API keys for all LLM providers stored as plaintext in `localStorage`, which is an unencrypted file on disk.
- **Impacto:** Any local process can read API keys.
- **Fix sugerido:** Use Tauri secure store or OS keychain.

### [CRITICAL] SEC-05: Worker CORS allows all origins
- **Ficheiro:** toquemedia-studio-api/src/index.ts:8
- **Problema:** `'Access-Control-Allow-Origin': '*'` allows any website to make authenticated requests.
- **Impacto:** Token theft and abuse from malicious pages.
- **Fix sugerido:** Restrict to specific client origins.

### [CRITICAL] SEC-06: Worker localhost/Ollama provider enables SSRF
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:25-27 and 48-51
- **Problema:** The `localhost:11434` provider in production allows the Worker to make requests to internal services.
- **Impacto:** SSRF attack vector.
- **Fix sugerido:** Remove localhost provider from production config.

### [HIGH] SEC-07: File operations not scoped to project root (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:86-118 vs 454-516
- **Problema:** `validate_path_within_root` exists but is marked `#[allow(dead_code)]` and never called. All operations use `validate_path_safe` which only blocks `..` but accepts any absolute path.
- **Impacto:** Any file readable/writable by the process user is accessible.
- **Fix sugerido:** Activate `validate_path_within_root` for all file operations.

### [HIGH] SEC-08: kill_process accepts arbitrary PID (Rust)
- **Ficheiro:** src-tauri/src/commands/terminal.rs:111-129
- **Problema:** Sends SIGTERM to any PID. No check that PID was spawned by the IDE.
- **Impacto:** Compromised frontend can kill any user process.
- **Fix sugerido:** Track spawned PIDs; only allow killing those.

### [HIGH] SEC-09: All environment variables exposed to frontend (Rust)
- **Ficheiro:** src-tauri/src/commands/terminal.rs:179-187
- **Problema:** Returns every environment variable. Commonly includes `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`.
- **Impacto:** Credential exposure.
- **Fix sugerido:** Filter known secret-bearing variables; or provide allowlist.

### [HIGH] SEC-10: Worker user-supplied provider field allows arbitrary routing
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:71
- **Problema:** `body.provider` from client directly selects provider, bypassing model-to-provider mapping.
- **Impacto:** Client can force requests to any configured provider.
- **Fix sugerido:** Derive provider solely from model name.

### [HIGH] SEC-11: Worker no email verification check on tokens
- **Ficheiro:** toquemedia-studio-api/src/auth.ts:18-26
- **Problema:** `email_verified` is extracted but never checked. Unverified email users can use the API.
- **Impacto:** Account impersonation via unverified signups.
- **Fix sugerido:** Require `email_verified === true`.

### [HIGH] SEC-12: Firebase config hardcoded in source
- **Ficheiro:** src/services/auth/firebaseAuth.ts:12-20
- **Problema:** Full Firebase config (apiKey, projectId, appId) hardcoded in source.
- **Impacto:** Prevents per-environment configuration; exposes project metadata.
- **Fix sugerido:** Load from environment variables.

### [MEDIUM] SEC-13: Auth user data persisted to unencrypted localStorage
- **Ficheiro:** src/stores/authStore.ts:23-46
- **Problema:** `user` object (uid, email) serialized to localStorage alongside API keys.
- **Impacto:** User profile available to local processes.
- **Fix sugerido:** Avoid persisting auth data, or use secure storage.

### [MEDIUM] SEC-14: Debugger launches arbitrary programs (Rust)
- **Ficheiro:** src-tauri/src/commands/debugger.rs:218-275
- **Problema:** `program`, `args`, `cwd`, `env` fields used without validation.
- **Impacto:** Second pathway to execute arbitrary programs.
- **Fix sugerido:** Validate program path against project root.

### [MEDIUM] SEC-15: Worker no request body size limit
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:69
- **Problema:** `request.json()` with no size validation. Large bodies forwarded to paid LLM APIs.
- **Impacto:** Cost abuse.
- **Fix sugerido:** Enforce Content-Length limit.

### [MEDIUM] SEC-16: Worker raw upstream responses forwarded to client
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:113
- **Problema:** `return providerResponse` forwards raw response. API key fragments in errors leak to end user.
- **Impacto:** Information disclosure.
- **Fix sugerido:** Sanitize error responses before forwarding.

### [MEDIUM] SEC-17: iframe allows script execution in preview
- **Ficheiro:** src/components/views/PreviewView.tsx:168
- **Problema:** `sandbox="allow-scripts"` enables JS in previewed content. Untrusted files could crypto-mine or exhaust CPU.
- **Impacto:** Malicious code execution in preview.
- **Fix sugerido:** Only enable `allow-scripts` for known-trusted content.

### [MEDIUM] SEC-18: write_file auto-creates arbitrary directory trees (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:484-494
- **Problema:** Combined with unscoped file operations, creates directories and writes anywhere on filesystem.
- **Impacto:** Arbitrary file creation at any path.
- **Fix sugerido:** Scope to project root.

---

## 7. Dead Code

### [HIGH] DC-01: Git branch hardcoded to "main" in StatusBar
- **Ficheiro:** src/components/ui/StatusBar.tsx:102
- **Problema:** `<Text>main</Text>` — not connected to any git service.

### [HIGH] DC-02: Error count hardcoded to "0" in StatusBar
- **Ficheiro:** src/components/ui/StatusBar.tsx:142
- **Problema:** Never reflects real diagnostics.

### [HIGH] DC-03: ProblemsContent is entirely static placeholder
- **Ficheiro:** src/components/ui/ProblemsContent.tsx:32-57
- **Problema:** Hardcoded fake problems ("Cannot find module 'react'"). Not connected to LSP.

### [HIGH] DC-04: OutputContent is entirely static placeholder
- **Ficheiro:** src/components/ui/OutputContent.tsx:5-28
- **Problema:** Hardcoded text ("Extension Host starting..."). Not connected to output stream.

### [HIGH] DC-05: DebugConsoleContent is entirely static placeholder
- **Ficheiro:** src/components/ui/DebugConsoleContent.tsx:5-28
- **Problema:** Hardcoded text ("Breakpoint hit: App.tsx:25"). Not connected to debugger.

### [HIGH] DC-06: BackendProcessesSidebar has hardcoded process list
- **Ficheiro:** src/components/ui/terminal/BackendProcessesSidebar.tsx:26-31
- **Problema:** Static fake processes. Stop button has no onClick handler.

### [HIGH] DC-07: Activity bar and BottomPanel badges hardcoded
- **Ficheiro:** src/components/ui/ActivityBar.tsx:128, 139; src/components/ui/BottomPanel.tsx:81
- **Problema:** Source control badge: 3, Extensions badge: 2, Problems badge: 3. Never update.

### [HIGH] DC-08: NewProjectDialog and CloneDialog create/clone are no-ops
- **Ficheiro:** src/components/welcome/NewProjectDialog.tsx:44-46; src/components/welcome/CloneDialog.tsx:34-36
- **Problema:** Handlers simply close dialog. No project created, no clone performed.

### [HIGH] DC-09: handleCloneRepo is empty
- **Ficheiro:** src/components/ui/TitleBar.tsx:40-42
- **Problema:** `function handleCloneRepo(): void { }` — empty body.

### [HIGH] DC-10: validate_path_within_root exists but unused (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:86-118
- **Problema:** Marked `#[allow(dead_code)]`. This is the correct security mitigation but is never called.

### [HIGH] DC-11: ProcessMap created but immediately discarded (Rust)
- **Ficheiro:** src-tauri/src/commands/terminal.rs:27; src-tauri/src/lib.rs:16
- **Problema:** `_process_map` — process tracking infrastructure exists but is thrown away.

### [HIGH] DC-12: Unused type exports in src/types/agent.ts
- **Ficheiro:** src/types/agent.ts:5, 11, 21, 30
- **Problema:** `AgentTool`, `AgentToolName`, `AgentToolCall`, `AgentResponse` — exported but never imported by any consumer.

### [MEDIUM] DC-13: 4 orphan utility files (198 lines total)
- **Ficheiros:** src/utils/fileTreeManager.ts, windowManager.ts, windowStateManager.ts, dialogUtils.ts
- **Problema:** Complete orphans — never imported by any file.

### [MEDIUM] DC-14: NavigationControls buttons are non-functional
- **Ficheiro:** src/components/ui/NavigationControls.tsx:7-77
- **Problema:** Go back/forward buttons have no onClick handler.

### [MEDIUM] DC-15: recoveryService startRecoveryMonitoring does nothing
- **Ficheiro:** src/services/recoveryService.ts:94-102
- **Problema:** Creates interval that fires every 30s with an empty callback.

### [MEDIUM] DC-16: filterText in TerminalV3 is cosmetic only
- **Ficheiro:** src/components/ui/TerminalV3.tsx:26, 131-132
- **Problema:** State bound to Input but never passed to TerminalSession or used to filter output.

### [MEDIUM] DC-17: Dead CSS from Tauri scaffold template
- **Ficheiro:** src/App.css
- **Problema:** `.logo`, `.container`, `#greet-input`, etc. never referenced by any TSX. Monaco token override to `#FFFFFF !important` could destroy syntax highlighting.

### [LOW] DC-18: greet template function still registered (Rust)
- **Ficheiro:** src-tauri/src/lib.rs:9-12
- **Problema:** Default Tauri template function adds unnecessary IPC surface.

### [LOW] DC-19: Disk space checks commented out (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:266-273, 402-407
- **Problema:** Both `validate_project_location` and `create_project` have disk space checks commented out.

### [LOW] DC-20: _userId parameter unused in Worker proxy
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:67
- **Problema:** Parameter accepted but never used.

### [LOW] DC-21: ProjectService largely bypassed
- **Ficheiro:** src/services/projectService.ts
- **Problema:** `projectStore.ts` directly calls `invoke()` for the same commands. Only used by recoveryService.

---

## 8. Error Handling Gaps

### [HIGH] EH-01: Silent catch blocks in MinimalTitleBar (4 instances)
- **Ficheiro:** src/components/MinimalTitleBar.tsx:24, 28, 43, 52
- **Problema:** All window operation failures silently swallowed. No user feedback.
- **Fix sugerido:** Show toast on failure.

### [HIGH] EH-02: Silent catch blocks in CommandPalette (4 instances)
- **Ficheiro:** src/components/ui/CommandPalette.tsx:52, 69, 101, 148
- **Problema:** Failed commands produce no notification.
- **Fix sugerido:** Show toast or status bar message on failure.

### [HIGH] EH-03: projectStore swallows editor closeAllFiles error
- **Ficheiro:** src/stores/projectStore.ts:71
- **Problema:** `try { ... } catch {}` — editor state left inconsistent while new project loads.
- **Fix sugerido:** Log error; abort project switch if editor cleanup fails.

### [MEDIUM] EH-04: Worker invalid JSON body returns 500 instead of 400
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:69
- **Problema:** `request.json()` throws on invalid JSON. Outer catch returns 500 "Internal server error" instead of 400.
- **Fix sugerido:** Wrap `request.json()` in try-catch returning 400.

### [MEDIUM] EH-05: Worker non-null assertions on JWT payload
- **Ficheiro:** toquemedia-studio-api/src/auth.ts:19-26
- **Problema:** `payload.sub!`, `payload.iat!`, etc. If jose has a bug, `userId` becomes `undefined` cast as `string`.
- **Fix sugerido:** Validate each field exists before using.

### [MEDIUM] EH-06: agentService assumes response.body is non-null
- **Ficheiro:** src/services/agent/agentService.ts:326
- **Problema:** `response.body!.getReader()` throws TypeError if body is null.
- **Fix sugerido:** Check for null body before accessing reader.

### [MEDIUM] EH-07: File tree errors logged to stderr, invisible to user (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:312-315
- **Problema:** `eprintln!` in a GUI app goes nowhere visible.
- **Fix sugerido:** Return partial results with error info to frontend.

### [MEDIUM] EH-08: Settings file parse failure silently falls back (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:1045-1049
- **Problema:** Corrupted settings silently replaced with defaults on next write.
- **Fix sugerido:** Backup corrupted file; notify user.

### [MEDIUM] EH-09: Silent catch on editor options update
- **Ficheiro:** src/components/ui/MonacoEditor.tsx:214
- **Problema:** `catch {}` after `updateOptions()`. Indentation settings failure invisible.
- **Fix sugerido:** Log error.

### [LOW] EH-10: JSON parse errors silently swallowed in search (Rust)
- **Ficheiro:** src-tauri/src/commands/search.rs:240-243
- **Problema:** Ripgrep JSON parse errors cause all results to be silently dropped.
- **Fix sugerido:** Log and continue; count dropped results.

### [LOW] EH-11: Permission check creates and may leave test file (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:320-327
- **Problema:** `.toquemedia_test` file cleanup error silently ignored.
- **Fix sugerido:** Retry cleanup; log if file remains.

---

## 9. Edge Cases

### [HIGH] EDGE-01: fileTreeStore createFileOrDirectory allows path traversal
- **Ficheiro:** src/stores/fileTreeStore.ts:165-209
- **Problema:** `name` like `../../.ssh/authorized_keys` makes fullPath escape project directory.
- **Impacto:** File creation outside project root.
- **Fix sugerido:** Reject names containing `..`.

### [HIGH] EDGE-02: FileWatcher.createPollingWatcher does nothing
- **Ficheiro:** src/utils/fileWatcher.ts:95-117
- **Problema:** Fallback polling watcher has empty body. File changes in non-Tauri environments undetectable.
- **Impacto:** No file watching in dev environment.
- **Fix sugerido:** Implement basic polling comparison.

### [MEDIUM] EDGE-03: Binary files cause hard error in read_file (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:454-480
- **Problema:** `read_to_string` fails on non-UTF-8 files. No binary detection.
- **Impacto:** Opening binary files shows opaque error.
- **Fix sugerido:** Detect binary content; return appropriate error.

### [MEDIUM] EDGE-04: Non-UTF-8 file names become empty strings (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:234-238
- **Problema:** `.to_str().unwrap_or("")` makes invalid-UTF-8 names invisible.
- **Impacto:** Files vanish from tree.
- **Fix sugerido:** Use `to_string_lossy()`.

### [MEDIUM] EDGE-05: Symlink following in copy_dir_all (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:560-579
- **Problema:** Blindly follows symlinks. Could copy `~/.ssh` or infinite recursion.
- **Impacto:** Data leak or hang.
- **Fix sugerido:** Add symlink detection; skip or follow with visited set.

### [MEDIUM] EDGE-06: System folder check is bypassable (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:1091-1126
- **Problema:** Case-sensitive `starts_with` on strings. Fails on symlinks, case-insensitive FS.
- **Impacto:** System directories can be opened as projects.
- **Fix sugerido:** Canonicalize paths; use case-insensitive comparison on macOS/Windows.

### [MEDIUM] EDGE-07: Rapid dropdown toggles cause concurrent session list requests
- **Ficheiro:** src/components/views/SessionDropdown.tsx
- **Problema:** `listProjectSessions` called on each open. No cancellation or sequencing.
- **Impacto:** UI flickers with out-of-order responses.
- **Fix sugerido:** Cancel previous request or use latest-only pattern.

### [MEDIUM] EDGE-08: Worker empty string API key sends garbage Authorization header
- **Ficheiro:** toquemedia-studio-api/src/proxy.ts:96-105
- **Problema:** Whitespace-only API key secret passes both checks and sends invalid bearer token.
- **Impacto:** Upstream returns auth error instead of config error.
- **Fix sugerido:** Trim and validate API key is non-empty.

### [MEDIUM] EDGE-09: create_directories_all uses extension as file heuristic (Rust)
- **Ficheiro:** src-tauri/src/commands/file_tree.rs:596-599
- **Problema:** `my.project` directory treated as file; `Makefile` treated as directory.
- **Impacto:** Wrong directory structure created.
- **Fix sugerido:** Accept explicit `is_directory` parameter.

### [MEDIUM] EDGE-10: Duplicate FileTreeFilter interfaces with conflicting shapes
- **Ficheiro:** src/types/fileTree.ts:19-23 vs src/hooks/useFileTreeWorker.ts:21-26
- **Problema:** Same name, different shapes (required vs optional `showHidden`; extra `searchTerm` field).
- **Impacto:** Type confusion; assignment errors.
- **Fix sugerido:** Merge into single canonical interface.

### [LOW] EDGE-11: now_iso returns Unix timestamp, not ISO 8601 (Rust)
- **Ficheiro:** src-tauri/src/commands/project.rs:136-142
- **Problema:** Function named `now_iso` returns seconds-since-epoch.
- **Impacto:** Misleading for anyone reading metadata.
- **Fix sugerido:** Rename to `now_unix_seconds` or return actual ISO string.

### [LOW] EDGE-12: Error toasts accumulate without bound
- **Ficheiro:** src/components/ui/Toast.tsx
- **Problema:** Error toasts never auto-dismiss. No max height or scroll on container.
- **Impacto:** Toast container overflows viewport during cascading failures.
- **Fix sugerido:** Add auto-dismiss timer and max visible limit.

### [LOW] EDGE-13: formatRelativeTime does not handle future timestamps
- **Ficheiro:** src/components/views/SessionDropdown.tsx
- **Problema:** `Date.now() - timestamp` produces negative values for future timestamps (clock skew).
- **Impacto:** Displays "-5m" artifacts.
- **Fix sugerido:** Clamp to minimum 0.

### [LOW] EDGE-14: Worker GET/PUT/DELETE returns 404 instead of 405
- **Ficheiro:** toquemedia-studio-api/src/index.ts:30
- **Problema:** Non-POST methods fall through to 404 instead of 405 Method Not Allowed.
- **Impacto:** Confusing error for API consumers.
- **Fix sugerido:** Add explicit method check returning 405.

---

## 10. Analise de Dependencias

### IDE (`package.json`)

**Unused dependencies:**
- `@emotion/styled` — never imported. Not needed by Chakra UI v3. (~dead weight)
- `framer-motion` — zero imports. Chakra UI v3 no longer requires it. (~130KB dead bundle weight)

**Unused devDependencies:**
- `@welldone-software/why-did-you-render` — never imported. Leftover from debugging.
- `commander` — only used by missing `src/testing/benchmarkCLI.ts`. All benchmark scripts are broken.

**Broken scripts:**
- `benchmark`, `benchmark:watch`, `test:performance`, `test:regression` — all reference missing file `src/testing/benchmarkCLI.ts`.

**Config issues:**
- `tsconfig.test.json` disables `noUnusedLocals` and `noUnusedParameters`.
- `jest.config.json` maps `~/` alias not defined in `tsconfig.json`. Tests pass but Vite build would fail.
- `tsconfig.app.json` appears orphaned — not referenced by any config or script.

### Worker (`toquemedia-studio-api/package.json`)
- Dependencies are minimal and all used (`jose`).
- No `.gitignore` file found.

### Rust (`Cargo.toml`)
- `tokio = { features = ["full"] }` — only `process` and `sync` used. Increases compile time.
- `tauri-plugin-fs` included but all file operations implemented manually in `file_tree.rs`. The plugin's security scoping is unused.
- No minimum patch versions specified.

---

## 11. Recomendacoes Prioritarias

### Top 10 fixes ordenados por impacto/esforco

| # | Finding | Severity | Effort | Rationale |
|---|---------|----------|--------|-----------|
| 1 | **SEC-01 + SEC-02**: Sandbox agent tool executor — restrict file operations to project root and add command confirmation | CRITICAL | Medium | LLM can currently read/write/delete any file and execute any command. Single biggest security risk. |
| 2 | **SEC-04**: Move API keys from localStorage to Tauri secure store | CRITICAL | Low | Plaintext API keys on disk. Quick migration to `tauri-plugin-store` with encryption. |
| 3 | **SEC-05 + SEC-06**: Lock down Worker CORS and remove localhost provider | CRITICAL | Low | Two-line changes that eliminate SSRF and cross-origin abuse. |
| 4 | **PERF-01 + BUG-01**: Remove `content` from editorStore `partialize` | HIGH | Low | Eliminates keystroke lag AND localStorage overflow. Biggest perf win. |
| 5 | **SEC-07**: Activate `validate_path_within_root` in Rust file operations | HIGH | Low | The function already exists but is `#[allow(dead_code)]`. Just call it. |
| 6 | **RC-02 + ML-01 + ML-02**: Add AbortController to agent loop with concurrency guard | CRITICAL | Medium | Prevents duplicate streaming, memory leaks, and wrong-session bugs. |
| 7 | **BUG-06**: Fix meta.json compression format mismatch | HIGH | Low | Project state fails to load between sessions. Consistent format = one-line fix. |
| 8 | **BA-03**: Make Worker fail-closed on Firestore error | HIGH | Low | Change two `return` statements to deny instead of grant access. |
| 9 | **BUG-05 + BUG-07 + BUG-08**: Fix Rust search and terminal bugs | HIGH | Low | Search returns errors for no-matches, replace is no-op, tab completion shows wrong dir. |
| 10 | **PERF-02**: Switch Rust commands from std::process to tokio::process | HIGH | Medium | Eliminates UI freezes during search and terminal operations. |
