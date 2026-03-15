import React, { memo } from 'react'
import {
  VStack,
  IconButton,
  Box
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
    {isActive && (
      <Box
        position="absolute"
        left="0"
        top="0"
        bottom="0"
        width="2px"
        bg={tokens.colors.accent.blueAlt}
        zIndex={1}
      />
    )}

    <IconButton
      aria-label={label}
      onClick={onClick}
      variant="ghost"
      size="lg"
      color={isActive ? tokens.colors.text.inverse : tokens.colors.text.subtle}
      bg="transparent"
      _hover={{
        color: tokens.colors.text.inverse,
        bg: 'transparent'
      }}
      borderRadius="0"
      width="100%"
      height="48px"
      border="none"
      position="relative"
      data-activity={id}
    >
      <Icon size={24} />
      {badge && badge > 0 && (
        <Box
          position="absolute"
          top="6px"
          right="6px"
          bg={tokens.colors.badge.notificationBg}
          color={tokens.colors.badge.notificationText}
          borderRadius="full"
          fontSize="10px"
          fontWeight="bold"
          minW="18px"
          h="18px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          px={1}
          border={`2px solid ${tokens.colors.badge.notificationBorder}`}
        >
          {badge > 99 ? '99+' : badge}
        </Box>
      )}
    </IconButton>
  </Box>
))

ActivityItem.displayName = 'ActivityItem'

function ActivityBar({ activeActivity, onActivityChange }: ActivityBarProps) {
  const activities = [
    {
      id: 'chat',
      icon: FiMessageSquare,
      label: 'Chat',
    },
    {
      id: 'explorer',
      icon: FiFolder,
      label: 'Explorer',
    },
    {
      id: 'search',
      icon: FiSearch,
      label: 'Search',
    },
    {
      id: 'editor',
      icon: FiCode,
      label: 'Editor',
    },
    {
      id: 'source-control',
      icon: FiGitBranch,
      label: 'Source Control',
      badge: 3
    },
    {
      id: 'run-debug',
      icon: FiPlay,
      label: 'Run and Debug',
    },
    {
      id: 'extensions',
      icon: FiPackage,
      label: 'Extensions',
      badge: 2
    }
  ]

  const bottomActivities = [
    {
      id: 'toggle-bottom-panel',
      icon: FiTerminal,
      label: 'Toggle Panel',
    },
    {
      id: 'accounts',
      icon: FiUser,
      label: 'Accounts',
    },
    {
      id: 'settings',
      icon: FiSettings,
      label: 'Manage',
    }
  ]

  return (
    <Box
      as="nav"
      role="navigation"
      aria-label="Activity Bar"
      className="vscode-activitybar"
      width="48px"
      height="100%"
      bg={tokens.colors.bg.activitybar}
      borderRight={`1px solid ${tokens.colors.border.activitybar}`}
      display="flex"
      flexDirection="column"
      justifyContent="space-between"
    >
      <VStack gap={0} pt={1}>
        {activities.map((activity) => (
          <ActivityItem
            key={activity.id}
            id={activity.id}
            icon={activity.icon}
            label={activity.label}
            isActive={activeActivity === activity.id}
            onClick={() => onActivityChange(activity.id)}
            badge={activity.badge}
          />
        ))}
      </VStack>

      <VStack gap={0} pb={1}>
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
