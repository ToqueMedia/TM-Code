import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { HStack, Box, Text } from '@chakra-ui/react'
import { tokens } from '../../theme/tokens'
import { IS_MAC } from '../../utils/platform'

// macOS traffic-light icon styles — icons hidden by default, shown on group hover
const macDotBase = {
	width: '12px',
	height: '12px',
	borderRadius: '9999px',
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	transition: 'all 0.15s',
	position: 'relative' as const,
}

interface WindowControlsProps {
	onClose: () => void
	onMinimize: () => void
	onMaximize: () => void
}

// Swallow the mousedown before it bubbles to the title bar's onMouseDown handler.
// Without this, the title bar's custom shouldStartDrag logic could race the click
// and (on Windows especially) start a native drag before the `click` event ever
// reaches the button's onClick handler, making the button feel dead.
function swallowMouseDown(e: MouseEvent<HTMLButtonElement>) {
	e.stopPropagation()
}

// Shared style object for the Windows/Linux title-bar buttons. Using a real
// <button> rather than a <div> ensures the element is semantically interactive:
// shouldStartDrag() short-circuits on interactive tags, and the title-bar drag
// handler walks up the DOM from the event target — a button stops that walk
// before it ever reaches a drag region.
const winBtnStyle: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '36px',
	height: '28px',
	cursor: 'pointer',
	background: 'transparent',
	border: 'none',
	padding: 0,
	margin: 0,
	color: tokens.colors.text.secondary,
	transition: 'all 0.15s',
	// Ensure the button intercepts pointer events (safety against any parent
	// CSS that sets pointer-events: none on drag regions).
	pointerEvents: 'auto',
}

// Windows/Linux title-bar button. Proper <button> element with hover state
// handled inline so we don't depend on Chakra pseudo props working across
// reset styles.
function WinBarButton({
	ariaLabel,
	onClick,
	hoverBg,
	hoverColor = tokens.colors.text.primary,
	children,
}: {
	ariaLabel: string
	onClick: () => void
	hoverBg: string
	hoverColor?: string
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			data-tauri-drag-region="false"
			data-no-drag
			onMouseDown={swallowMouseDown}
			onClick={onClick}
			style={winBtnStyle}
			onMouseEnter={e => {
				e.currentTarget.style.background = hoverBg
				e.currentTarget.style.color = hoverColor
			}}
			onMouseLeave={e => {
				e.currentTarget.style.background = 'transparent'
				e.currentTarget.style.color = tokens.colors.text.secondary
			}}
		>
			{children}
		</button>
	)
}

const WindowControls = ({ onClose, onMinimize, onMaximize }: WindowControlsProps) => {
	if (IS_MAC) {
		// macOS: traffic-light circles with Finder-style icons on hover
		return (
			<HStack
				gap={2}
				data-tauri-drag-region="false"
				role="group"
				css={{
					'& .mac-dot-icon': { opacity: 0, transition: 'opacity 0.15s' },
					'&:hover .mac-dot-icon': { opacity: 1 },
				}}
			>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.close}
					onClick={onClose}
					_active={{ transform: 'scale(0.85)' }}
				>
					<Text className="mac-dot-icon" fontSize="9px" lineHeight="1" color="rgba(80,0,0,0.8)" fontWeight="700" mt="-1px">
						&#x2715;
					</Text>
				</Box>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.minimize}
					onClick={onMinimize}
					_active={{ transform: 'scale(0.85)' }}
				>
					<Text className="mac-dot-icon" fontSize="12px" lineHeight="1" color="rgba(120,70,0,0.8)" fontWeight="700" mt="-2px">
						&#x2013;
					</Text>
				</Box>
				<Box
					{...macDotBase}
					bg={tokens.colors.windowControl.maximize}
					onClick={onMaximize}
					_active={{ transform: 'scale(0.85)' }}
				>
					{/* Diagonal arrows like Finder fullscreen icon */}
					<Box className="mac-dot-icon" position="relative" w="7px" h="7px">
						<Box
							position="absolute" top="0" left="0"
							w="0" h="0"
							borderLeft="3.5px solid rgba(0,80,0,0.8)"
							borderBottom="3.5px solid transparent"
						/>
						<Box
							position="absolute" bottom="0" right="0"
							w="0" h="0"
							borderRight="3.5px solid rgba(0,80,0,0.8)"
							borderTop="3.5px solid transparent"
						/>
					</Box>
				</Box>
			</HStack>
		)
	}

	// Windows/Linux: icon-based real <button> elements
	return (
		<HStack gap={0} data-tauri-drag-region="false" data-no-drag>
			<WinBarButton
				ariaLabel="Minimize"
				onClick={onMinimize}
				hoverBg="rgba(255,255,255,0.08)"
			>
				<Text fontSize="16px" lineHeight="1" mt="-2px" fontWeight="300">&#x2013;</Text>
			</WinBarButton>
			<WinBarButton
				ariaLabel="Maximize"
				onClick={onMaximize}
				hoverBg="rgba(255,255,255,0.08)"
			>
				<Box
					width="9px"
					height="9px"
					border="1px solid currentColor"
					borderRadius="1px"
				/>
			</WinBarButton>
			<WinBarButton
				ariaLabel="Close"
				onClick={onClose}
				hoverBg="#e81123"
				hoverColor="#fff"
			>
				<Text fontSize="16px" lineHeight="1" fontWeight="300">&#x2715;</Text>
			</WinBarButton>
		</HStack>
	)
}

export default WindowControls