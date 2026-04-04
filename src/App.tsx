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
import { useLayoutStore } from './stores/layoutStore';
import { logger } from './utils/logger';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNativeMenu } from './hooks/useNativeMenu';
import { useEffect, useRef, useState } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { LoadingSpinner } from './components/ui/LoadingSpinner';
import { ToastContainer } from './components/ui/Toast';
import { tokens } from '@/theme/tokens';

function App() {
	const { currentProject, openProject, recentProjects } = useProjectStore();
	const { isAuthenticated, isLoading: authLoading } = useAuthStore();
	const hasCompletedOnboarding = useSettingsStore(s => s.hasCompletedOnboarding);
	const [initializing, setInitializing] = useState(true);
	const [loginInitialMode, setLoginInitialMode] = useState<'signin' | 'signup'>('signin');
	const prevProjectRef = useRef<string | null>(null);

	// Set up keyboard shortcuts + native macOS menu handler
	useKeyboardShortcuts();
	useNativeMenu();

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
		// Only auto-open during initial app load, not on subsequent state changes
		// (e.g. after project deletion sets currentProject to null)
		if (!initializing) return;

		// Wait for auth to resolve before trying to auto-open project
		if (authLoading) return;

		// If not authenticated, stop initializing
		if (!isAuthenticated) {
			setInitializing(false);
			return;
		}

		const initializeApp = async () => {
			if (!currentProject && recentProjects.length > 0) {
				const lastProject = recentProjects[0];
				if (lastProject.path) {
					try {
						await openProject(lastProject.path);
					} catch (error) {
						logger.error('app', 'Failed to open last project:', error);
					}
				}
			}
			setInitializing(false);
		};

		initializeApp();
	}, [authLoading, isAuthenticated, initializing, currentProject, openProject, recentProjects]);

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

	const handleOpenProject = (path?: string, options?: { initGit?: boolean }) => {
		if (path) {
			openProject(path, options);
		}
	};

	const handleOnboardingComplete = (action: OnboardingDoneAction) => {
		setLoginInitialMode(action);
	};

	// Show loading state while auth or app is initializing
	if (authLoading || initializing) {
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
