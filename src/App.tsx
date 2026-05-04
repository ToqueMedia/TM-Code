// src/App.tsx
import './utils/platformPatches'
import './utils/monacoEnv'
import WelcomeScreen from './components/WelcomeScreen';
import MainLayout from './components/MainLayout';
import LoginScreen from './components/auth/LoginScreen';
import OnboardingFlow from './components/onboarding/OnboardingFlow';
import type { OnboardingDoneAction } from './components/onboarding/OnboardingFlow';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore } from './stores/authStore';
import { useSettingsStore } from './stores/settingsStore';
import { useChatStore } from './stores/chatStore';
import { useSkillStore } from './stores/skillStore';
import FirebaseAuthService from './services/auth/firebaseAuth';
import SkillService from './services/agent/skillService';
import QuickOpenService from './services/quickOpenService';
import MCPService from './services/mcp/mcpService';
import { browserSession } from './services/browserSessionManager';
import ToolExecutor from './services/agent/toolExecutor';
import AgentService from './services/agent/agentService';
import { autoCheckForUpdate } from './services/updateService';
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
import { flushSync } from 'react-dom';
import { Box, Flex } from '@chakra-ui/react';
import { LoadingSpinner } from './components/ui/LoadingSpinner';
import { RequirementsErrorScreen } from './components/ui/RequirementsErrorScreen';
import { ToastContainer } from './components/ui/Toast';
import UpdateBanner from './components/ui/UpdateBanner';
import { t } from '@/i18n';
import { tokens } from '@/theme/tokens';

