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
  FiUser
} from 'react-icons/fi'

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
    {/* Active indicator */}
    {isActive && (
      <Box
        position="absolute"
        left="0"
        top="0"
        bottom="0"
        width="2px"
        bg="#0078d4"
        zIndex={1}
      />
    )}
    
    <IconButton
      aria-label={label}
      onClick={onClick}
      variant="ghost"
      size="lg"
      color={isActive ? '#ffffff' : '#858585'}
      bg="transparent"
      _hover={{
        color: '#ffffff',
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
          bg="#007acc"
          color="white"
          borderRadius="full"
          fontSize="10px"
          fontWeight="bold"
          minW="18px"
          h="18px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          px={1}
          border="2px solid #333333"
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
      id: 'source-control',
      icon: FiGitBranch,
      label: 'Source Control',
      badge: 3 // Example: 3 modified files
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
      badge: 2 // Example: 2 extension updates
    }
  ]

  const bottomActivities = [
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
      className="vscode-activitybar"
      width="48px"
      height="100%"
      bg="#333333"
      borderRight="1px solid #1e1f22"
      display="flex"
      flexDirection="column"
      justifyContent="space-between"
    >
      {/* Main Activities */}
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

      {/* Bottom Activities */}
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