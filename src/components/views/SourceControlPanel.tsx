import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Flex, Text, Box, HStack } from '@chakra-ui/react'
import {
  VscCheck, VscRefresh, VscAdd, VscRemove, VscDiscard,
  VscChevronDown, VscChevronRight, VscSparkle,
  VscSync, VscError, VscSourceControl,
} from 'react-icons/vsc'
import { useVirtualizer } from '@tanstack/react-virtual'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { GitService, type GitFileStatus } from '@/services/gitService'
import { acquireGitStatusPolling, refreshGitStatus } from '@/services/gitStatusPoller'
import { useGitStatusStore } from '@/stores/gitStatusStore'
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
// Commit textarea growth bounds. It auto-grows from MIN up to MAX, then scrolls
// inside — the cap stops a long (e.g. AI-generated) message from pushing the
// commit button + file list out of the overflow-hidden column (user, 2026-06-17).
const COMMIT_TEXTAREA_MIN_HEIGHT = 48
const COMMIT_TEXTAREA_MAX_HEIGHT = 200
const TM_CODE_COMMIT_SIGNATURE = 'Co-Authored-By: TM Code <tm.code@toquemedia.net>'

// The signature is invisible to the user (never shown in the textarea) and is
// appended at commit time — so both AI-generated and hand-typed messages get
// signed, and the textarea stays clean (user request, 2026-06-12).
function ensureTmCodeCommitSignature(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  if (/^Co-Authored-By:\s*TM Code\s*</im.test(trimmed)) return trimmed
  return `${trimmed}\n\n${TM_CODE_COMMIT_SIGNATURE}`
}

/** Strip any TM Code trailer the AI may still emit, so it never reaches the textarea. */
function stripTmCodeCommitSignature(message: string): string {
  return message.replace(/\n*^Co-Authored-By:\s*TM Code\s*<[^>]*>\s*$/gim, '').trim()
}

/**
 * Strip chain-of-thought from the AI message. The commit-message call is
 * non-streaming, so reasoning models (notably Gemini via the data-plane) emit
 * their `<think>…</think>` block INLINE in `message.content` instead of in a
 * separate streamed reasoning channel — without this it leaks straight into the
 * commit textarea (see screenshot, 2026-06-16).
 */
