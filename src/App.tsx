// src/App.tsx
import './utils/platformPatches'
import './utils/monacoEnv'
import WelcomeScreen from './components/WelcomeScreen';
import FileViewer from './components/FileViewer';
import LoginScreen from './components/auth/LoginScreen';
import OnboardingFlow from './components/onboarding/OnboardingFlow';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore } from './stores/authStore';
import { useSettingsStore } from './stores/settingsStore';
import { useChatStore } from './stores/chatStore';
import { useAgentStore } from './stores/agentStore';
import { useSkillStore } from './stores/skillStore';
import FirebaseAuthService from './services/auth/firebaseAuth';
import SkillService from './services/agent/skillService';
import QuickOpenService from './services/quickOpenService';
import MCPService from './services/mcp/mcpService';
import { browserSession } from './services/browserSessionManager';
import ToolExecutor from './services/agent/toolExecutor';
import AgentService from './services/agent/agentService';
import { getQueryGuard } from './services/agent/queryGuard';
import { useParallelTaskStore } from './stores/parallelTaskStore';
import { autoCheckForUpdate, stopAutoUpdateChecks } from './services/updateService';
import { checkStartupRequirements, GLOBAL_REQUIREMENTS } from './services/startupRequirements';
import type { EnvironmentCheckResult } from './services/environmentCheck';
import { useUpdateStore } from './stores/updateStore';
import { useLayoutStore } from './stores/layoutStore';
import { usePermissionStore } from './stores/permissionStore';
import { logger } from './utils/logger';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNativeMenu } from './hooks/useNativeMenu';
import { useBillingRefresh } from './hooks/useBillingRefresh';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { LoadingSpinner } from './components/ui/LoadingSpinner';
import { RequirementsErrorScreen } from './components/ui/RequirementsErrorScreen';
import { ToastContainer } from './components/ui/Toast';
import UpdateBanner from './components/ui/UpdateBanner';
import UserBlockedBanner from './components/ui/UserBlockedBanner';
import { t } from '@/i18n';
import { tokens } from '@/theme/tokens';
import { invoke } from '@tauri-apps/api/core';


// Detect standalone editor windows opened via "Open With" from OS.
// The URL looks like: index.html?standalone=<encoded-paths>
const standaloneParam = new URLSearchParams(window.location.search).get('standalone')
const STANDALONE_FILES: string[] = standaloneParam ? JSON.parse(decodeURIComponent(standaloneParam)) : []

/** Lightweight app shell for standalone editor windows (no auth, no project, no sidebar). */
function StandaloneEditorApp({ files }: { files: string[] }) {
	useEffect(() => {
		invoke('app_ready').catch(() => { /* not running under Tauri */ })
	}, [])

	return (
		<Flex
			w="100vw"
			h="100vh"
			direction="column"
			bg={tokens.colors.bg.app}
			overflow="hidden"
		>
			<FileViewer
				standalone
				filePath={files[0]}
				onClose={() => {
					import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
						getCurrentWindow().close().catch(() => {})
					})
				}}
			/>
		</Flex>
	)
}

