import { memo, useState, useCallback, useEffect } from 'react'
import {
  Box,
  Button,
  Field,
  Flex,
  HStack,
  Input,
  NativeSelect,
  Switch,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { FiArrowLeft, FiPlus, FiTrash2, FiSquare, FiRefreshCw, FiServer, FiExternalLink, FiLogOut } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSettingsStore, DEFAULT_SHORTCUTS, type ShortcutId, type KeyBinding } from '../../stores/settingsStore'
import KeyBindingDisplay from '../ui/KeyBindingDisplay'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore, McpServerState } from '../../stores/mcpStore'
import { useProjectStore } from '../../stores/projectStore'
import { useAuthStore } from '../../stores/authStore'
import { useBillingStore } from '../../stores/billingStore'
import FirebaseAuthService from '../../services/auth/firebaseAuth'
import SkillService from '../../services/agent/skillService'
import MCPService from '../../services/mcp/mcpService'
import { invoke } from '@tauri-apps/api/core'
import { getPendingUpdate, setPendingUpdate, installUpdate, checkForUpdate, type UpdateInfo } from '../../services/updateService'
import { IS_WINDOWS } from '@/utils/platform'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n'

type SectionId = 'profile' | 'editor' | 'shortcuts' | 'skills' | 'mcp' | 'sandbox'

const NAV_KEYS: { id: SectionId; key: TranslationKey }[] = [
  { id: 'profile', key: 'settings.profilePlan' },
  { id: 'editor', key: 'settings.editor' },
  { id: 'sandbox', key: 'settings.sandbox' as TranslationKey },
  { id: 'shortcuts', key: 'settings.shortcuts' },
  { id: 'skills', key: 'settings.skills' },
  { id: 'mcp', key: 'settings.mcpServers' },
]

interface SettingsViewProps {
  onBack?: () => void
}

function SettingsView({ onBack }: SettingsViewProps = {}) {
  const [activeSection, setActiveSection] = useState<SectionId>('profile')
  const t = useTranslation()

  return (
    <Flex flex="1" overflow="hidden">
      {/* Left nav */}
      <Flex
        direction="column"
        w="200px"
        flexShrink={0}
        bg={tokens.colors.bg.sidebar}
        borderRight={`1px solid ${tokens.colors.border.sidebarPanel}`}
      >
        <Box
          as="button"
          display="flex"
          alignItems="center"
          gap={2}
          px={4}
          h="44px"
          cursor="pointer"
          color={tokens.colors.text.secondary}
          bg="transparent"
          border="none"
          textAlign="left"
          w="100%"
          transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
          onClick={function () { onBack ? onBack() : useLayoutStore.getState().goBack() }}
          flexShrink={0}
          data-no-drag
        >
          <FiArrowLeft size={14} />
          <Text fontSize="13px" fontWeight="500">{t('settings.title')}</Text>
        </Box>

        <Box h="1px" bg={tokens.colors.border.sidebarPanel} />

        <VStack align="stretch" gap={0} pt={2} px={2}>
          {NAV_KEYS.map(function (item) {
            const isActive = activeSection === item.id
            return (
              <Box
                key={item.id}
                as="button"
                display="block"
                textAlign="left"
                px={3}
                py="7px"
                borderRadius={tokens.radius.lg}
                fontSize="13px"
                fontWeight={isActive ? '500' : '400'}
                color={isActive ? tokens.colors.text.primary : tokens.colors.text.secondary}
                bg={isActive ? tokens.colors.bg.activeItem : 'transparent'}
                cursor="pointer"
                transition={tokens.transition.fast}
                _hover={{
                  bg: isActive ? tokens.colors.bg.activeItem : tokens.colors.bg.hoverSubtle,
                  color: tokens.colors.text.primary,
                }}
                onClick={function () { setActiveSection(item.id) }}
              >
                {t(item.key)}
              </Box>
            )
          })}
        </VStack>
      </Flex>

      {/* Content */}
      <Flex direction="column" flex="1" overflow="hidden">
        <Flex
          align="center"
          px={8}
          h="52px"
          flexShrink={0}
          borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}
        >
          <Text fontSize="16px" fontWeight="600" color={tokens.colors.text.primary}>
            {t(NAV_KEYS.find(function (n) { return n.id === activeSection })?.key || 'settings.profilePlan')}
          </Text>
        </Flex>

        <Box flex="1" overflowY="auto" px={8} py={6}>
          <Box maxW="640px">
            {activeSection === 'profile' && <ProfileSection />}
            {activeSection === 'editor' && <EditorSection />}
            {activeSection === 'sandbox' && <SandboxSection />}
            {activeSection === 'shortcuts' && <ShortcutsSection />}
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'mcp' && <McpSection />}
          </Box>
        </Box>
      </Flex>
    </Flex>
  )
}

// ━━━ Profile & Plan Section ━━━

const PLAN_CONFIG: Record<string, { labelKey: string; color: string; creditsLabelKey: string; isTop: boolean }> = {
  explorer:       { labelKey: 'Free',         color: tokens.colors.text.muted,      creditsLabelKey: 'settings.dailyCredits',    isTop: false },
  pro:            { labelKey: 'Pro',          color: tokens.colors.accent.purple,   creditsLabelKey: 'settings.monthlyCredits',  isTop: false },
  'business-4x':  { labelKey: 'Business 4x',  color: tokens.colors.accent.orange,   creditsLabelKey: 'settings.monthlyCredits',  isTop: false },
  'business-8x':  { labelKey: 'Business 8x',  color: tokens.colors.accent.primary,  creditsLabelKey: 'settings.monthlyCredits',  isTop: true },
}