function stripReasoningBlocks(text: string): string {
  // 1. Remove well-formed <think>…</think> blocks.
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // 2. A dangling close tag means the opener arrived as a separate field (or
  //    was trimmed upstream) — keep only what follows the last </think>.
  const lastClose = out.toLowerCase().lastIndexOf('</think>')
  if (lastClose !== -1) out = out.slice(lastClose + '</think>'.length)
  // 3. Drop any stray tag left over, but keep the surrounding text.
  return out.replace(/<\/?think>/gi, '').trim()
}

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

  const staged = files.filter(f => f.staged)
  const unstaged = files.filter(f => !f.staged)

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

  // ── Commit ───────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
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
  }, [projectPath, commitMsg, staged.length, showFeedback, branch])

  // ── Stage All & Commit (quick action) ────────────────────────────────

  const handleStageAllAndCommit = useCallback(async () => {
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
  }, [projectPath, commitMsg, showFeedback, branch])

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
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')
      const diffBase = staged.length > 0 ? 'git diff --cached' : 'git diff HEAD'
      const maxDiffChars = 24_000
      const diffResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        { command: `${diffBase} --stat --compact-summary`, cwd: projectPath, timeoutSecs: 8 }
      )
      const diffStat = diffResult.success ? diffResult.stdout.trim() : ''
      const nameStatusResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        { command: `${diffBase} --name-status`, cwd: projectPath, timeoutSecs: 8 }
      )
      const nameStatus = nameStatusResult.success ? nameStatusResult.stdout.trim() : ''
      const numstatResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        { command: `${diffBase} --numstat`, cwd: projectPath, timeoutSecs: 8 }
      )
      const numstat = numstatResult.success ? numstatResult.stdout.trim() : ''
      const detailResult = await inv<{ stdout: string; exitCode: number; success: boolean; timedOut: boolean; stderr: string }>(
        'execute_command',
        {
          command: `${diffBase} --no-color --find-renames --find-copies --diff-algorithm=histogram -U4`,
          cwd: projectPath,
          timeoutSecs: 10,
        }
      )
      const rawDiffDetail = detailResult.success ? detailResult.stdout.trim() : ''
      const diffDetail = rawDiffDetail.length > maxDiffChars
        ? `${rawDiffDetail.slice(0, maxDiffChars)}\n\n[Diff truncated: ${rawDiffDetail.length - maxDiffChars} additional characters omitted]`
        : rawDiffDetail
      const targetFiles = staged.length > 0 ? staged : unstaged
      const fileList = targetFiles.map(f => `${f.status}: ${f.path}`).join('\n')

      const FirebaseAuthService = (await import('../../services/auth/firebaseAuth')).default
      let token = await FirebaseAuthService.getInstance().getIdToken()
      if (!token) token = await FirebaseAuthService.getInstance().getIdToken(true)
      if (!token) throw new Error(t('sourceControl.notAuthenticated'))

      const { resolveAIWorkerUrl } = await import('../../utils/devUrls')
      const workerUrl = resolveAIWorkerUrl()
      const { tauriFetch } = await import('../../services/tauriFetch')
      const response = await tauriFetch(`${workerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Generate a detailed git commit message for these changes using conventional commits format.

Base the message on the actual diff hunks and changed files below. Mention concrete modules, components, APIs, config, tests, and behavior changes when they are visible in the diff. Do not invent changes that are not supported by the diff.

Format:
<type>(<scope>): <subject line, max 72 chars>

<body: 6-12 bullet points explaining what changed, why, and the impact>

Rules:
- type: feat, fix, refactor, chore, docs, style, perf, test
- scope: the main area affected (component, service, worker endpoint, etc.)
- subject: imperative mood, lowercase, no period, specific to the main change
- body: each line starts with "- "
- be THOROUGH: cover every meaningful change visible in the diff — new functions/components, changed behavior, removed code, edge cases handled, UI/UX adjustments, config/dependency changes
- group related bullets by area (e.g. UI, service, worker) when multiple areas changed
- for each significant bullet, include the "why" or the user-visible effect, not just the "what"
- call out breaking changes or migrations explicitly with "BREAKING:" if the diff shows any
- do not pad with filler: every bullet must be backed by the diff, but do not omit real changes either
- do not add any signature, trailer, attribution, user name or email — the app appends those automatically
- Output ONLY the commit message, no quotes, no markdown, no explanation

Files changed:
${fileList}

Name/status:
${nameStatus}

Line changes:
${numstat}

Diff stat:
${diffStat}

Diff hunks:
${diffDetail}`,
          }],
          temperature: 0.2,
          max_tokens: 1200,
          stream: false,
        }),
      })

      if (!response.ok) throw new Error(`API ${response.status}`)
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const aiMsg = data.choices?.[0]?.message?.content?.trim() || ''

      if (aiMsg) {
        const cleaned = stripReasoningBlocks(aiMsg)
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/^(commit message:?\s*)/i, '')
          .trim()
        setCommitMsg(stripTmCodeCommitSignature(cleaned))
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
        <button type="button" className="sc-btn" title={t("view.refresh")} aria-label={t("view.refresh")} onClick={() => refreshGitStatus({ spinner: true })} disabled={loading}>
          {loading ? <span className="sc-spin"><VscRefresh size={13} /></span> : <VscRefresh size={13} />}
        </button>
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
    <div ref={scrollRef} className="sc-scroll">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vItem => {
          const item = items[vItem.index]
          return (
            <div key={vItem.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vItem.size, transform: `translateY(${vItem.start}px)` }}>
              {item.type === 'header' ? (
                <SectionHeader
                  label={item.section === 'staged' ? t('sourceControl.staged') : t('sourceControl.changes')}
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
        {section === 'staged' ? (
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
          {section === 'staged' ? (
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
  prev.onOpenFile === next.onOpenFile
)
FileRow.displayName = 'FileRow'

export default memo(SourceControlPanel)