function App() {
	// If this is a standalone editor window, skip all normal init and render only FileViewer
	if (STANDALONE_FILES.length > 0) {
		return (
			<StandaloneEditorApp files={STANDALONE_FILES} />
		)
	}

	const { currentProject, openProject, hasHydrated } = useProjectStore();
	const { isAuthenticated, isLoading: authLoading, signupComplete } = useAuthStore();
	const isBlocked = useAuthStore(state => state.user?.blocked === true);
	const hasCompletedOnboarding = useSettingsStore(s => s.hasCompletedOnboarding);
	const [initializing, setInitializing] = useState(true);
	const [requirementsResult, setRequirementsResult] = useState<EnvironmentCheckResult | null>(null);
	// True while openProject is in-flight. Keeps the spinner visible even after
	// setInitializing(false) fires — prevents WelcomeScreen from showing while a
	// project is actively loading (both on startup auto-open and manual opens).
	const prevProjectRef = useRef<string | null>(null);
	// Guards against concurrent initializeApp invocations (dependency re-runs while async in progress,
	// or React StrictMode double-fire). Without this, openProject can be called twice in parallel.
	const hasStartedInitRef = useRef(false);
	// Standalone files opened from OS (no project context).
	const [standaloneFiles, setStandaloneFiles] = useState<string[]>([]);

	const handleRetryRequirements = useCallback(async () => {
		const result = await checkStartupRequirements(true);
		setRequirementsResult(result);
	}, []);

	// Set up keyboard shortcuts + native macOS menu handler
	useKeyboardShortcuts();
	useNativeMenu();
	// Refresh billing state on window focus / network reconnect (no polling)
	useBillingRefresh();

	// Splash dismiss — the main window is created hidden by Rust to avoid the
	// flash of empty chrome before the SPA mounts. React's first paint
	// commits *before* this effect runs, so by the time we call `app_ready`
	// the DOM is fully populated. The Rust side has a 15s failsafe in case
	// this effect never fires (render crash) — see lib.rs setup.
	useEffect(() => {
		let active = true
		import('@tauri-apps/api/core').then(({ invoke }) => {
			if (!active) return
			invoke('app_ready').catch(() => { /* not running under Tauri */ })
		})
		return () => { active = false }
	}, []);

	// Keep open editor buffers in sync with the filesystem — shell edits by
	// the agent (execute_command), Source Control discard/stage, and files
	// changed externally while the window was unfocused. The direct agent
	// write tools refresh their own target; this is the catch-all sweep.
	useEffect(() => {
		let stop: (() => void) | null = null
		let active = true
		import('./services/bufferReconciler').then(({ startBufferReconciler }) => {
			if (!active) return
			stop = startBufferReconciler()
		})
		return () => { active = false; stop?.() }
	}, []);

	// Detect the mandatory external tools (git/node/python) once the app is up,
	// and re-check on window focus. Prompt sending is blocked while any is
	// missing (see requiredToolsStore + the handleSend gates). Best-effort;
	// covers every view, not just the shell-styled surface.
	useEffect(() => {
		const refresh = () => {
			import('./stores/requiredToolsStore').then(({ useRequiredToolsStore }) => {
				useRequiredToolsStore.getState().refresh()
			})
		}
		refresh()
		window.addEventListener('focus', refresh)
		return () => window.removeEventListener('focus', refresh)
	}, []);


	useEffect(() => {
		let active = true
		FirebaseAuthService.getInstance().init();
		// Restore persisted sandbox state to Rust backend
		import('./stores/settingsStore').then(({ useSettingsStore }) => {
			if (!active) return
			const sandboxEnabled = useSettingsStore.getState().sandboxEnabled;
			if (sandboxEnabled) {
				import('@tauri-apps/api/core').then(({ invoke }) => {
					if (!active) return
					invoke('sandbox_set_enabled', { enabled: true }).catch(() => {});
				});
			}
		});
		return () => { active = false }
	}, []);

	// Listen for OAuth popup messages forwarded from the Rust popup window
	useEffect(() => {
		let active = true;
		let unlistenMessage: (() => void) | undefined;
		let unlistenClosed: (() => void) | undefined;

		import('@tauri-apps/api/event').then(({ listen }) => {
			if (!active) return;
			listen<string>('oauth-popup-message', (e) => {
				if (!active) return;
				try {
					const data = JSON.parse(e.payload);
					window.dispatchEvent(new MessageEvent('message', { data: data }));
					if ((window as any)._oauthProxy) {
						(window as any)._oauthProxy.closed = true;
					}
				} catch (err) {}
			}).then(unsub => {
				if (active) unlistenMessage = unsub;
				else unsub();
			});

			listen('oauth-popup-closed', () => {
				if (!active) return;
				if ((window as any)._oauthProxy) {
					(window as any)._oauthProxy.closed = true;
				}
			}).then(unsub => {
				if (active) unlistenClosed = unsub;
				else unsub();
			});
		}).catch(() => {});

		return () => {
			active = false;
			if (unlistenMessage) unlistenMessage();
			if (unlistenClosed) unlistenClosed();
		};
	}, []);

	// Native OS notification when the agent asks for permission while the
	// IDE window is in the background. The notify() helper itself skips when
	// the window is focused, so users actively watching the app see only the
	// in-app dialog, never a duplicate banner.
	useEffect(() => {
		let lastSeenId: string | null = null
		return usePermissionStore.subscribe((state) => {
			const next = state.pendingPermission
			if (!next || next.id === lastSeenId) return
			lastSeenId = next.id
			import('./services/notificationService').then(({ notify, humaniseToolName }) => {
				notify({
					title: 'TM Code — permission needed',
					body: `The agent wants to ${humaniseToolName(next.toolName)}`,
					dedupKey: `permission:${next.id}`,
				})
			})
		})
	}, []);

	// "Open With TM Code" — file association launches. The OS hands us a
	// file path either via env::args (Win/Linux) or RunEvent::Opened (macOS
	// Apple Event). Both routes funnel into the Rust pending-files buffer.
	// On mount we drain the buffer; while running we also listen for live
	// open events. For every path: open the common-ancestor folder ONCE as
	// project, open all files in the editor, force the view to `editor`
	// (not the default `chat`) so the user lands where they expect.
	useEffect(() => {
		let unlisten: (() => void) | undefined
		let active = true

		// Common-ancestor folder of an arbitrary set of paths. When the user
		// selects multiple files in Finder / Explorer and uses "Open With",
		// each may live in a different directory — we want to open one
		// project that contains them all, not call openProject() per file
		// (the last one would win and the previous switches would just
		// thrash dev servers).
		function commonAncestor(paths: string[]): string {
			if (paths.length === 0) return ''
			const sep = paths[0].includes('/') ? '/' : '\\'
			if (paths.length === 1) {
				return paths[0].substring(0, paths[0].lastIndexOf(sep)) || sep
			}
			const splits = paths.map(p => p.split(sep))
			const minLen = Math.min(...splits.map(s => s.length))
			const common: string[] = []
			for (let i = 0; i < minLen; i++) {
				const seg = splits[0][i]
				if (splits.every(s => s[i] === seg)) common.push(seg)
				else break
			}
			// If the last common segment looks like a partial filename we
			// stopped at the file boundary — drop the last shared file part.
			const joined = common.join(sep)
			return joined || sep
		}

		async function openManyInEditor(paths: string[]) {
			if (paths.length === 0) return
			try {
				const { useProjectStore } = await import('@/stores/projectStore')
				const projectStore = useProjectStore.getState()
				const already = projectStore.currentProject?.path

				// File-only opens (single file or a few siblings) MUST NOT mount
				// the surrounding folder as a TM Code project — that pollutes
				// recents with directories the user never intended to track
				// (e.g. /Users/me/Documents because they "Open With" a stray
				// .md). XCode-style behaviour: show the file in a bare editor,
				// touch nothing else. If a project is already open we just open
				// the file in its editor; otherwise we drop into a "no project,
				// file viewer" state without persisting anything to recents.
				const { invoke } = await import('@tauri-apps/api/core')
				// is_directory failure must NOT silently downgrade a folder to a
				// "file open" — the next step would skip openProject and try to
				// open the directory path in the editor, breaking the user flow
				// with no visible reason. Default to `true` on IPC failure so we
				// preserve the previous behaviour (mount as project) when the
				// probe is inconclusive. Only treat as file-only when EVERY probe
				// definitively returned false.
				const probes = await Promise.all(
					paths.map(p => invoke<boolean>('is_directory', { path: p }).catch(() => true))
				)
				const onlyFiles = probes.every(isDir => isDir === false)

				const { useEditorRepository } = await import('@/stores/editorStore')
				const { useLayoutStore } = await import('@/stores/layoutStore')

				if (onlyFiles) {
					// No openProject call. If there's already a project open, the
					// files open inside it (same UX as drag-drop onto the editor
					// pane). If not, open a separate window — recents stays untouched.
					const repo = useEditorRepository.getState()
					for (const p of paths) repo.openFile(p)
					if (!already) {
						// Open a new standalone editor window
						const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
						const fileParam = encodeURIComponent(JSON.stringify(paths))
						const label = `editor-${Date.now()}`
						new WebviewWindow(label, {
							url: `index.html?standalone=${fileParam}`,
							title: paths.length === 1
								? paths[0].split(/[\/\\]/).pop() ?? 'Editor'
								: `${paths.length} files`,
							width: 960,
							height: 720,
							minWidth: 600,
							minHeight: 400,
							decorations: false,
							transparent: true,
							titleBarStyle: 'overlay',
							hiddenTitle: true,
						})
						return
					}
					useLayoutStore.getState().setViewMode('editor')
					return
				}

				// Folder open (or mixed) — keep the project-mount path.
				const projectRoot = commonAncestor(paths)
				if (already !== projectRoot) {
					await projectStore.openProject(projectRoot)
				}
				const repo = useEditorRepository.getState()
				for (const p of paths) repo.openFile(p)
				useLayoutStore.getState().setViewMode('editor')
			} catch (err) {
				logger.error('app', 'open-with batch failed:', err)
			}
		}

		;(async () => {
			try {
				const { invoke } = await import('@tauri-apps/api/core')
				const { listen } = await import('@tauri-apps/api/event')

				// Drain cold-start buffer first — paths queued by Rust before
				// the SPA mounted (file-association launch).
				const pending = await invoke<string[]>('take_pending_open_files')
				if (active && pending && pending.length > 0) {
					// Block the regular "restore last project" useEffect from
					// also running — file association is a stronger signal of
					// intent than persisted state.
					hasStartedInitRef.current = true
					await openManyInEditor(pending)
				}

				// Live listener for "Open With" while the app is already running.
				const u = await listen<string[]>('open-file-with-app', async (e) => {
					if (!active) return
					await openManyInEditor(e.payload || [])
				})
				unlisten = u
			} catch {
				// Tauri not present (jsdom tests, etc.)
			}
		})()

		return () => { active = false; unlisten?.() }
	}, []);

	// Multi-window parallel work: mirror this window's agent-run state to the
	// project's on-disk status file so OTHER windows can badge it in their
	// recents lists (each window is a separate OS process — disk is the only
	// shared channel). Reader side: useProjectAgentStatuses.
	useEffect(() => {
		void import('./services/projectAgentStatusService')
			.then(m => m.initProjectAgentStatusWriter())
			.catch(() => { /* Tauri not present (jsdom tests) */ })
		// Budget exhausted → stop EVERYTHING in this window (main run +
		// sub-agents) with a descriptive system message, instead of letting
		// each parallel run burn one more turn until its own 402.
		void import('./services/budgetStopService')
			.then(m => m.initBudgetStopWatcher())
			.catch(() => { /* Tauri not present (jsdom tests) */ })
		// Double-open guard: heartbeat this window's presence on its open
		// project so other windows can warn before opening it too.
		void import('./services/projectWindowLockService')
			.then(m => m.initProjectWindowLock())
			.catch(() => { /* Tauri not present (jsdom tests) */ })
		// Focus requests while agent is idle (finished run still on this project).
		void import('./services/projectWindowFocusService')
			.then(m => {
				// Cache this process's pid once — the sidebar uses it to open
				// self-owned agent-badge projects without the focus IPC round-trip.
				void m.primeSelfPid()
				m.startFocusRequestConsumer(
					() => useProjectStore.getState().currentProject?.path,
				)
			})
			.catch(() => { /* Tauri not present (jsdom tests) */ })
	}, []);

	// Backstop drain for `--open-project`: initializeApp only drains it on
	// the AUTHENTICATED boot path — a window that boots signed-out returned
	// early there and the queued target survived login with nobody left to
	// read it (the init effect is one-shot). Fires once when both auth and
	// init have settled; on the normal boot the slot is already empty.
	const pendingProjectDrainedRef = useRef(false);
	useEffect(() => {
		if (!isAuthenticated || initializing) return;
		if (pendingProjectDrainedRef.current) return;
		pendingProjectDrainedRef.current = true;
		void (async () => {
			try {
				const { invoke } = await import('@tauri-apps/api/core');
				const pendingProject = await invoke<string | null>('take_pending_open_project');
				if (pendingProject && !useProjectStore.getState().currentProject) {
					await openProject(pendingProject);
				}
			} catch {
				/* Tauri not present (jsdom tests) */
			}
		})();
	}, [isAuthenticated, initializing, openProject]);

	// Native file drop — drag a folder from Finder/Explorer onto the window
	// to open it as a project. Uses Tauri's window-level drag-drop event
	// (which gives real filesystem paths), distinct from the HTML5 drop in
	// the prompt area (which handles image attachments via DataTransfer).
	const [isDraggingFolder, setIsDraggingFolder] = useState(false);
	useEffect(() => {
		let unlisten: (() => void) | undefined
		let active = true

		;(async () => {
			try {
				const { getCurrentWebview } = await import('@tauri-apps/api/webview')
				const { invoke } = await import('@tauri-apps/api/core')
				const u = await getCurrentWebview().onDragDropEvent(async (event) => {
					if (!active) return
					const p = event.payload
					if (p.type === 'enter' || p.type === 'over') {
						setIsDraggingFolder(true)
					} else if (p.type === 'leave') {
						setIsDraggingFolder(false)
					} else if (p.type === 'drop') {
						setIsDraggingFolder(false)
						const paths = p.paths
						if (!paths || paths.length === 0) return
						const droppedPath = paths[0]
						try {
							// Two-step gate: cheap is_directory probe first to
							// distinguish folder drops from file drops (which
							// the PromptBar HTML5 path handles for images).
							// Only when it really is a folder do we run the
							// fuller validate_project_path — and only then
							// surface validation errors to the user.
							const isDir = await invoke<boolean>('is_directory', { path: droppedPath })
							if (!isDir) return
							const result = await invoke<{ valid: boolean; error?: string }>(
								'validate_project_path',
								{ path: droppedPath }
							)
							if (!result.valid) {
								if (result.error) {
									const { useToastStore } = await import('./stores/toastStore')
									useToastStore.getState().addToast('error', result.error)
								}
								return
							}
							await openProject(droppedPath)
						} catch (err) {
							logger.error('app', 'Folder-drop open failed:', err)
						}
					}
				})
				unlisten = u
			} catch {
				// Tauri webview API unavailable (e.g. running tests in jsdom)
			}
		})()

		return () => { active = false; unlisten?.() }
	}, [openProject]);

	useEffect(() => {
		// Only auto-open during initial app load, not on subsequent state changes
		// (e.g. after project deletion sets currentProject to null)
		if (!initializing) return;

		// Wait for store hydration
		if (!hasHydrated) return;

		// Don't block on Firebase when persisted state already shows authenticated.
		// Firebase resolves onAuthStateChanged asynchronously — if emulators are
		// not running or there's no network, this can take 2+ minutes.
		// If isAuthenticated is already true from the persisted store, proceed
		// immediately. Firebase will update auth state in the background.
		if (authLoading && !isAuthenticated) return;

		// Prevent concurrent invocations: openProject updating the Zustand store
		// (currentProject, recentProjects) triggers this effect to re-run while the
		// first async call is still in progress. The ref ensures we only start once.
		if (hasStartedInitRef.current) return;
		hasStartedInitRef.current = true;

		const initializeApp = async () => {
			// Guard against the file-association drain effect having already
			// opened a project while we were waiting for auth/hydration.
			// Belt-and-braces with hasStartedInitRef — if drain finished
			// before we got here, currentProject is set and we'd otherwise
			// thrash by reopening the persisted last-project on top.
			if (useProjectStore.getState().currentProject) return;

			// MANDATORY: Check global prerequisites before anything else
			const requirements = await checkStartupRequirements();
			setRequirementsResult(requirements);

			// Determine if we should block based on mandatory requirements
			const hasMissingMandatory = GLOBAL_REQUIREMENTS.some(req => {
				if (!req.mandatory) return false;
				const status = requirements?.requirements?.[req.name];
				return !status || !status.meetsMinimum;
			});

			if (hasMissingMandatory) {
				setInitializing(false);
				return;
			}

			// If not authenticated, stop initializing after requirements check
			if (!isAuthenticated) {
				setInitializing(false);
				return;
			}

			// Window launched with `--open-project <dir>` ("Open in New Window"
			// on another instance): that explicit target beats BOTH the
			// persisted welcomeScreen preference and the auto-open-last-project
			// fallback — the user asked for THIS project in THIS window.
			try {
				const { invoke } = await import('@tauri-apps/api/core');
				const pendingProject = await invoke<string | null>('take_pending_open_project');
				if (pendingProject) {
					try {
						await openProject(pendingProject);
					} catch (error) {
						logger.error('app', 'Failed to open --open-project target:', error);
					}
					setInitializing(false);
					return;
				}
			} catch {
				// Tauri not present (jsdom tests, etc.)
			}

			// Read directly from the store — not from the effect closure — to avoid
			// stale values if the store updated between renders and the effect firing.
			const { currentProject: proj, recentProjects: recent, welcomeScreen } = useProjectStore.getState();

			// If the user was explicitly on the Welcome screen last time the app
			// closed, honour that on restart — do NOT auto-open the most recent
			// project. `welcomeScreen === null` means "no Welcome preference yet"
			// (first-ever launch or pre-0.3.0 persisted state), in which case the
			// legacy auto-open-last-project behaviour still applies.
			if (!proj && !welcomeScreen && recent.length > 0) {
				const lastProject = recent[0];
				if (lastProject.path) {
					try {
						await openProject(lastProject.path);
					} catch (error) {
						logger.error('app', 'Failed to open last project:', error);
					}
				}
			}
			// Unblock after openProject so the spinner covers the transition.
			setInitializing(false);
		};

		initializeApp();
	}, [authLoading, isAuthenticated, initializing, hasHydrated, openProject]);

	// Restore session when project changes
	useEffect(() => {
		if (!currentProject) {
			prevProjectRef.current = null;
			// No project active — wipe any chat state left over from the previous one.
			useChatStore.getState().clearAllSessions();
			return;
		}

		const projectPath = currentProject.path;
		if (projectPath === prevProjectRef.current) return;

		const prevPath = prevProjectRef.current;
		prevProjectRef.current = projectPath;

		// Sessions are project-scoped: a session belongs only to the project that
		// created it. Without an explicit synchronous wipe, the chatStore's
		// in-memory `sessions` Map and `activeSessionId` carry over from the
		// previous project, and the UI flashes the previous project's chat
		// until restoreLastSession resolves async. Order matters here:
		//
		//   1. Kick off cleanupOnExit for the previous project. It captures the
		//      session ref synchronously (before its first `await`), then writes
		//      to disk in the background — the wipe in step 2 cannot affect it.
		//   2. Synchronously clear in-memory chat state. UI immediately drops
		//      the previous project's messages.
		//   3. Async-load the new project's session (or create one if there's
		//      no last session for this project).
		if (prevPath) {
			useChatStore.getState().cleanupOnExit(prevPath).catch(err => {
				logger.warn('app', 'cleanupOnExit failed for previous project:', err);
			});
		}

		// F2 MDI: if a main agent (or parallel tasks) are live, park their
		// sessions instead of wiping — switching projects must not cancel or
		// orphan mid-flight writers.
		const agentStillRunning = (() => {
			if (getQueryGuard().getSnapshot()) return true;
			for (const r of useParallelTaskStore.getState().runs.values()) {
				if (r.status === 'running' || r.status === 'queued') return true;
			}
			const chat = useChatStore.getState();
			return chat.isStreaming === true && !!chat.streamingSessionId;
		})();

		useChatStore.getState().clearAllSessions(
			agentStillRunning || !!prevPath ? { preserveLiveRuns: true } : undefined,
		);
		// Reset transient agent UI state ONLY when no run is parked — wiping
		// status to idle while the main loop is still working would kill the
		// projectAgentStatus badge heartbeat and lie about "idle".
		if (!agentStillRunning) {
			useAgentStore.getState().resetTransientState();
		}

		const chatStore = useChatStore.getState();
		// Sessão pedida a partir da sidebar de Projectos (clique numa sessão de
		// um projecto que ainda não estava activo nesta janela): consome-se
		// DEPOIS do wipe/park e ANTES do warm-restore — sem isto, o restore
		// aterraría na sessão mais recente do projecto em vez da escolhida.
		const pendingOpen = chatStore.pendingSessionOpen;
		if (pendingOpen && pendingOpen.projectPath === projectPath) {
			useChatStore.getState().setPendingSessionOpen(null);
			// Parked live sessions keep their in-memory transcript ahead of
			// disk — activate directly instead of regressing via disk read.
			if (chatStore.sessions.has(pendingOpen.sessionId)) {
				chatStore.setActiveSession(pendingOpen.sessionId);
				return;
			}
			void (async () => {
				await useChatStore.getState().loadSessionFromDisk(projectPath, pendingOpen.sessionId);
				// loadSessionFromDisk sai em silêncio quando o ficheiro não
				// existe (sessão apagada entretanto) — fallback ao comportamento
				// normal para não deixar o chat sem sessão activa.
				if (useChatStore.getState().activeSessionId !== pendingOpen.sessionId) {
					await useChatStore.getState().createNewSession(projectPath);
				}
			})().catch(err => {
				logger.error('app', 'Failed to open requested session:', err);
				useChatStore.getState().createNewSession(projectPath).catch(() => {});
			});
			return;
		}
		// Warm switch: prefer an in-memory main session for this project
		// (kept by preserveLiveRuns) so A→B→A does not re-read disk.
		let warmSessionId: string | null = null;
		let bestUpdated = -1;
		for (const [id, s] of chatStore.sessions) {
			if (s.projectPath !== projectPath || s.isParallelTask === true) continue;
			if (s.updatedAt > bestUpdated) {
				bestUpdated = s.updatedAt;
				warmSessionId = id;
			}
		}
		if (warmSessionId) {
			chatStore.setActiveSession(warmSessionId);
			return;
		}

		chatStore.restoreLastSession(projectPath).then(restored => {
			if (!restored) {
				chatStore.createNewSession(projectPath);
			}
		}).catch(err => {
			logger.error('app', 'Failed to restore session:', err);
			chatStore.createNewSession(projectPath);
		});
	}, [currentProject]);

	// Frontend-design discoverability now lives in the rotating command tips
	// (ChatWorkingTips) instead of a toast on project
	// open — the toast nagged on every frontend project even before the user
	// did anything. Removed per user request (2026-06-20).

	// Check for app updates on startup (non-blocking, 5s delay)
	useEffect(() => {
		if (!isAuthenticated) return;
		autoCheckForUpdate();
		return () => stopAutoUpdateChecks();
	}, [isAuthenticated]);

	// Re-check snooze state every minute if update is pending
	const hasPendingUpdate = !!useUpdateStore(s => s.pendingUpdate);
	const isBannerVisible = useUpdateStore(s => s.isBannerVisible);

	useEffect(() => {
		if (!isAuthenticated || !hasPendingUpdate || isBannerVisible) return;
		
		const interval = setInterval(() => {
			useUpdateStore.getState().checkSnooze();
		}, 60000);
		return () => clearInterval(interval);
	}, [isAuthenticated, hasPendingUpdate, isBannerVisible]);

	// Listen for runtime errors from the preview WebView (console.error, uncaught exceptions).
	// The preview IPC handler dispatches a CustomEvent on window (via eval) because
	// wry's IPC closure doesn't have access to Tauri's Emitter trait.
	//
	// Side-effect: detect Google Identity Services (GIS) failures inside the
	// preview iframe and show a friendly IDE-level toast. The agent must NOT
	// embed iframe-warning text in generated code — that responsibility lives
	// here so the message stays accurate (browser API errors evolve) and
	// localised to the developer's UI language.
	const gisToastShownRef = useRef(false);
	const previewReloadKey = useLayoutStore(s => s.previewReloadKey);

	// Reset the GIS-toast dedup flag whenever the preview reloads. Without
	// this, the user sees the iframe-warning toast exactly once for the entire
	// app session — even after they bounce the dev server or switch projects.
	useEffect(() => {
		gisToastShownRef.current = false;
	}, [previewReloadKey]);

	useEffect(() => {
		const GIS_ERROR_PATTERNS = [
			/accounts\.google\.com\/gsi\/client/i,
			/\[GSI_LOGGER\]/i,
			/FedCM/i,
			/Refused to display.+accounts\.google\.com/i,
			/script error.+google/i,
			/identity[._\s]services/i,
			// CSP frame-ancestors / COOP errors that block the GIS popup
			/frame-ancestors.+google/i,
			/Cross-Origin-Opener-Policy.+google/i,
		];

		function isPreviewProtocolNoise(text: string): boolean {
			// Historical noise from the now-removed tmpreview:// proxy. Kept
			// for one or two releases so transcripts captured against older
			// builds still scrub clean. Safe to delete after v0.8.x.
			if (text.includes('setupWebSocket@tmpreview://')) return true;
			if (text.startsWith('Script error.') && text.includes('(:0)')) return true;
			return false;
		}

		function handlePreviewConsole(e: Event) {
			const detail = (e as CustomEvent<{ level: string; text: string }>).detail;
			const { level, text } = detail || { level: '', text: '' };
			if (!text) return;
			if (isPreviewProtocolNoise(text)) return;

			// Scope runtime logs to the focused project's active preview.
			// A ghost macOS webview (or a page still retrying a dead port after
			// project switch) must not pollute layoutStore / DevServerStatus.
			const layout = useLayoutStore.getState();
			const hasLivePreviewTarget = !!(
				layout.devServer?.frontendUrl
				|| layout.devServer?.backendUrl
				|| (layout.previewMode === 'static' && layout.previewHtmlContent)
				|| layout.isPreviewServerLoading
			);
			if (!hasLivePreviewTarget) return;

			useLayoutStore.getState().addDevServerLog(
				`[runtime] ${text}`,
				level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error',
			);

			// GIS-in-iframe detection — only on errors. Dedup is per-preview-reload
			// (the ref resets via the effect above) so the user gets one toast
			// per "session of the preview".
			if (
				!gisToastShownRef.current &&
				level !== 'warn' &&
				GIS_ERROR_PATTERNS.some((re) => re.test(text))
			) {
				gisToastShownRef.current = true;
				import('./stores/toastStore').then(({ useToastStore }) => {
					useToastStore.getState().addToast(
						'warning',
						t('preview.gisIframeBlocked'),
						12000,
					);
				}).catch(() => { /* non-critical */ });
			}
		}

		// Proactive detection: when the preview emits a `gis-detected` signal
		// (sent by the injected probe in PreviewView), show the toast BEFORE
		// the developer clicks anything. Catches the silent-failure mode where
		// FedCM blocks the button without firing console.error.
		function handleGisDetected() {
			if (gisToastShownRef.current) return;
			gisToastShownRef.current = true;
			import('./stores/toastStore').then(({ useToastStore }) => {
				useToastStore.getState().addToast(
					'warning',
					t('preview.gisIframeBlocked'),
					12000,
				);
			}).catch(() => { /* non-critical */ });
		}

		window.addEventListener('preview-console', handlePreviewConsole);
		window.addEventListener('preview-gis-detected', handleGisDetected);
		return () => {
			window.removeEventListener('preview-console', handlePreviewConsole);
			window.removeEventListener('preview-gis-detected', handleGisDetected);
		};
	}, []);

	// Initialize MCP servers once at app startup (global — persists across project switches)
	useEffect(() => {
		if (!isAuthenticated) return;

		let cancelled = false;

		async function initMcp() {
			try {
				const mcpService = MCPService.getInstance();
				await mcpService.initialize();

				if (!cancelled) {
					const mcpTools = mcpService.getAllTools();
					if (mcpTools.length > 0) {
						const toolExecutor = ToolExecutor.getInstance();
						toolExecutor.registerMCPTools(
							mcpTools,
							browserSession.wrapCallTool((serverName, toolName, args) =>
								mcpService.callTool(serverName, toolName, args),
							),
						);
						AgentService.getInstance().refreshTools();
					}
				}
			} catch (error) {
				logger.warn('app', 'Failed to initialize MCP servers:', error);
			}
		}

		initMcp();
		return () => { cancelled = true; };
	}, [isAuthenticated]);

	// Preload skills + project-specific MCP overrides when project changes
	useEffect(() => {
		if (!currentProject?.path) return;

		const projectPath = currentProject.path;
		let cancelled = false;

		async function initializeProjectServices() {
			// Build file index for @mentions and Quick Open
			QuickOpenService.getInstance().initialize(projectPath).catch(err => {
				logger.warn('app', 'Failed to initialize QuickOpen index:', err);
			});

			// Load skills into store (for status bar display)
			try {
				const skillService = SkillService.getInstance();
				skillService.invalidateCache();
				const skills = await skillService.loadSkills(projectPath);
				if (!cancelled) {
					useSkillStore.getState().setSkills(skills);
				}
			} catch (error) {
				logger.warn('app', 'Failed to preload skills:', error);
			}

			// F4: start/refresh this project's MCP scope without stopping others.
			try {
				const mcpService = MCPService.getInstance();
				await mcpService.initialize(projectPath);
				// Mirror this project's (+ global) tools into the executor for UI/agent.
				if (!cancelled) {
					const mcpTools = mcpService.getAllTools(projectPath);
					if (mcpTools.length > 0) {
						const toolExecutor = ToolExecutor.getInstance();
						toolExecutor.registerMCPTools(
							mcpTools,
							browserSession.wrapCallTool((serverName, toolName, args) =>
								mcpService.callTool(serverName, toolName, args, projectPath),
							),
						);
						AgentService.getInstance().refreshTools();
					}
				}
			} catch (error) {
				logger.warn('app', 'Failed to load project MCP overrides:', error);
			}
		}

		initializeProjectServices();

		return () => {
			cancelled = true;
		};
	}, [currentProject?.path]);

	// Save session + abort active stream on window close.
	//
	// `beforeunload` fires synchronously and ignores async work, so we limit
	// ourselves to operations that complete (or initiate) synchronously:
	//   - saveSessionToDisk(): fire-and-forget Tauri invoke (IPC, fast)
	//   - cancelLoop(): AbortController.abort() is sync — the fetch reader
	//     stops reading immediately, the Cloudflare Worker upstream sees
	//     `request.signal.aborted` and cancels the LLM call. Without this,
	//     the worker keeps generating and consuming tokens even though the
	//     IDE is gone — exactly the "backend continues, nothing renders"
	//     symptom the developer reported.
	useEffect(() => {
		const handleBeforeUnload = () => {
			const project = useProjectStore.getState().currentProject;
			if (project) {
				useChatStore.getState().saveSessionToDisk();
			}
			if (useChatStore.getState().isStreaming) {
				AgentService.getInstance().cancelLoop();
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	}, []);

	const handleOpenProject = async (path?: string, options?: { initGit?: boolean }) => {
		if (!path) return;
		try {
			await openProject(path, options);
		} catch (error) {
			logger.error('app', 'Failed to open project:', error);
			const { useToastStore } = await import('./stores/toastStore');
			useToastStore.getState().addToast('error', t('app.failedOpenProject').replace('{message}', (error as Error).message || t('error.unknown')));
		}
	};

	// Show loading state while:
	// - app is bootstrapping (initializing)
	// - Firebase auth is still resolving and we have no persisted auth
	if (initializing || (authLoading && !isAuthenticated)) {
		return (
			<Flex
				justify="center"
				align="center"
				height="100vh"
				bg={tokens.colors.bg.welcome}
			>
				<LoadingSpinner size="lg" label={t('app.initializing')} />
			</Flex>
		);
	}

	// MANDATORY: Block application if Node.js or Python are missing
	const missingMandatory = requirementsResult && GLOBAL_REQUIREMENTS.some(req => {
		if (!req.mandatory) return false;
		const status = requirementsResult?.requirements?.[req.name];
		return !status || !status.meetsMinimum;
	});

	if (missingMandatory && requirementsResult) {
		return <RequirementsErrorScreen result={requirementsResult} onRetry={handleRetryRequirements} />;
	}

	// First-time install → show onboarding before login
	if (!hasCompletedOnboarding) {
		return <OnboardingFlow onComplete={() => {}} />;
	}

	// Not authenticated → show login
	if (!isAuthenticated) {
		return <LoginScreen />;
	}

	// Authenticated but the backend hasn't answered yet (signupComplete === null
	// until /v1/me resolves, seconds after sign-in). Keep showing a spinner —
	// bouncing back to an idle LoginScreen in this window made every successful
	// login look like it silently failed.
	if (signupComplete === null) {
		return (
			<Flex
				justify="center"
				align="center"
				height="100vh"
				bg={tokens.colors.bg.welcome}
			>
				<LoadingSpinner size="lg" label={t('login.signingIn')} />
			</Flex>
		);
	}

	// Backend /v1/me reported `signup_incomplete`. Show login screen — signup
	// must be done on the website. The explicit key forces a fresh mount so the
	// submit spinner from the previous attempt doesn't survive the transition.
	if (signupComplete !== true) {
		return <LoginScreen key="signup-incomplete" />;
	}

	return (
		<Box
			bg="#0a0a0a"
			minHeight="100vh"
			position="relative"
		>
			<UpdateBanner />
			<UserBlockedBanner />
			{/* Global ambient gradient */}
			<Box
				position="fixed"
				top="0"
				left="0"
				width="100%"
				height="100%"
				pointerEvents="none"
				zIndex={0}
				background="radial-gradient(ellipse at top, rgba(254, 16, 99, 0.04) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(163, 113, 247, 0.03) 0%, transparent 50%)"
			/>

			<Box position="relative" zIndex={1}>
				{/* Conta suspensa → só o Welcome, sem workspace activo. */}
				{isBlocked ? (
					<WelcomeScreen
						onOpenProject={handleOpenProject}
					/>
				) : standaloneFiles.length > 0 && !currentProject ? (
						// The viewer now sizes to its container (h=100%) instead of
						// hardcoding 100vh — inline it must discount the 35px title
						// bar or its status bar lands below the fold.
						<Box h="calc(100vh - 35px)">
							<FileViewer
								filePath={standaloneFiles[0]}
								onClose={() => setStandaloneFiles([])}
							/>
						</Box>
					) : (
						<WelcomeScreen
							onOpenProject={handleOpenProject}
						/>
					)
				}
			</Box>

			<ToastContainer />

			{/* Native file-drop overlay — appears while a Finder/Explorer drag
			    is over the window. Pointer-events: none so it never blocks the
			    underlying drop event from reaching Tauri's native handler. */}
			{isDraggingFolder && (
				<Box
					position="fixed"
					inset={0}
					bg="rgba(254, 16, 99, 0.12)"
					border={`2px dashed ${tokens.colors.accent.primary}`}
					borderRadius="0"
					pointerEvents="none"
					zIndex={9999}
					display="flex"
					alignItems="center"
					justifyContent="center"
					backdropFilter="blur(2px)"
				>
					<Box
						bg={tokens.colors.dialog.bg}
						border={`1px solid ${tokens.colors.accent.primaryMuted}`}
						borderRadius="12px"
						px={6}
						py={4}
						boxShadow={tokens.shadow.overlay}
						textAlign="center"
					>
						<Box fontSize="13px" fontWeight={500} color={tokens.colors.text.primary}>
							Drop folder to open as project
						</Box>
					</Box>
				</Box>
			)}
		</Box>
	);
}

export default App;