function ProfileSection() {
  const t = useTranslation()
  const user = useAuthStore(s => s.user)
  const plan = useBillingStore(s => s.plan)
  const billingLoaded = useBillingStore(s => s.isLoaded)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const cycleEnd = useBillingStore(s => s.cycleEnd)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const noCredits = useBillingStore(s => s.noCredits)
  const appLanguage = useSettingsStore(s => s.appLanguage)
  const agentLanguage = useSettingsStore(s => s.agentLanguage)
  const setAppLanguage = useSettingsStore(s => s.setAppLanguage)
  const setAgentLanguage = useSettingsStore(s => s.setAgentLanguage)

  const planKey = plan || 'explorer'
  const planInfo = PLAN_CONFIG[planKey] || PLAN_CONFIG.explorer
  const isFree = planKey === 'explorer'
  const isTopPlan = planInfo.isTop

  async function handleSignOut() {
    try {
      await FirebaseAuthService.getInstance().signOut()
      // Auth + billing reset handled by onAuthStateChanged(null) in firebaseAuth.ts
      useAuthStore.getState().clear()
    } catch {}
  }

  async function openStudio() {
    try {
      const opener = await import('@tauri-apps/plugin-opener')
      await opener.openUrl('https://studio.toquemedia.net/upgrade')
    } catch {}
  }

  const initials = user?.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() || '?'

  return (
    <VStack align="stretch" gap={8}>

      {/* ── Account ─────────────────────────────────────── */}
      <VStack align="stretch" gap={4}>
        <Flex align="center" gap={4}>
          {user?.photoURL ? (
            <Box w="44px" h="44px" borderRadius="full" overflow="hidden" flexShrink={0}>
              <img src={user.photoURL} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </Box>
          ) : (
            <Flex
              w="44px" h="44px" borderRadius="full" flexShrink={0}
              align="center" justify="center"
              bg={`linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`}
            >
              <Text fontSize="15px" fontWeight="700" color="white">{initials}</Text>
            </Flex>
          )}
          <Box flex={1} minW={0}>
            <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
              {user?.displayName || t('common.user')}
            </Text>
            <Text fontSize="12px" color={tokens.colors.text.secondary} lineClamp={1}>
              {user?.email || '—'}
            </Text>
          </Box>
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" color={tokens.colors.text.muted} bg="transparent"
            cursor="pointer" transition={tokens.transition.fast}
            _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
            onClick={handleSignOut}
          >
            <FiLogOut size={12} />{t("common.signOut")}
          </Box>
        </Flex>

        <Box h="1px" bg={tokens.colors.border.subtle} />
      </VStack>

      {/* ── Plan & Credits ──────────────────────────────── */}
      <VStack align="stretch" gap={3}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
          {t("settings.planCredits")}
        </Text>

        <Flex justify="space-between" align="center">
          <HStack gap={2.5}>
            <Box w="8px" h="8px" borderRadius="full" bg={planInfo.color} boxShadow={`0 0 6px ${planInfo.color}40`} />
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              {billingLoaded ? planInfo.labelKey : '...'}
            </Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>{t(planInfo.creditsLabelKey as any)}</Text>
          </HStack>
          {!isTopPlan && (
            <Box
              as="button" display="flex" alignItems="center" gap="5px"
              px={2.5} py="4px" borderRadius={tokens.radius.md}
              fontSize="12px" fontWeight="500"
              color={tokens.colors.accent.primary} bg={tokens.colors.accent.primarySubtle}
              cursor="pointer" transition={tokens.transition.fast}
              _hover={{ bg: tokens.colors.accent.primaryHover }}
              onClick={openStudio}
            >
              {t("settings.upgrade")}<FiExternalLink size={11} />
            </Box>
          )}
        </Flex>

        {/* Cycle budget bar */}
        <Box>
          <Flex justify="space-between" align="center" mb={1.5}>
            <Text fontSize="12px" color={tokens.colors.text.secondary}>{t("settings.creditsRemaining")}</Text>
            <Text
              fontSize="13px" fontWeight="700" fontFamily={tokens.fontFamily.mono}
              color={noCredits ? tokens.colors.accent.red : tokens.colors.text.primary}
            >
              {billingLoaded && tokenBudget > 0
                ? `${Math.round(consumedPct * 100)}%`
                : '—'}
            </Text>
          </Flex>
          {billingLoaded && tokenBudget > 0 && (
            <>
              <Box h="3px" borderRadius="full" bg={tokens.colors.border.subtle} overflow="hidden">
                <Box
                  h="100%" borderRadius="full"
                  bg={consumedPct >= 1
                    ? tokens.colors.accent.red
                    : consumedPct >= 0.95
                    ? tokens.colors.accent.orange
                    : consumedPct >= 0.80
                    ? '#f0b429'
                    : `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`
                  }
                  width={`${Math.min(100, Math.max(2, consumedPct * 100))}%`}
                  transition="width 0.5s ease"
                />
              </Box>
              <Flex justify="space-between" align="center" mt={1}>
                {cycleEnd && (
                  <Text fontSize="10px" color={tokens.colors.text.disabled}>
                    {t('settings.resetsOn' as any)} {cycleEnd}
                  </Text>
                )}
              </Flex>
              {tmsRemaining > 0 && (
                <Text fontSize="11px" color={tokens.colors.accent.orange} mt={1.5}>
                  +{tmsRemaining} {t('settings.overageCredits' as any)}
                </Text>
              )}
            </>
          )}
          {noCredits && (
            <Text fontSize="11px" color={tokens.colors.accent.red} mt={1.5}>
              {isFree ? t('settings.upgradeForMore') : t('settings.buyMore')}
            </Text>
          )}
        </Box>

        {/* Action links */}
        <HStack gap={2} mt={1}>
          {!isFree && (
            <Box
              as="button" display="flex" alignItems="center" gap="5px"
              px={2.5} py="5px" borderRadius={tokens.radius.md}
              fontSize="12px" fontWeight="500"
              color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
              border="1px solid" borderColor={tokens.colors.bg.cardBorder}
              cursor="pointer" transition={tokens.transition.fast}
              _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
              onClick={openStudio}
            >
              <FiPlus size={11} />{t("settings.buyCredits")}
            </Box>
          )}
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" fontWeight="500"
            color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
            border="1px solid" borderColor={tokens.colors.bg.cardBorder}
            cursor="pointer" transition={tokens.transition.fast}
            _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
            onClick={openStudio}
          >
            <FiExternalLink size={11} />{t("settings.manageAccount")}
          </Box>
        </HStack>

        <Box h="1px" bg={tokens.colors.border.subtle} />
      </VStack>

      {/* ── App Update ──────────────────────────────────── */}
      <UpdateSection />

      {/* ── Language ─────────────────────────────────────── */}
      <VStack align="stretch" gap={3}>
        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
          {t("settings.language")}
        </Text>

        <HStack justify="space-between" align="center">
          <Box>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">{t("settings.interface")}</Text>
            <Text color={tokens.colors.text.disabled} fontSize="11px">{t("settings.interfaceDesc")}</Text>
          </Box>
          <NativeSelect.Root size="sm" width="160px">
            <NativeSelect.Field
              bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary} value={appLanguage}
              onChange={e => setAppLanguage(e.target.value as 'en' | 'pt')}
            >
              <option value="en">English</option>
              <option value="pt">Português</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>

        <HStack justify="space-between" align="center">
          <Box>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">{t("settings.agent")}</Text>
            <Text color={tokens.colors.text.disabled} fontSize="11px">{t("settings.agentDesc")}</Text>
          </Box>
          <NativeSelect.Root size="sm" width="160px">
            <NativeSelect.Field
              bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
              color={tokens.colors.text.primary} value={agentLanguage}
              onChange={e => setAgentLanguage(e.target.value as 'en' | 'pt' | 'zh' | 'es' | 'fr' | 'de' | 'ja')}
            >
              <option value="en">English</option>
              <option value="pt">Português</option>
              <option value="zh">中文</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="ja">日本語</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </HStack>
      </VStack>

    </VStack>
  )
}

