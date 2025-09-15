// src/App.tsx
import React from 'react'
import { Provider } from '@/components/ui/provider'
import WelcomeScreen from './components/WelcomeScreen'
import Editor from './components/Editor'

const App: React.FC = () => {
  const [currentProject, setCurrentProject] = React.useState<{name: string, file: string} | null>(null)

  const handleOpenProject = () => {
    // In a real implementation, this would open a file picker dialog
    // For demonstration purposes, we'll just set a mock project
    setCurrentProject({
      name: 'Discord Bot API',
      file: 'bot.py'
    })
  }

  const handleCreateProject = (projectData: any) => {
    // In a real implementation, this would create a new project
    // For demonstration purposes, we'll just set a mock project
    setCurrentProject({
      name: projectData.name || 'New Project',
      file: 'index.ts'
    })
  }

  return (
    <Provider>
      {currentProject ? (
        <Editor 
          projectName={currentProject.name} 
          fileName={currentProject.file} 
          filePath={`~/Projects/${currentProject.name}/${currentProject.file}`}
        />
      ) : (
        <WelcomeScreen 
          onOpenProject={handleOpenProject} 
          onCreateProject={handleCreateProject} 
        />
      )}
    </Provider>
  )
}

export default App