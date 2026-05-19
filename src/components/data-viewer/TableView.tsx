import { useState } from 'react'
import { Box, Flex, NativeSelect, Text } from '@chakra-ui/react'
import { FiRefreshCw } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { isBlobMarker, type Cell } from '../../services/dataViewerService'
import type { PageSize } from '../../stores/dataViewerStore'

const PAGE_SIZE_OPTIONS: PageSize[] = [10, 20, 50, 100]
const CELL_TRUNCATE = 200

interface TableViewProps {
  table: string
  columns: string[]
  rows: Cell[][]
  pageSize: PageSize
  onPageSizeChange: (size: PageSize) => void
  onRefresh: () => void
  loading: boolean
}

function TableView({ table, columns, rows, pageSize, onPageSizeChange, onRefresh, loading }: TableViewProps) {
  const t = useTranslation()
  return (
    <Flex direction="column" flex="1" overflow="hidden">
      <Flex
        align="center"
        justify="space-between"
        px={4}
        h="40px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Text fontSize="13px" fontWeight="600" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.primary}>
          {table}
        </Text>
        <Flex align="center" gap={2}>
          <Text fontSize="10px" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.04em">
            {t('dataViewer.rowsPerPage')}
          </Text>
          <NativeSelect.Root size="xs" w="64px">
            <NativeSelect.Field
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
              fontFamily={tokens.fontFamily.mono}
              fontSize="11px"
            >
              {PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={String(opt)}>{opt}</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t('dataViewer.refreshRows')}
            title={t('dataViewer.refreshRows')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              borderRadius: tokens.radius.md,
              background: 'transparent',
              border: 'none',
              color: tokens.colors.text.muted,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.4 : 1,
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            <FiRefreshCw size={12} />
          </button>
        </Flex>
      </Flex>

      <Box flex="1" overflow="auto" position="relative">
        {/* Subtle overlay during reloads so the user sees the table is
            re-fetching without losing the previous rows. Full-area loader
            only on the very first paint (no rows yet). */}
        {loading && rows.length > 0 && (
          <Box
            position="absolute"
            top={0}
            right={3}
            mt={2}
            zIndex={2}
            px={2}
            py="2px"
            borderRadius={tokens.radius.full}
            bg="rgba(0,0,0,0.5)"
            fontSize="10px"
            fontFamily={tokens.fontFamily.mono}
            color={tokens.colors.text.muted}
          >
            {t('dataViewer.loading')}
          </Box>
        )}
        {loading && rows.length === 0 ? (
          <Flex align="center" justify="center" h="100%" color={tokens.colors.text.muted} fontSize="12px">
            {t('dataViewer.loading')}
          </Flex>
        ) : columns.length === 0 ? (
          <Flex align="center" justify="center" h="100%" color={tokens.colors.text.disabled} fontSize="12px">
            {t('dataViewer.noColumns')}
          </Flex>
        ) : (
          <Box
            as="table"
            w="100%"
            style={{ borderCollapse: 'collapse', opacity: loading ? 0.55 : 1, transition: 'opacity 120ms ease-out' }}
            fontFamily={tokens.fontFamily.mono}
            fontSize="11px"
          >
            <Box as="thead" position="sticky" top={0} bg={tokens.colors.bg.sidebar} zIndex={1}>
              <Box as="tr">
                {columns.map((c) => (
                  <Box
                    key={c}
                    as="th"
                    textAlign="left"
                    px={3}
                    py={2}
                    color={tokens.colors.text.muted}
                    fontSize="10px"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                    borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
                    whiteSpace="nowrap"
                  >
                    {c}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box as="tbody">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    style={{
                      padding: '24px 12px',
                      textAlign: 'center',
                      color: tokens.colors.text.disabled,
                      fontSize: '11px',
                    }}
                  >
                    {t('dataViewer.noRows')}
                  </td>
                </tr>
              ) : (
                rows.map((row, ri) => (
                  <Box
                    as="tr"
                    key={ri}
                    transition={tokens.transition.fast}
                    _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                  >
                    {row.map((cell, ci) => (
                      <CellRender key={ci} value={cell} />
                    ))}
                  </Box>
                ))
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Flex>
  )
}

function CellRender({ value }: { value: Cell }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const baseStyles = {
    px: 3,
    py: 2,
    borderBottom: `1px solid ${tokens.colors.border.sidebarPanel}`,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    verticalAlign: 'top' as const,
  }

  if (value === null || value === undefined) {
    return (
      <Box as="td" {...baseStyles} color={tokens.colors.text.disabled} fontStyle="italic">
        NULL
      </Box>
    )
  }
  // BLOBs come in as a discriminated `{ __binary: <byteCount> }` from the
  // dev path. Check this BEFORE the typeof checks below — `typeof object`
  // would otherwise fall through into the generic text branch.
  if (isBlobMarker(value)) {
    return (
      <Box as="td" {...baseStyles} color={tokens.colors.text.disabled} fontStyle="italic">
        {`<binary, ${value.__binary} bytes>`}
      </Box>
    )
  }
  if (typeof value === 'boolean') {
    return (
      <Box as="td" {...baseStyles} color={tokens.colors.text.primary}>
        {value ? 'true' : 'false'}
      </Box>
    )
  }
  if (typeof value === 'number') {
    return (
      <Box as="td" {...baseStyles} color={tokens.colors.accent.purple}>
        {value}
      </Box>
    )
  }

  const text = String(value)

  const needsTruncate = text.length > CELL_TRUNCATE
  const display = !needsTruncate || expanded ? text : text.slice(0, CELL_TRUNCATE) + '…'

  return (
    <Box as="td" {...baseStyles} color={tokens.colors.text.primary}>
      {display}
      {needsTruncate && (
        <Text
          as="span"
          ml={2}
          color={tokens.colors.accent.primary}
          cursor="pointer"
          fontSize="10px"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('dataViewer.showLess') : t('dataViewer.showFull')}
        </Text>
      )}
    </Box>
  )
}

export default TableView
