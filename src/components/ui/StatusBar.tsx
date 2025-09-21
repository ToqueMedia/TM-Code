import React, { memo, Suspense } from 'react'
import { Flex, Text, Box, Separator, Menu, HStack } from '@chakra-ui/react'
import { FiGitBranch, FiAlertCircle, FiChevronDown, FiCode } from 'react-icons/fi'
import { useEditorRepository } from '../../stores/editorStore'
import MonacoBridge from '../../utils/monacoBridge'

// Lazy load PerformanceStatus
const PerformanceStatus = React.lazy(() => import('./PerformanceStatus'))

// Status bar item component - Enhanced with animations
const StatusBarItem = memo<{ children: React.ReactNode; tooltip?: string }>(({ 
	children, 
	tooltip 
}) => (
	<Box
		px={3}
		py={1}
		fontSize="xs"
		fontWeight="medium"
		cursor="pointer"
		position="relative"
		_hover={{
			bg: 'whiteAlpha.100',
			transform: 'translateY(-1px)',
			_after: {
				opacity: 1,
				transform: 'scaleX(1)',
			}
		}}
		transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
		display="flex"
		alignItems="center"
		gap={1}
		title={tooltip}
		_after={{
			content: '""',
			position: 'absolute',
			bottom: 0,
			left: '50%',
			transform: 'translateX(-50%) scaleX(0)',
			width: '80%',
			height: '2px',
			bg: 'blue.400',
			opacity: 0,
			transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
		}}
	>
		{children}
	</Box>
))

StatusBarItem.displayName = 'StatusBarItem'

interface StatusBarProps {
	currentProject: { name: string; path: string } | null
	activeFile: string | null
	openFiles: Array<{ path: string; language: string; isDirty: boolean }>
	cursorPosition: { line: number; column: number }
	languages: string[]
	tabSizeSetting: number
	insertSpacesSetting: boolean
	detectIndentationSetting: boolean
	setTabSizeSetting: (size: number) => void
	setInsertSpacesSetting: (value: boolean) => void
	setDetectIndentationSetting: (value: boolean) => void
}

