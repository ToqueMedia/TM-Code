import { useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

// Inject keyframe once globally
if (typeof document !== 'undefined' && !document.getElementById('ctx-menu-keyframes')) {
	const style = document.createElement('style')
	style.id = 'ctx-menu-keyframes'
	style.textContent = '@keyframes ctxMenuIn{from{opacity:0;transform:scale(0.98)}to{opacity:1;transform:scale(1)}}'
	document.head.appendChild(style)
}

export interface ContextMenuItem {
	label: string
	hint?: string
	action?: () => void
	separator?: boolean
	disabled?: boolean
}

interface ContextMenuOverlayProps {
	items: ContextMenuItem[]
	x: number
	y: number
	onClose: () => void
}

export default function ContextMenuOverlay({ items, x, y, onClose }: ContextMenuOverlayProps) {
	const menuRef = useRef<HTMLDivElement>(null)
	const [highlightIdx, setHighlightIdx] = useState(-1)

	// Clamp to viewport after mount
	useEffect(function clamp() {
		const el = menuRef.current
		if (!el) return
		const rect = el.getBoundingClientRect()
		const vw = window.innerWidth
		const vh = window.innerHeight
		if (rect.right > vw - 8) el.style.left = Math.max(8, vw - rect.width - 8) + 'px'
		if (rect.bottom > vh - 8) el.style.top = Math.max(8, vh - rect.height - 8) + 'px'
	}, [])

	// Keyboard navigation
	useEffect(function keys() {
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') { onClose(); return }
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				setHighlightIdx(h => {
					let next = h + 1
					while (next < items.length && items[next].separator) next++
					return next >= items.length ? h : next
				})
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault()
				setHighlightIdx(h => {
					let prev = h - 1
					while (prev >= 0 && items[prev].separator) prev--
					return prev < 0 ? h : prev
				})
			}
			if (e.key === 'Enter' && highlightIdx >= 0 && highlightIdx < items.length) {
				const item = items[highlightIdx]
				if (item.action && !item.disabled && !item.separator) {
					item.action()
					onClose()
				}
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [highlightIdx, items, onClose])

	return (
		<Box
			position="fixed"
			inset={0}
			zIndex={30000}
			onMouseDown={onClose}
		>
			<Box
				ref={menuRef}
				role="menu"
				aria-label="Context menu"
				position="fixed"
				left={`${x}px`}
				top={`${y}px`}
				bg={tokens.colors.menu.bg}
				border={`1px solid ${tokens.colors.menu.border}`}
				borderRadius="8px"
				minW="260px"
				boxShadow={tokens.shadow.overlay}
				overflow="hidden"
				py="4px"
				transform="scale(0.98)"
				opacity={0}
				animation="ctxMenuIn 100ms ease-out forwards"
				onMouseDown={e => e.stopPropagation()}
			>
				{items.map(function renderItem(item, idx) {
					if (item.separator) {
						return <Box key={`sep-${idx}`} h="1px" bg={tokens.colors.menu.separator} mx={2} my="4px" />
					}

					const isHighlighted = idx === highlightIdx

					return (
						<Flex
							key={`${item.label}-${idx}`}
							role="menuitem"
							tabIndex={0}
							align="center"
							justify="space-between"
							px={3}
							py="6px"
							mx="4px"
							borderRadius="4px"
							cursor={item.disabled ? 'default' : 'pointer'}
							opacity={item.disabled ? 0.4 : 1}
							bg={isHighlighted ? tokens.colors.menu.hover : 'transparent'}
							_hover={{ bg: item.disabled ? 'transparent' : tokens.colors.menu.hover }}
							onMouseEnter={() => setHighlightIdx(idx)}
							onMouseLeave={() => setHighlightIdx(-1)}
							onClick={e => {
								e.stopPropagation()
								if (item.action && !item.disabled) {
									item.action()
									onClose()
								}
							}}
							onKeyDown={e => {
								if (e.key === 'Enter' && item.action && !item.disabled) {
									item.action()
									onClose()
								}
							}}
						>
							<Text fontSize="13px" color={tokens.colors.menu.text} lineHeight="1.2">
								{item.label}
							</Text>
							{item.hint && (
								<Text fontSize="12px" color={tokens.colors.text.muted} ml={6} whiteSpace="nowrap">
									{item.hint}
								</Text>
							)}
						</Flex>
					)
				})}
			</Box>
		</Box>
	)
}
