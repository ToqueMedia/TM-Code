// src/App.tsx
import './utils/platformPatches'
import WelcomeScreen from './components/WelcomeScreen';
import CodeEditorNew from './components/CodeEditorNew';
import CodeEditorSimple from './components/CodeEditorSimple';
import { useProjectStore } from './stores/projectStore';
import { NewProjectDialog } from './components/dialogs/NewProjectDialog';
import { useDialog } from './hooks/useDialog';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useEffect, useState } from 'react';

function App() {
  const { currentProject, openProject, recentProjects } = useProjectStore();
  const newProjectDialog = useDialog();
  const [initializing, setInitializing] = useState(true);
  
  // Set up keyboard shortcuts
  useKeyboardShortcuts();

  useEffect(() => {
    // Check if there's a recent project to open automatically
    const initializeApp = async () => {
      if (!currentProject && recentProjects.length > 0) {
        // Try to open the most recent project
        const lastProject = recentProjects[0];
        if (lastProject.path) {
          try {
            await openProject(lastProject.path);
          } catch (error) {
            console.error('Failed to open last project:', error);
          }
        }
      }
      setInitializing(false);
    };

    initializeApp();
  }, [currentProject, openProject, recentProjects]);

  const handleOpenProject = (path?: string) => {
    if (path) {
      openProject(path);
    }
  };

  // Show loading state while initializing
  if (initializing) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        backgroundColor: '#0a0e13',
        color: '#e6edf3'
      }}>
        Initializing...
      </div>
    );
  }

  // Use simplified editor if URL has ?debug=simple
  const urlParams = new URLSearchParams(window.location.search);
  const useSimpleEditor = urlParams.get('debug') === 'simple';

  return (
    <>
      {currentProject ? (
        useSimpleEditor ? <CodeEditorSimple /> : <CodeEditorNew />
      ) : (
        <WelcomeScreen 
          onOpenProject={handleOpenProject}
          onCreateProject={newProjectDialog.open}
        />
      )}
      
      <NewProjectDialog 
        isOpen={newProjectDialog.isOpen}
        onClose={newProjectDialog.close}
      />
    </>
  );
}

export default App;