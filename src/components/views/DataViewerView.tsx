import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiArrowLeft } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { useLayoutStore } from '../../stores/layoutStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useDataViewerStore, type DataSource } from '../../stores/dataViewerStore'
import { useCurrentProject } from '../../hooks/useProjectState'
import * as dataViewerService from '../../services/dataViewerService'
import type { Cell, ColumnInfo, ProjectContext, RowValues, SortDirection } from '../../services/dataViewerService'
import TablesSidebar from '../data-viewer/TablesSidebar'
import TableView, { type SelectedCell } from '../data-viewer/TableView'
import Pagination from '../data-viewer/Pagination'
import SourceToggle from '../data-viewer/SourceToggle'
import EmptyState from '../data-viewer/EmptyState'
import RowMutationDialog from '../data-viewer/RowMutationDialog'
import { logger } from '../../utils/logger'
import { trackEvent } from '../../services/analytics'

interface DataViewerViewProps {
  /** When true, hides the full-screen header (back arrow + title). Used when
   *  the component is rendered inside a drawer that brings its own chrome. */
  embedded?: boolean
}

function DataViewerView({ embedded = false }: DataViewerViewProps) {
  const t = useTranslation()
  const currentProject = useCurrentProject()
  const source = useDataViewerStore((s) => s.source)
  const activeTable = useDataViewerStore((s) => s.activeTable)
  const page = useDataViewerStore((s) => s.page)
  const pageSize = useDataViewerStore((s) => s.pageSize)
  const setSource = useDataViewerStore((s) => s.setSource)
  const setActiveTable = useDataViewerStore((s) => s.setActiveTable)
  const setPage = useDataViewerStore((s) => s.setPage)
  const setPageSize = useDataViewerStore((s) => s.setPageSize)
  const hydrate = useDataViewerStore((s) => s.hydrateFromProject)

  const [hasDev, setHasDev] = useState(false)
  const [hasProd, setHasProd] = useState(false)
  const [detectReady, setDetectReady] = useState(false)
  const [tables, setTables] = useState<string[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [columns, setColumns] = useState<string[]>([])
  const [columnInfo, setColumnInfo] = useState<ColumnInfo[]>([])
  const [rows, setRows] = useState<Cell[][]>([])
  const [rowIds, setRowIds] = useState<Cell[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowFilter, setRowFilter] = useState('')
  const [sort, setSort] = useState<{ column: string; direction: SortDirection } | null>(null)
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null)
  const [exportingCsv, setExportingCsv] = useState(false)
  const [mutatingRows, setMutatingRows] = useState(false)
  const [mutationDialog, setMutationDialog] = useState<'add' | 'edit' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Race guard: discard results from a stale (project, source) once the
  // active selection has changed.
  const requestEpoch = useRef(0)
  const rowRequestEpoch = useRef(0)
  // One-shot guard for the "opened" telemetry event — fires once per mount.
  const openedTrackedRef = useRef(false)

  // useMemo com deps primitivas, NÃO um literal por render: este objecto é
  // dependência do useCallback de fetchTablesOnce, que é dependência do
  // efeito das tabelas. Com identidade nova a cada render, o efeito corria
  // após CADA render e os seus próprios setState (tablesLoading true→false)
  // geravam o render seguinte — loop perpétuo de efeito↔render, mascarado
  // pelo cache do service (sem rede, mas CPU e spinner a tremer). O efeito
  // das rows já usava primitivas nas deps por este exacto motivo.
  const project: ProjectContext | null = useMemo(
    () =>
      currentProject
        ? { path: currentProject.path, id: currentProject.id, name: currentProject.name }
        : null,
    [currentProject?.path, currentProject?.id, currentProject?.name],
  )

  useEffect(() => {
    if (openedTrackedRef.current) return
    openedTrackedRef.current = true
    void trackEvent('data_viewer_opened', {
      hasProject: !!project,
    })
  }, [project])

  // Detect available sources and hydrate the stored preference once per project.
  useEffect(() => {
    if (!project) return
    let cancelled = false
    setDetectReady(false)
    dataViewerService
      .detectSources(project)
      .then(async (result) => {
        if (cancelled) return
        // Even though Dev is "available", check if a DB file actually exists.
        // If not, disable Dev so the user sees "no database" instead of loading forever.
        const devDbExists = result.hasDevDb
          ? await dataViewerService.hasDevDatabase(project.path)
          : false
        if (cancelled) return
        setHasDev(devDbExists)
        setHasProd(result.hasProdConfig)
        const fallback: DataSource =
          devDbExists ? 'dev' : result.hasProdConfig ? 'prod' : 'dev'
        // A lista de fontes disponíveis acompanha o fallback: sem ela, uma
        // preferência 'prod' persistida de uma sessão anterior hidratava
        // mesmo com o .env já sem TMDB_* — e o viewer abria num erro
        // de base de dados de produção indisponível em vez de cair para dev.
        const available: DataSource[] = [
          ...(devDbExists ? (['dev'] as const) : []),
          ...(result.hasProdConfig ? (['prod'] as const) : []),
        ]
        hydrate(project.id, fallback, available)
        setDetectReady(true)
      })
      .catch((err) => {
        if (cancelled) return
        logger.error('data-viewer', 'detectSources failed', err)
        setDetectReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [project?.id, project?.path, hydrate])

  // Pure fetch — independent of the auto-select decision so its deps
  // stay narrow. The effect below composes the fetch with auto-select.
  const fetchTablesOnce = useCallback(
    async (forceRefresh: boolean): Promise<string[] | null> => {
      if (!project || !detectReady) return null
      requestEpoch.current += 1
      const epoch = requestEpoch.current
      setTablesLoading(true)
      setError(null)
      try {
        if (forceRefresh) dataViewerService.invalidateCache(source, project.id)
        const result = await dataViewerService.listTables(source, project)
        if (epoch !== requestEpoch.current) return null
        setTables(result)
        return result
      } catch (err) {
        if (epoch !== requestEpoch.current) return null
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setTables([])
        void trackEvent('data_viewer_query_failed', { stage: 'list_tables', source })
        return null
      } finally {
        if (epoch === requestEpoch.current) setTablesLoading(false)
      }
    },
    [project, source, detectReady],
  )

  // Manual refresh path (the sidebar button) — re-fetch and re-apply the
  // same auto-select rule the effect uses, so the table list and active
  // selection stay in sync after a force refresh.
  const refreshTables = useCallback(async () => {
    const result = await fetchTablesOnce(true)
    if (!result) return
    const next = activeTable && result.includes(activeTable) ? activeTable : result[0] ?? null
    if (next !== activeTable) setActiveTable(next)
  }, [fetchTablesOnce, activeTable, setActiveTable])

  // Effect-driven path — fires when the project/source/detect-ready
  // tuple changes. Reads `activeTable` from the store at execution time
  // rather than carrying it in the dep array, so re-runs don't fire
  // every time the user picks a different table (which would re-fetch
  // the table list unnecessarily). Without this split, the previous
  // shape needed `eslint-disable-next-line` to suppress the missing dep.
  useEffect(() => {
    let cancelled = false
    void fetchTablesOnce(false).then(result => {
      if (cancelled || !result) return
      const current = useDataViewerStore.getState().activeTable
      const next = current && result.includes(current) ? current : result[0] ?? null
      if (next !== current) setActiveTable(next)
    })
    return () => { cancelled = true }
  }, [fetchTablesOnce, setActiveTable])

  // Load rows when the active table, page, page size, or source changes.
  // Extracted so the manual "Refresh rows" button can replay the same call
  // with cache invalidation — see invalidateCache below.
  const loadRows = useCallback(
    async (forceRefresh: boolean = false) => {
      if (!project || !activeTable) {
        rowRequestEpoch.current += 1
        setColumns([])
        setColumnInfo([])
        setRows([])
        setRowIds([])
        setTotalRows(0)
        setSelectedCell(null)
        setRowsLoading(false)
        return
      }
      rowRequestEpoch.current += 1
      const epoch = rowRequestEpoch.current
      setRowsLoading(true)
      setError(null)
      try {
        if (forceRefresh) dataViewerService.invalidateCache(source, project.id, activeTable)
        const queryOptions = { filter: rowFilter, sort }
        const [count, data, info] = await Promise.all([
          dataViewerService.countRows(source, project, activeTable, rowFilter),
          dataViewerService.getRows(source, project, activeTable, page, pageSize, queryOptions),
          dataViewerService.getTableInfo(source, project, activeTable),
        ])
        if (epoch !== rowRequestEpoch.current) return
        setTotalRows(count)
        setColumns(data.columns)
        setColumnInfo(info)
        setRows(data.rows)
        setRowIds(data.rowIds ?? [])
      } catch (err) {
        if (epoch !== rowRequestEpoch.current) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setColumns([])
        setColumnInfo([])
        setRows([])
        setRowIds([])
        setTotalRows(0)
        setSelectedCell(null)
        const isPragmaUnsupported =
          err instanceof Error && err.name === 'PragmaUnsupportedError'
        void trackEvent('data_viewer_query_failed', {
          stage: 'get_rows',
          source,
          kind: isPragmaUnsupported ? 'pragma_unsupported' : 'generic',
        })
      } finally {
        if (epoch === rowRequestEpoch.current) setRowsLoading(false)
      }
    },
    [project, source, activeTable, page, pageSize, rowFilter, sort],
  )

  useEffect(() => {
    void loadRows(false)
  }, [loadRows])

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))

  function handleSourceChange(next: DataSource) {
    if (next === source || !project) return
    setRowFilter('')
    setSort(null)
    setSelectedCell(null)
    setSource(next, project.id)
    void trackEvent('data_viewer_source_switched', { from: source, to: next })
  }

  const handleTableSelect = useCallback((table: string) => {
    setRowFilter('')
    setSort(null)
    setSelectedCell(null)
    setActiveTable(table)
  }, [setActiveTable])

  const handlePageSizeChange = useCallback((size: typeof pageSize) => {
    setSelectedCell(null)
    setPageSize(size)
  }, [setPageSize])

  const handlePageChange = useCallback((nextPage: number) => {
    setSelectedCell(null)
    setPage(nextPage)
  }, [setPage])

  const handleFilterChange = useCallback((value: string) => {
    setRowFilter(value)
    setSelectedCell(null)
    setPage(1)
  }, [setPage])

  const handleSortChange = useCallback((column: string) => {
    setSort(current => {
      if (!current || current.column !== column) return { column, direction: 'asc' }
      if (current.direction === 'asc') return { column, direction: 'desc' }
      return null
    })
    setSelectedCell(null)
    setPage(1)
  }, [setPage])

  const handleExportCsv = useCallback(async () => {
    if (!project || !activeTable || exportingCsv) return
    const exportColumns = columns.length > 0 ? columns : columnInfo.map(c => c.name)
    if (exportColumns.length === 0) return

    setExportingCsv(true)
    try {
      const queryOptions = { filter: rowFilter, sort }
      const total = await dataViewerService.countRows(source, project, activeTable, rowFilter)
      const csvRows = [exportColumns.map(csvEscape).join(',')]
      const exportPageSize = 500
      const exportPages = Math.max(1, Math.ceil(total / exportPageSize))

      for (let exportPage = 1; exportPage <= exportPages; exportPage += 1) {
        const data = await dataViewerService.getRows(
          source,
          project,
          activeTable,
          exportPage,
          exportPageSize,
          queryOptions,
        )
        for (const row of data.rows) {
          csvRows.push(exportColumns.map((_, index) => csvEscape(row[index] ?? null)).join(','))
        }
        if (data.rows.length < exportPageSize) break
      }

      const blob = new Blob(['\ufeff' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${safeFilename(project.name)}-${source}-${safeFilename(activeTable)}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)

      void trackEvent('data_viewer_export_csv', {
        source,
        rows: total,
        filtered: rowFilter.trim().length > 0,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('data-viewer', 'exportCsv failed', err)
      setError(message)
      void trackEvent('data_viewer_query_failed', { stage: 'export_csv', source })
    } finally {
      setExportingCsv(false)
    }
  }, [activeTable, columnInfo, columns, exportingCsv, project, rowFilter, sort, source])

  const handleSubmitMutation = useCallback(async (values: RowValues) => {
    if (!project || !activeTable) return
    setMutatingRows(true)
    try {
      if (mutationDialog === 'add') {
        await dataViewerService.insertRow(source, project, activeTable, columnInfo, values)
        useToastStore.getState().addToast('success', t('dataViewer.rowAdded'))
      } else {
        if (!selectedCell) throw new Error(t('dataViewer.noRowSelected'))
        await dataViewerService.updateRow(
          source,
          project,
          activeTable,
          columnInfo,
          selectedCell.rowValues,
          selectedCell.rowId,
          values,
        )
        useToastStore.getState().addToast('success', t('dataViewer.rowUpdated'))
      }
      setMutationDialog(null)
      setSelectedCell(null)
      await loadRows(true)
    } catch (err) {
      logger.error('data-viewer', 'row mutation failed', err)
      throw err
    } finally {
      setMutatingRows(false)
    }
  }, [activeTable, columnInfo, loadRows, mutationDialog, project, selectedCell, source, t])

  const handleDeleteRow = useCallback(async () => {
    if (!project || !activeTable || !selectedCell || mutatingRows) return
    if (!window.confirm(t('dataViewer.deleteRowConfirm'))) return

    setMutatingRows(true)
    try {
      await dataViewerService.deleteRow(
        source,
        project,
        activeTable,
        columnInfo,
        selectedCell.rowValues,
        selectedCell.rowId,
      )
      useToastStore.getState().addToast('success', t('dataViewer.rowDeleted'))
      setSelectedCell(null)
      await loadRows(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('data-viewer', 'deleteRow failed', err)
      useToastStore.getState().addToast('error', `${t('dataViewer.deleteRowFailed')}: ${message}`, 10_000)
    } finally {
      setMutatingRows(false)
    }
  }, [activeTable, columnInfo, loadRows, mutatingRows, project, selectedCell, source, t])

  function handleSendProvisionPrompt() {
    // Drop a pre-filled message into the chat's draft input. The user
    // confirms before sending so we never auto-fire a tool call on their
    // behalf — they always retain veto.
    try {
      useChatStore.getState().setDraftInput('Cria uma migração Drizzle para o dev.db local; a base de dados de produção deve ser provisionada no Publish/deploy.')
      useLayoutStore.getState().setViewMode('chat')
    } catch {
      // setDraftInput may not exist on older builds — fail open and just
      // navigate; user can type the prompt themselves.
      useLayoutStore.getState().setViewMode('chat')
    }
  }

  if (!project) {
    return (
      <EmptyState
        title={t('dataViewer.noProject')}
        hint={t('dataViewer.noProjectHint')}
      />
    )
  }

  return (
    <Flex flex="1" overflow="hidden" direction="column">
      {/* Header — hidden in embedded mode (the host drawer supplies its own
          chrome and close affordance). The source toggle still needs to be
          reachable in embedded mode, so it gets a lighter inline strip. */}
      {!embedded ? (
        <Flex
          align="center"
          justify="space-between"
          px={4}
          h="48px"
          flexShrink={0}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        >
          <Flex align="center" gap={3}>
            <Box
              as="button"
              display="flex"
              alignItems="center"
              gap={2}
              color={tokens.colors.text.secondary}
              cursor="pointer"
              px={2}
              py="6px"
              borderRadius={tokens.radius.md}
              transition={tokens.transition.fast}
              _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
              onClick={() => useLayoutStore.getState().goBack()}
            >
              <FiArrowLeft size={14} />
              <Text fontSize="13px" fontWeight="500">{t('dataViewer.title')}</Text>
            </Box>
            <Box w="1px" h="16px" bg={tokens.colors.border.sidebarPanel} />
            <Text fontSize="12px" color={tokens.colors.text.muted}>
              {project.name}
            </Text>
          </Flex>

          <SourceToggle
            source={source}
            hasDev={hasDev}
            hasProd={hasProd}
            onChange={handleSourceChange}
          />
        </Flex>
      ) : (
        <Flex
          align="center"
          justify="flex-end"
          px={3}
          py="6px"
          flexShrink={0}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        >
          <SourceToggle
            source={source}
            hasDev={hasDev}
            hasProd={hasProd}
            onChange={handleSourceChange}
          />
        </Flex>
      )}

      <Flex flex="1" overflow="hidden">
        {/* Tables sidebar */}
        <TablesSidebar
          tables={tables}
          activeTable={activeTable}
          loading={tablesLoading}
          onSelect={handleTableSelect}
          onRefresh={refreshTables}
        />

        {/* Main area */}
        <Flex direction="column" flex="1" overflow="hidden">
          {!detectReady ? (
            <EmptyState title={t('dataViewer.detectingSources')} />
          ) : !hasDev && !hasProd ? (
            <EmptyState
              title={t('dataViewer.noDb')}
              hint={t('dataViewer.noDbHint')}
              actionLabel={t('dataViewer.noDbCta')}
              onAction={handleSendProvisionPrompt}
            />
          ) : error ? (
            <EmptyState title={t('dataViewer.errorTitle')} hint={error} variant="error" />
          ) : !activeTable ? (
            <EmptyState
              title={tables.length === 0 ? t('dataViewer.noTablesYet') : t('dataViewer.pickTable')}
              hint={
                tables.length === 0
                  ? t('dataViewer.noTablesYetHint')
                  : t('dataViewer.pickTableHint')
              }
            />
          ) : (
            <>
              <TableView
                table={activeTable}
                columns={columns}
                columnInfo={columnInfo}
                rows={rows}
                rowIds={rowIds}
                page={page}
                pageSize={pageSize}
                totalRows={totalRows}
                filter={rowFilter}
                sort={sort}
                selectedCell={selectedCell}
                onPageSizeChange={handlePageSizeChange}
                onFilterChange={handleFilterChange}
                onSortChange={handleSortChange}
                onSelectCell={setSelectedCell}
                onAddRow={() => setMutationDialog('add')}
                onEditRow={() => { if (selectedCell) setMutationDialog('edit') }}
                onDeleteRow={handleDeleteRow}
                onExportCsv={handleExportCsv}
                onRefresh={() => loadRows(true)}
                loading={rowsLoading}
                exporting={exportingCsv}
                mutating={mutatingRows}
              />
              <Pagination
                page={page}
                totalPages={totalPages}
                totalRows={totalRows}
                pageSize={pageSize}
                onChange={handlePageChange}
              />
            </>
          )}
        </Flex>
      </Flex>
      {activeTable && (
        <RowMutationDialog
          open={mutationDialog !== null}
          mode={mutationDialog ?? 'add'}
          table={activeTable}
          columns={columnInfo}
          initialValues={mutationDialog === 'edit' ? selectedCell?.rowValues ?? null : null}
          saving={mutatingRows}
          onClose={() => { if (!mutatingRows) setMutationDialog(null) }}
          onSubmit={handleSubmitMutation}
        />
      )}
    </Flex>
  )
}

function csvEscape(value: Cell): string {
  const raw = cellToText(value)
  if (!/[",\r\n]/.test(raw)) return raw
  return `"${raw.replace(/"/g, '""')}"`
}

function cellToText(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && value !== null && '__binary' in value) {
    const byteCount = typeof value.__binary === 'number' ? value.__binary : 0
    return `<binary, ${byteCount} bytes>`
  }
  return String(value)
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'data'
}

export default memo(DataViewerView)