function App() {
	const { currentProject, openProject, hasHydrated } = useProjectStore();
	const { isAuthenticated, isLoading: authLoading, signupComplete } = useAuthStore();
	const hasCompletedOnboarding = useSettingsStore(s => s.hasCompletedOnboarding);
	const [initializing, setInitializing] = useState(true);
	const [requirementsResult, setRequirementsResult] = useState<EnvironmentCheckResult | null>(null);
	// True while openProject is in-flight. Keeps the spinner visible even after
	// setInitializing(false) fires — prevents WelcomeScreen from showing while a
	// project is actively loading (both on startup auto-open and manual opens).
	const [isOpeningProject, setIsOpeningProject] = useState(false);
	const [loginInitialMode, setLoginInitialMode] = useState<'signin' | 'signup'>('signin');
	const prevProjectRef = useRef<string | null>(null);
	// Guards against concurrent initializeApp invocations (dependency re-runs while async in progress,
	// or React StrictMode double-fire). Without this, openProject can be called twice in parallel.
	const hasStartedInitRef = useRef(false);

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
		import('@tauri-apps/api/core').then(({ invoke }) => {
			invoke('app_ready').catch(() => { /* not running under Tauri */ })
		})
	}, []);


	// Initialize Firebase Auth listener
	useEffect(() => {
		FirebaseAuthService.getInstance().init();
		// Restore persisted sandbox state to Rust backend
		import('./stores/settingsStore').then(({ useSettingsStore }) => {
			const sandboxEnabled = useSettingsStore.getState().sandboxEnabled;
			if (sandboxEnabled) {
				import('@tauri-apps/api/core').then(({ invoke }) => {
					invoke('sandbox_set_enabled', { enabled: true }).catch(() => {});
				});
			}
		});
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
				const projectRoot = commonAncestor(paths)
				const { useProjectStore } = await import('@/stores/projectStore')
				const already = useProjectStore.getState().currentProject?.path
				if (already !== projectRoot) {
					await useProjectStore.getState().openProject(projectRoot)
				}
				const { useEditorRepository } = await import('@/stores/editorStore')
				const repo = useEditorRepository.getState()
				for (const p of paths) repo.openFile(p)
				const { useLayoutStore } = await import('@/stores/layoutStore')
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

			// Read directly from the store — not from the effect closure — to avoid
			// stale values if the store updated between renders and the effect firing.
			const { currentProject: proj, cmdModeProjectPath: cmd, recentProjects: recent, welcomeScreen } = useProjectStore.getState();

			// If the user was explicitly on the Welcome screen last time the app
			// closed, honour that on restart — do NOT auto-open the most recent
			// project. `welcomeScreen === null` means "no Welcome preference yet"
			// (first-ever launch or pre-0.3.0 persisted state), in which case the
			// legacy auto-open-last-project behaviour still applies.
			if (!proj && !cmd && !welcomeScreen && recent.length > 0) {
				const lastProject = recent[0];
				if (lastProject.path) {
					setIsOpeningProject(true);
					try {
						await openProject(lastProject.path);
					} catch (error) {
						logger.error('app', 'Failed to open last project:', error);
					} finally {
						setIsOpeningProject(false);
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

		useChatStore.getState().clearAllSessions();

		const chatStore = useChatStore.getState();
		chatStore.restoreLastSession(projectPath).then(restored => {
			if (!restored) {
				chatStore.createNewSession(projectPath);
			}
		}).catch(err => {
			logger.error('app', 'Failed to restore session:', err);
			chatStore.createNewSession(projectPath);
		});
	}, [currentProject]);

	// Frontend-design tip: when the active project is a frontend type, suggest
	// `#design` once per (session × project). Mirrors claude-vaz's pattern of
	// nudging the user toward the frontend-design plugin without auto-loading
	// it. The skill stays opt-in — this is just discoverability.
	useEffect(() => {
		if (!currentProject?.path) return;
		const pt = currentProject.projectType;
		const FRONTEND_TYPES = new Set(['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt']);
		if (!pt || !FRONTEND_TYPES.has(pt)) return;

		const dedupKey = `design-tip-shown:${currentProject.path}`;
		if (sessionStorage.getItem(dedupKey)) return;
		sessionStorage.setItem(dedupKey, '1');

		// Small delay so the tip lands after the project finishes loading and
		// the chat UI has stabilised — avoids a toast-on-top-of-skeleton flash.
		const timer = setTimeout(() => {
			import('./stores/toastStore').then(({ useToastStore }) => {
				useToastStore.getState().addToast(
					'info',
					t('tip.designHashtag'),
					12000,
				)
			}).catch(() => { /* non-critical */ });
		}, 1500);

		return () => clearTimeout(timer);
	}, [currentProject?.path, currentProject?.projectType]);

	// Check for app updates on startup (non-blocking, 5s delay)
	useEffect(() => {
		if (!isAuthenticated) return;
		autoCheckForUpdate();
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

		function handlePreviewConsole(e: Event) {
			const detail = (e as CustomEvent<{ level: string; text: string }>).detail;
			const { level, text } = detail || { level: '', text: '' };
			if (!text) return;

			useLayoutStore.getState().addDevServerLog(
				`[runtime] ${text}`,
				level === 'warn' ? 'warn' : 'error',
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

			// Load project-specific MCP overrides (without restarting global servers)
			try {
				const mcpService = MCPService.getInstance();
				await mcpService.initialize(projectPath);

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
				logger.warn('app', 'Failed to load project MCP overrides:', error);
			}
		}

		initializeProjectServices();

		return () => {
			cancelled = true;
		};
	}, [currentProject?.path]);

	// Save session on window close (beforeunload fires synchronously but we fire-and-forget the save)
	useEffect(() => {
		const handleBeforeUnload = () => {
			const project = useProjectStore.getState().currentProject;
			if (project) {
				// Force immediate flush — fire-and-forget is acceptable here
				// because Tauri invoke is IPC (not network), it completes fast
				useChatStore.getState().saveSessionToDisk();
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	}, []);

	const handleOpenProject = async (path?: string, options?: { initGit?: boolean }) => {
		if (!path) return;
		// flushSync forces React to paint the spinner BEFORE openProject starts.
		// Without it, React 18 automatic batching groups setIsOpeningProject(true)
		// and setIsOpeningProject(false) into one render — the intermediate spinner
		// state never paints and WelcomeScreen appears frozen.
		flushSync(() => setIsOpeningProject(true));
		try {
			await openProject(path, options);
		} catch (error) {
			logger.error('app', 'Failed to open project:', error);
		} finally {
			setIsOpeningProject(false);
		}
	};

	const handleOnboardingComplete = (action: OnboardingDoneAction) => {
		setLoginInitialMode(action);
	};

	// Show loading state while:
	// - app is bootstrapping (initializing)
	// - Firebase auth is still resolving and we have no persisted auth
	// - a project is actively being opened (prevents WelcomeScreen flash while
	//   openProject is in-flight — both on startup auto-open and manual opens)
	if (initializing || (authLoading && !isAuthenticated) || isOpeningProject) {
		return (
			<Flex
				justify="center"
				align="center"
				height="100vh"
				bg={tokens.colors.bg.welcome}
			>
				<LoadingSpinner size="lg" label="Initializing..." />
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
		return <OnboardingFlow onComplete={handleOnboardingComplete} />;
	}

	// Not authenticated → show login
	if (!isAuthenticated) {
		return <LoginScreen initialMode={loginInitialMode} />;
	}

	// Authenticated but signup not yet complete (mid-phone-link or backend
	// /v1/me reported `signup_incomplete`). Stay on the login surface — the
	// IDE shell must not render until the backend confirms signup is done.
	// `signupComplete === null` means the first /v1/me hasn't returned yet;
	// we wait rather than render the IDE optimistically.
	if (signupComplete !== true) {
		return <LoginScreen initialMode="signup" />;
	}

	return (
		<Box
			bg="#0a0a0a"
			minHeight="100vh"
			position="relative"
		>
			<UpdateBanner />
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
				{currentProject ? <MainLayout /> :
					<WelcomeScreen
						onOpenProject={handleOpenProject}
					/>
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