// ━━━ Update Section ━━━

function UpdateSection() {
  const t = useTranslation()
  const [update, setUpdate] = useState<UpdateInfo | null>(getPendingUpdate)
  const [status, setStatus] = useState<'idle' | 'checking' | 'downloading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleCheck = useCallback(async () => {
    setStatus('checking')
    setError(null)
    const minDelay = new Promise(r => setTimeout(r, 800))
    try {
      const [result] = await Promise.all([checkForUpdate(), minDelay])
      setUpdate(result)
      // Persist so the banner survives navigation away from Settings
      setPendingUpdate(result)
      setStatus('idle')
    } catch (err) {
      await minDelay
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  const handleInstall = useCallback(async () => {
    setStatus('downloading')
    setError(null)
    try {
      await installUpdate()
      // relaunch happens inside installUpdate — this line is unreachable
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [])

  return (
    <VStack align="stretch" gap={3}>
      <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.06em">
        {t('settings.appUpdate')}
      </Text>

      {update ? (
        <Flex
          align="center" justify="space-between"
          px={4} py={3} borderRadius={tokens.radius.lg}
          bg="rgba(254, 16, 99, 0.06)"
          border="1px solid rgba(254, 16, 99, 0.15)"
        >
          <Box>
            <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
              TM Code {update.version} {t('settings.updateAvailable')}
            </Text>
            <Text fontSize="11px" color={tokens.colors.text.secondary} mt={0.5}>
              {t('settings.updateRestart')}
            </Text>
          </Box>
          <Button
            size="sm"
            bg={tokens.colors.accent.primary}
            color="white"
            borderRadius={tokens.radius.md}
            fontSize="12px"
            fontWeight="600"
            px={4}
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            disabled={status === 'downloading'}
            onClick={status === 'downloading' ? undefined : handleInstall}
          >
            {status === 'downloading' ? t('settings.updateDownloading') : t('settings.updateNow')}
          </Button>
        </Flex>
      ) : (
        <Flex align="center" justify="space-between">
          <Text fontSize="13px" color={tokens.colors.text.secondary}>
            {status === 'error' ? t('settings.updateCheckFailed') : t('settings.updateUpToDate')}
          </Text>
          <Box
            as="button" display="flex" alignItems="center" gap="5px"
            px={2.5} py="5px" borderRadius={tokens.radius.md}
            fontSize="12px" fontWeight="500"
            color={tokens.colors.text.secondary} bg={tokens.colors.bg.card}
            border="1px solid" borderColor={tokens.colors.bg.cardBorder}
            outline="none"
            cursor={status === 'checking' ? 'default' : 'pointer'}
            opacity={status === 'checking' ? 0.6 : 1}
            transition={tokens.transition.fast}
            _hover={{ borderColor: tokens.colors.border.default, color: tokens.colors.text.primary }}
            onClick={status === 'checking' ? undefined : handleCheck}
          >
            <Box
              display="inline-flex"
              css={status === 'checking' ? {
                animation: 'spin 1s linear infinite',
                '@keyframes spin': { to: { transform: 'rotate(360deg)' } },
              } : undefined}
            >
              <FiRefreshCw size={11} />
            </Box>
            {status === 'checking' ? t('settings.updateChecking') : t('settings.updateCheck')}
          </Box>
        </Flex>
      )}

      {error && (
        <Text fontSize="11px" color={tokens.colors.accent.red}>{error}</Text>
      )}

      <Box h="1px" bg={tokens.colors.border.subtle} />
    </VStack>
  )
}

// ━━━ Editor Section ━━━

function SandboxSection() {
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled)
  const setSandboxEnabled = useSettingsStore(s => s.setSandboxEnabled)
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [platform, setPlatform] = useState('')
  const [depsOk, setDepsOk] = useState(true)
  const [depsMissing, setDepsMissing] = useState<string[]>([])
  const [depsHints, setDepsHints] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(function () {
    invoke<{ enabled: boolean; available: boolean; platform: string }>('sandbox_status').then(function (info) {
      setSandboxAvailable(info.available)
      setPlatform(info.platform)
      setLoading(false)
    })
    invoke<{ ok: boolean; missing: string[]; hints: string[] }>('sandbox_check_deps').then(function (deps) {
      setDepsOk(deps.ok)
      setDepsMissing(deps.missing)
      setDepsHints(deps.hints)
    })
  }, [])

  function handleToggle(checked: boolean) {
    setSandboxEnabled(checked) // persists to localStorage + syncs to Rust
  }

  const platformLabel = platform === 'macos' ? 'sandbox-exec (Seatbelt)'
    : platform === 'linux' ? 'bubblewrap (bwrap)'
    : platform === 'windows' ? 'WSL2 + bubblewrap'
    : 'Not available'

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title="Sandbox">
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                Sandbox
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                Isola os comandos do agente ao directório do projecto. Protege ficheiros do sistema, SSH keys, credentials e histórico.
              </Text>
            </Box>
            {!loading && (
              <Switch.Root
                checked={sandboxEnabled}
                onCheckedChange={function (e) { handleToggle(e.checked) }}
                colorPalette="pink"
                disabled={!sandboxAvailable}
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            )}
          </HStack>
        </Field.Root>

        <Box h="1px" bg={tokens.colors.border.subtle} />

        <VStack align="stretch" gap={2} px={1}>
          <HStack justify="space-between">
            <Text fontSize="12px" color={tokens.colors.text.secondary}>Engine</Text>
            <Text fontSize="12px" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
              {platformLabel}
            </Text>
          </HStack>
          <HStack justify="space-between">
            <Text fontSize="12px" color={tokens.colors.text.secondary}>Estado</Text>
            <HStack gap={1.5}>
              <Box
                w="6px" h="6px" borderRadius="full"
                bg={sandboxEnabled ? tokens.colors.accent.green : tokens.colors.text.disabled}
              />
              <Text fontSize="12px" color={sandboxEnabled ? tokens.colors.accent.green : tokens.colors.text.disabled}>
                {sandboxEnabled ? 'Activo' : 'Inactivo'}
              </Text>
            </HStack>
          </HStack>
        </VStack>

        {sandboxEnabled && (
          <>
            <Box h="1px" bg={tokens.colors.border.subtle} />
            <VStack align="stretch" gap={1} px={1}>
              <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.05em">
                Protecções activas
              </Text>
              <Text fontSize="12px" color={tokens.colors.text.secondary}>
                {platform === 'macos'
                  ? 'Filesystem: apenas projecto + /tmp. Executáveis: /usr, /bin, /opt, tools. Network: sem restrição (npm/git). Bloqueado: ~/.ssh, ~/.aws, ~/.gnupg, keychains.'
                  : 'Filesystem: / read-only, projecto read-write. Bloqueado: ~/.ssh, ~/.aws, ~/.gnupg, ~/.docker, .bash_history, .netrc, .npmrc, .git-credentials.'
                }
              </Text>
            </VStack>
          </>
        )}

        {!depsOk && !loading && (
          <VStack align="stretch" gap={1} px={1}>
            <Text fontSize="12px" color={tokens.colors.accent.orange} fontWeight="500">
              Dependências em falta:
            </Text>
            {depsMissing.map(function (dep, i) {
              return <Text key={i} fontSize="12px" color={tokens.colors.accent.red}>• {dep}</Text>
            })}
            {depsHints.map(function (hint, i) {
              return <Text key={i} fontSize="11px" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono}>{hint}</Text>
            })}
          </VStack>
        )}
      </SettingsGroup>

      <FlaggedCommandsSection />
    </VStack>
  )
}

