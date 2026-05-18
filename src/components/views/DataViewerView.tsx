import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiArrowLeft } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { useLayoutStore } from '../../stores/layoutStore'
import { useChatStore } from '../../stores/chatStore'
import { useDataViewerStore, type DataSource } from '../../stores/dataViewerStore'
import { useCurrentProject } from '../../hooks/useProjectState'
import * as dataViewerService from '../../services/dataViewerService'
import type { Cell, ProjectContext } from '../../services/dataViewerService'
import TablesSidebar from '../data-viewer/TablesSidebar'
import TableView from '../data-viewer/TableView'
import Pagination from '../data-viewer/Pagination'
import SourceToggle from '../data-viewer/SourceToggle'
import EmptyState from '../data-viewer/EmptyState'
import { logger } from '../../utils/logger'
import { trackEvent } from '../../services/analytics'

function DataViewerView() {
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
  const [rows, setRows] = useState<Cell[][]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Race guard: discard results from a stale (project, source) once the
  // active selection has changed.
  const requestEpoch = useRef(0)
  // One-shot guard for the "opened" telemetry event — fires once per mount.
  const openedTrackedRef = useRef(false)

  const project: ProjectContext | null = currentProject
    ? { path: currentProject.path, id: currentProject.id, name: currentProject.name }
    : null

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
      .then((result) => {
        if (cancelled) return
        setHasDev(result.hasDevDb)
        setHasProd(result.hasProdConfig)
        const fallback: DataSource =
          result.hasDevDb ? 'dev' : result.hasProdConfig ? 'prod' : 'dev'
        hydrate(project.id, fallback)
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

  // Load tables when the project or source changes.
  const loadTables = useCallback(
    async (forceRefresh: boolean = false) => {
      if (!project || !detectReady) return
      requestEpoch.current += 1
      const epoch = requestEpoch.current
      setTablesLoading(true)
      setError(null)
      try {
        if (forceRefresh) dataViewerService.invalidateCache(source, project.id)
        const result = await dataViewerService.listTables(source, project)
        if (epoch !== requestEpoch.current) return
        setTables(result)
        // Auto-select the first table when none is active or the active one
        // disappeared after switching sources.
        const next = activeTable && result.includes(activeTable) ? activeTable : result[0] ?? null
        if (next !== activeTable) setActiveTable(next)
      } catch (err) {
        if (epoch !== requestEpoch.current) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setTables([])
        void trackEvent('data_viewer_query_failed', { stage: 'list_tables', source })
      } finally {
        if (epoch === requestEpoch.current) setTablesLoading(false)
      }
    },
    [project, source, detectReady, activeTable, setActiveTable],
  )

  useEffect(() => {
    loadTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, source, detectReady])

  // Load rows when the active table, page, page size, or source changes.
  // Extracted so the manual "Refresh rows" button can replay the same call
  // with cache invalidation — see invalidateCache below.
  const loadRows = useCallback(
    async (forceRefresh: boolean = false) => {
      if (!project || !activeTable) {
        setColumns([])
        setRows([])
        setTotalRows(0)
        return
      }
      setRowsLoading(true)
      setError(null)
      try {
        if (forceRefresh) dataViewerService.invalidateCache(source, project.id, activeTable)
        const [count, data] = await Promise.all([
          dataViewerService.countRows(source, project, activeTable),
          dataViewerService.getRows(source, project, activeTable, page, pageSize),
        ])
        setTotalRows(count)
        setColumns(data.columns)
        setRows(data.rows)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setColumns([])
        setRows([])
        setTotalRows(0)
        void trackEvent('data_viewer_query_failed', { stage: 'get_rows', source })
      } finally {
        setRowsLoading(false)
      }
    },
    [project, source, activeTable, page, pageSize],
  )

  useEffect(() => {
    let cancelled = false
    if (!project || !activeTable) {
      setColumns([])
      setRows([])
      setTotalRows(0)
      return
    }
    // Use the callback's logic but tolerate cancellation — if the user
    // changes table mid-fetch, the in-flight result is discarded.
    setRowsLoading(true)
    setError(null)
    Promise.all([
      dataViewerService.countRows(source, project, activeTable),
      dataViewerService.getRows(source, project, activeTable, page, pageSize),
    ])
      .then(([count, data]) => {
        if (cancelled) return
        setTotalRows(count)
        setColumns(data.columns)
        setRows(data.rows)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setColumns([])
        setRows([])
        setTotalRows(0)
        void trackEvent('data_viewer_query_failed', { stage: 'get_rows', source })
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project?.id, project?.path, source, activeTable, page, pageSize])

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))

  function handleSourceChange(next: DataSource) {
    if (next === source || !project) return
    setSource(next, project.id)
    void trackEvent('data_viewer_source_switched', { from: source, to: next })
  }

  function handleSendProvisionPrompt() {
    // Drop a pre-filled message into the chat's draft input. The user
    // confirms before sending so we never auto-fire a tool call on their
    // behalf — they always retain veto.
    try {
      useChatStore.getState().setDraftInput('Corre provision_database para preparar a base de dados em produção.')
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
      {/* Header */}
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

      <Flex flex="1" overflow="hidden">
        {/* Tables sidebar */}
        <TablesSidebar
          tables={tables}
          activeTable={activeTable}
          loading={tablesLoading}
          onSelect={setActiveTable}
          onRefresh={() => loadTables(true)}
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
                rows={rows}
                pageSize={pageSize}
                onPageSizeChange={setPageSize}
                onRefresh={() => loadRows(true)}
                loading={rowsLoading}
              />
              <Pagination
                page={page}
                totalPages={totalPages}
                totalRows={totalRows}
                pageSize={pageSize}
                onChange={setPage}
              />
            </>
          )}
        </Flex>
      </Flex>
    </Flex>
  )
}

export default memo(DataViewerView)