const StatusBar = memo<StatusBarProps>(({
	currentProject,
	activeFile,
	openFiles,
	cursorPosition,
	languages,
	tabSizeSetting,
	insertSpacesSetting,
	detectIndentationSetting,
	setTabSizeSetting,
	setInsertSpacesSetting,
	setDetectIndentationSetting
}) => {
	// Apply indentation immediately to current editor model
	function applyIndentationNow(tabSize: number, insertSpaces: boolean, detect: boolean): void {
		try {
			const editor = MonacoBridge.getInstance().getCurrentEditor()
			if (!editor) return
			editor.updateOptions({ tabSize, insertSpaces })
			// Update active model
			// @ts-ignore - types are available at runtime
			const model = editor.getModel?.()
			if (model) {
				if (detect) {
					// @ts-ignore
					model.detectIndentation(insertSpaces, tabSize)
				} else {
					model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces })
				}
			}
		} catch { }
	}

	return (
		<Flex
			height="26px"
			bg="#0f172a"
			color="#e2e8f0"
			alignItems="center"
			fontSize="xs"
			fontWeight="medium"
			px={6}
			gap={2}
			borderTop="1px solid #1e293b"
			boxShadow="inset 0 1px 0 rgba(255,255,255,0.03)"
			letterSpacing="0.02em"
			userSelect="none"
		>
			<HStack gap={0} height="100%">
				<StatusBarItem tooltip="Git branch">
					<FiGitBranch size={12} />
					<Text>main</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				{/* Language picker */}
				<Box position="relative">
					<Menu.Root>
						<Menu.Trigger asChild>
							<Box as="button"
								px={3}
								py={1}
								fontSize="xs"
								display="flex"
								alignItems="center"
								gap={1}
								_hover={{ bg: 'whiteAlpha.100' }}
								borderRadius="4px"
								title="Change language"
							>
								<FiCode size={12} />
								<Text>{(() => {
									const file = openFiles.find(f => f.path === activeFile)
									return file?.language ? file.language : 'Plain Text'
								})()}</Text>
							</Box>
						</Menu.Trigger>
						<Menu.Positioner>
							<Menu.Content>
								{['plaintext', 'typescript', 'javascript', 'json', 'html', 'css', 'scss', 'markdown', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'php', 'sql'].map(function (lang) {
									return (
										<Menu.Item value={lang} key={lang} onClick={async function () {
											if (!activeFile) return
											try {
												const monaco = await import('monaco-editor')
												const model = monaco.editor.getModel(monaco.Uri.file(activeFile))
												if (model) {
													monaco.editor.setModelLanguage(model, lang as any)
													// persist in store
													useEditorRepository.getState().updateEditorState(activeFile, { language: lang })
												}
											} catch { }
										}}>{lang}</Menu.Item>
									)
								})}
							</Menu.Content>
						</Menu.Positioner>
					</Menu.Root>
				</Box>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Line and column">
					<Text>Ln {cursorPosition.line}, Col {cursorPosition.column}</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				{/* Indentation status */}
				<Box position="relative">
					<Menu.Root>
						<Menu.Trigger asChild>
							<Box as="button"
								px={3}
								py={1}
								fontSize="xs"
								display="flex"
								alignItems="center"
								gap={1}
								_hover={{ bg: 'whiteAlpha.100' }}
								borderRadius="4px"
								title="Change indentation"
								cursor="pointer"
							>
								<Text>{insertSpacesSetting ? 'Spaces' : 'Tabs'}: {tabSizeSetting}</Text>
								<FiChevronDown size={12} />
							</Box>
						</Menu.Trigger>
						<Menu.Positioner>
							<Menu.Content bg="#1e1e1e" border="1px solid #2b2b2c">
								<Menu.Item value="indent-spaces" onClick={function () {
									setDetectIndentationSetting(false)
									setInsertSpacesSetting(true)
									applyIndentationNow(tabSizeSetting, true, false)
								}}>Indent Using Spaces</Menu.Item>
								<Menu.Item value="indent-tabs" onClick={function () {
									setDetectIndentationSetting(false)
									setInsertSpacesSetting(false)
									applyIndentationNow(tabSizeSetting, false, false)
								}}>Indent Using Tabs</Menu.Item>
								<Menu.Separator />
								<Menu.Item value="tab-2" onClick={function () {
									setDetectIndentationSetting(false)
									setTabSizeSetting(2)
									applyIndentationNow(2, insertSpacesSetting, false)
								}}>Tab Size: 2</Menu.Item>
								<Menu.Item value="tab-4" onClick={function () {
									setDetectIndentationSetting(false)
									setTabSizeSetting(4)
									applyIndentationNow(4, insertSpacesSetting, false)
								}}>Tab Size: 4</Menu.Item>
								<Menu.Item value="tab-8" onClick={function () {
									setDetectIndentationSetting(false)
									setTabSizeSetting(8)
									applyIndentationNow(8, insertSpacesSetting, false)
								}}>Tab Size: 8</Menu.Item>
								<Menu.Separator />
								<Menu.Item value="detect-toggle" onClick={function () {
									const next = !detectIndentationSetting
									setDetectIndentationSetting(next)
									applyIndentationNow(tabSizeSetting, insertSpacesSetting, next)
								}}>
									{detectIndentationSetting ? '✓ Detect Indentation' : 'Detect Indentation (Off)'}
								</Menu.Item>
								<Menu.Separator />
								<Menu.Item value="convert-spaces" onClick={function () {
									try {
										const editor = MonacoBridge.getInstance().getCurrentEditor()
										if (!editor) return
										const model = editor.getModel?.()
										const tabSize = tabSizeSetting
										if (!model) return
										const edits: any[] = []
										const lineCount = model.getLineCount()
										for (let i = 1; i <= lineCount; i++) {
											const content = model.getLineContent(i)
											let firstCol = model.getLineFirstNonWhitespaceColumn(i)
											if (firstCol === 0) firstCol = content.length + 1
											const indent = content.slice(0, Math.max(0, firstCol - 1))
											const desired = indent.replace(/\t/g, ' '.repeat(tabSize))
											if (indent !== desired) {
												edits.push({
													range: { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: firstCol },
													text: desired,
												})
											}
										}
										if (edits.length > 0) {
											editor.pushUndoStop()
											editor.executeEdits('indent-convert-spaces', edits)
											editor.pushUndoStop()
										}
										setDetectIndentationSetting(false)
										setInsertSpacesSetting(true)
										applyIndentationNow(tabSize, true, false)
									} catch { }
								}}>Convert Indentation to Spaces</Menu.Item>
								<Menu.Item value="convert-tabs" onClick={function () {
									try {
										const editor = MonacoBridge.getInstance().getCurrentEditor()
										if (!editor) return
										const model = editor.getModel?.()
										const tabSize = tabSizeSetting
										if (!model) return
										const edits: any[] = []
										const lineCount = model.getLineCount()
										const spaces = ' '.repeat(tabSize)
										for (let i = 1; i <= lineCount; i++) {
											const content = model.getLineContent(i)
											let firstCol = model.getLineFirstNonWhitespaceColumn(i)
											if (firstCol === 0) firstCol = content.length + 1
											const indent = content.slice(0, Math.max(0, firstCol - 1))
											// Replace groups of spaces equal to tab size with tabs
											let desired = indent
											if (spaces.length > 0) {
												const re = new RegExp(spaces, 'g')
												desired = indent.replace(re, '\t')
											}
											if (indent !== desired) {
												edits.push({
													range: { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: firstCol },
													text: desired,
												})
											}
										}
										if (edits.length > 0) {
											editor.pushUndoStop()
											editor.executeEdits('indent-convert-tabs', edits)
											editor.pushUndoStop()
										}
										setDetectIndentationSetting(false)
										setInsertSpacesSetting(false)
										applyIndentationNow(tabSize, false, false)
									} catch { }
								}}>Convert Indentation to Tabs</Menu.Item>
							</Menu.Content>
						</Menu.Positioner>
					</Menu.Root>
				</Box>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Encoding">
					<Text>UTF-8</Text>
				</StatusBarItem>
			</HStack>

			<HStack gap={0} height="100%" marginLeft="auto">
				<Suspense fallback={null}>
					<PerformanceStatus compact />
				</Suspense>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Errors and warnings">
					<FiAlertCircle size={12} />
					<Text>0</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Monaco languages supported">
					<Text>Langs: {languages.length}</Text>
				</StatusBarItem>

				<Separator orientation="vertical" height="16px" mx={2} />

				<StatusBarItem tooltip="Current project">
					<Text>{currentProject?.name}</Text>
				</StatusBarItem>
			</HStack>
		</Flex>
	)
})

StatusBar.displayName = 'StatusBar'

export default StatusBar