// ── All commands that can be flagged for approval ──
// Import the canonical list from toolExecutor to keep UI and logic in sync
import ToolExecutor from '../../services/agent/toolExecutor'

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'rm': 'Remove files or directories',
  'rmdir': 'Remove empty directories',
  'mv': 'Move or rename files',
  'cp': 'Copy files or directories',
  'chmod': 'Change file permissions',
  'chown': 'Change file ownership',
  'ln': 'Create symbolic links',
  'mkfs': 'Format a disk partition',
  'dd': 'Low-level disk copy',
  'shutdown': 'Shut down the system',
  'reboot': 'Reboot the system',
  'git push': 'Push commits to remote',
  'git reset': 'Reset commit history',
  'git checkout': 'Switch branches or restore files',
  'git merge': 'Merge branches',
  'git rebase': 'Rebase commit history',
  'git stash': 'Stash uncommitted changes',
  'git clean': 'Remove untracked files',
  'git commit': 'Create a commit',
  'npm uninstall': 'Remove packages (npm)',
  'yarn remove': 'Remove packages (yarn)',
  'pnpm remove': 'Remove packages (pnpm)',
  'kill': 'Kill a process by PID',
  'pkill': 'Kill processes by name',
  'killall': 'Kill all processes by name',
  'sudo': 'Run as superuser',
  'su': 'Switch user',
  'doas': 'Run as another user',
  'pkexec': 'Run as privileged user',
  'wget': 'Download files from the web',
  'launchctl': 'Manage macOS services',
  'systemctl': 'Manage Linux services',
  'docker': 'Docker container commands',
  'docker-compose': 'Docker Compose commands',
}

const FLAGGABLE_COMMANDS = ToolExecutor.DANGEROUS_COMMANDS.map(cmd => ({
  command: cmd,
  label: cmd,
  description: COMMAND_DESCRIPTIONS[cmd] || cmd,
}))

function FlaggedCommandsSection() {
  const t = useTranslation()
  const flaggedCommands = useSettingsStore(s => s.flaggedCommands)
  const toggleFlaggedCommand = useSettingsStore(s => s.toggleFlaggedCommand)

  return (
    <SettingsGroup title={t('settings.flaggedCommands')}>
      <Text fontSize="12px" color={tokens.colors.text.secondary} mb={3}>
        {t('settings.flaggedCommandsDesc')}
      </Text>
      <VStack
        align="stretch"
        gap={0}
        maxH="calc(100vh - 380px)"
        overflowY="auto"
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.1)', borderRadius: '4px' },
        }}
      >
        {FLAGGABLE_COMMANDS.map(({ command, label, description }) => {
          const isActive = flaggedCommands.includes(command)
          return (
            <Flex
              key={command}
              align="center"
              gap={3}
              py="6px"
              px={2}
              borderRadius={tokens.radius.md}
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              cursor="pointer"
              onClick={() => toggleFlaggedCommand(command)}
            >
              {/* Checkbox — checked = agent must ask before running */}
              <Box
                w="16px"
                h="16px"
                borderRadius="4px"
                border={`1.5px solid ${isActive ? tokens.colors.accent.red : tokens.colors.border.default}`}
                bg={isActive ? tokens.colors.accent.red : 'transparent'}
                display="flex"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                transition={tokens.transition.fast}
              >
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </Box>
              <Box flex={1} minW={0}>
                <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary} fontFamily={tokens.fontFamily.mono}>
                  {label}
                </Text>
                <Text fontSize="11px" color={tokens.colors.text.disabled}>{description}</Text>
              </Box>
              {isActive && (
                <Text fontSize="10px" color={tokens.colors.accent.red} fontWeight="600" flexShrink={0}>
                  {t('settings.blocked')}
                </Text>
              )}
            </Flex>
          )
        })}
      </VStack>
    </SettingsGroup>
  )
}

