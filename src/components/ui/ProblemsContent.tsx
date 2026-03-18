import { memo, useCallback, useEffect, useMemo } from 'react'
import { Flex, Text, Box, ScrollArea, HStack, Spinner } from '@chakra-ui/react'
import { FiAlertTriangle, FiXCircle, FiInfo, FiRefreshCw, FiFile, FiChevronRight } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import {
  useProblemsStore,
  selectDiagnosticsByFile,
  selectErrorCount,
  selectWarningCount,
  selectInfoCount,
} from '@/stores/problemsStore'
import { useEditorRepository } from '@/stores/editorStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import type { Diagnostic } from '@/stores/problemsStore'

const severityIcon = (severity: Diagnostic['severity']) => {
  switch (severity) {
    case 'error': return FiXCircle
    case 'warning': return FiAlertTriangle
    case 'info': return FiInfo
  }
}

const severityColor = (severity: Diagnostic['severity']) => {
  switch (severity) {
    case 'error': return tokens.colors.accent.red
    case 'warning': return tokens.colors.accent.orange
    case 'info': return tokens.colors.accent.blueBright
  }
}

const relativePath = (fullPath: string, root: string | null) => {
  if (!root || !fullPath.startsWith(root)) return fullPath
  return fullPath.slice(root.length + 1)
}

const ProblemsContent = memo(() => {
  const grouped = useProblemsStore(selectDiagnosticsByFile)
  const errorCount = useProblemsStore(selectErrorCount)
  const warningCount = useProblemsStore(selectWarningCount)
  const infoCount = useProblemsStore(selectInfoCount)
  const isScanning = useProblemsStore(s => s.isScanning)
  const scanProject = useProblemsStore(s => s.scanProject)
  const lastScanAt = useProblemsStore(s => s.lastScanAt)
  const projectRoot = useProjectStore(s => s.currentProject?.path ?? null)

  const openFile = useEditorRepository(s => s.openFile)
  const setCursorPosition = useEditorRepository(s => s.setCursorPosition)
  const setViewMode = useLayoutStore(s => s.setViewMode)

  // Auto-scan on first mount if never scanned
  useEffect(() => {
    if (!lastScanAt && !isScanning) {
      scanProject()
    }
  }, [lastScanAt, isScanning, scanProject])

  const handleNavigate = useCallback(async (diag: Diagnostic) => {
    await openFile(diag.file)
    setCursorPosition(diag.file, diag.line, diag.column)
    setViewMode('editor')
    // Tell the Monaco editor to reveal the position once it's mounted/active
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('monaco:revealPosition', {
        detail: { file: diag.file, line: diag.line, column: diag.column },
      }))
    })
  }, [openFile, setCursorPosition, setViewMode])

  const sortedFiles = useMemo(() => {
    return Object.entries(grouped).sort(([, a], [, b]) => {
      const aErrors = a.filter(d => d.severity === 'error').length
      const bErrors = b.filter(d => d.severity === 'error').length
      return bErrors - aErrors
    })
  }, [grouped])

  const totalCount = errorCount + warningCount + infoCount

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Summary bar */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py={1.5}
        borderBottom="1px solid"
        borderColor={tokens.colors.border.glass}
        bg={tokens.colors.bg.panel}
        flexShrink={0}
      >
        <HStack gap={4}>
          <HStack gap={1.5}>
            <FiXCircle size={12} color={tokens.colors.accent.red} />
            <Text fontSize="xs" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
              {errorCount}
            </Text>
          </HStack>
          <HStack gap={1.5}>
            <FiAlertTriangle size={12} color={tokens.colors.accent.orange} />
            <Text fontSize="xs" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
              {warningCount}
            </Text>
          </HStack>
          <HStack gap={1.5}>
            <FiInfo size={12} color={tokens.colors.accent.blueBright} />
            <Text fontSize="xs" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>
              {infoCount}
            </Text>
          </HStack>
        </HStack>

        <HStack gap={2}>
          {isScanning && (
            <Spinner size="xs" color={tokens.colors.accent.primary} />
          )}
          <Box
            as="button"
            onClick={() => scanProject()}
            cursor="pointer"
            color={tokens.colors.text.muted}
            _hover={{ color: tokens.colors.text.primary }}
            transition={tokens.transition.fast}
            p={1}
            borderRadius={tokens.radius.sm}
          >
            <FiRefreshCw size={13} />
          </Box>
        </HStack>
      </Flex>

      {/* Content */}
      <ScrollArea.Root flex="1">
        <ScrollArea.Viewport>
          {totalCount === 0 && !isScanning ? (
            <Flex
              align="center"
              justify="center"
              py={8}
              direction="column"
              gap={2}
            >
              <Text fontSize="sm" color={tokens.colors.text.muted}>
                No problems detected
              </Text>
              <Text fontSize="xs" color={tokens.colors.text.disabled}>
                Click refresh to scan the project
              </Text>
            </Flex>
          ) : (
            sortedFiles.map(([filePath, diags]) => (
              <Box key={filePath}>
                {/* File header */}
                <Flex
                  align="center"
                  gap={2}
                  px={3}
                  py={1.5}
                  bg={tokens.colors.bg.panelAlt}
                  borderBottom="1px solid"
                  borderColor={tokens.colors.border.glass}
                >
                  <FiFile size={12} color={tokens.colors.text.muted} />
                  <Text
                    fontSize="xs"
                    color={tokens.colors.text.primary}
                    fontFamily={tokens.fontFamily.mono}
                    fontWeight="500"
                    flex="1"
                    truncate
                  >
                    {relativePath(filePath, projectRoot)}
                  </Text>
                  <Text
                    fontSize="xs"
                    color={tokens.colors.text.disabled}
                    fontFamily={tokens.fontFamily.mono}
                  >
                    {diags.length}
                  </Text>
                </Flex>

                {/* Diagnostics */}
                {diags.map((diag) => {
                  const Icon = severityIcon(diag.severity)
                  const color = severityColor(diag.severity)

                  return (
                    <Flex
                      key={diag.id}
                      align="center"
                      px={3}
                      pl={6}
                      py={1.5}
                      gap={2}
                      cursor="pointer"
                      borderBottom="1px solid"
                      borderColor={tokens.colors.border.glass}
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      transition={tokens.transition.fast}
                      onClick={() => handleNavigate(diag)}
                    >
                      <Icon size={13} color={color} style={{ flexShrink: 0 }} />
                      <Text
                        fontSize="xs"
                        color={tokens.colors.text.primary}
                        flex="1"
                        truncate
                      >
                        {diag.message}
                      </Text>
                      <HStack gap={1} flexShrink={0}>
                        <Text
                          fontSize="xs"
                          color={tokens.colors.text.disabled}
                          fontFamily={tokens.fontFamily.mono}
                        >
                          [{diag.line},{diag.column}]
                        </Text>
                        {diag.code > 0 && (
                          <Text
                            fontSize="xs"
                            color={tokens.colors.text.disabled}
                            fontFamily={tokens.fontFamily.mono}
                          >
                            TS{diag.code}
                          </Text>
                        )}
                        <FiChevronRight size={10} color={tokens.colors.text.disabled} />
                      </HStack>
                    </Flex>
                  )
                })}
              </Box>
            ))
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </Flex>
  )
})

ProblemsContent.displayName = 'ProblemsContent'

export default ProblemsContent
