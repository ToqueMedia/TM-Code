import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Flex, Text, Box, HStack, Textarea } from '@chakra-ui/react'
import {
  VscCheck, VscRefresh, VscAdd, VscRemove, VscDiscard,
  VscChevronDown, VscChevronRight, VscSparkle,
  VscCloudUpload, VscCloudDownload,
} from 'react-icons/vsc'
import { useVirtualizer } from '@tanstack/react-virtual'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { GitService, type GitFileStatus } from '@/services/gitService'
import { useCurrentProject } from '@/hooks/useProjectState'
import { getFileIconByExtension } from '@/utils/iconMapper'

const statusMeta: Record<string, { color: string; label: string }> = {
  added:     { color: tokens.colors.accent.green, label: 'A' },
  untracked: { color: tokens.colors.accent.green, label: 'U' },
  modified:  { color: tokens.colors.accent.orange, label: 'M' },
  deleted:   { color: tokens.colors.accent.red, label: 'D' },
  renamed:   { color: tokens.colors.accent.purple, label: 'R' },
}

type FeedbackType = 'success' | 'error' | null
const ROW_HEIGHT = 22

function SourceControlPanel() {
  const currentProject = useCurrentProject()
  const projectPath = currentProject?.path ?? ''
  const projectName = currentProject?.name ?? ''

  const [files, setFiles] = useState<GitFileStatus[]>([])
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [feedback, setFeedback] = useState<{ type: FeedbackType; msg: string }>({ type: null, msg: '' })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const showFeedback = useCallback((type: 'success' | 'error', msg: string) => {
    setFeedback({ type, msg })
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    const duration = type === 'error' ? 6000 : 3000
    feedbackTimer.current = setTimeout(() => setFeedback({ type: null, msg: '' }), duration)
  }, [])

  // ── Load ──────────────────────────────────────────────────────────────

  const loadStatus = useCallback(async (showSpinner = false) => {
    if (!projectPath || loadingRef.current) return
    loadingRef.current = true
    if (showSpinner && mountedRef.current) setLoading(true)
    try {
      const [statusFiles, branchName] = await Promise.all([
        GitService.getStatusFiles(projectPath),
        GitService.getCurrentBranch(projectPath),
      ])
      if (mountedRef.current) { setFiles(statusFiles); setBranch(branchName) }
    } catch {
      if (mountedRef.current) setFiles([])
    } finally {
      if (showSpinner && mountedRef.current) setLoading(false)
      loadingRef.current = false
    }
  }, [projectPath])

  useEffect(() => {
    loadStatus(true)
    const id = setInterval(() => loadStatus(false), 6000)
    return () => clearInterval(id)
  }, [loadStatus])

  const staged = files.filter(f => f.staged)
  const unstaged = files.filter(f => !f.staged)

  // ── Actions (stable callbacks — no inline closures) ───────────────────

  const refreshGutter = useCallback((filePath?: string) => {
    window.dispatchEvent(new CustomEvent('git:refreshGutter', { detail: filePath ? `${projectPath}/${filePath}` : '' }))
  }, [projectPath])

  const onStageFile = useCallback(async (path: string) => {
    try { await GitService.stageFile(projectPath, path); await loadStatus(); refreshGutter(path) } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback, refreshGutter])

  const onUnstageFile = useCallback(async (path: string) => {
    try { await GitService.unstageFile(projectPath, path); await loadStatus(); refreshGutter(path) } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback, refreshGutter])

  const stageAll = useCallback(async () => {
    try { await GitService.stageAll(projectPath); await loadStatus() } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback])

  const unstageAll = useCallback(async () => {
    try { await GitService.unstageAll(projectPath); await loadStatus() } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback])

  const onDiscardFile = useCallback(async (path: string) => {
    const ok = await tauriConfirm(
      `Discard changes in "${path.split('/').pop()}"?\n\nThis cannot be undone.`,
      { title: 'Discard Changes', kind: 'warning' }
    )
    if (!ok) return
    try { await GitService.discardFile(projectPath, path); await loadStatus() } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback])

  const discardAll = useCallback(async () => {
    const ok = await tauriConfirm(
      `Discard ALL changes? This will restore tracked files and delete untracked files.\n\nThis cannot be undone.`,
      { title: 'Discard All Changes', kind: 'warning' }
    )
    if (!ok) return
    try { await GitService.discardAll(projectPath); await loadStatus() } catch (e) { showFeedback('error', String(e)) }
  }, [projectPath, loadStatus, showFeedback])

  const onOpenFile = useCallback((relPath: string) => {
    if (!projectPath) return
    // Open diff view (side-by-side comparison with HEAD)
    window.dispatchEvent(new CustomEvent('editor:open-diff', {
      detail: { relPath, projectPath }
    }))
  }, [projectPath])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || staged.length === 0) return
    setCommitting(true)
    try {
      await GitService.commit(projectPath, commitMsg.trim())
      if (!mountedRef.current) return
      setCommitMsg('')
      if (textareaRef.current) textareaRef.current.style.height = '26px'
      showFeedback('success', `Committed to ${branch}`)
      await loadStatus()
    } catch (e) {
      if (!mountedRef.current) return
      showFeedback('error', `Commit failed: ${e}`)
    }
    if (mountedRef.current) setCommitting(false)
  }, [projectPath, commitMsg, staged.length, loadStatus, showFeedback, branch])

  const [generating, setGenerating] = useState(false)

  const handleGenerateCommitMsg = useCallback(async () => {
    if (files.length === 0 || generating) return
    setGenerating(true)
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')

      // Get the actual diff for context
      const diffResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        {
          command: staged.length > 0 ? 'git diff --cached --stat' : 'git diff --stat HEAD',
          cwd: projectPath,
          timeoutSecs: 5,
        }
      )
      const diffStat = diffResult.success ? diffResult.stdout.trim() : ''

      // Get detailed diff (limited to avoid huge payloads)
      const detailResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        {
          command: staged.length > 0
            ? 'git diff --cached --no-color -U2 | head -200'
            : 'git diff --no-color -U2 HEAD | head -200',
          cwd: projectPath,
          timeoutSecs: 5,
        }
      )
      const diffDetail = detailResult.success ? detailResult.stdout.trim() : ''

      // File list with statuses
      const targetFiles = staged.length > 0 ? staged : unstaged
      const fileList = targetFiles.map(f => `${f.status}: ${f.path}`).join('\n')

      // Call the AI via the backend
      const FirebaseAuthService = (await import('../../services/auth/firebaseAuth')).default
      let token = await FirebaseAuthService.getInstance().getIdToken()
      if (!token) token = await FirebaseAuthService.getInstance().getIdToken(true)
      if (!token) throw new Error('Not authenticated — try signing out and back in')

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'
      const response = await fetch(`${workerUrl}/v1/commit-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Generate a git commit message for these changes using conventional commits format.

Format:
<type>(<scope>): <subject line, max 72 chars>

<body: 2-4 bullet points explaining what changed and why>

Rules:
- type: feat, fix, refactor, chore, docs, style, perf, test
- scope: the main area affected (component name, service, etc.)
- subject: imperative mood, lowercase, no period
- body: each line starts with "- ", explain what not how
- Output ONLY the commit message, no quotes, no markdown, no explanation

Files changed:
${fileList}

Diff stat:
${diffStat}

Diff detail:
${diffDetail.slice(0, 4000)}`,
          }],
        }),
      })

      if (!response.ok) throw new Error(`API ${response.status}`)

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      let aiMsg = data.choices?.[0]?.message?.content?.trim() || ''

      if (aiMsg) {
        // Clean up: remove quotes, backticks, "commit message:" prefixes
        const cleaned = aiMsg
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/^(commit message:?\s*)/i, '')
          .split('\n')[0]
          .trim()
        setCommitMsg(cleaned)
        if (textareaRef.current) {
          textareaRef.current.style.height = '26px'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 208)}px`
        }
      } else {
        showFeedback('error', 'AI returned empty message')
      }
    } catch (e) {
      showFeedback('error', `Generate failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setGenerating(false)
    }
  }, [files, staged, unstaged, projectPath, generating, showFeedback])

  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)

  const handlePush = useCallback(async () => {
    if (!projectPath || pushing) return
    setPushing(true)
    try {
      const result = await GitService.push(projectPath)
      showFeedback('success', result || `Pushed to ${branch}`)
    } catch (e) {
      showFeedback('error', `Push: ${e instanceof Error ? e.message : e}`)
    } finally {
      setPushing(false)
    }
  }, [projectPath, branch, showFeedback, pushing])

  const handlePull = useCallback(async () => {
    if (!projectPath || pulling) return
    setPulling(true)
    try {
      const result = await GitService.pull(projectPath)
      showFeedback('success', result || `Pulled from ${branch}`)
      await loadStatus()
    } catch (e) {
      showFeedback('error', `Pull: ${e instanceof Error ? e.message : e}`)
    } finally {
      setPulling(false)
    }
  }, [projectPath, branch, showFeedback, loadStatus, pulling])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommit()
    }
  }, [handleCommit])

  const canCommit = commitMsg.trim().length > 0 && staged.length > 0

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Flex direction="column" height="100%" overflow="hidden">

      {/* ── Header ────────────────────────────────────────────── */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="34px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.05em">
          Source Control
        </Text>
      </Flex>

      {/* ── Sub-header ────────────────────────────────────────── */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        h="28px"
        flexShrink={0}
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
      >
        <HStack gap={1}>
          <VscChevronDown size={11} color={tokens.colors.text.muted} />
          <Text fontSize="10px" fontWeight="700" color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.04em">
            Changes
          </Text>
        </HStack>
        <HStack gap={0}>
          <ActionIcon icon={<VscCheck size={13} />} label={t("view.commit")} onClick={handleCommit} />
          <ActionIcon icon={<VscCloudDownload size={12} />} label="Pull" onClick={handlePull} spinning={pulling} />
          <ActionIcon icon={<VscCloudUpload size={12} />} label="Push" onClick={handlePush} spinning={pushing} />
          <ActionIcon icon={<VscRefresh size={12} />} label={t("view.refresh")} onClick={() => loadStatus(true)} spinning={loading} />
        </HStack>
      </Flex>

      {/* ── Commit input ──────────────────────────────────────── */}
      <Box px={2.5} pt={2} pb={1} flexShrink={0} position="relative">
        <Textarea
          ref={textareaRef}
          value={commitMsg}
          onChange={e => {
            setCommitMsg(e.target.value)
            // Auto-resize: use ref to ensure we target the real textarea element
            const el = textareaRef.current
            if (el) {
              el.style.height = '26px'
              el.style.height = `${Math.min(el.scrollHeight, 208)}px`
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={`Message (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to commit on "${branch}")`}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          fontSize="12px"
          fontFamily={tokens.fontFamily.ui}
          bg={tokens.colors.bg.input}
          border={`1px solid ${tokens.colors.border.input}`}
          borderRadius="4px"
          color={tokens.colors.text.primary}
          _placeholder={{ color: tokens.colors.text.disabled, fontSize: '11px' }}
          _focus={{
            borderColor: tokens.colors.accent.primaryBorder,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primarySubtle}`,
          }}
          resize="none"
          px={2}
          py="4px"
          minH="26px"
          maxH="208px"
          overflowY="auto"
          lineHeight="18px"
          pr="28px"
        />
        {/* AI generate commit message */}
        {files.length > 0 && (
          <Box
            as="button"
            position="absolute"
            right="14px"
            top="12px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            w="20px"
            h="20px"
            borderRadius="4px"
            color={generating ? tokens.colors.accent.primary : tokens.colors.text.disabled}
            bg="transparent"
            cursor={generating ? 'default' : 'pointer'}
            transition={`all ${tokens.transition.fast}`}
            _hover={generating ? {} : { color: tokens.colors.accent.primary, bg: tokens.colors.accent.primarySubtle }}
            onClick={handleGenerateCommitMsg}
            title="Generate commit message"
          >
            {generating ? (
              <Box
                w="12px"
                h="12px"
                borderRadius="full"
                border="2px solid transparent"
                borderTopColor={tokens.colors.accent.primary}
                css={{ animation: 'spin 0.7s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }}
              />
            ) : (
              <VscSparkle size={13} />
            )}
          </Box>
        )}
      </Box>

      {/* ── Commit button ─────────────────────────────────────── */}
      <Box px={2.5} pb={1.5} pt={0.5} flexShrink={0}>
        <Flex
          as="button"
          align="center"
          justify="center"
          gap={1.5}
          w="100%"
          h="28px"
          borderRadius="4px"
          bg={canCommit ? tokens.colors.accent.primary : tokens.colors.accent.primarySubtle}
          color={canCommit ? '#fff' : tokens.colors.text.disabled}
          cursor={canCommit ? 'pointer' : 'default'}
          fontSize="12px"
          fontWeight="600"
          fontFamily={tokens.fontFamily.ui}
          transition={`all ${tokens.transition.fast}`}
          _hover={canCommit ? { bg: tokens.colors.accent.primaryDark } : {}}
          onClick={handleCommit}
          opacity={committing ? 0.6 : 1}
        >
          <VscCheck size={13} />
          <Text>{t("view.commit")}</Text>
        </Flex>
      </Box>

      {/* ── Feedback toast ────────────────────────────────────── */}
      {feedback.type && (
        <Box px={2.5} pb={1.5} flexShrink={0}>
          <Flex
            align="center"
            gap={1.5}
            px={2}
            py="4px"
            borderRadius="4px"
            bg={feedback.type === 'success' ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle}
            border={`1px solid ${feedback.type === 'success' ? tokens.colors.accent.greenMuted : tokens.colors.accent.redMuted}`}
          >
            <VscCheck size={11} color={feedback.type === 'success' ? tokens.colors.accent.green : tokens.colors.accent.red} />
            <Text
              fontSize="11px"
              color={feedback.type === 'success' ? tokens.colors.accent.greenBright : tokens.colors.accent.red}
              truncate
            >
              {feedback.msg}
            </Text>
          </Flex>
        </Box>
      )}

      {/* ── File lists (virtualized) ──────────────────────────── */}
      <Box flex={1} overflow="hidden">
        {files.length === 0 && !loading && (
          <Flex direction="column" align="center" justify="center" py={8} gap={2}>
            <VscCheck size={14} color={tokens.colors.text.disabled} />
            <Text fontSize="12px" color={tokens.colors.text.muted}>{t("view.noChanges")}</Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>{t("view.workingTreeClean")}</Text>
          </Flex>
        )}

        {files.length > 0 && (
          <VirtualFileList
            staged={staged}
            unstaged={unstaged}
            stagedOpen={stagedOpen}
            changesOpen={changesOpen}
            projectName={projectName}
            onToggleStaged={() => setStagedOpen(v => !v)}
            onToggleChanges={() => setChangesOpen(v => !v)}
            onOpenFile={onOpenFile}
            onStageFile={onStageFile}
            onUnstageFile={onUnstageFile}
            onDiscardFile={onDiscardFile}
            onStageAll={stageAll}
            onUnstageAll={unstageAll}
            onDiscardAll={discardAll}
          />
        )}
      </Box>
    </Flex>
  )
}

// ── Virtual File List ────────────────────────────────────────────────────
// Flattens sections + files into a single virtual list for O(visible) rendering

type ListItem =
  | { type: 'header'; section: 'staged' | 'unstaged'; count: number; isOpen: boolean }
  | { type: 'file'; file: GitFileStatus; section: 'staged' | 'unstaged' }

const VirtualFileList = memo<{
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  stagedOpen: boolean
  changesOpen: boolean
  projectName: string
  onToggleStaged: () => void
  onToggleChanges: () => void
  onOpenFile: (path: string) => void
  onStageFile: (path: string) => void
  onUnstageFile: (path: string) => void
  onDiscardFile: (path: string) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardAll: () => void
}>(({
  staged, unstaged, stagedOpen, changesOpen, projectName,
  onToggleStaged, onToggleChanges,
  onOpenFile, onStageFile, onUnstageFile, onDiscardFile,
  onStageAll, onUnstageAll, onDiscardAll,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Build flat list of items
  const items: ListItem[] = []
  if (staged.length > 0) {
    items.push({ type: 'header', section: 'staged', count: staged.length, isOpen: stagedOpen })
    if (stagedOpen) {
      for (const f of staged) items.push({ type: 'file', file: f, section: 'staged' })
    }
  }
  if (unstaged.length > 0) {
    items.push({ type: 'header', section: 'unstaged', count: unstaged.length, isOpen: changesOpen })
    if (changesOpen) {
      for (const f of unstaged) items.push({ type: 'file', file: f, section: 'unstaged' })
    }
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  return (
    <div ref={scrollRef} style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vItem => {
          const item = items[vItem.index]
          return (
            <div
              key={vItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${vItem.size}px`,
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              {item.type === 'header' ? (
                <SectionHeader
                  label={item.section === 'staged' ? 'Staged Changes' : 'Changes'}
                  count={item.count}
                  isOpen={item.isOpen}
                  onToggle={item.section === 'staged' ? onToggleStaged : onToggleChanges}
                  section={item.section}
                  onStageAll={onStageAll}
                  onUnstageAll={onUnstageAll}
                  onDiscardAll={onDiscardAll}
                />
              ) : (
                <FileRow
                  file={item.file}
                  section={item.section}
                  projectName={projectName}
                  onOpenFile={onOpenFile}
                  onStageFile={onStageFile}
                  onUnstageFile={onUnstageFile}
                  onDiscardFile={onDiscardFile}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

VirtualFileList.displayName = 'VirtualFileList'

// ── Section Header ───────────────────────────────────────────────────────

const SectionHeader = memo<{
  label: string
  count: number
  isOpen: boolean
  onToggle: () => void
  section: 'staged' | 'unstaged'
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardAll: () => void
}>(({ label, count, isOpen, onToggle, section, onStageAll, onUnstageAll, onDiscardAll }) => (
  <Flex
    align="center"
    justify="space-between"
    px={2}
    h={`${ROW_HEIGHT}px`}
    cursor="pointer"
    _hover={{ bg: tokens.colors.bg.hoverSubtle, '& .section-actions': { opacity: 1 } }}
    transition={`background ${tokens.transition.fast}`}
    onClick={onToggle}
    userSelect="none"
  >
    <HStack gap={1}>
      {isOpen
        ? <VscChevronDown size={11} color={tokens.colors.text.muted} />
        : <VscChevronRight size={11} color={tokens.colors.text.muted} />
      }
      <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.secondary}>
        {label}
      </Text>
    </HStack>
    <HStack gap={0.5}>
      <Box
        className="section-actions"
        opacity={0}
        transition={`opacity ${tokens.transition.fast}`}
        onClick={e => e.stopPropagation()}
        display="flex"
      >
        {section === 'staged' ? (
          <ActionIcon icon={<VscRemove size={13} />} label={t("view.unstageAll")} onClick={onUnstageAll} />
        ) : (
          <HStack gap={0}>
            <ActionIcon icon={<VscDiscard size={12} />} label={t("view.discardAllChanges")} onClick={onDiscardAll} />
            <ActionIcon icon={<VscAdd size={13} />} label={t("view.stageAll")} onClick={onStageAll} />
          </HStack>
        )}
      </Box>
      <Box
        px={1.5}
        borderRadius={tokens.radius.full}
        bg="rgba(255, 255, 255, 0.1)"
        minW="18px"
        textAlign="center"
      >
        <Text fontSize="10px" fontWeight="600" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} lineHeight="16px">
          {count}
        </Text>
      </Box>
    </HStack>
  </Flex>
))

SectionHeader.displayName = 'SectionHeader'

// ── File Row ─────────────────────────────────────────────────────────────
// Receives stable callbacks (path-based) instead of inline closures

const FileRow = memo<{
  file: GitFileStatus
  section: 'staged' | 'unstaged'
  projectName: string
  onOpenFile: (path: string) => void
  onStageFile: (path: string) => void
  onUnstageFile: (path: string) => void
  onDiscardFile: (path: string) => void
}>(({ file, section, projectName, onOpenFile, onStageFile, onUnstageFile, onDiscardFile }) => {
  const cfg = statusMeta[file.status] || statusMeta.modified
  const fileName = file.path.split('/').pop() || file.path
  const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''
  const ext = fileName.split('.').pop()?.toLowerCase()
  const iconUrl = getFileIconByExtension(ext, fileName)

  return (
    <Flex
      align="center"
      gap={1.5}
      px={2}
      pl={5}
      h={`${ROW_HEIGHT}px`}
      cursor="pointer"
      _hover={{ bg: tokens.colors.bg.hoverSubtle, '& .file-actions': { opacity: 1 } }}
      onClick={() => onOpenFile(file.path)}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} />
      ) : (
        <div style={{ width: 14, height: 14, flexShrink: 0 }} />
      )}

      <Text
        fontSize="12px"
        color={tokens.colors.text.primary}
        fontFamily={tokens.fontFamily.ui}
        fontWeight="400"
        whiteSpace="nowrap"
        flexShrink={0}
      >
        {fileName}
      </Text>

      <Text
        flex={1}
        fontSize="11px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.ui}
        truncate
        whiteSpace="nowrap"
      >
        {projectName}{dirPath ? ` • ${dirPath}` : ''}
      </Text>

      <div
        className="file-actions"
        style={{ opacity: 0, transition: `opacity ${tokens.transition.fast}`, display: 'flex', flexShrink: 0 }}
        onClick={e => e.stopPropagation()}
      >
        {section === 'staged' ? (
          <ActionIcon icon={<VscRemove size={12} />} label={t("view.unstage")} onClick={() => onUnstageFile(file.path)} />
        ) : (
          <>
            <ActionIcon icon={<VscDiscard size={11} />} label={t("view.discardChanges")} onClick={() => onDiscardFile(file.path)} />
            <ActionIcon icon={<VscAdd size={12} />} label={t("view.stage")} onClick={() => onStageFile(file.path)} />
          </>
        )}
      </div>

      <Text
        fontSize="11px"
        fontWeight="700"
        fontFamily={tokens.fontFamily.mono}
        color={cfg.color}
        flexShrink={0}
        w="14px"
        textAlign="right"
      >
        {cfg.label}
      </Text>
    </Flex>
  )
}, (prev, next) =>
  prev.file.path === next.file.path &&
  prev.file.status === next.file.status &&
  prev.file.staged === next.file.staged &&
  prev.section === next.section &&
  prev.projectName === next.projectName
)

FileRow.displayName = 'FileRow'

// ── Action Icon Button ───────────────────────────────────────────────────

const ActionIcon = memo<{
  icon: React.ReactNode
  label: string
  onClick: () => void
  spinning?: boolean
}>(({ icon, label, onClick, spinning }) => (
  <div
    role="button"
    title={label}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: 3,
      color: tokens.colors.text.muted,
      cursor: 'pointer',
      flexShrink: 0,
    }}
    onClick={(e) => { e.stopPropagation(); onClick() }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLDivElement).style.color = tokens.colors.text.primary;
      (e.currentTarget as HTMLDivElement).style.backgroundColor = tokens.colors.bg.hoverSubtle
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLDivElement).style.color = tokens.colors.text.muted;
      (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'
    }}
  >
    <span style={spinning ? { animation: 'spin 1s linear infinite' } : undefined}>
      {icon}
    </span>
  </div>
))

ActionIcon.displayName = 'ActionIcon'

export default memo(SourceControlPanel)
