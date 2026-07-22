import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Flex, Text, Box, HStack } from '@chakra-ui/react'
import {
  VscCheck, VscRefresh, VscAdd, VscRemove, VscDiscard,
  VscChevronDown, VscChevronRight, VscSparkle,
  VscSync, VscError, VscSourceControl, VscWarning, VscGoToFile,
} from 'react-icons/vsc'
import { useVirtualizer } from '@tanstack/react-virtual'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { GitService, type GitFileStatus } from '@/services/gitService'
import TaskBranchesSection from './TaskBranchesSection'
import { acquireGitStatusPolling, refreshGitStatus } from '@/services/gitStatusPoller'
import { useGitStatusStore } from '@/stores/gitStatusStore'
import { useCurrentProject } from '@/hooks/useProjectState'
import { getFileIconByExtension } from '@/utils/iconMapper'
import { CollabShareControls } from '@/components/collab/CollabShareControls'
import {
  cleanGeneratedCommitMessage, ensureTmCodeCommitSignature,
  buildCommitPrompt, selectTopChangedPaths, COMMIT_PROMPT_LIMITS,
} from './sourceControlCommit'

const statusMeta: Record<string, { color: string; label: string }> = {
  added:      { color: tokens.colors.accent.greenBright, label: 'A' },
  untracked:  { color: tokens.colors.accent.greenBright, label: 'U' },
  modified:   { color: tokens.colors.accent.orangeBright, label: 'M' },
  deleted:    { color: tokens.colors.accent.red, label: 'D' },
  renamed:    { color: tokens.colors.accent.purple, label: 'R' },
  // Convenção do VS Code: conflitos de merge com "!" a vermelho.
  conflicted: { color: tokens.colors.accent.red, label: '!' },
}

type FeedbackType = 'success' | 'error' | null
const ROW_HEIGHT = 28
// Commit textarea growth bounds. It auto-grows from MIN up to MAX, then scrolls
// inside — the cap stops a long (e.g. AI-generated) message from pushing the
// commit button + file list out of the overflow-hidden column (user, 2026-06-17).
const COMMIT_TEXTAREA_MIN_HEIGHT = 48
const COMMIT_TEXTAREA_MAX_HEIGHT = 200
const COMMIT_MESSAGE_AI_TIMEOUT_MS = 90_000
const COMMIT_MESSAGE_WORKER_TIMEOUT_SECS = Math.ceil(COMMIT_MESSAGE_AI_TIMEOUT_MS / 1000)
const COMMIT_MESSAGE_AI_MAX_ATTEMPTS = 2

// ── Styles (injected once) ──────────────────────────────────────────────

const PANEL_STYLES = `
.sc-textarea {
  width: 100%;
  min-height: ${COMMIT_TEXTAREA_MIN_HEIGHT}px;
  max-height: ${COMMIT_TEXTAREA_MAX_HEIGHT}px;
  padding: 8px 32px 8px 10px;
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
.sc-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
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

/* Rows: hover highlight; per-item actions stay hidden until hover (VS Code
   pattern) so the list reads as a clean file list instead of a button grid. */
.sc-row {
  transition: background ${tokens.transition.fast};
}
.sc-row:hover {
  background: ${tokens.colors.bg.hoverSubtle};
}
.sc-row .sc-actions {
  opacity: 0;
  transition: opacity ${tokens.transition.fast};
}
.sc-row:hover .sc-actions,
.sc-row .sc-actions:focus-within {
  opacity: 1;
}

/* Unified commit button (primary / ghost variants) */
.sc-commit {
  width: 100%;
  height: 28px;
  border-radius: 4px;
  border: none;
  background: ${tokens.colors.accent.primary};
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-family: ${tokens.fontFamily.ui};
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all ${tokens.transition.fast};
}
.sc-commit:hover:not(:disabled) {
  background: ${tokens.colors.accent.primaryDark};
}
.sc-commit:active:not(:disabled) {
  transform: translateY(1px);
}
.sc-commit.ghost {
  border: 1px solid ${tokens.colors.accent.primaryMuted};
  background: ${tokens.colors.accent.primarySubtle};
  color: ${tokens.colors.accent.primary};
}
.sc-commit.ghost:hover:not(:disabled) {
  background: ${tokens.colors.accent.primaryHover};
  border-color: ${tokens.colors.accent.primaryBorder};
}
.sc-commit:disabled:not(.busy) {
  background: ${tokens.colors.bg.whiteSubtle};
  color: ${tokens.colors.text.disabled};
  border: none;
  cursor: default;
}
.sc-commit.busy {
  opacity: 0.75;
  cursor: progress;
}

/* Feedback banner slide-in */
.sc-feedback {
  animation: sc-feedback-in 0.16s ease-out;
}
@keyframes sc-feedback-in {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* File list scroll area — reserve the scrollbar gutter so the status letter
   at the right edge is never clipped by the overlay scrollbar, and render a
   thin custom scrollbar instead of the chunky default. */
.sc-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}
.sc-scroll::-webkit-scrollbar {
  width: 10px;
}
.sc-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.sc-scroll::-webkit-scrollbar-thumb {
  background: ${tokens.colors.scrollbar.explorerThumb};
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.sc-scroll:hover::-webkit-scrollbar-thumb {
  background: ${tokens.colors.scrollbar.explorerThumbHover};
  background-clip: padding-box;
}
.sc-scroll::-webkit-scrollbar-thumb:active {
  background: ${tokens.colors.scrollbar.explorerThumbActive};
  background-clip: padding-box;
}
`

