// src/App.tsx
import './utils/platformPatches'
import './utils/monacoEnv'
import WelcomeScreen from './components/WelcomeScreen';
import MainLayout from './components/MainLayout';
import LoginScreen from './components/auth/LoginScreen';
import { useProjectStore } from './stores/projectStore';
import { useAuthStore } from './stores/authStore';
import { useChatStore } from './stores/chatStore';
import FirebaseAuthService from './services/auth/firebaseAuth';
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
	}, [authLoading, isAuthenticated, currentProject, openProject, recentProjects]);

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
		<Box>
			{currentProject ? <MainLayout /> :
				<WelcomeScreen
					onOpenProject={handleOpenProject}
				/>
			}

			<ToastContainer />
		</Box>
	);
}

export default App;
