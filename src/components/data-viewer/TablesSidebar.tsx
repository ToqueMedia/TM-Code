import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiDatabase, FiRefreshCw } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'

interface TablesSidebarProps {
  tables: string[]
  activeTable: string | null
  loading: boolean
  onSelect: (table: string) => void
  onRefresh: () => void
}

function TablesSidebar({ tables, activeTable, loading, onSelect, onRefresh }: TablesSidebarProps) {
  const t = useTranslation()
  return (
    <Flex
      direction="column"
      w="220px"
      flexShrink={0}
      bg={tokens.colors.bg.sidebar}
      borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
    >
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="40px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Flex align="center" gap={2}>
          <FiDatabase size={13} color={tokens.colors.text.muted} />
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.04em">
            {t('dataViewer.tables')}
          </Text>
        </Flex>
        <button
          type="button"
          onClick={onRefresh}
          aria-label={t('dataViewer.refreshTables')}
          title={t('dataViewer.refreshTables')}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '22px',
            height: '22px',
            borderRadius: '4px',
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.muted,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.4 : 1,
            transition: `all ${tokens.transition.fast}`,
          }}
        >
          <FiRefreshCw size={11} />
        </button>
      </Flex>

      <Box flex="1" overflowY="auto" py={1}>
        {tables.length === 0 ? (
          <Text px={3} py={2} fontSize="11px" color={tokens.colors.text.disabled}>
            {loading ? t('dataViewer.loading') : t('dataViewer.noTables')}
          </Text>
        ) : (
          <VStack align="stretch" gap={0}>
            {tables.map((name) => {
              const isActive = name === activeTable
              return (
                <Box
                  key={name}
                  as="button"
                  textAlign="left"
                  px={3}
                  py="6px"
                  mx={1}
                  borderRadius={tokens.radius.md}
                  fontSize="12px"
                  fontFamily={tokens.fontFamily.mono}
                  fontWeight={isActive ? '600' : '400'}
                  color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
                  bg={isActive ? tokens.colors.bg.activeItem : 'transparent'}
                  cursor="pointer"
                  transition={tokens.transition.fast}
                  _hover={{
                    bg: isActive ? tokens.colors.bg.activeItem : tokens.colors.bg.hoverSubtle,
                    color: tokens.colors.text.primary,
                  }}
                  onClick={() => onSelect(name)}
                >
                  {name}
                </Box>
              )
            })}
          </VStack>
        )}
      </Box>
    </Flex>
  )
}

export default TablesSidebar
