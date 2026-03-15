import { useState, useRef } from 'react'
import { createListCollection } from '@chakra-ui/react'
import { useProjectStore } from '../../stores/projectStore'
import { ProjectTemplate } from '../../types/project'
import { open } from '@tauri-apps/plugin-dialog'
import { ProjectValidator } from '../../utils/projectValidator'
import { logger } from '../../utils/logger'

export const templateCollection = createListCollection({
  items: [
    { label: 'Blank Project', value: ProjectTemplate.Blank },
    { label: 'React Project', value: ProjectTemplate.React },
    { label: 'Node.js Project', value: ProjectTemplate.Node },
    { label: 'TypeScript Project', value: ProjectTemplate.TypeScript },
    { label: 'Vue.js Project', value: ProjectTemplate.Vue },
    { label: 'Python Project', value: ProjectTemplate.Python },
    { label: 'Rust Project', value: ProjectTemplate.Rust },
  ],
})

export function useNewProjectDialog(onClose: () => void) {
  const [projectName, setProjectName] = useState('')
  const [template, setTemplate] = useState(ProjectTemplate.Blank)
  const [location, setLocation] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { createProject } = useProjectStore()

  const handleSubmit = async () => {
    if (!projectName.trim()) {
      setError('Project name is required')
      return
    }

    if (!location.trim()) {
      setError('Project location is required')
      return
    }

    setIsLoading(true)
    setError('')

    try {
      // Validate project name
      const nameValidation = await ProjectValidator.validateProjectName(projectName)
      if (!nameValidation.valid) {
        setError(nameValidation.error || 'Invalid project name')
        setIsLoading(false)
        return
      }

      // Validate project location
      const locationValidation = await ProjectValidator.validateProjectLocation(location)
      if (!locationValidation.valid) {
        setError(locationValidation.error || 'Invalid project location')
        setIsLoading(false)
        return
      }

      // Create the project path
      const projectPath = `${location}/${projectName}`

      await createProject(projectPath, template)
      onClose()
      setProjectName('')
      setTemplate(ProjectTemplate.Blank)
      setLocation('')
      setError('')
    } catch (error: unknown) {
      logger.error('ui', 'Failed to create project:', error)
      setError((error as Error).message || 'Failed to create project. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleBrowse = async () => {
    try {
      // Check if we're in a Tauri context
      if (typeof window !== 'undefined' && '__TAURI__' in window) {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select project location',
        })
        if (selected) {
          setLocation(selected as string)
        }
      } else {
        // Fallback for web development - trigger file input
        fileInputRef.current?.click()
      }
    } catch (error) {
      logger.error('ui', 'Failed to open directory dialog:', error)
    }
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setError('Full directory access is only available in the desktop app. Please enter the path manually.')
    }
  }

  return {
    projectName,
    setProjectName,
    template,
    setTemplate,
    location,
    setLocation,
    isLoading,
    error,
    fileInputRef,
    handleSubmit,
    handleBrowse,
    handleFileInputChange,
  }
}
