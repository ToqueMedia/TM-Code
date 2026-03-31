import React, { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { VscSymbolFile } from 'react-icons/vsc'
import { Reorder } from 'framer-motion'
import EditorTab from './EditorTab'
import { useEditorRepository } from '../../stores/editorStore'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface EditorTabsProps {
	openFiles: Array<{ path: string; isDirty: boolean; isPreview?: boolean }>
	activeFile: string | null
	onSetActiveFile: (path: string) => void
	onCloseFile: (path: string, e: React.MouseEvent) => void
	onReorderFiles: (newOrder: string[]) => void
}

const EditorTabs = memo<EditorTabsProps>(({ openFiles, activeFile, onSetActiveFile, onCloseFile, onReorderFiles }) => {
	const externalPaths = openFiles.map(f => f.path)

	// Local order state — Reorder.Group mutates this on every drag frame.
	// We only commit to the Zustand store when the drag ends.
	const [localOrder, setLocalOrder] = useState(externalPaths)
	const isDraggingRef = useRef(false)
	const localOrderRef = useRef(localOrder)
	localOrderRef.current = localOrder

	// Sync local order when external state changes (e.g. new tab opened, tab closed)
	// but NOT while the user is dragging
	useEffect(() => {
		if (!isDraggingRef.current) {
			setLocalOrder(externalPaths)
		}
	}, [externalPaths.join('\n')])

	const handleDragStart = useCallback(() => {
		isDraggingRef.current = true
	}, [])

	const handleDragEnd = useCallback(() => {
		isDraggingRef.current = false
		// Commit the final order to the store
		onReorderFiles(localOrderRef.current)
		// Force sync back from store after a tick (handles validation rejection)
		requestAnimationFrame(() => {
			if (!isDraggingRef.current) {
				setLocalOrder(openFiles.map(f => f.path))
			}
		})
	}, [onReorderFiles, openFiles])

	// Build file map for quick lookup
	const fileMap = new Map(openFiles.map(f => [f.path, f]))

	// Derive render order: localOrder filtered to valid paths + any new external paths appended
	// useMemo with stable deps so Reorder.Group doesn't reset animations on every render
	const externalKey = externalPaths.join('\n')
	const localKey = localOrder.join('\n')
	const renderOrder = useMemo(() => {
		const validSet = new Set(externalPaths)
		const valid = localOrder.filter(p => validSet.has(p))
		const resultSet = new Set(valid)
		for (const p of externalPaths) {
			if (!resultSet.has(p)) { valid.push(p); resultSet.add(p) }
		}
		return valid
	}, [externalKey, localKey]) // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<Flex
			bg={tokens.colors.bg.panel}
			position="relative"
			h="auto"
			overflowX="auto"
			overflowY="hidden"
			css={{
				'&::-webkit-scrollbar': { height: '0px' },
				scrollbarWidth: 'none',
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				const target = (e.target as HTMLElement).closest('[data-path]') as HTMLElement | null
				const path = target?.getAttribute('data-path') || activeFile || null
				window.dispatchEvent(new CustomEvent('tabs:contextmenu:open', { detail: { x: e.clientX, y: e.clientY, path } }))
			}}
		>
			{openFiles.length > 0 ? (
				<Reorder.Group
					axis="x"
					values={renderOrder}
					onReorder={setLocalOrder}
					style={{
						display: 'flex',
						listStyle: 'none',
						margin: 0,
						padding: 0,
						alignItems: 'center',
					}}
				>
					{renderOrder.map((path) => {
						const file = fileMap.get(path)!
						return (
							<EditorTab
								key={path}
								path={path}
								name={path.split('/').pop() || 'Untitled'}
								isDirty={file.isDirty}
								isActive={activeFile === path}
								isPreview={file.isPreview}
								onClick={() => onSetActiveFile(path)}
								onDoubleClick={() => {
									const { pinFile } = useEditorRepository.getState()
									pinFile(path)
								}}
								onClose={(e) => onCloseFile(path, e)}
								onDragStart={handleDragStart}
								onDragEnd={handleDragEnd}
							/>
						)
					})}
				</Reorder.Group>
			) : (
				<Flex
					alignItems="center"
					justifyContent="center"
					gap={2}
					flex="1"
					color={tokens.colors.text.muted}
					fontSize="12px"
					height="30px"
				>
					<VscSymbolFile size={11} />
					<Text fontSize="11px">{t("explorer.noOpenTabs")}</Text>
				</Flex>
			)}
		</Flex>
	)
})

EditorTabs.displayName = 'EditorTabs'

export default EditorTabs