function EditorSection() {
  const t = useTranslation()
  const autocompleteEnabled = useSettingsStore(function (s) { return s.autocomplete.enabled })
  const tabSize = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpaces = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentation = useSettingsStore(function (s) { return s.editor.detectIndentation })
  const formatOnSave = useSettingsStore(function (s) { return s.formatOnSave })

  const setAutocompleteEnabled = useSettingsStore(function (s) { return s.setAutocompleteEnabled })
  const setTabSize = useSettingsStore(function (s) { return s.setTabSize })
  const setInsertSpaces = useSettingsStore(function (s) { return s.setInsertSpaces })
  const setDetectIndentation = useSettingsStore(function (s) { return s.setDetectIndentation })
  const setFormatOnSave = useSettingsStore(function (s) { return s.setFormatOnSave })

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t("settings.aiAutocomplete")}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t("settings.enableAutocomplete")}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.autocompleteDesc')}
              </Text>
            </Box>
            <Switch.Root checked={autocompleteEnabled} onCheckedChange={function (e) { setAutocompleteEnabled(e.checked) }} colorPalette="pink">
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.formatting")}>
        <Field.Root>
          <HStack justify="space-between">
            <Box>
              <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                {t('settings.formatOnSave')}
              </Text>
              <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                {t('settings.formatOnSaveDesc')}
              </Text>
            </Box>
            <Switch.Root checked={formatOnSave} onCheckedChange={function (e) { setFormatOnSave(e.checked) }} colorPalette="pink">
              <Switch.HiddenInput />
              <Switch.Control />
            </Switch.Root>
          </HStack>
        </Field.Root>
      </SettingsGroup>

      <SettingsGroup title={t("settings.indentation")}>
        <VStack align="stretch" gap={4}>
          <Field.Root>
            <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px" mb={1}>
              {t('settings.tabSize')}
            </Text>
            <NativeSelect.Root size="sm" width="120px">
              <NativeSelect.Field
                bg={tokens.colors.bg.input}
                borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary}
                value={String(tabSize)}
                onChange={function (e) { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setTabSize(v) }}
              >
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="8">8</option>
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>

          <Field.Root>
            <HStack justify="space-between">
              <Box>
                <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                  {t('settings.insertSpaces')}
                </Text>
                <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                  {t('settings.insertSpacesDesc')}
                </Text>
              </Box>
              <Switch.Root checked={insertSpaces} onCheckedChange={function (e) { setInsertSpaces(e.checked) }} colorPalette="blue">
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>
          </Field.Root>

          <Field.Root>
            <HStack justify="space-between">
              <Box>
                <Text color={tokens.colors.text.primary} fontWeight="500" fontSize="13px">
                  {t('settings.detectIndentation')}
                </Text>
                <Text color={tokens.colors.text.secondary} fontSize="12px" mt="2px">
                  {t('settings.detectIndentationDesc')}
                </Text>
              </Box>
              <Switch.Root checked={detectIndentation} onCheckedChange={function (e) { setDetectIndentation(e.checked) }} colorPalette="blue">
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>
          </Field.Root>
        </VStack>
      </SettingsGroup>
    </VStack>
  )
}

// ━━━ Shortcuts Section ━━━

const SHORTCUT_ORDER: ShortcutId[] = [
  'diffAccept', 'diffAcceptAll', 'diffReject', 'diffRejectAll',
  'quickOpen', 'commandPalette', 'toggleTerminal', 'toggleSidebar',
  'splitEditor', 'goToLine', 'searchInProject', 'settings',
  'openFile', 'newProject', 'closeFile',
]