function SourceControlPanel() {
  const currentProject = useCurrentProject()
  const projectPath = currentProject?.path ?? ''
  const projectName = currentProject?.name ?? ''

  // Git state comes from the shared store (one poller app-wide) — see
  // services/gitStatusPoller.ts for the refresh strategy.
  const files = useGitStatusStore(s => s.files)
  const branch = useGitStatusStore(s => s.branch)
  const loading = useGitStatusStore(s => s.loading)
  const ahead = useGitStatusStore(s => s.ahead)
  const behind = useGitStatusStore(s => s.behind)
  const hasUpstream = useGitStatusStore(s => s.hasUpstream)

  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [conflictsOpen, setConflictsOpen] = useState(true)
  const [feedback, setFeedback] = useState<{ type: FeedbackType; msg: string }>({ type: null, msg: '' })
  const [generating, setGenerating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Grows to fit the message UP TO COMMIT_TEXTAREA_MAX_HEIGHT, then scrolls
  // inside (CSS max-height + overflow-y:auto). Capping growth keeps the commit
  // button + file list below visible instead of being pushed off the
  // overflow-hidden column by a long message (user request, 2026-06-17).
  // Below the cap it still squeezes the file list (flex:1) rather than scrolling.
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = `${COMMIT_TEXTAREA_MIN_HEIGHT}px`
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMMIT_TEXTAREA_MIN_HEIGHT), COMMIT_TEXTAREA_MAX_HEIGHT)}px`
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [commitMsg, resizeTextarea])

  // ── Git status subscription (shared poller) ──────────────────────────

  useEffect(() => {
    if (!projectPath) return
    return acquireGitStatusPolling(projectPath)
  }, [projectPath])

  const conflicted = files.filter(f => f.status === 'conflicted')
  const staged = files.filter(f => f.staged && f.status !== 'conflicted')
  const unstaged = files.filter(f => !f.staged && f.status !== 'conflicted')

  // ── Git actions ──────────────────────────────────────────────────────

  const refreshGutter = useCallback((filePath?: string) => {
    window.dispatchEvent(new CustomEvent('git:refreshGutter', { detail: filePath ? `${projectPath}/${filePath}` : '' }))
  }, [projectPath])

  const onStageFile = useCallback(async (path: string) => {
    try { await GitService.stageFile(projectPath, path); await refreshGitStatus(); refreshGutter(path) }
    catch (e) { showFeedback('error', t('sourceControl.stage').replace('{file}', String(e))) }
  }, [projectPath, showFeedback, refreshGutter])

  const onUnstageFile = useCallback(async (path: string) => {
    try { await GitService.unstageFile(projectPath, path); await refreshGitStatus(); refreshGutter(path) }
    catch (e) { showFeedback('error', t('sourceControl.unstage').replace('{file}', String(e))) }
  }, [projectPath, showFeedback, refreshGutter])

  const stageAll = useCallback(async () => {
    try { await GitService.stageAll(projectPath); await refreshGitStatus() }
    catch (e) { showFeedback('error', t('sourceControl.stageAll').replace('{file}', String(e))) }
  }, [projectPath, showFeedback])

  const unstageAll = useCallback(async () => {
    try { await GitService.unstageAll(projectPath); await refreshGitStatus() }
    catch (e) { showFeedback('error', t('sourceControl.unstageAll').replace('{file}', String(e))) }
  }, [projectPath, showFeedback])

  const onDiscardFile = useCallback(async (path: string) => {
    const ok = await tauriConfirm(t('sourceControl.discardConfirm').replace('{file}', path.split('/').pop() || path), { title: t('sourceControl.discardTitle'), kind: 'warning' })
    if (!ok) return
    try { await GitService.discardFile(projectPath, path); await refreshGitStatus() }
    catch (e) { showFeedback('error', t('sourceControl.discardFile').replace('{file}', String(e))) }
  }, [projectPath, showFeedback])

  const discardAll = useCallback(async () => {
    const ok = await tauriConfirm(t('sourceControl.discardAllConfirm'), { title: t('sourceControl.discardAllTitle'), kind: 'warning' })
    if (!ok) return
    try { await GitService.discardAll(projectPath); await refreshGitStatus() }
    catch (e) { showFeedback('error', t('sourceControl.discardAll').replace('{file}', String(e))) }
  }, [projectPath, showFeedback])

  const onOpenFile = useCallback((relPath: string) => {
    if (!projectPath) return
    window.dispatchEvent(new CustomEvent('editor:open-diff', { detail: { relPath, projectPath } }))
  }, [projectPath])

  // ── Conflitos de merge (secção "Merge Changes", como no VS Code) ─────

  // Conflito abre o FICHEIRO editável (com os marcadores <<<<<<<), não a
  // vista de diff — é aí que se resolve.
  const onOpenConflictFile = useCallback((relPath: string) => {
    if (!projectPath) return
    window.dispatchEvent(new CustomEvent('editor:open-file', { detail: `${projectPath}/${relPath}` }))
  }, [projectPath])

  // Marcar como resolvido = git add (a semântica do git e do VS Code).
  // Confirmação quando o ficheiro ainda tem marcadores de conflito seria o
  // ideal; mantemos a ação explícita e reversível (unstage devolve o estado).
  const onMarkResolved = useCallback(async (path: string) => {
    try { await GitService.stageFile(projectPath, path); await refreshGitStatus(); refreshGutter(path) }
    catch (e) { showFeedback('error', t('sourceControl.markResolved').replace('{file}', String(e))) }
  }, [projectPath, showFeedback, refreshGutter])

  const onMarkAllResolved = useCallback(async () => {
    try {
      for (const file of conflicted) {
        await GitService.stageFile(projectPath, file.path)
      }
      await refreshGitStatus()
      refreshGutter()
    } catch (e) { showFeedback('error', t('sourceControl.markResolved').replace('{file}', String(e))) }
  }, [projectPath, conflicted, showFeedback, refreshGutter])

  // ── Commit ───────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    if (conflicted.length > 0) { showFeedback('error', t('sourceControl.resolveConflictsFirst')); return }
    if (!commitMsg.trim()) { showFeedback('error', t('sourceControl.enterCommitMessage')); return }
    if (staged.length === 0) { showFeedback('error', t('sourceControl.stageFilesFirst')); return }
    setCommitting(true)
    try {
      await GitService.commit(projectPath, ensureTmCodeCommitSignature(commitMsg))
      if (!mountedRef.current) return
      setCommitMsg('')
      if (textareaRef.current) textareaRef.current.style.height = `${COMMIT_TEXTAREA_MIN_HEIGHT}px`
      showFeedback('success', t('sourceControl.committedTo').replace('{branch}', branch))
      await refreshGitStatus()
    } catch (e) {
      if (mountedRef.current) showFeedback('error', t('sourceControl.commit').replace('{file}', String(e)))
    }
    if (mountedRef.current) setCommitting(false)
  }, [projectPath, commitMsg, staged.length, conflicted.length, showFeedback, branch])

  // ── Stage All & Commit (quick action) ────────────────────────────────

  const handleStageAllAndCommit = useCallback(async () => {
    if (conflicted.length > 0) { showFeedback('error', t('sourceControl.resolveConflictsFirst')); return }
    if (!commitMsg.trim()) { showFeedback('error', t('sourceControl.enterCommitMessage')); return }
    setCommitting(true)
    try {
      await GitService.stageAll(projectPath)
      await GitService.commit(projectPath, ensureTmCodeCommitSignature(commitMsg))
      if (!mountedRef.current) return
      setCommitMsg('')
      if (textareaRef.current) textareaRef.current.style.height = `${COMMIT_TEXTAREA_MIN_HEIGHT}px`
      showFeedback('success', t('sourceControl.committedAllTo').replace('{branch}', branch))
      await refreshGitStatus()
    } catch (e) {
      if (mountedRef.current) showFeedback('error', t('sourceControl.commit').replace('{file}', String(e)))
    }
    if (mountedRef.current) setCommitting(false)
  }, [projectPath, commitMsg, conflicted.length, showFeedback, branch])

  // ── Sync (pull, then push) ───────────────────────────────────────────
  // After a commit the main button becomes "Pull & Push": one click brings
  // the branch up to date and publishes the new commits, in that order.

  const handleSync = useCallback(async () => {
    if (!projectPath || syncing) return
    setSyncing(true)
    try {
      await GitService.pull(projectPath)
    } catch (e) {
      showFeedback('error', t('sourceControl.pull').replace('{file}', e instanceof Error ? e.message : String(e)))
      setSyncing(false)
      return
    }
    try {
      const result = await GitService.push(projectPath)
      showFeedback('success', result || t('sourceControl.pushedTo').replace('{branch}', branch))
    } catch (e) {
      showFeedback('error', t('sourceControl.push').replace('{file}', e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
      await refreshGitStatus()
    }
  }, [projectPath, branch, showFeedback, syncing])

  // ── AI commit message ────────────────────────────────────────────────

  const handleGenerateCommitMsg = useCallback(async () => {
    if (files.length === 0 || generating) return
    setGenerating(true)
    const aiAbort = new AbortController()
    const aiTimeout = setTimeout(() => aiAbort.abort(), COMMIT_MESSAGE_AI_TIMEOUT_MS)
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')
      type CommandResult = { stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }
      const runGit = async (command: string, timeoutSecs: number): Promise<{ text: string; note: string }> => {
        try {
          const result = await inv<CommandResult>('execute_command', { command, cwd: projectPath, timeoutSecs })
          if (result.success) return { text: result.stdout.trim(), note: '' }
          const reason = result.timedOut ? `timed out after ${timeoutSecs}s` : (result.stderr || `exit ${result.exitCode}`).trim()
          return { text: result.stdout.trim(), note: `${command}: ${reason}` }
        } catch (err) {
          return { text: '', note: `${command}: ${err instanceof Error ? err.message : String(err)}` }
        }
      }
      const diffBase = staged.length > 0 ? 'git diff --cached' : 'git diff HEAD'

      // Summaries first (cheap, parallel). The DETAIL diff command is decided
      // from numstat afterwards: for big changesets, `git diff -U3` over the
      // whole tree can produce tens of MB that the Rust side buffers in full
      // and ships over IPC only for us to keep 12KB — that transfer was the
      // main reason generation failed with many modified files.
      const [diffStatResult, nameStatusResult, numstatResult] = await Promise.all([
        runGit(`${diffBase} --stat --compact-summary`, 20),
        runGit(`${diffBase} --name-status`, 20),
        runGit(`${diffBase} --numstat`, 20),
      ])
      const diffStat = diffStatResult.text
      const nameStatus = nameStatusResult.text
      const numstat = numstatResult.text

      const changedFileCount = numstat.split('\n').filter(l => l.trim()).length
      // Generated/vendored files (lockfiles, dist, node_modules, minified
      // bundles) are excluded from the DETAIL diff — their hunks are pure
      // noise for a commit message and routinely dwarf the real changes.
      // They still appear in the summaries above, so the model knows they
      // changed. Double quotes work in both `sh -c` (mac) and `cmd /C` (win).
      const detailExcludes = [
        '*node_modules/*', '*package-lock.json', '*yarn.lock', '*pnpm-lock.yaml',
        '*bun.lockb', '*Cargo.lock', '*.min.js', '*.min.css', '*.map',
      ].map(p => `":(exclude)${p}"`).join(' ')
      let detailPathspec = `-- ${detailExcludes}`
      if (changedFileCount > COMMIT_PROMPT_LIMITS.detailFileThreshold) {
        // Huge changeset: fetch hunks only for the files with the most churn
        // instead of diffing the whole tree.
        const topPaths = selectTopChangedPaths(numstat, COMMIT_PROMPT_LIMITS.detailTopFiles)
        if (topPaths.length > 0) {
          detailPathspec = `-- ${topPaths.map(p => `"${p}"`).join(' ')}`
        }
      }
      const detailResult = await runGit(
        `${diffBase} --no-color --find-renames --find-copies --diff-algorithm=histogram -U3 ${detailPathspec}`,
        25,
      )

      const diffNotes = [
        diffStatResult.note, nameStatusResult.note, numstatResult.note, detailResult.note,
        changedFileCount > COMMIT_PROMPT_LIMITS.detailFileThreshold
          ? `Changeset has ${changedFileCount} files; detailed hunks included only for the ${COMMIT_PROMPT_LIMITS.detailTopFiles} most-changed files.`
          : '',
      ].filter(Boolean).join('\n')

      const targetFiles = staged.length > 0 ? staged : unstaged
      const sections = {
        fileList: targetFiles.map(f => `${f.status}: ${f.path}`).join('\n'),
        nameStatus,
        numstat,
        diffStat,
        diffDetail: detailResult.text,
        diffNotes,
      }

      let aiMsg = ''
      const { resolveAuxByokRoute, byokAuxCompletion } = await import('../../services/agent/byokRouting')
      const auxRoute = resolveAuxByokRoute()

      const callAi = async (attempt: number): Promise<string> => {
        // Attempt 2 rebuilds the prompt with a smaller diff budget — if the
        // first attempt failed on prompt size (worker 400 / timeout),
        // retrying the identical payload could never succeed.
        const promptContent = buildCommitPrompt(sections, {
          detailBudget: attempt === 1
            ? COMMIT_PROMPT_LIMITS.detailChars
            : COMMIT_PROMPT_LIMITS.detailCharsRetry,
        })
        const messages = attempt === 1
          ? [{ role: 'user', content: promptContent }]
          : [{
              role: 'user',
              content: `${promptContent}\n\nThe previous generation attempt failed or returned empty content. Retry now and output a non-empty commit message only.`,
            }]

        if (auxRoute) {
          // Free + BYOK: generate the commit message on the user's own key.
          const content = ((await byokAuxCompletion(auxRoute.snapshot, {
            messages,
            maxTokens: 1200,
            temperature: attempt === 1 ? 0.2 : 0.1,
            signal: aiAbort.signal,
          })) ?? '').trim()
          if (aiAbort.signal.aborted) throw new DOMException('Request aborted', 'AbortError')
          return content
        }

        const FirebaseAuthService = (await import('../../services/auth/firebaseAuth')).default
        let token = await FirebaseAuthService.getInstance().getIdToken()
        if (!token) token = await FirebaseAuthService.getInstance().getIdToken(true)
        if (!token) throw new Error(t('sourceControl.notAuthenticated'))

        const { resolveAIWorkerUrl } = await import('../../utils/devUrls')
        const workerUrl = resolveAIWorkerUrl()
        const { tauriFetch } = await import('../../services/tauriFetch')
        const response = await tauriFetch(`${workerUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Request-Type': 'utility',
          },
          timeoutSecs: COMMIT_MESSAGE_WORKER_TIMEOUT_SECS,
          signal: aiAbort.signal,
          body: JSON.stringify({
            model: 'tm-active-model',
            messages,
            temperature: attempt === 1 ? 0.2 : 0.1,
            max_tokens: 1200,
            stream: false,
          }),
        })

        if (!response.ok) throw new Error(`API ${response.status}`)
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
        return data.choices?.[0]?.message?.content?.trim() || ''
      }

      let lastError: unknown = null
      for (let attempt = 1; attempt <= COMMIT_MESSAGE_AI_MAX_ATTEMPTS; attempt++) {
        try {
          aiMsg = await callAi(attempt)
          if (aiMsg) break
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err
          lastError = err
        }
      }

      if (!aiMsg && lastError) {
        throw lastError
      }

      if (aiMsg) {
        setCommitMsg(cleanGeneratedCommitMessage(aiMsg))
        requestAnimationFrame(resizeTextarea)
      } else {
        showFeedback('error', `AI returned empty after ${COMMIT_MESSAGE_AI_MAX_ATTEMPTS} attempts`)
      }
    } catch (e) {
      const message = e instanceof DOMException && e.name === 'AbortError'
        ? `timed out after ${COMMIT_MESSAGE_WORKER_TIMEOUT_SECS}s`
        : e instanceof Error ? e.message : String(e)
      showFeedback('error', `Generate failed after ${COMMIT_MESSAGE_AI_MAX_ATTEMPTS} attempts: ${message}`)
    } finally {
      clearTimeout(aiTimeout)
      setGenerating(false)
    }
  }, [files, staged, unstaged, projectPath, generating, showFeedback, resizeTextarea])

  // ── Keyboard ─────────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (staged.length > 0) handleCommit()
      else if (unstaged.length > 0) handleStageAllAndCommit()
    }
  }, [handleCommit, handleStageAllAndCommit, staged.length, unstaged.length])

  const hasConflicts = conflicted.length > 0
  const canCommit = commitMsg.trim().length > 0 && staged.length > 0 && !hasConflicts
  const canStageAndCommit = commitMsg.trim().length > 0 && staged.length === 0 && unstaged.length > 0 && !hasConflicts
  // Working tree clean but commits to sync → the main button becomes "Pull & Push".
  const canSync = files.length === 0 && hasUpstream && (ahead > 0 || behind > 0)

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <Flex direction="column" height="100%" overflow="hidden">
      <style>{PANEL_STYLES}</style>

      {/* Header */}
      <Flex align="center" justify="space-between" px={3} h="34px" flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
        <HStack gap={1.5}>
          <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.secondary} textTransform="uppercase" letterSpacing="0.05em">
            Source Control
          </Text>
          {files.length > 0 && (
            <Text
              as="span"
              fontSize="9px"
              fontWeight="700"
              fontFamily={tokens.fontFamily.mono}
              color={tokens.colors.badge.notificationText}
              bg={tokens.colors.accent.primary}
              borderRadius="full"
              px="5px"
              lineHeight="14px"
              minW="14px"
              textAlign="center"
            >
              {files.length}
            </Text>
          )}
        </HStack>
        <HStack gap={1}>
          <CollabShareControls compact />
          <button type="button" className="sc-btn" title={t("view.refresh")} aria-label={t("view.refresh")} onClick={() => refreshGitStatus({ spinner: true })} disabled={loading}>
            {loading ? <span className="sc-spin"><VscRefresh size={13} /></span> : <VscRefresh size={13} />}
          </button>
        </HStack>
      </Flex>

      {/* Branch row — name + ahead/behind counters vs upstream */}
      {branch && (
        <Flex align="center" gap={1.5} px={2.5} py="5px" flexShrink={0} borderBottom={`1px solid ${tokens.colors.border.glass}`}>
          <Flex align="center" gap={1.5} minW={0} flex={1} title={branch}>
            <VscSourceControl size={12} color={tokens.colors.text.muted} style={{ flexShrink: 0 }} />
            <Text fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} lineClamp={1}>
              {branch}
            </Text>
          </Flex>
          {hasUpstream && (ahead > 0 || behind > 0) && (
            <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
              {behind > 0 && `${behind}↓`}
              {behind > 0 && ahead > 0 && ' '}
              {ahead > 0 && `${ahead}↑`}
            </Text>
          )}
        </Flex>
      )}

      {/* Commit area */}
      <Box px={2.5} pt={2} pb={1} flexShrink={0} position="relative">
        <textarea
          ref={textareaRef}
          className="sc-textarea"
          value={commitMsg}
          onChange={e => { setCommitMsg(e.target.value) }}
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
            type="button"
            className="sc-btn accent"
            style={{ position: 'absolute', right: 14, top: 12 }}
            title={t('sourceControl.generateCommit')}
            aria-label={t('sourceControl.generateCommit')}
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

      {/* Main action button — Commit → Stage All & Commit → Pull & Push.
          Right after a commit the working tree is clean and ahead > 0, so the
          same button flips to syncing the branch (pull, then push). */}
      <Box px={2.5} pb={1.5} pt={0.5} flexShrink={0}>
        <button
          type="button"
          className={`sc-commit${canStageAndCommit ? ' ghost' : ''}${committing || syncing ? ' busy' : ''}`}
          onClick={
            canCommit ? handleCommit
            : canStageAndCommit ? handleStageAllAndCommit
            : canSync ? handleSync
            : undefined
          }
          disabled={(!canCommit && !canStageAndCommit && !canSync) || committing || syncing}
        >
          {committing || syncing ? (
            <Box w="12px" h="12px" borderRadius="full" border="2px solid transparent" borderTopColor="currentColor" className="sc-spin" />
          ) : canStageAndCommit ? (
            <VscAdd size={13} />
          ) : canSync ? (
            <VscSync size={13} />
          ) : (
            <VscCheck size={13} />
          )}
          {canCommit || canStageAndCommit || committing
            ? (canStageAndCommit ? 'Stage All & Commit' : 'Commit')
            : canSync || syncing
              ? `Pull & Push${ahead > 0 ? ` (${ahead}↑)` : ''}`
              : 'Commit'}
        </button>
      </Box>

      {/* Conflitos bloqueiam o commit — aviso persistente (padrão VS Code) */}
      {hasConflicts && (
        <Box px={2.5} pb={1.5} flexShrink={0} role="alert">
          <Flex
            align="center" gap={1.5} px={2} py="5px" borderRadius="4px"
            bg={tokens.colors.accent.redSubtle}
            border={`1px solid ${tokens.colors.accent.redMuted}`}
          >
            <Box flexShrink={0} display="flex">
              <VscWarning size={11} color={tokens.colors.accent.red} />
            </Box>
            <Text fontSize="11px" color={tokens.colors.accent.red} lineClamp={2}>
              {t('sourceControl.conflictsBanner').replace('{count}', String(conflicted.length))}
            </Text>
          </Flex>
        </Box>
      )}

      {/* Feedback */}
      {feedback.type && (
        <Box px={2.5} pb={1.5} flexShrink={0} role="status" aria-live="polite">
          <Flex
            className="sc-feedback"
            align="center" gap={1.5} px={2} py="5px" borderRadius="4px"
            bg={feedback.type === 'success' ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle}
            border={`1px solid ${feedback.type === 'success' ? tokens.colors.accent.greenMuted : tokens.colors.accent.redMuted}`}
          >
            <Box flexShrink={0} display="flex">
              {feedback.type === 'success'
                ? <VscCheck size={11} color={tokens.colors.accent.green} />
                : <VscError size={11} color={tokens.colors.accent.red} />}
            </Box>
            <Text fontSize="11px" color={feedback.type === 'success' ? tokens.colors.accent.greenBright : tokens.colors.accent.red} lineClamp={2} title={feedback.msg}>
              {feedback.msg}
            </Text>
          </Flex>
        </Box>
      )}

      {/* File list */}
      <Box flex={1} overflow="hidden">
        {/* Branches worktree/* das tarefas paralelas — merge é a revisão. */}
        <TaskBranchesSection projectPath={projectPath} currentBranch={branch} onFeedback={showFeedback} />

        {files.length === 0 && !loading && (
          <Flex direction="column" align="center" justify="center" py={10} gap={2.5}>
            <Flex
              align="center" justify="center" w="34px" h="34px" borderRadius="full"
              bg={tokens.colors.accent.greenSubtle}
              border={`1px solid ${tokens.colors.accent.greenMuted}`}
            >
              <VscCheck size={16} color={tokens.colors.accent.greenBright} />
            </Flex>
            <Text fontSize="12px" fontWeight="500" color={tokens.colors.text.secondary}>{t("view.noChanges")}</Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>{t("view.workingTreeClean")}</Text>
          </Flex>
        )}

        {files.length > 0 && (
          <VirtualFileList
            conflicted={conflicted}
            staged={staged}
            unstaged={unstaged}
            conflictsOpen={conflictsOpen}
            stagedOpen={stagedOpen}
            changesOpen={changesOpen}
            projectName={projectName}
            onToggleConflicts={() => setConflictsOpen(v => !v)}
            onToggleStaged={() => setStagedOpen(v => !v)}
            onToggleChanges={() => setChangesOpen(v => !v)}
            onOpenFile={onOpenFile}
            onOpenConflictFile={onOpenConflictFile}
            onStageFile={onStageFile}
            onUnstageFile={onUnstageFile}
            onDiscardFile={onDiscardFile}
            onMarkResolved={onMarkResolved}
            onMarkAllResolved={onMarkAllResolved}
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

type ListSection = 'conflicted' | 'staged' | 'unstaged'

type ListItem =
  | { type: 'header'; section: ListSection; count: number; isOpen: boolean }
  | { type: 'file'; file: GitFileStatus; section: ListSection }

const VirtualFileList = memo<{
  conflicted: GitFileStatus[]; staged: GitFileStatus[]; unstaged: GitFileStatus[]
  conflictsOpen: boolean; stagedOpen: boolean; changesOpen: boolean; projectName: string
  onToggleConflicts: () => void; onToggleStaged: () => void; onToggleChanges: () => void
  onOpenFile: (path: string) => void
  onOpenConflictFile: (path: string) => void
  onStageFile: (path: string) => void; onUnstageFile: (path: string) => void
  onDiscardFile: (path: string) => void
  onMarkResolved: (path: string) => void; onMarkAllResolved: () => void
  onStageAll: () => void; onUnstageAll: () => void; onDiscardAll: () => void
}>(({
  conflicted, staged, unstaged, conflictsOpen, stagedOpen, changesOpen,
  onToggleConflicts, onToggleStaged, onToggleChanges,
  onOpenFile, onOpenConflictFile, onStageFile, onUnstageFile, onDiscardFile,
  onMarkResolved, onMarkAllResolved,
  onStageAll, onUnstageAll, onDiscardAll,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Conflitos primeiro — é a secção que bloqueia tudo o resto (VS Code).
  const items: ListItem[] = []
  if (conflicted.length > 0) {
    items.push({ type: 'header', section: 'conflicted', count: conflicted.length, isOpen: conflictsOpen })
    if (conflictsOpen) for (const f of conflicted) items.push({ type: 'file', file: f, section: 'conflicted' })
  }
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
    <div ref={scrollRef} className="sc-scroll">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vItem => {
          const item = items[vItem.index]
          return (
            <div key={vItem.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vItem.size, transform: `translateY(${vItem.start}px)` }}>
              {item.type === 'header' ? (
                <SectionHeader
                  label={
                    item.section === 'conflicted' ? t('sourceControl.mergeChanges')
                    : item.section === 'staged' ? t('sourceControl.staged')
                    : t('sourceControl.changes')
                  }
                  count={item.count} isOpen={item.isOpen}
                  onToggle={
                    item.section === 'conflicted' ? onToggleConflicts
                    : item.section === 'staged' ? onToggleStaged
                    : onToggleChanges
                  }
                  section={item.section}
                  onStageAll={onStageAll} onUnstageAll={onUnstageAll} onDiscardAll={onDiscardAll}
                  onMarkAllResolved={onMarkAllResolved}
                />
              ) : (
                <FileRow
                  file={item.file} section={item.section}
                  onOpenFile={item.section === 'conflicted' ? onOpenConflictFile : onOpenFile}
                  onStageFile={onStageFile}
                  onUnstageFile={onUnstageFile} onDiscardFile={onDiscardFile}
                  onMarkResolved={onMarkResolved}
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
  section: ListSection
  onStageAll: () => void; onUnstageAll: () => void; onDiscardAll: () => void
  onMarkAllResolved: () => void
}>(({ label, count, isOpen, onToggle, section, onStageAll, onUnstageAll, onDiscardAll, onMarkAllResolved }) => (
  <div
    className="sc-row"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', height: ROW_HEIGHT, cursor: 'pointer', userSelect: 'none' }}
    onClick={onToggle}
    role="button"
    aria-expanded={isOpen}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      {isOpen ? <VscChevronDown size={11} color={tokens.colors.text.muted} /> : <VscChevronRight size={11} color={tokens.colors.text.muted} />}
      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={e => e.stopPropagation()}>
      <span className="sc-actions" style={{ display: 'flex', gap: 2 }}>
        {section === 'conflicted' ? (
          <button type="button" className="sc-btn green" title={t('sourceControl.markAllResolved')} aria-label={t('sourceControl.markAllResolved')} onClick={onMarkAllResolved}><VscCheck size={13} /></button>
        ) : section === 'staged' ? (
          <button type="button" className="sc-btn" title={t("view.unstageAll")} aria-label={t("view.unstageAll")} onClick={onUnstageAll}><VscRemove size={13} /></button>
        ) : (
          <>
            <button type="button" className="sc-btn red" title={t("view.discardAllChanges")} aria-label={t("view.discardAllChanges")} onClick={onDiscardAll}><VscDiscard size={12} /></button>
            <button type="button" className="sc-btn green" title={t("view.stageAll")} aria-label={t("view.stageAll")} onClick={onStageAll}><VscAdd size={13} /></button>
          </>
        )}
      </span>
      <span style={{
        fontSize: 10, fontWeight: 600, color: tokens.colors.text.secondary,
        fontFamily: tokens.fontFamily.mono, lineHeight: '18px',
        padding: '0 5px', borderRadius: 9999, background: tokens.colors.bg.whiteOverlay, minWidth: 18, textAlign: 'center',
      }}>
        {count}
      </span>
    </div>
  </div>
))
SectionHeader.displayName = 'SectionHeader'

// ── File Row ─────────────────────────────────────────────────────────────

const FileRow = memo<{
  file: GitFileStatus; section: ListSection
  onOpenFile: (path: string) => void; onStageFile: (path: string) => void
  onUnstageFile: (path: string) => void; onDiscardFile: (path: string) => void
  onMarkResolved: (path: string) => void
}>(({ file, section, onOpenFile, onStageFile, onUnstageFile, onDiscardFile, onMarkResolved }) => {
  const cfg = statusMeta[file.status] || statusMeta.modified
  const fileName = file.path.split('/').pop() || file.path
  const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''
  const ext = fileName.split('.').pop()?.toLowerCase()
  const iconUrl = getFileIconByExtension(ext, fileName)

  return (
    <div
      className="sc-row"
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 20px', height: ROW_HEIGHT, cursor: 'pointer' }}
      onClick={() => onOpenFile(file.path)}
      title={file.path}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} />
      ) : (
        <div style={{ width: 14, height: 14, flexShrink: 0 }} />
      )}

      {/* Name + path share one shrinkable box that truncates as a unit. This
          keeps the right cluster (actions + status letter) pinned, so the
          M/U/A column stays aligned no matter how long the filename is — a
          long name no longer pushes the status letter out of place. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, overflow: 'hidden' }}>
        {/* Filename tinted by git status + strike-through on deletions — the
            VS Code convention, so state reads at a glance without the letter. */}
        <span style={{
          fontSize: 12,
          color: cfg.color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 1,
          minWidth: 0,
          textDecoration: file.status === 'deleted' ? 'line-through' : 'none',
          opacity: file.status === 'deleted' ? 0.75 : 1,
        }}>
          {fileName}
        </span>
        {dirPath && (
          <span style={{ flexShrink: 1000000, fontSize: 11, color: tokens.colors.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {dirPath}
          </span>
        )}
      </div>

      {/* Right cluster — pinned, fixed-width status column so M/U/A align. */}
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 4 }}>
        <div className="sc-actions" style={{ display: 'flex' }} onClick={e => e.stopPropagation()}>
          {section === 'conflicted' ? (
            <>
              <button type="button" className="sc-btn" title={t('sourceControl.openConflict')} aria-label={t('sourceControl.openConflict')} onClick={() => onOpenFile(file.path)}><VscGoToFile size={12} /></button>
              <button type="button" className="sc-btn green" title={t('sourceControl.markResolvedBtn')} aria-label={t('sourceControl.markResolvedBtn')} onClick={() => onMarkResolved(file.path)}><VscCheck size={12} /></button>
            </>
          ) : section === 'staged' ? (
            <button type="button" className="sc-btn" title={t('sourceControl.unstageBtn')} aria-label={t('sourceControl.unstageBtn')} onClick={() => onUnstageFile(file.path)}><VscRemove size={12} /></button>
          ) : (
            <>
              <button type="button" className="sc-btn red" title={t('sourceControl.discardBtn')} aria-label={t('sourceControl.discardBtn')} onClick={() => onDiscardFile(file.path)}><VscDiscard size={11} /></button>
              <button type="button" className="sc-btn green" title={t('sourceControl.stageBtn')} aria-label={t('sourceControl.stageBtn')} onClick={() => onStageFile(file.path)}><VscAdd size={12} /></button>
            </>
          )}
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: tokens.fontFamily.mono, color: cfg.color, flexShrink: 0, width: 12, textAlign: 'center' }}>
          {cfg.label}
        </span>
      </div>
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
  prev.onMarkResolved === next.onMarkResolved &&
  prev.onOpenFile === next.onOpenFile
)
FileRow.displayName = 'FileRow'

export default memo(SourceControlPanel)
