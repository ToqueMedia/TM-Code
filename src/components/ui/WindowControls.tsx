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
		// macOS: traffic-light circles with native-style icons on hover
		return (
			<HStack
				gap="8px"
				data-no-drag
				role="group"
				css={{
					'& .mac-dot-icon': { 
						opacity: 0, 
						transition: 'opacity 0.15s',
						pointerEvents: 'none'
					},
					'&:hover .mac-dot-icon': { opacity: 1 },
				}}
			>
				{/* Close */}
				<Box
					{...macDotBase}
					bg="#ff5f56"
					border="0.5px solid rgba(0,0,0,0.12)"
					onClick={onClose}
					_active={{ bg: '#bf4740' }}
				>
					<svg className="mac-dot-icon" width="6" height="6" viewBox="0 0 6 6" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M1.05 1.05L4.95 4.95M4.95 1.05L1.05 4.95" stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" strokeLinecap="round"/>
					</svg>
				</Box>

				{/* Minimize */}
				<Box
					{...macDotBase}
					bg="#ffbd2e"
					border="0.5px solid rgba(0,0,0,0.12)"
					onClick={onMinimize}
					_active={{ bg: '#bf8e22' }}
				>
					<svg className="mac-dot-icon" width="6" height="1" viewBox="0 0 6 1" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M0 0.5H6" stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" strokeLinecap="round"/>
					</svg>
				</Box>

				{/* Full Screen / Maximize */}
				<Box
					{...macDotBase}
					bg="#27c93f"
					border="0.5px solid rgba(0,0,0,0.12)"
					onClick={onMaximize}
					_active={{ bg: '#1d962f' }}
				>
					<svg className="mac-dot-icon" width="6" height="6" viewBox="0 0 6 6" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M3.5 1H5V2.5M2.5 5H1V3.5M1.2 4.8L4.8 1.2" stroke="rgba(0,0,0,0.5)" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
					</svg>
				</Box>
			</HStack>
		)
	}

	// Windows/Linux: icon-based real <button> elements
	return (
		<HStack gap={0} data-no-drag>
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