function ShortcutsSection() {
  const t = useTranslation()
  const shortcuts = useSettingsStore(s => s.shortcuts)
  const setShortcut = useSettingsStore(s => s.setShortcut)
  const resetShortcuts = useSettingsStore(s => s.resetShortcuts)
  const [editingId, setEditingId] = useState<ShortcutId | null>(null)
  const [pendingBinding, setPendingBinding] = useState<KeyBinding | null>(null)

  // Capture key combo when editing + cancel on click outside
  useEffect(() => {
    if (!editingId) return

    function handleKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()

      // Enter confirms the pending binding
      if (e.key === 'Enter' && pendingBinding && editingId) {
        setShortcut(editingId, pendingBinding)
        setEditingId(null)
        setPendingBinding(null)
        return
      }

      // Escape cancels (with or without pending — always exit edit mode)
      if (e.key === 'Escape') {
        setEditingId(null)
        setPendingBinding(null)
        return
      }

      // Ignore lone modifier presses
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return

      const binding: KeyBinding = { key: e.key }
      if (e.metaKey || e.ctrlKey) binding.meta = true
      if (e.shiftKey) binding.shift = true
      if (e.altKey) binding.alt = true

      setPendingBinding(binding)
    }

    // Cancel editing if user clicks anywhere (focus moved away)
    function handleClick() {
      setEditingId(null)
      setPendingBinding(null)
    }

    window.addEventListener('keydown', handleKey, true)
    // Delay click listener to avoid the same click that started editing
    const timer = setTimeout(() => window.addEventListener('click', handleClick), 100)
    return () => {
      window.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('click', handleClick)
      clearTimeout(timer)
    }
  }, [editingId, pendingBinding, setShortcut])

  return (
    <VStack align="stretch" gap={4}>
      <Box>
        <Text fontSize="12px" color={tokens.colors.text.muted} mb={3}>
          {t('settings.shortcutsDesc')}
        </Text>
      </Box>

      <Box
        borderRadius="10px"
        border={`1px solid ${tokens.colors.border.subtle}`}
        overflow="hidden"
      >
        {SHORTCUT_ORDER.map((id, idx) => {
          const isEditing = editingId === id
          const isModified = JSON.stringify(shortcuts[id]) !== JSON.stringify(DEFAULT_SHORTCUTS[id])

          return (
            <Flex
              key={id}
              align="center"
              justify="space-between"
              px={4}
              py="10px"
              bg={isEditing ? 'rgba(254, 16, 99, 0.06)' : 'transparent'}
              borderTop={idx > 0 ? `1px solid ${tokens.colors.border.subtle}` : undefined}
              _hover={{ bg: isEditing ? undefined : 'rgba(255, 255, 255, 0.02)' }}
              cursor="pointer"
              onClick={() => {
                if (!isEditing) {
                  setEditingId(id)
                  setPendingBinding(null)
                }
              }}
            >
              <Flex align="center" gap={2}>
                <Text fontSize="13px" color={tokens.colors.text.primary}>
                  {t(`settings.shortcut.${id}` as TranslationKey)}
                </Text>
                {isModified && !isEditing && (
                  <Box w="5px" h="5px" borderRadius="full" bg={tokens.colors.accent.primary} flexShrink={0} />
                )}
              </Flex>
              {isEditing ? (
                <Box
                  px="10px"
                  py="4px"
                  borderRadius="6px"
                  bg="rgba(254, 16, 99, 0.12)"
                  border={`1px solid ${tokens.colors.accent.primary}`}
                  minW="60px"
                  textAlign="center"
                >
                  {pendingBinding ? (
                    <KeyBindingDisplay binding={pendingBinding} />
                  ) : (
                    <Text fontSize="12px" color={tokens.colors.accent.primary} fontStyle="italic">
                      {t('settings.pressKeys')}
                    </Text>
                  )}
                </Box>
              ) : (
                <KeyBindingDisplay binding={shortcuts[id]} />
              )}
            </Flex>
          )
        })}
      </Box>

      <Button
        variant="ghost"
        size="sm"
        color={tokens.colors.text.secondary}
        _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
        onClick={resetShortcuts}
        alignSelf="flex-start"
      >
        {t('settings.resetShortcuts')}
      </Button>
    </VStack>
  )
}

// ━━━ Skills Section ━━━

function SkillsSection() {
  const t = useTranslation()
  const skills = useSkillStore(function (s) { return s.skills })
  const isLoading = useSkillStore(function (s) { return s.isLoading })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })
  const [showNewSkill, setShowNewSkill] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillScope, setNewSkillScope] = useState<'project' | 'global'>('project')
  const [newSkillContent, setNewSkillContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const loadSkills = useCallback(async function () {
    if (!projectPath) return
    useSkillStore.getState().setLoading(true)
    try {
      const skillService = SkillService.getInstance()
      skillService.invalidateCache()
      const loaded = await skillService.loadSkills(projectPath)
      useSkillStore.getState().setSkills(loaded)
    } catch (error) {
      useSkillStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }, [projectPath])

  useEffect(function () { loadSkills() }, [loadSkills])

  async function handleCreateSkill() {
    if (!newSkillName.trim() || !newSkillContent.trim()) return
    setIsSaving(true)
    try {
      const skillService = SkillService.getInstance()
      if (newSkillScope === 'project' && projectPath) {
        await skillService.createProjectSkill(projectPath, newSkillName, newSkillContent)
      } else {
        await skillService.createGlobalSkill(newSkillName, newSkillContent)
      }
      setShowNewSkill(false)
      setNewSkillName('')
      setNewSkillContent('')
      await loadSkills()
    } catch { /* */ } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteSkill(skill: { id: string; name: string; path: string; scope: string }) {
    if (skill.scope === 'bundled') return
    try {
      const skillService = SkillService.getInstance()
      await skillService.deleteSkill(skill as Parameters<typeof skillService.deleteSkill>[0])
      await loadSkills()
    } catch { /* */ }
  }

  const bundledSkills = skills.filter(function (s) { return s.scope === 'bundled' })
  const globalSkills = skills.filter(function (s) { return s.scope === 'global' })
  const projectSkills = skills.filter(function (s) { return s.scope === 'project' })

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t("settings.bundled")} badge={t("settings.autoDetected")}>
        {isLoading ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('settings.loadingSkills')}</Text>
        ) : bundledSkills.length === 0 ? (
          <EmptyState text={t('settings.noBundledSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {bundledSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="bundled" />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.global")} badge={IS_WINDOWS ? '%USERPROFILE%\\.toquemedia-studio\\skills\\' : '~/.toquemedia-studio/skills/'}>
        {globalSkills.length === 0 ? (
          <EmptyState text={t('settings.noGlobalSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {globalSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="global" onDelete={function () { handleDeleteSkill(skill) }} />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.project")} badge={IS_WINDOWS ? '.tms\\skills\\' : '.tms/skills/'}>
        {projectSkills.length === 0 ? (
          <EmptyState text={t('settings.noProjectSkills')} />
        ) : (
          <VStack align="stretch" gap={1}>
            {projectSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="project" onDelete={function () { handleDeleteSkill(skill) }} />
            })}
          </VStack>
        )}
      </SettingsGroup>

      {showNewSkill ? (
        <Box p={4} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.border.default} bg={tokens.colors.bg.overlay}>
          <VStack align="stretch" gap={3}>
            <HStack gap={3}>
              <Box flex={1}>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.name")}</Text>
                <Input size="sm" value={newSkillName} onChange={function (e) { setNewSkillName(e.target.value) }}
                  placeholder="my-conventions" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                  color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }} />
              </Box>
              <Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.scope")}</Text>
                <NativeSelect.Root size="sm" width="120px">
                  <NativeSelect.Field bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                    color={tokens.colors.text.primary} value={newSkillScope}
                    onChange={function (e) { setNewSkillScope(e.target.value as 'project' | 'global') }}>
                    <option value="project">{t('settings.project')}</option>
                    <option value="global">{t('settings.global')}</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Box>
            </HStack>
            <Box>
              <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.content")}</Text>
              <Textarea size="sm" value={newSkillContent} onChange={function (e) { setNewSkillContent(e.target.value) }}
                placeholder={"# My Conventions\n\nWrite your coding conventions here..."}
                bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
                rows={10} fontFamily={tokens.fontFamily.mono} fontSize="12px" />
            </Box>
            <HStack justify="flex-end" gap={2}>
              <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(false) }}
                color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}>{t('settings.cancel')}</Button>
              <Button size="sm" onClick={handleCreateSkill}
                disabled={!newSkillName.trim() || !newSkillContent.trim() || isSaving}
                bg={tokens.colors.accent.primary} color="white"
                _hover={{ bg: tokens.colors.accent.primaryDark }} _disabled={{ opacity: 0.5 }}>
                {isSaving ? t('settings.saving') : t('settings.createSkill')}</Button>
            </HStack>
          </VStack>
        </Box>
      ) : (
        <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(true) }}
          color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }} w="fit-content">
          <FiPlus style={{ marginRight: 6 }} />{t('settings.newSkill')}
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        {t('settings.skillsNote')}
      </Text>
    </VStack>
  )
}

