import React, { useRef } from 'react'
import { Box, Input, Text, HStack } from '@chakra-ui/react'
import { FiSearch, FiFile } from 'react-icons/fi'
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
		<Box position="relative" width="55%" minW="280px" maxW="560px">
			<Box position="relative">
				<Box
					position="absolute"
					left="8px"
					top="50%"
					transform="translateY(-50%)"
					zIndex={1}
					pointerEvents="none"
				>
					<FiSearch size={12} color={tokens.colors.text.muted} />
				</Box>
				<Input
					ref={searchRef}
					type="search"
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					h="26px"
					borderRadius="6px"
					enterKeyHint="search"
					value={query}
					onChange={onQueryChange}
					onFocus={onInputFocus}
					onBlur={onInputBlur}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					size="sm"
					fontSize="12px"
					bg={tokens.colors.bg.input}
					border={`1px solid ${focused ? tokens.colors.accent.primaryBorder : tokens.colors.border.glass}`}
					color={tokens.colors.text.primary}
					pl="28px"
					_focus={{
						borderColor: tokens.colors.accent.primaryBorder,
						boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
					}}
					_placeholder={{ color: tokens.colors.text.hint, fontSize: '12px' }}
					transition={`all ${tokens.transition.normal}`}
					className="no-drag"
				/>
			</Box>
			{focused && query.trim().length > 0 && visibleResults.length > 0 && (
				<Box
					position="absolute"
					top="34px"
					left={0}
					right={0}
					bg={tokens.colors.bg.overlay}
					border={`1px solid ${tokens.colors.border.panel}`}
					borderRadius="8px"
					zIndex={20}
					maxH="320px"
					overflowY="auto"
					boxShadow={tokens.shadow.overlay}
					className="no-drag"
					py={1}
					css={{
						'&::-webkit-scrollbar': { width: '4px' },
						'&::-webkit-scrollbar-track': { background: 'transparent' },
						'&::-webkit-scrollbar-thumb': {
							background: tokens.colors.scrollbar.thumb,
							borderRadius: '4px',
						},
					}}
				>
					{visibleResults.map(function item(node: QuickOpenItem, idx: number) {
						const isActive = idx === highlightIndex
						return (
							<HStack
								key={node.path}
								data-quick-open-item="true"
								role="button"
								tabIndex={0}
								px={3}
								py={1.5}
								cursor="pointer"
								gap={2}
								bg={isActive ? tokens.colors.accent.primaryHover : 'transparent'}
								_hover={{ bg: tokens.colors.accent.primaryHover }}
								onMouseDown={function md(e) { e.preventDefault() }}
								onClick={function onClick() { onOpenPath(node.path) }}
								transition={`background ${tokens.transition.fast}`}
							>
								<FiFile size={14} color={isActive ? tokens.colors.accent.primary : tokens.colors.text.muted} />
								<Box flex={1} minW={0}>
									<Text
										fontSize="12px"
										color={tokens.colors.text.primary}
										fontWeight={isActive ? '500' : '400'}
										whiteSpace="nowrap"
										overflow="hidden"
										textOverflow="ellipsis"
									>
										{node.name}
									</Text>
									<Text
										fontSize="10px"
										color={tokens.colors.text.disabled}
										whiteSpace="nowrap"
										overflow="hidden"
										textOverflow="ellipsis"
									>
										{node.path}
									</Text>
								</Box>
							</HStack>
						)
					})}
				</Box>
			)}
		</Box>
	)
}

export default QuickOpen
