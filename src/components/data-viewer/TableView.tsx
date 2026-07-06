import { useState, type ChangeEvent, type ReactNode } from 'react'
import { Box, Flex, NativeSelect, Text } from '@chakra-ui/react'
import { FiArrowDown, FiArrowUp, FiCopy, FiDownload, FiEdit2, FiPlus, FiRefreshCw, FiSearch, FiTrash2, FiX } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { isBlobMarker, type Cell, type ColumnInfo, type RowValues, type SortDirection } from '../../services/dataViewerService'
import type { PageSize } from '../../stores/dataViewerStore'

const PAGE_SIZE_OPTIONS: PageSize[] = [10, 20, 50, 100]
const CELL_TRUNCATE = 200

interface TableViewProps {
  table: string
  columns: string[]
  columnInfo: ColumnInfo[]
  rows: Cell[][]
  rowIds?: Cell[]
  page: number
  pageSize: PageSize
  totalRows: number
  filter: string
  sort: { column: string; direction: SortDirection } | null
  selectedCell: SelectedCell | null
  onPageSizeChange: (size: PageSize) => void
  onFilterChange: (value: string) => void
  onSortChange: (column: string) => void
  onSelectCell: (cell: SelectedCell | null) => void
  onAddRow: () => void
  onEditRow: () => void
  onDeleteRow: () => void
  onExportCsv: () => void
  onRefresh: () => void
  loading: boolean
  exporting: boolean
  mutating: boolean
}

export interface SelectedCell {
  rowNumber: number
  columnName: string
  columnType: string
  notNull: boolean
  isPrimaryKey: boolean
  value: Cell
  rowValues: RowValues
  rowId?: Cell | null
}

function TableView({
  table,
  columns,
  columnInfo,
  rows,
  rowIds,
  page,
  pageSize,
  totalRows,
  filter,
  sort,
  selectedCell,
  onPageSizeChange,
  onFilterChange,
  onSortChange,
  onSelectCell,
  onAddRow,
  onEditRow,
  onDeleteRow,
  onExportCsv,
  onRefresh,
  loading,
  exporting,
  mutating,
}: TableViewProps) {
  const t = useTranslation()
  const columnMetaByName = new Map(columnInfo.map(col => [col.name, col]))

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
        <Flex direction="column" minW={0}>
          <Text fontSize="13px" fontWeight="600" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.primary} lineClamp={1}>
            {table}
          </Text>
          <Text fontSize="10px" color={tokens.colors.text.disabled}>
            {t('dataViewer.resultSummary')
              .replace('{columns}', String(columns.length))
              .replace('{rows}', String(totalRows))}
          </Text>
        </Flex>
        <Flex align="center" gap={2} flexShrink={0}>
          <Flex
            align="center"
            gap={2}
            h="26px"
            w="220px"
            px={2}
            border={`1px solid ${tokens.colors.border.sidebarPanel}`}
            borderRadius={tokens.radius.md}
            bg={tokens.colors.bg.input}
          >
            <FiSearch size={12} color={tokens.colors.text.disabled} />
            <input
              value={filter}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onFilterChange(event.target.value)}
              placeholder={t('dataViewer.filterRows')}
              aria-label={t('dataViewer.filterRows')}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 0,
                outline: 'none',
                color: tokens.colors.text.primary,
                fontSize: '11px',
              }}
            />
          </Flex>
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
          <ToolbarButton
            onClick={onAddRow}
            disabled={loading || mutating || columnInfo.length === 0}
            ariaLabel={t('dataViewer.addRow')}
            title={t('dataViewer.addRow')}
          >
            <FiPlus size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={onEditRow}
            disabled={loading || mutating || !selectedCell}
            ariaLabel={t('dataViewer.editRow')}
            title={t('dataViewer.editRow')}
          >
            <FiEdit2 size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={onDeleteRow}
            disabled={loading || mutating || !selectedCell}
            ariaLabel={t('dataViewer.deleteRow')}
            title={t('dataViewer.deleteRow')}
          >
            <FiTrash2 size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={onExportCsv}
            disabled={loading || exporting || mutating || rows.length === 0}
            ariaLabel={t('dataViewer.exportCsv')}
            title={t('dataViewer.exportCsv')}
          >
            <FiDownload size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={onRefresh}
            disabled={loading}
            ariaLabel={t('dataViewer.refreshRows')}
            title={t('dataViewer.refreshRows')}
          >
            <FiRefreshCw size={12} />
          </ToolbarButton>
        </Flex>
      </Flex>

      <Flex flex="1" overflow="hidden">
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
                    p={0}
                    color={tokens.colors.text.muted}
                    fontSize="10px"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                    borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
                    whiteSpace="nowrap"
                  >
                    <HeaderCell
                      name={c}
                      meta={columnMetaByName.get(c)}
                      active={sort?.column === c}
                      direction={sort?.column === c ? sort.direction : null}
                      onSort={() => onSortChange(c)}
                    />
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
                rows.map((row, ri) => {
                  const rowNumber = (page - 1) * pageSize + ri + 1
                  const rowValues = columns.reduce<RowValues>((acc, column, index) => {
                    acc[column] = row[index] ?? null
                    return acc
                  }, {})
                  const rowId = rowIds?.[ri] ?? null
                  return (
                  <Box
                    as="tr"
                    key={ri}
                    transition={tokens.transition.fast}
                    _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                  >
                    {columns.map((column, ci) => {
                      const meta = columnMetaByName.get(column)
                      const value = row[ci] ?? null
                      const isSelected =
                        selectedCell?.rowNumber === rowNumber &&
                        selectedCell.columnName === column
                      return (
                        <CellRender
                          key={column}
                          value={value}
                          selected={isSelected}
                          onClick={() => onSelectCell({
                            rowNumber,
                            columnName: column,
                            columnType: meta?.type || '',
                            notNull: Boolean(meta?.notNull),
                            isPrimaryKey: Boolean(meta?.isPrimaryKey),
                            value,
                            rowValues,
                            rowId,
                          })}
                        />
                      )
                    })}
                  </Box>
                  )
                })
              )}
            </Box>
          </Box>
        )}
      </Box>
      {selectedCell && (
        <CellDetailsPanel cell={selectedCell} onClose={() => onSelectCell(null)} />
      )}
      </Flex>
    </Flex>
  )
}