// ━━━ MCP Section ━━━

function McpSection() {
  const t = useTranslation()
  const servers = useMcpStore(function (s) { return s.servers })
  const isInitializing = useMcpStore(function (s) { return s.isInitializing })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })
  const [showAddServer, setShowAddServer] = useState(false)

  async function handleStop(name: string) {
    try { await MCPService.getInstance().stopServer(name) } catch { /* */ }
  }

  async function handleRemove(name: string) {
    try {
      await MCPService.getInstance().removeServer(projectPath, name)
    } catch (err) {
      console.error('[MCP] Failed to remove server:', err)
    }
  }

  async function handleRestartServer(name: string) {
    try {
      await MCPService.getInstance().stopServer(name)
      await MCPService.getInstance().addSingleServer(projectPath, name)
    } catch { /* */ }
  }

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title={t("settings.activeServers")}>
        {isInitializing ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t('settings.initializingMcp')}</Text>
        ) : servers.length === 0 ? (
          <Box py={6} textAlign="center">
            <Box mb={3} color={tokens.colors.text.disabled}><FiServer size={28} style={{ margin: '0 auto' }} /></Box>
            <Text fontSize="13px" color={tokens.colors.text.muted} mb={1}>{t('settings.noMcpServers')}</Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>
              {t('settings.addServerOrEdit')}
            </Text>
          </Box>
        ) : (
          <VStack align="stretch" gap={2}>
            {servers.map(function (server) {
              return (
                <McpServerCard key={server.name} server={server}
                  onStop={function () { handleStop(server.name) }}
                  onRemove={function () { handleRemove(server.name) }}
                  onRestart={function () { handleRestartServer(server.name) }} />
              )
            })}
          </VStack>
        )}
      </SettingsGroup>

      {/* {t('settings.addServer')} Form */}
      {showAddServer ? (
        <AddServerForm
          projectPath={projectPath || ''}
          onDone={function () { setShowAddServer(false) }}
          onCancel={function () { setShowAddServer(false) }}
        />
      ) : (
        <Button size="sm" variant="outline" onClick={function () { setShowAddServer(true) }}
          color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }} w="fit-content">
          <FiPlus style={{ marginRight: 6 }} />{t('settings.addServer')}
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        {t('settings.mcpNote')}
      </Text>
    </VStack>
  )
}

// ━━━ Add Server Form ━━━

function AddServerForm(props: { projectPath: string; onDone: () => void; onCancel: () => void }) {
  const t = useTranslation()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envPairs, setEnvPairs] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!name.trim()) { setError(t('settings.serverNameRequired')); return }
    if (!command.trim()) { setError(t('settings.commandRequired')); return }

    setIsSaving(true)
    setError('')

    try {
      // Write to global config so MCP servers persist across projects
      const homeDir = await invoke<string>('get_home_directory')
      const configDir = `${homeDir}/.toquemedia-studio`
      const configPath = `${configDir}/mcp.json`
      let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      try {
        const raw = await invoke<string>('read_file', { path: configPath })
        config = JSON.parse(raw)
        if (!config.mcpServers) config.mcpServers = {}
      } catch {
        // No existing config
      }

      // Standard MCP format: { command, args?, env? }
      const serverEntry: Record<string, unknown> = {
        command: command.trim(),
      }

      // Shell-style split: respects "quoted strings" as single args
      const argsList: string[] = []
      const argRegex = /(?:"([^"]*)")|(?:'([^']*)')|(\S+)/g
      let match: RegExpExecArray | null
      const trimmed = args.trim()
      if (trimmed) {
        while ((match = argRegex.exec(trimmed)) !== null) {
          argsList.push(match[1] ?? match[2] ?? match[3])
        }
      }
      if (argsList.length > 0) serverEntry.args = argsList

      // Parse env pairs (KEY=VALUE per line)
      if (envPairs.trim()) {
        const env: Record<string, string> = {}
        for (const line of envPairs.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        if (Object.keys(env).length > 0) serverEntry.env = env
      }

      config.mcpServers[name.trim()] = serverEntry
      await invoke('create_directories_all', { path: configDir })
      await invoke('write_file', { path: configPath, content: JSON.stringify(config, null, 2) })

      await MCPService.getInstance().addSingleServer(undefined, name.trim())
      props.onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Box p={4} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.accent.primaryBorder} bg={tokens.colors.bg.overlay}>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb={3}>{t('settings.addMcpServer')}</Text>
      <VStack align="stretch" gap={3}>
        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.name")}</Text>
          <Input size="sm" value={name} onChange={function (e) { setName(e.target.value) }}
            placeholder="chakra-ui" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }} />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.command")}</Text>
          <Input size="sm" value={command} onChange={function (e) { setCommand(e.target.value) }}
            placeholder="npx" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
            fontFamily={tokens.fontFamily.mono} fontSize="12px" />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("settings.arguments")}</Text>
          <Input size="sm" value={args} onChange={function (e) { setArgs(e.target.value) }}
            placeholder="-y @chakra-ui/react-mcp"
            bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
            fontFamily={tokens.fontFamily.mono} fontSize="12px" />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>
            {t('settings.envVars')}
            <Text as="span" color={tokens.colors.text.disabled}> {t('settings.envOptional')}</Text>
          </Text>
          <Textarea size="sm" value={envPairs} onChange={function (e) { setEnvPairs(e.target.value) }}
            placeholder={"GITHUB_TOKEN=ghp_...\nAPI_KEY=sk-..."}
            bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
            rows={2} fontFamily={tokens.fontFamily.mono} fontSize="12px" />
        </Box>

        {error && <Text fontSize="11px" color={tokens.colors.accent.red}>{error}</Text>}

        <HStack justify="flex-end" gap={2}>
          <Button size="sm" variant="outline" onClick={props.onCancel}
            color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
            _hover={{ bg: tokens.colors.bg.hoverSubtle }}>{t('settings.cancel')}</Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}
            bg={tokens.colors.accent.primary} color="white"
            _hover={{ bg: tokens.colors.accent.primaryDark }} _disabled={{ opacity: 0.5 }}>
            {isSaving ? t('settings.adding') : t('settings.addServer')}</Button>
        </HStack>
      </VStack>
    </Box>
  )
}

