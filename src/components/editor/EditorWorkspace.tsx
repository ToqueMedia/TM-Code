import { Suspense, lazy } from 'react'
import { Flex } from '@chakra-ui/react'
import EditorTabs from '../ui/EditorTabs'
import Breadcrumbs from '../ui/Breadcrumbs'
import EditorSkeleton from './EditorSkeleton'
import EditorEmptyState from './EditorEmptyState'
import { showEditorContextMenu } from './EditorContextMenu'
import { logger } from '../../utils/logger'

// Lazy load componentes pesados
const MonacoEditor = lazy(() => import('../ui/MonacoEditor'))

interface EditorWorkspaceProps {
	openFiles: Array<{ path: string; isDirty: boolean }>
	activeFile: string | null
	projectPath: string
	editorRef: React.RefObject<HTMLDivElement | null>
	onSetActiveFile: (file: string) => void
	onCloseFile: (file: string) => void
	onCursorPositionChange: (line: number, column: number) => void
}

const EditorWorkspace: React.FC<EditorWorkspaceProps> = ({
	openFiles,
	activeFile,
	projectPath,
	editorRef,
	onSetActiveFile,
	onCloseFile,
	onCursorPositionChange,
}) => (
	<Flex
		flex="1"
		bg="bg.editor"
		direction="column"
		ref={editorRef}
		minW={0}
	>
		<EditorTabs
			openFiles={openFiles}
			activeFile={activeFile}
			onSetActiveFile={onSetActiveFile}
			onCloseFile={onCloseFile}
		/>

		<Breadcrumbs
			filePath={activeFile || undefined}
			projectRoot={projectPath}
			onNavigate={(path) => logger.debug('editor', 'Navigate to:', path)}
		/>

		<Flex flex="1" overflow="hidden" onContextMenu={(e) => {
			showEditorContextMenu(e, {
				activeFile,
				projectPath,
			})
		}}>
			{activeFile ? (
				<Suspense fallback={<EditorSkeleton />}>
					<MonacoEditor
						key={activeFile || 'no-file'}
						path={activeFile}
						onCursorPositionChange={onCursorPositionChange}
					/>
				</Suspense>
			) : (
				<EditorEmptyState />
			)}
		</Flex>
	</Flex>
)

EditorWorkspace.displayName = 'EditorWorkspace'

export default EditorWorkspace
