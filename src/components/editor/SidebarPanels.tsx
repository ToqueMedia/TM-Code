import { memo, useState, useEffect } from 'react'
import { Box, Text, VStack, Flex } from '@chakra-ui/react'
import { FiGitBranch, FiPlay, FiPackage } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import DebuggerPanel from '../DebuggerPanel'

const PlaceholderPanel = memo<{ icon: React.ElementType; title: string; description: string }>(
	({ icon: Icon, title, description }) => (
		<Flex
			height="100%"
			align="center"
			justify="center"
			p={6}
		>
			<VStack gap={3}>
				<Box
					p={3}
					borderRadius="10px"
					bg={tokens.colors.bg.hoverSubtle}
				>
					<Icon size={24} color={tokens.colors.text.muted} />
				</Box>
				<VStack gap={1}>
					<Text fontSize="sm" color={tokens.colors.text.primary} fontWeight="500">
						{title}
					</Text>
					<Text fontSize="xs" color={tokens.colors.text.muted} textAlign="center" maxW="220px">
						{description}
					</Text>
				</VStack>
			</VStack>
		</Flex>
	)
)

PlaceholderPanel.displayName = 'PlaceholderPanel'

export const SourceControlPanel = memo(() => (
	<PlaceholderPanel
		icon={FiGitBranch}
		title={t("view.sourceControl")}
		description={t("view.gitComingSoon")}
	/>
))

SourceControlPanel.displayName = 'SourceControlPanel'

export const RunDebugPanel = memo(() => {
	const [isDebuggerVisible, setIsDebuggerVisible] = useState(false)

	useEffect(() => {
		const handleOpenDebugger = () => {
			setIsDebuggerVisible(true)
		}

		window.addEventListener('debugger:open', handleOpenDebugger)

		return () => {
			window.removeEventListener('debugger:open', handleOpenDebugger)
		}
	}, [])

	return (
		<>
			<Flex
				height="100%"
				align="center"
				justify="center"
				p={6}
			>
				<VStack gap={4}>
					<Box
						p={3}
						borderRadius="10px"
						bg={tokens.colors.accent.primarySubtle}
					>
						<FiPlay
							size={24}
							color={tokens.colors.accent.primary}
							style={{ filter: `drop-shadow(0 0 6px ${tokens.colors.accent.primaryGlow})` }}
						/>
					</Box>
					<VStack gap={1}>
						<Text fontSize="sm" color={tokens.colors.text.primary} fontWeight="500">
							Run & Debug
						</Text>
						<Text fontSize="xs" color={tokens.colors.text.muted} textAlign="center" maxW="220px">
							Configure and run your application
						</Text>
					</VStack>
					<Box
						as="button"
						px={4}
						py={2}
						borderRadius="8px"
						bg={tokens.colors.accent.primary}
						color="#fff"
						fontSize="12px"
						fontWeight="600"
						cursor="pointer"
						transition={`all ${tokens.transition.normal}`}
						_hover={{
							bg: tokens.colors.accent.primaryDark,
							boxShadow: `0 4px 16px ${tokens.colors.accent.primaryGlow}`,
							transform: 'translateY(-1px)',
						}}
						_active={{
							transform: 'translateY(0px)',
						}}
						onClick={() => setIsDebuggerVisible(true)}
					>
						Open Debugger
					</Box>
				</VStack>
			</Flex>

			<DebuggerPanel
				isVisible={isDebuggerVisible}
				onClose={() => setIsDebuggerVisible(false)}
			/>
		</>
	)
})

RunDebugPanel.displayName = 'RunDebugPanel'

export const ExtensionsPanel = memo(() => (
	<PlaceholderPanel
		icon={FiPackage}
		title={t("view.extensionsComingSoon")}
		description={t("view.extensionsComingSoon")}
	/>
))

ExtensionsPanel.displayName = 'ExtensionsPanel'
