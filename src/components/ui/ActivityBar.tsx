import React, { memo } from 'react'
import {
  VStack,
  IconButton,
  Box,
} from '@chakra-ui/react'
import {
  FiFolder,
  FiSearch,
  FiGitBranch,
  FiPlay,
  FiPackage,
  FiSettings,
  FiUser,
  FiTerminal,
  FiMessageSquare,
  FiCode
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'

interface ActivityBarProps {
  activeActivity: string
  onActivityChange: (activity: string) => void
}

interface ActivityItemProps {
  id: string
  icon: React.ElementType
  label: string
  isActive: boolean
  onClick: () => void
  badge?: number
}

const ActivityItem = memo<ActivityItemProps>(({
  id,
  icon: Icon,
  label,
  isActive,
  onClick,
  badge
}) => (
  <Box position="relative" width="100%">
    {/* Active indicator — pink accent bar */}
    {isActive && (
      <Box
        position="absolute"
        left="0"
        top="25%"
        bottom="25%"
        width="2px"
        bg={tokens.colors.accent.primary}
        borderRadius="0 2px 2px 0"
        zIndex={1}
        boxShadow={`0 0 8px ${tokens.colors.accent.primaryGlow}`}
      />
    )}

    <IconButton
      aria-label={label}
      title={label}
      onClick={onClick}
      variant="ghost"
      size="lg"
      color={isActive ? tokens.colors.text.inverse : tokens.colors.text.muted}
      bg={isActive ? tokens.colors.accent.primarySubtle : 'transparent'}
      _hover={{
        color: tokens.colors.text.inverse,
        bg: tokens.colors.bg.hoverSubtle,
      }}
      borderRadius="0"
      width="100%"
      height="44px"
      border="none"
      position="relative"
      data-activity={id}
      transition={`all ${tokens.transition.normal}`}
    >
      <Icon size={20} />
      {badge !== undefined && badge > 0 && (
        <Box
          position="absolute"
          top="6px"
          right="8px"
          bg={tokens.colors.accent.primary}
          color="#fff"
          borderRadius="full"
          fontSize="9px"
          fontWeight="bold"
          minW="16px"
          h="16px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          px="4px"
          lineHeight="1"
          boxShadow={`0 0 6px ${tokens.colors.accent.primaryGlow}`}
        >
          {badge > 99 ? '99+' : badge}
        </Box>
      )}
    </IconButton>
  </Box>
))

ActivityItem.displayName = 'ActivityItem'

function ActivityBar({ activeActivity, onActivityChange }: ActivityBarProps) {
  const t = useTranslation()

  const activities = [
    { id: 'chat', icon: FiMessageSquare, label: t('activity.chat') },
    { id: 'explorer', icon: FiFolder, label: t('activity.explorer') },
    { id: 'search', icon: FiSearch, label: t('activity.search') },
    { id: 'editor', icon: FiCode, label: t('activity.editor') },
    { id: 'source-control', icon: FiGitBranch, label: t('activity.sourceControl') },
    { id: 'run-debug', icon: FiPlay, label: t('activity.runDebug') },
    { id: 'extensions', icon: FiPackage, label: t('activity.extensions') },
  ]

  const bottomActivities = [
    { id: 'toggle-bottom-panel', icon: FiTerminal, label: t('activity.terminal') },
    { id: 'accounts', icon: FiUser, label: t('activity.accounts') },
    { id: 'settings', icon: FiSettings, label: t('activity.settings') },
  ]

  return (
    <Box
      as="nav"
      role="navigation"
      aria-label="Activity Bar"
      width="48px"
      height="100%"
      bg={tokens.colors.bg.activitybar}
      borderRight={`1px solid ${tokens.colors.border.activitybar}`}
      display="flex"
      flexDirection="column"
      justifyContent="space-between"
    >
      <VStack gap={0} pt={0.5}>
        {activities.map((activity) => (
          <ActivityItem
            key={activity.id}
            id={activity.id}
            icon={activity.icon}
            label={activity.label}
            isActive={activeActivity === activity.id}
            onClick={() => onActivityChange(activity.id)}
          />
        ))}
      </VStack>

      <VStack gap={0} pb={0.5}>
        {bottomActivities.map((activity) => (
          <ActivityItem
            key={activity.id}
            id={activity.id}
            icon={activity.icon}
            label={activity.label}
            isActive={activeActivity === activity.id}
            onClick={() => onActivityChange(activity.id)}
          />
        ))}
      </VStack>
    </Box>
  )
}

export default memo(ActivityBar)