// ━━━ Shared components ━━━

function SettingsGroup(props: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <Box>
      <Flex align="center" gap={2} mb={3}>
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>{props.title}</Text>
        {props.badge && (
          <Text fontSize="10px" color={tokens.colors.text.disabled} bg={tokens.colors.bg.card}
            px={2} py="1px" borderRadius={tokens.radius.full} fontFamily={tokens.fontFamily.mono}>
            {props.badge}
          </Text>
        )}
      </Flex>
      {props.children}
    </Box>
  )
}

function SkillRow(props: { name: string; scope: string; onDelete?: () => void }) {
  const scopeColors: Record<string, string> = {
    bundled: tokens.colors.accent.purple,
    global: tokens.colors.accent.blue,
    project: tokens.colors.accent.green,
  }
  return (
    <Flex align="center" justify="space-between" px={3} py="8px" borderRadius={tokens.radius.lg}
      bg={tokens.colors.bg.card} border="1px solid" borderColor={tokens.colors.bg.cardBorder}
      transition={tokens.transition.fast} _hover={{ borderColor: tokens.colors.border.default }}>
      <HStack gap={2}>
        <Box w="6px" h="6px" borderRadius="full" bg={scopeColors[props.scope] || tokens.colors.text.disabled} />
        <Text fontSize="13px" color={tokens.colors.text.primary}>{props.name}</Text>
      </HStack>
      {props.onDelete && (
        <Box as="button" display="flex" alignItems="center" justifyContent="center"
          w="26px" h="26px" borderRadius={tokens.radius.md} bg="transparent"
          color={tokens.colors.text.disabled} cursor="pointer" transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
          onClick={props.onDelete}>
          <FiTrash2 size={13} />
        </Box>
      )}
    </Flex>
  )
}

function McpServerCard(props: { server: McpServerState; onStop: () => void; onRemove: () => void; onRestart: () => void }) {
  const t = useTranslation()
  const { server } = props
  const statusColors: Record<string, string> = {
    running: tokens.colors.accent.green,
    starting: tokens.colors.accent.orange,
    error: tokens.colors.accent.red,
    stopped: tokens.colors.text.disabled,
  }
  return (
    <Box p={3} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.border.default}
      bg={tokens.colors.bg.card} transition={tokens.transition.fast} _hover={{ borderColor: tokens.colors.border.glass }}>
      <Flex justify="space-between" align="center" mb={server.tools.length > 0 || server.error ? 2 : 0}>
        <HStack gap={2}>
          <Box w="8px" h="8px" borderRadius="full" bg={statusColors[server.status] || tokens.colors.text.disabled} />
          <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary}>{server.name}</Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled}>({server.transport})</Text>
        </HStack>
        <HStack gap={1}>
          {server.status === 'running' && (
            <ActionButton icon={<FiSquare size={11} />} label={t('settings.stop')} color={tokens.colors.accent.red}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onStop} />
          )}
          {server.status === 'error' && (
            <ActionButton icon={<FiRefreshCw size={11} />} label={t('settings.restart')} color={tokens.colors.accent.orange}
              hoverBg="rgba(247, 127, 0, 0.1)" onClick={props.onRestart} />
          )}
          {(server.status === 'stopped' || server.status === 'error') && (
            <ActionButton icon={<FiTrash2 size={11} />} label={t('settings.remove')} color={tokens.colors.text.disabled}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onRemove} />
          )}
        </HStack>
      </Flex>
      {server.error && <Text fontSize="11px" color={tokens.colors.accent.red} mb={1}>{server.error}</Text>}
      {server.tools.length > 0 && (
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          {t('settings.tools')}: {server.tools.map(function (tool) { return tool.name }).join(', ')}
        </Text>
      )}
    </Box>
  )
}

function ActionButton(props: { icon: React.ReactNode; label: string; color: string; hoverBg: string; onClick: () => void }) {
  return (
    <Box as="button" display="flex" alignItems="center" gap="4px" px={2} py={1}
      borderRadius={tokens.radius.md} bg="transparent" color={props.color} cursor="pointer"
      fontSize="11px" fontWeight="500" transition={tokens.transition.fast}
      _hover={{ bg: props.hoverBg }} onClick={props.onClick}>
      {props.icon}{props.label}
    </Box>
  )
}

function EmptyState(props: { text: string }) {
  return <Text fontSize="12px" color={tokens.colors.text.muted} py={2}>{props.text}</Text>
}

export default memo(SettingsView)
