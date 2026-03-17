// src/App.tsx
import './utils/platformPatches'
import './utils/monacoEnv'
import WelcomeScreen from './components/WelcomeScreen';
import MainLayout from './components/MainLayout';
import LoginScreen from './components/auth/LoginScreen';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore } from './stores/authStore';
import { useChatStore } from './stores/chatStore';
import { useSkillStore } from './stores/skillStore';
import FirebaseAuthService from './services/auth/firebaseAuth';
import SkillService from './services/agent/skillService';
import MCPService from './services/mcp/mcpService';
import ToolExecutor from './services/agent/toolExecutor';
import AgentService from './services/agent/agentService';
import { logger } from './utils/logger';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useEffect, useRef, useState } from 'react';
import { Box, Flex } from '@chakra-ui/react';
import { LoadingSpinner } from './components/ui/LoadingSpinner';
import { ToastContainer } from './components/ui/Toast';
import { tokens } from '@/theme/tokens';

function App() {
	const { currentProject, openProject, recentProjects } = useProjectStore();
	const { isAuthenticated, isLoading: authLoading } = useAuthStore();
	const [initializing, setInitializing] = useState(true);
	const prevProjectRef = useRef<string | null>(null);

	// Set up keyboard shortcuts
	useKeyboardShortcuts();

	// Initialize Firebase Auth listener
	useEffect(() => {
		FirebaseAuthService.getInstance().init();
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

	// Initialize MCP servers and preload skills when project changes
	useEffect(() => {
		if (!currentProject?.path) return;

		const projectPath = currentProject.path;
		let cancelled = false;

		async function initializeServices() {
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

			// Initialize MCP servers from config
			try {
				const mcpService = MCPService.getInstance();
				await mcpService.initialize(projectPath);

				if (!cancelled) {
					// Register MCP tools with the agent's tool executor
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

		initializeServices();

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

	const handleOpenProject = (path?: string) => {
		if (path) {
			openProject(path);
		}
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

	// Not authenticated → show login
	if (!isAuthenticated) {
		return <LoginScreen />;
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
