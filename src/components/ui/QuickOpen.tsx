import React, { useRef } from 'react'
import { Box, Input, Text } from '@chakra-ui/react'
import type { QuickOpenItem } from '../../services/quickOpenService'
import { tokens } from '@/theme/tokens'

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
				bg={tokens.colors.bg.app}
				borderColor={tokens.colors.border.default}
				color={tokens.colors.text.primary}
				_focus={{ borderColor: tokens.colors.border.focus }}
				className="no-drag"
			/>
			{focused && query.trim().length > 0 && visibleResults.length > 0 && (
				<Box
					position="absolute"
					top="32px"
					left={0}
					right={0}
					bg={tokens.colors.bg.overlay}
					border={`1px solid ${tokens.colors.border.default}`}
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
								bg={isActive ? tokens.colors.bg.hover : 'transparent'}
								_hover={{ bg: tokens.colors.bg.hover }}
								onMouseDown={function md(e) { e.preventDefault() }}
								onClick={function onClick() { onOpenPath(node.path) }}
							>
								<Text fontSize="sm" color={tokens.colors.text.primary}>{node.name}</Text>
								<Text fontSize="xs" color={tokens.colors.text.subtle}>{node.path}</Text>
							</Box>
						)
					})}
				</Box>
			)}
		</Box>
	)
}

export default QuickOpen
