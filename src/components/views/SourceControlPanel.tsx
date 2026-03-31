import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Flex, Text, Box, HStack } from '@chakra-ui/react'
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
  added:     { color: tokens.colors.accent.greenBright, label: 'A' },
  untracked: { color: tokens.colors.accent.greenBright, label: 'U' },
  modified:  { color: tokens.colors.accent.orangeBright, label: 'M' },
  deleted:   { color: tokens.colors.accent.red, label: 'D' },
  renamed:   { color: tokens.colors.accent.purple, label: 'R' },
}

type FeedbackType = 'success' | 'error' | null
const ROW_HEIGHT = 28

// ── Styles (injected once) ──────────────────────────────────────────────

const PANEL_STYLES = `
.sc-textarea {
  width: 100%;
  min-height: 30px;
  max-height: 200px;
  padding: 6px 32px 6px 8px;
  border: 1px solid ${tokens.colors.border.input};
  border-radius: 4px;
  background: ${tokens.colors.bg.input};
  color: ${tokens.colors.text.primary};
  font-family: ${tokens.fontFamily.ui};
  font-size: 12px;
  line-height: 18px;
  resize: none;
  outline: none;
  overflow-y: auto;
  box-sizing: border-box;
}
.sc-textarea::placeholder {
  color: ${tokens.colors.text.disabled};
  font-size: 11px;
}
.sc-textarea:focus {
  border-color: ${tokens.colors.accent.primaryBorder};
  box-shadow: 0 0 0 1px ${tokens.colors.accent.primarySubtle};
}
.sc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: ${tokens.colors.text.muted};
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: all 0.1s ease;
}
.sc-btn:hover {
  color: ${tokens.colors.text.primary};
  background: ${tokens.colors.bg.hoverSubtle};
}
.sc-btn:active {
  transform: scale(0.92);
}
.sc-btn.accent:hover {
  color: ${tokens.colors.accent.primary};
  background: ${tokens.colors.accent.primarySubtle};
}
.sc-btn.green:hover {
  color: ${tokens.colors.accent.greenBright};
  background: ${tokens.colors.accent.greenSubtle};
}
.sc-btn.red:hover {
  color: ${tokens.colors.accent.red};
  background: ${tokens.colors.accent.redSubtle};
}
.sc-spin { animation: sc-spin 0.7s linear infinite; }
@keyframes sc-spin { to { transform: rotate(360deg); } }
`

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
  const [generating, setGenerating] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
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
    feedbackTimer.current = setTimeout(() => setFeedback({ type: null, msg: '' }), type === 'error' ? 6000 : 3000)
  }, [])

  // ── Auto-resize textarea ─────────────────────────────────────────────

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '30px'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  // ── Load git status ──────────────────────────────────────────────────

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

  // ── Git actions ──────────────────────────────────────────────────────

  const refreshGutter = useCallback((filePath?: string) => {
    window.dispatchEvent(new CustomEvent('git:refreshGutter', { detail: filePath ? `${projectPath}/${filePath}` : '' }))
  }, [projectPath])

  const onStageFile = useCallback(async (path: string) => {
    try { await GitService.stageFile(projectPath, path); await loadStatus(); refreshGutter(path) }
    catch (e) { showFeedback('error', `Stage: ${e}`) }
  }, [projectPath, loadStatus, showFeedback, refreshGutter])

  const onUnstageFile = useCallback(async (path: string) => {
    try { await GitService.unstageFile(projectPath, path); await loadStatus(); refreshGutter(path) }
    catch (e) { showFeedback('error', `Unstage: ${e}`) }
  }, [projectPath, loadStatus, showFeedback, refreshGutter])

  const stageAll = useCallback(async () => {
    try { await GitService.stageAll(projectPath); await loadStatus() }
    catch (e) { showFeedback('error', `Stage all: ${e}`) }
  }, [projectPath, loadStatus, showFeedback])

  const unstageAll = useCallback(async () => {
    try { await GitService.unstageAll(projectPath); await loadStatus() }
    catch (e) { showFeedback('error', `Unstage all: ${e}`) }
  }, [projectPath, loadStatus, showFeedback])

  const onDiscardFile = useCallback(async (path: string) => {
    const ok = await tauriConfirm(`Discard changes in "${path.split('/').pop()}"?\n\nThis cannot be undone.`, { title: 'Discard Changes', kind: 'warning' })
    if (!ok) return
    try { await GitService.discardFile(projectPath, path); await loadStatus() }
    catch (e) { showFeedback('error', `Discard: ${e}`) }
  }, [projectPath, loadStatus, showFeedback])

  const discardAll = useCallback(async () => {
    const ok = await tauriConfirm('Discard ALL changes?\n\nThis cannot be undone.', { title: 'Discard All', kind: 'warning' })
    if (!ok) return
    try { await GitService.discardAll(projectPath); await loadStatus() }
    catch (e) { showFeedback('error', `Discard all: ${e}`) }
  }, [projectPath, loadStatus, showFeedback])

  const onOpenFile = useCallback((relPath: string) => {
    if (!projectPath) return
    window.dispatchEvent(new CustomEvent('editor:open-diff', { detail: { relPath, projectPath } }))
  }, [projectPath])

  // ── Commit ───────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) { showFeedback('error', 'Enter a commit message'); return }
    if (staged.length === 0) { showFeedback('error', 'Stage files first'); return }
    setCommitting(true)
    try {
      await GitService.commit(projectPath, commitMsg.trim())
      if (!mountedRef.current) return
      setCommitMsg('')
      if (textareaRef.current) textareaRef.current.style.height = '30px'
      showFeedback('success', `Committed to ${branch}`)
      await loadStatus()
    } catch (e) {
      if (mountedRef.current) showFeedback('error', `Commit: ${e}`)
    }
    if (mountedRef.current) setCommitting(false)
  }, [projectPath, commitMsg, staged.length, loadStatus, showFeedback, branch])

  // ── Stage All & Commit (quick action) ────────────────────────────────

  const handleStageAllAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) { showFeedback('error', 'Enter a commit message'); return }
    setCommitting(true)
    try {
      await GitService.stageAll(projectPath)
      await GitService.commit(projectPath, commitMsg.trim())
      if (!mountedRef.current) return
      setCommitMsg('')
      if (textareaRef.current) textareaRef.current.style.height = '30px'
      showFeedback('success', `Committed all to ${branch}`)
      await loadStatus()
    } catch (e) {
      if (mountedRef.current) showFeedback('error', `Commit: ${e}`)
    }
    if (mountedRef.current) setCommitting(false)
  }, [projectPath, commitMsg, loadStatus, showFeedback, branch])

  // ── Push / Pull ──────────────────────────────────────────────────────

  const handlePush = useCallback(async () => {
    if (!projectPath || pushing) return
    setPushing(true)
    try {
      const result = await GitService.push(projectPath)
      showFeedback('success', result || `Pushed to ${branch}`)
    } catch (e) { showFeedback('error', `Push: ${e instanceof Error ? e.message : e}`) }
    finally { setPushing(false) }
  }, [projectPath, branch, showFeedback, pushing])

  const handlePull = useCallback(async () => {
    if (!projectPath || pulling) return
    setPulling(true)
    try {
      const result = await GitService.pull(projectPath)
      showFeedback('success', result || `Pulled from ${branch}`)
      await loadStatus()
    } catch (e) { showFeedback('error', `Pull: ${e instanceof Error ? e.message : e}`) }
    finally { setPulling(false) }
  }, [projectPath, branch, showFeedback, loadStatus, pulling])

  // ── AI commit message ────────────────────────────────────────────────

  const handleGenerateCommitMsg = useCallback(async () => {
    if (files.length === 0 || generating) return
    setGenerating(true)
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')
      const diffResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        { command: staged.length > 0 ? 'git diff --cached --stat' : 'git diff --stat HEAD', cwd: projectPath, timeoutSecs: 5 }
      )
      const diffStat = diffResult.success ? diffResult.stdout.trim() : ''
      const detailResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        { command: staged.length > 0 ? 'git diff --cached --no-color -U2 | head -200' : 'git diff --no-color -U2 HEAD | head -200', cwd: projectPath, timeoutSecs: 5 }
      )
      const diffDetail = detailResult.success ? detailResult.stdout.trim() : ''
      const targetFiles = staged.length > 0 ? staged : unstaged
      const fileList = targetFiles.map(f => `${f.status}: ${f.path}`).join('\n')

      const FirebaseAuthService = (await import('../../services/auth/firebaseAuth')).default
      let token = await FirebaseAuthService.getInstance().getIdToken()
      if (!token) token = await FirebaseAuthService.getInstance().getIdToken(true)
      if (!token) throw new Error('Not authenticated')

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'
      const response = await fetch(`${workerUrl}/v1/commit-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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
      const aiMsg = data.choices?.[0]?.message?.content?.trim() || ''

      if (aiMsg) {
        const cleaned = aiMsg.replace(/^["'`]+|["'`]+$/g, '').replace(/^(commit message:?\s*)/i, '').trim()
        setCommitMsg(cleaned)
        requestAnimationFrame(resizeTextarea)
      } else {
        showFeedback('error', 'AI returned empty message')
      }
    } catch (e) {
      showFeedback('error', `Generate failed: ${e instanceof Error ? e.message : e}`)
    } finally { setGenerating(false) }
  }, [files, staged, unstaged, projectPath, generating, showFeedback, resizeTextarea])

  // ── Keyboard ─────────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (staged.length > 0) handleCommit()
      else if (unstaged.length > 0) handleStageAllAndCommit()
    }
  }, [handleCommit, handleStageAllAndCommit, staged.length, unstaged.length])

  const canCommit = commitMsg.trim().length > 0 && staged.length > 0
  const canStageAndCommit = commitMsg.trim().length > 0 && staged.length === 0 && unstaged.length > 0

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <Flex direction="column" height="100%" overflow="hidden">
      <style>{PANEL_STYLES}</style>

      {/* Header */}
      <Flex align="center" justify="space-between" px={3} h="34px" flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.05em">
          Source Control
        </Text>
        <HStack gap={0}>
          <button className="sc-btn" title="Pull" onClick={handlePull}>
            {pulling ? <span className="sc-spin"><VscCloudDownload size={13} /></span> : <VscCloudDownload size={13} />}
          </button>
          <button className="sc-btn" title="Push" onClick={handlePush}>
            {pushing ? <span className="sc-spin"><VscCloudUpload size={13} /></span> : <VscCloudUpload size={13} />}
          </button>
          <button className="sc-btn" title={t("view.refresh")} onClick={() => loadStatus(true)}>
            {loading ? <span className="sc-spin"><VscRefresh size={13} /></span> : <VscRefresh size={13} />}
          </button>
        </HStack>
      </Flex>

      {/* Branch badge */}
      {branch && (
        <Flex px={3} py={1} flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.glass}`}>
          <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
            {branch}
          </Text>
        </Flex>
      )}

      {/* Commit area */}
      <Box px={2.5} pt={2} pb={1} flexShrink={0} position="relative">
        <textarea
          ref={textareaRef}
          className="sc-textarea"
          value={commitMsg}
          onChange={e => { setCommitMsg(e.target.value); resizeTextarea() }}
          onKeyDown={handleKeyDown}
          placeholder={`Commit message (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter)`}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {files.length > 0 && (
          <button
            className="sc-btn accent"
            style={{ position: 'absolute', right: 14, top: 12 }}
            title="Generate commit message"
            onClick={handleGenerateCommitMsg}
            disabled={generating}
          >
            {generating ? (
              <Box w="12px" h="12px" borderRadius="full" border="2px solid transparent" borderTopColor={tokens.colors.accent.primary} className="sc-spin" />
            ) : (
              <VscSparkle size={13} />
            )}
          </button>
        )}
      </Box>

      {/* Commit / Stage All & Commit buttons */}
      <Box px={2.5} pb={1.5} pt={0.5} flexShrink={0}>
        {canCommit ? (
          <button
            style={{
              width: '100%', height: 28, borderRadius: 4, border: 'none',
              background: tokens.colors.accent.primary, color: '#fff',
              fontSize: 12, fontWeight: 600, fontFamily: tokens.fontFamily.ui,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              opacity: committing ? 0.6 : 1, transition: `all ${tokens.transition.fast}`,
            }}
            onClick={handleCommit}
          >
            <VscCheck size={13} /> Commit
          </button>
        ) : canStageAndCommit ? (
          <button
            style={{
              width: '100%', height: 28, borderRadius: 4,
              border: `1px solid ${tokens.colors.accent.primaryMuted}`,
              background: tokens.colors.accent.primarySubtle, color: tokens.colors.accent.primary,
              fontSize: 12, fontWeight: 600, fontFamily: tokens.fontFamily.ui,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              opacity: committing ? 0.6 : 1, transition: `all ${tokens.transition.fast}`,
            }}
            onClick={handleStageAllAndCommit}
          >
            <VscAdd size={13} /> Stage All & Commit
          </button>
        ) : (
          <button
            style={{
              width: '100%', height: 28, borderRadius: 4, border: 'none',
              background: tokens.colors.accent.primarySubtle, color: tokens.colors.text.disabled,
              fontSize: 12, fontWeight: 600, fontFamily: tokens.fontFamily.ui,
              cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
            disabled
          >
            <VscCheck size={13} /> Commit
          </button>
        )}
      </Box>

      {/* Feedback */}
      {feedback.type && (
        <Box px={2.5} pb={1.5} flexShrink={0}>
          <Flex
            align="center" gap={1.5} px={2} py="5px" borderRadius="4px"
            bg={feedback.type === 'success' ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle}
            border={`1px solid ${feedback.type === 'success' ? tokens.colors.accent.greenMuted : tokens.colors.accent.redMuted}`}
          >
            <VscCheck size={11} color={feedback.type === 'success' ? tokens.colors.accent.green : tokens.colors.accent.red} />
            <Text fontSize="11px" color={feedback.type === 'success' ? tokens.colors.accent.greenBright : tokens.colors.accent.red} lineClamp={2}>
              {feedback.msg}
            </Text>
          </Flex>
        </Box>
      )}

      {/* File list */}
      <Box flex={1} overflow="hidden">
        {files.length === 0 && !loading && (
          <Flex direction="column" align="center" justify="center" py={8} gap={2}>
            <VscCheck size={16} color={tokens.colors.text.disabled} />
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

type ListItem =
  | { type: 'header'; section: 'staged' | 'unstaged'; count: number; isOpen: boolean }
  | { type: 'file'; file: GitFileStatus; section: 'staged' | 'unstaged' }

const VirtualFileList = memo<{
  staged: GitFileStatus[]; unstaged: GitFileStatus[]
  stagedOpen: boolean; changesOpen: boolean; projectName: string
  onToggleStaged: () => void; onToggleChanges: () => void
  onOpenFile: (path: string) => void
  onStageFile: (path: string) => void; onUnstageFile: (path: string) => void
  onDiscardFile: (path: string) => void
  onStageAll: () => void; onUnstageAll: () => void; onDiscardAll: () => void
}>(({
  staged, unstaged, stagedOpen, changesOpen,
  onToggleStaged, onToggleChanges,
  onOpenFile, onStageFile, onUnstageFile, onDiscardFile,
  onStageAll, onUnstageAll, onDiscardAll,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  const items: ListItem[] = []
  if (staged.length > 0) {
    items.push({ type: 'header', section: 'staged', count: staged.length, isOpen: stagedOpen })
    if (stagedOpen) for (const f of staged) items.push({ type: 'file', file: f, section: 'staged' })
  }
  if (unstaged.length > 0) {
    items.push({ type: 'header', section: 'unstaged', count: unstaged.length, isOpen: changesOpen })
    if (changesOpen) for (const f of unstaged) items.push({ type: 'file', file: f, section: 'unstaged' })
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
            <div key={vItem.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vItem.size, transform: `translateY(${vItem.start}px)` }}>
              {item.type === 'header' ? (
                <SectionHeader
                  label={item.section === 'staged' ? 'Staged Changes' : 'Changes'}
                  count={item.count} isOpen={item.isOpen}
                  onToggle={item.section === 'staged' ? onToggleStaged : onToggleChanges}
                  section={item.section}
                  onStageAll={onStageAll} onUnstageAll={onUnstageAll} onDiscardAll={onDiscardAll}
                />
              ) : (
                <FileRow
                  file={item.file} section={item.section}
                  onOpenFile={onOpenFile} onStageFile={onStageFile}
                  onUnstageFile={onUnstageFile} onDiscardFile={onDiscardFile}
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
  label: string; count: number; isOpen: boolean; onToggle: () => void
  section: 'staged' | 'unstaged'
  onStageAll: () => void; onUnstageAll: () => void; onDiscardAll: () => void
}>(({ label, count, isOpen, onToggle, section, onStageAll, onUnstageAll, onDiscardAll }) => (
  <div
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', height: ROW_HEIGHT, cursor: 'pointer', userSelect: 'none' }}
    onClick={onToggle}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {isOpen ? <VscChevronDown size={11} color={tokens.colors.text.muted} /> : <VscChevronRight size={11} color={tokens.colors.text.muted} />}
      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary }}>{label}</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={e => e.stopPropagation()}>
      {section === 'staged' ? (
        <button className="sc-btn" title={t("view.unstageAll")} onClick={onUnstageAll}><VscRemove size={13} /></button>
      ) : (
        <>
          <button className="sc-btn red" title={t("view.discardAllChanges")} onClick={onDiscardAll}><VscDiscard size={12} /></button>
          <button className="sc-btn green" title={t("view.stageAll")} onClick={onStageAll}><VscAdd size={13} /></button>
        </>
      )}
      <span style={{
        fontSize: 10, fontWeight: 600, color: tokens.colors.text.secondary,
        fontFamily: tokens.fontFamily.mono, lineHeight: '18px',
        padding: '0 5px', borderRadius: 9999, background: 'rgba(255,255,255,0.1)', minWidth: 18, textAlign: 'center',
      }}>
        {count}
      </span>
    </div>
  </div>
))
SectionHeader.displayName = 'SectionHeader'

// ── File Row ─────────────────────────────────────────────────────────────

const FileRow = memo<{
  file: GitFileStatus; section: 'staged' | 'unstaged'
  onOpenFile: (path: string) => void; onStageFile: (path: string) => void
  onUnstageFile: (path: string) => void; onDiscardFile: (path: string) => void
}>(({ file, section, onOpenFile, onStageFile, onUnstageFile, onDiscardFile }) => {
  const cfg = statusMeta[file.status] || statusMeta.modified
  const fileName = file.path.split('/').pop() || file.path
  const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''
  const ext = fileName.split('.').pop()?.toLowerCase()
  const iconUrl = getFileIconByExtension(ext, fileName)

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 20px', height: ROW_HEIGHT, cursor: 'pointer' }}
      onClick={() => onOpenFile(file.path)}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} />
      ) : (
        <div style={{ width: 14, height: 14, flexShrink: 0 }} />
      )}

      <span style={{ fontSize: 12, color: tokens.colors.text.primary, whiteSpace: 'nowrap', flexShrink: 0 }}>
        {fileName}
      </span>

      <span style={{ flex: 1, fontSize: 11, color: tokens.colors.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {dirPath && `${dirPath}`}
      </span>

      <div style={{ display: 'flex', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {section === 'staged' ? (
          <button className="sc-btn" title={t("view.unstage")} onClick={() => onUnstageFile(file.path)}><VscRemove size={12} /></button>
        ) : (
          <>
            <button className="sc-btn red" title={t("view.discardChanges")} onClick={() => onDiscardFile(file.path)}><VscDiscard size={11} /></button>
            <button className="sc-btn green" title={t("view.stage")} onClick={() => onStageFile(file.path)}><VscAdd size={12} /></button>
          </>
        )}
      </div>

      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: tokens.fontFamily.mono, color: cfg.color, flexShrink: 0, width: 14, textAlign: 'right' }}>
        {cfg.label}
      </span>
    </div>
  )
}, (prev, next) =>
  prev.file.path === next.file.path &&
  prev.file.status === next.file.status &&
  prev.file.staged === next.file.staged &&
  prev.section === next.section &&
  prev.onStageFile === next.onStageFile &&
  prev.onUnstageFile === next.onUnstageFile &&
  prev.onDiscardFile === next.onDiscardFile &&
  prev.onOpenFile === next.onOpenFile
)
FileRow.displayName = 'FileRow'

export default memo(SourceControlPanel)