function HeaderCell({
  name,
  meta,
  active,
  direction,
  onSort,
}: {
  name: string
  meta?: ColumnInfo
  active: boolean
  direction: SortDirection | null
  onSort: () => void
}) {
  return (
    <Box
      as="button"
      onClick={onSort}
      w="100%"
      minW="120px"
      px={3}
      py={1.5}
      textAlign="left"
      cursor="pointer"
      color={active ? tokens.colors.text.primary : tokens.colors.text.muted}
      _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.primary }}
    >
      <Flex align="center" gap={1.5}>
        <Text as="span" lineClamp={1}>{name}</Text>
        {active && (direction === 'desc' ? <FiArrowDown size={10} /> : <FiArrowUp size={10} />)}
        {meta?.isPrimaryKey && (
          <Text as="span" color={tokens.colors.accent.primary} fontSize="9px">PK</Text>
        )}
      </Flex>
      {meta?.type && (
        <Text fontSize="9px" color={tokens.colors.text.disabled} textTransform="none" letterSpacing="0" mt="1px">
          {meta.type}{meta.notNull ? ' · not null' : ''}
        </Text>
      )}
    </Box>
  )
}

function CellRender({ value, selected, onClick }: { value: Cell; selected: boolean; onClick: () => void }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const baseStyles = {
    px: 3,
    py: 2,
    borderBottom: `1px solid ${tokens.colors.border.sidebarPanel}`,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    verticalAlign: 'top' as const,
    cursor: 'pointer',
    bg: selected ? tokens.colors.accent.primarySubtle : undefined,
    boxShadow: selected ? `inset 0 0 0 1px ${tokens.colors.accent.primaryMuted}` : undefined,
    onClick,
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

function CellDetailsPanel({ cell, onClose }: { cell: SelectedCell; onClose: () => void }) {
  const t = useTranslation()
  const display = formatCellValue(cell.value)

  return (
    <Flex
      direction="column"
      w="280px"
      flexShrink={0}
      borderLeft={`1px solid ${tokens.colors.border.sidebarPanel}`}
      bg={tokens.colors.bg.sidebar}
    >
      <Flex align="center" justify="space-between" px={3} h="38px" borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
        <Text fontSize="11px" fontWeight="700" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.04em">
          {t('dataViewer.cellDetails')}
        </Text>
        <ToolbarButton onClick={onClose} ariaLabel={t('misc.close')} title={t('misc.close')}>
          <FiX size={12} />
        </ToolbarButton>
      </Flex>

      <Flex direction="column" gap={3} p={3} overflow="auto">
        <Meta label={t('dataViewer.row')} value={String(cell.rowNumber)} />
        <Meta label={t('dataViewer.column')} value={cell.columnName} />
        <Meta label={t('dataViewer.type')} value={cell.columnType || 'unknown'} />
        <Meta
          label={t('dataViewer.constraints')}
          value={[
            cell.isPrimaryKey ? 'primary key' : null,
            cell.notNull ? 'not null' : 'nullable',
          ].filter(Boolean).join(' · ')}
        />
        <Flex align="center" justify="space-between">
          <Text fontSize="10px" color={tokens.colors.text.disabled} textTransform="uppercase" letterSpacing="0.04em">
            {t('dataViewer.value')}
          </Text>
          <ToolbarButton
            onClick={() => { void navigator.clipboard?.writeText(display) }}
            ariaLabel={t('dataViewer.copyValue')}
            title={t('dataViewer.copyValue')}
          >
            <FiCopy size={12} />
          </ToolbarButton>
        </Flex>
        <Box
          p={3}
          minH="120px"
          border={`1px solid ${tokens.colors.border.sidebarPanel}`}
          borderRadius={tokens.radius.md}
          bg={tokens.colors.bg.mainLayout}
          color={tokens.colors.text.primary}
          fontFamily={tokens.fontFamily.mono}
          fontSize="11px"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
        >
          {display}
        </Box>
      </Flex>
    </Flex>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text fontSize="10px" color={tokens.colors.text.disabled} textTransform="uppercase" letterSpacing="0.04em">
        {label}
      </Text>
      <Text mt="2px" fontSize="12px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} wordBreak="break-word">
        {value}
      </Text>
    </Box>
  )
}

function ToolbarButton({
  children,
  onClick,
  disabled = false,
  ariaLabel,
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  ariaLabel: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onClick() }}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
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
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: `all ${tokens.transition.fast}`,
      }}
    >
      {children}
    </button>
  )
}

function formatCellValue(value: Cell): string {
  if (value === null || value === undefined) return 'NULL'
  if (isBlobMarker(value)) return `<binary, ${value.__binary} bytes>`
  return String(value)
}

export default TableView
