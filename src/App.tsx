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
import ToolExecutor from './services/agent/toolExecutor';
import AgentService from './services/agent/agentService';
import { autoCheckForUpdate } from './services/updateService';
import { checkStartupRequirements, GLOBAL_REQUIREMENTS } from './services/startupRequirements';
import type { EnvironmentCheckResult } from './services/environmentCheck';
import { useUpdateStore } from './stores/updateStore';
import { useLayoutStore } from './stores/layoutStore';
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
import { tokens } from '@/theme/tokens';

// Debug helper — timestamps relative to app start
const _t0 = performance.now()
const _ts = () => `+${(performance.now() - _t0).toFixed(0)}ms`

function App() {
	const { currentProject, openProject, hasHydrated } = useProjectStore();
	const { isAuthenticated, isLoading: authLoading } = useAuthStore();
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
	const renderCountRef = useRef(0);

	// ── DEBUG: log every render with key state ──────────────────────────────
	renderCountRef.current++;
	if (import.meta.env.DEV) {
		const view = (initializing || isOpeningProject) ? 'SPINNER' : !isAuthenticated ? 'LOGIN' : currentProject ? 'MAINLAYOUT' : 'WELCOMESCREEN';
		console.log(
			`%c[App #${renderCountRef.current}] ${_ts()} view=${view}`,
			'color:#fe1063;font-weight:bold',
			{ initializing, isOpeningProject, currentProject: currentProject?.name ?? null, hasHydrated, authLoading, isAuthenticated },
		);
	}
	// ────────────────────────────────────────────────────────────────────────

	const handleRetryRequirements = useCallback(async () => {
		const result = await checkStartupRequirements(true);
		setRequirementsResult(result);
	}, []);

	// Set up keyboard shortcuts + native macOS menu handler
	useKeyboardShortcuts();
	useNativeMenu();
	// Refresh billing state on window focus / network reconnect (no polling)
	useBillingRefresh();

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

	useEffect(() => {
		if (import.meta.env.DEV) console.log(`%c[initEffect] ${_ts()} fired`, 'color:#a371f7', { initializing, hasHydrated, authLoading, isAuthenticated, hasStarted: hasStartedInitRef.current });

		// Only auto-open during initial app load, not on subsequent state changes
		// (e.g. after project deletion sets currentProject to null)
		if (!initializing) return;

		// Wait for store hydration
		if (!hasHydrated) { if (import.meta.env.DEV) console.log(`[initEffect] ${_ts()} waiting for hydration`); return; }

		// Don't block on Firebase when persisted state already shows authenticated.
		// Firebase resolves onAuthStateChanged asynchronously — if emulators are
		// not running or there's no network, this can take 2+ minutes.
		// If isAuthenticated is already true from the persisted store, proceed
		// immediately. Firebase will update auth state in the background.
		if (authLoading && !isAuthenticated) { if (import.meta.env.DEV) console.log(`[initEffect] ${_ts()} waiting for auth`); return; }

		// Prevent concurrent invocations: openProject updating the Zustand store
		// (currentProject, recentProjects) triggers this effect to re-run while the
		// first async call is still in progress. The ref ensures we only start once.
		if (hasStartedInitRef.current) { if (import.meta.env.DEV) console.log(`[initEffect] ${_ts()} already started, skipping`); return; }
		hasStartedInitRef.current = true;

		const initializeApp = async () => {
			if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} start requirements check`);
			
			// MANDATORY: Check global prerequisites before anything else
			const requirements = await checkStartupRequirements();
			setRequirementsResult(requirements);

			// Determine if we should block based on mandatory requirements
			const hasMissingMandatory = GLOBAL_REQUIREMENTS.some(req => {
				if (!req.mandatory) return false;
				const status = requirements?.requirements?.[req.name];
				return !status || !status.met;
			});

			if (hasMissingMandatory) {
				if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} missing mandatory requirements, blocking`);
				setInitializing(false);
				return;
			}

			// If not authenticated, stop initializing after requirements check
			if (!isAuthenticated) {
				if (import.meta.env.DEV) console.log(`[initEffect] ${_ts()} not authenticated → setInitializing(false)`);
				setInitializing(false);
				return;
			}

			// Read directly from the store — not from the effect closure — to avoid
			// stale values if the store updated between renders and the effect firing.
			const { currentProject: proj, cmdModeProjectPath: cmd, recentProjects: recent } = useProjectStore.getState();

			if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} start project recovery`, { proj: proj?.name ?? null, cmd, recentCount: recent.length });

			if (!proj && !cmd && recent.length > 0) {
				const lastProject = recent[0];
				if (lastProject.path) {
					setIsOpeningProject(true);
					try {
						if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} calling openProject("${lastProject.path}")`);
						await openProject(lastProject.path);
						if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} openProject resolved, store.currentProject=`, useProjectStore.getState().currentProject?.name ?? null);
					} catch (error) {
						if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} openProject THREW:`, error);
						logger.error('app', 'Failed to open last project:', error);
					} finally {
						setIsOpeningProject(false);
					}
				}
			}
			// Unblock after openProject so the spinner covers the transition.
			if (import.meta.env.DEV) console.log(`[initializeApp] ${_ts()} calling setInitializing(false), store.currentProject=`, useProjectStore.getState().currentProject?.name ?? null);
			setInitializing(false);
		};

		initializeApp();
	}, [authLoading, isAuthenticated, initializing, hasHydrated, openProject]);

	// Restore session when project changes
	useEffect(() => {
		if (!currentProject) {
			prevProjectRef.current = null;
			return;
		}

		const projectPath = currentProject.path;
		if (projectPath === prevProjectRef.current) return;

		// Save previous project's session before switching (sync-safe: app is still running)
		const prevPath = prevProjectRef.current;
		if (prevPath) {
			useChatStore.getState().cleanupOnExit(prevPath);
		}

		prevProjectRef.current = projectPath;

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
	useEffect(() => {
		function handlePreviewConsole(e: Event) {
			const { level, text } = (e as CustomEvent<{ level: string; text: string }>).detail;
			if (text) {
				useLayoutStore.getState().addDevServerLog(
					`[runtime] ${text}`,
					level === 'warn' ? 'warn' : 'error',
				);
			}
		}
		window.addEventListener('preview-console', handlePreviewConsole);
		return () => window.removeEventListener('preview-console', handlePreviewConsole);
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
						toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
							mcpService.callTool(serverName, toolName, args)
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
						toolExecutor.registerMCPTools(mcpTools, (serverName, toolName, args) =>
							mcpService.callTool(serverName, toolName, args)
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
		</Box>
	);
}

export default App;
