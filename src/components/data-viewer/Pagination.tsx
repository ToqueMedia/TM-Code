import { Box, Flex, Text } from '@chakra-ui/react'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'

interface PaginationProps {
  page: number
  totalPages: number
  totalRows: number
  pageSize: number
  onChange: (page: number) => void
}

function Pagination({ page, totalPages, totalRows, pageSize, onChange }: PaginationProps) {
  const t = useTranslation()
  const canPrev = page > 1
  const canNext = page < totalPages
  const start = totalRows === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, totalRows)

  const rangeLabel =
    totalRows === 0
      ? t('dataViewer.noRows')
      : t('dataViewer.showingRange')
          .replace('{start}', String(start))
          .replace('{end}', String(end))
          .replace('{total}', String(totalRows))

  return (
    <Flex
      align="center"
      justify="center"
      gap={3}
      px={4}
      py={2}
      flexShrink={0}
      borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`}
      bg={tokens.colors.bg.sidebar}
    >
      <PageButton disabled={!canPrev} onClick={() => onChange(page - 1)} ariaLabel="Previous page">
        <FiChevronLeft size={13} />
      </PageButton>

      <Text fontSize="11px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.secondary}>
        {t('dataViewer.pageLabel')} <Text as="span" fontWeight="600" color={tokens.colors.text.primary}>{page}</Text>
        {' / '}
        <Text as="span" color={tokens.colors.text.muted}>{totalPages}</Text>
      </Text>

      <PageButton disabled={!canNext} onClick={() => onChange(page + 1)} ariaLabel="Next page">
        <FiChevronRight size={13} />
      </PageButton>

      <Box w="1px" h="14px" bg={tokens.colors.border.sidebarPanel} />

      <Text fontSize="11px" color={tokens.colors.text.muted}>
        {rangeLabel}
      </Text>
    </Flex>
  )
}

function PageButton({
  disabled,
  onClick,
  children,
  ariaLabel,
}: {
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        borderRadius: tokens.radius.md,
        background: 'transparent',
        border: 'none',
        color: disabled ? tokens.colors.text.disabled : tokens.colors.text.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: tokens.transition.fast,
      }}
    >
      {children}
    </button>
  )
}

export default Pagination
