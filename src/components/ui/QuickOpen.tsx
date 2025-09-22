import React, { useRef } from 'react'
import { Box, Input, Text } from '@chakra-ui/react'
import type { QuickOpenItem } from '../../services/quickOpenService'

interface QuickOpenProps {
	query: string
	focused: boolean
	highlightIndex: number
	visibleResults: QuickOpenItem[]
	onQueryChange: (e: React.ChangeEvent<HTMLInputElement>) => void
	onInputFocus: () => void
	onInputBlur: (e: React.FocusEvent<HTMLInputElement>) => void
	onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
	onOpenPath: (path: string) => void
	placeholder: string
}

const QuickOpen = ({ 
	query, 
	focused, 
	highlightIndex, 
	visibleResults,
	onQueryChange, 
	onInputFocus, 
	onInputBlur, 
	onKeyDown, 
	onOpenPath,
	placeholder
}: QuickOpenProps) => {
	const searchRef = useRef<HTMLInputElement | null>(null)

	return (
		<Box position="relative" width="60%" minW="320px">
			<Input
				ref={searchRef}
				type="search"
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				h={'24px'}
				borderRadius={'6px'}
				outline={'none'}
				enterKeyHint="search"
				value={query}
				onChange={onQueryChange}
				onFocus={onInputFocus}
				onBlur={onInputBlur}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				size="sm"
				bg="#1e1e1e"
				borderColor="#3c3c3c"
				color="#e6edf3"
				_focus={{ borderColor: '#58a6ff', boxShadow: '0 0 0 2px rgba(88, 166, 255, 0.3)' }}
				className="no-drag"
			/>
			{focused && query.trim().length > 0 && visibleResults.length > 0 && (
				<Box
					position="absolute"
					top="32px"
					left={0}
					right={0}
					bg="#2d2d30"
					border="1px solid #3c3c3c"
					borderRadius="6px"
					zIndex={20}
					maxH="300px"
					overflowY="auto"
					className="no-drag"
				>
					{visibleResults.map(function item(node: QuickOpenItem, idx: number) {
						const isActive = idx === highlightIndex
						return (
							<Box
								key={node.path}
								data-quick-open-item="true"
								role="button"
								tabIndex={0}
								px={3}
								py={2}
								cursor="pointer"
								bg={isActive ? '#094771' : 'transparent'}
								_hover={{ bg: '#094771' }}
								onMouseDown={function md(e) { e.preventDefault() }}
								onClick={function onClick() { onOpenPath(node.path) }}
							>
								<Text fontSize="sm" color="#e6edf3">{node.name}</Text>
								<Text fontSize="xs" color="#858585">{node.path}</Text>
							</Box>
						)
					})}
				</Box>
			)}
		</Box>
	)
}

export default QuickOpen