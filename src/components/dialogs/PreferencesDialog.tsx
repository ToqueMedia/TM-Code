import React, { useEffect, useState, useCallback } from 'react'
import {
  Box,
  Button,
  Dialog,
  Field,
  Flex,
  HStack,
  Portal,
  NativeSelect,
  Switch,
  Text,
  Textarea,
  VStack,
  Input,
} from '@chakra-ui/react'
import { FiPlus, FiTrash2, FiSquare, FiRefreshCw } from 'react-icons/fi'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore, McpServerState } from '../../stores/mcpStore'
import { useProjectStore } from '../../stores/projectStore'
import SkillService from '../../services/agent/skillService'
import MCPService from '../../services/mcp/mcpService'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

type TabId = 'editor' | 'skills' | 'mcp'

export default function PreferencesDialog(): React.ReactElement | null {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('editor')

  useEffect(function onEvent() {
    function openPreferences() { setIsOpen(true) }
    function closePreferences() { setIsOpen(false) }
    window.addEventListener('app:preferences', openPreferences)
    window.addEventListener('app:preferences:close', closePreferences)
    return function cleanup() {
      window.removeEventListener('app:preferences', openPreferences)
      window.removeEventListener('app:preferences:close', closePreferences)
    }
  }, [])

  function onClose(): void { setIsOpen(false) }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'editor', label: 'Editor' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP Servers' },
  ]

  return (
    <Dialog.Root open={isOpen} onOpenChange={function (e) { if (!e.open) onClose() }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            bg={tokens.colors.bg.app}
            color={tokens.colors.text.primary}
            border="1px solid"
            borderColor={tokens.colors.border.default}
            minW="640px"
            maxH="80vh"
          >
            <Dialog.Header
              bg={tokens.colors.bg.overlay}
              borderBottom="1px solid"
              borderColor={tokens.colors.border.default}
              color={tokens.colors.text.inverse}
              pb={0}
            >
              <VStack align="stretch" gap={0} w="100%">
                <Dialog.Title mb={3}>{t("menu.settings")}</Dialog.Title>
                <Flex gap={0}>
                  {tabs.map(function (tab) {
                    const isActive = activeTab === tab.id
                    return (
                      <Box
                        key={tab.id}
                        as="button"
                        px={4}
                        py="10px"
                        fontSize="13px"
                        fontWeight={isActive ? '600' : '400'}
                        color={isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary}
                        borderBottom="2px solid"
                        borderColor={isActive ? tokens.colors.accent.primary : 'transparent'}
                        bg="transparent"
                        cursor="pointer"
                        transition={tokens.transition.fast}
                        _hover={{
                          color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary,
                          bg: tokens.colors.bg.hoverSubtle,
                        }}
                        onClick={function () { setActiveTab(tab.id) }}
                      >
                        {tab.label}
                      </Box>
                    )
                  })}
                </Flex>
              </VStack>
            </Dialog.Header>

            <Dialog.Body bg={tokens.colors.bg.app} pb={6} overflowY="auto" maxH="60vh">
              {activeTab === 'editor' && <EditorTab />}
              {activeTab === 'skills' && <SkillsTab />}
              {activeTab === 'mcp' && <McpTab />}
            </Dialog.Body>

            <Dialog.Footer
              bg={tokens.colors.bg.overlay}
              borderTop="1px solid"
              borderColor={tokens.colors.border.default}
            >
              <Button
                variant="outline"
                onClick={onClose}
                color={tokens.colors.text.primary}
                borderColor={tokens.colors.border.default}
                _hover={{
                  bg: tokens.colors.bg.whiteSubtle,
                  borderColor: tokens.colors.border.subtle
                }}
              >
                Close
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

// === Editor Tab ===

function EditorTab(): React.ReactElement {
  const tabSize = useSettingsStore(function (s) { return s.editor.tabSize })
  const insertSpaces = useSettingsStore(function (s) { return s.editor.insertSpaces })
  const detectIndentation = useSettingsStore(function (s) { return s.editor.detectIndentation })
  const autocompleteEnabled = useSettingsStore(function (s) { return s.autocomplete.enabled })

  const setTabSize = useSettingsStore(function (s) { return s.setTabSize })
  const setInsertSpaces = useSettingsStore(function (s) { return s.setInsertSpaces })
  const setDetectIndentation = useSettingsStore(function (s) { return s.setDetectIndentation })
  const setAutocompleteEnabled = useSettingsStore(function (s) { return s.setAutocompleteEnabled })

  return (
    <>
      <Text fontSize="sm" color={tokens.colors.text.primary} mb={3} fontWeight="600">
        AI Autocomplete
      </Text>

      <Field.Root mb={6}>
        <Field.Label color={tokens.colors.text.primary} fontWeight="600" fontSize="14px">
          Enable Autocomplete
        </Field.Label>
        <HStack justify="space-between" mt={1}>
          <Text color={tokens.colors.text.secondary} fontSize="sm">
            Show inline AI code suggestions while typing
          </Text>
          <Switch.Root checked={autocompleteEnabled} onCheckedChange={function (e) { setAutocompleteEnabled(e.checked) }} colorPalette="pink">
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </HStack>
      </Field.Root>

      <Box mb={6} h="1px" bg={tokens.colors.border.default} />

      <Text fontSize="sm" color={tokens.colors.text.primary} mb={3} fontWeight="600">
        Indentation
      </Text>

      <Field.Root mb={4}>
        <Field.Label color={tokens.colors.text.primary} fontWeight="600" fontSize="14px">
          Tab Size
        </Field.Label>
        <Box mt={1}>
          <NativeSelect.Root size="sm" width="200px">
            <NativeSelect.Field
              bg={tokens.colors.bg.overlay}
              borderColor={tokens.colors.border.default}
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
        </Box>
      </Field.Root>

      <Field.Root mb={4}>
        <Field.Label color={tokens.colors.text.primary} fontWeight="600" fontSize="14px">
          Insert Spaces
        </Field.Label>
        <HStack justify="space-between" mt={1}>
          <Text color={tokens.colors.text.secondary} fontSize="sm">
            Use spaces instead of tabs
          </Text>
          <Switch.Root checked={insertSpaces} onCheckedChange={function (e) { setInsertSpaces(e.checked) }} colorPalette="blue">
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </HStack>
      </Field.Root>

      <Field.Root mb={2}>
        <Field.Label color={tokens.colors.text.primary} fontWeight="600" fontSize="14px">
          Detect Indentation
        </Field.Label>
        <HStack justify="space-between" mt={1}>
          <Text color={tokens.colors.text.secondary} fontSize="sm">
            Infer indentation from file content
          </Text>
          <Switch.Root checked={detectIndentation} onCheckedChange={function (e) { setDetectIndentation(e.checked) }} colorPalette="blue">
            <Switch.HiddenInput />
            <Switch.Control />
          </Switch.Root>
        </HStack>
      </Field.Root>
    </>
  )
}

// === Experimental Tab ===

/**
 * Format a counter with abbreviated units for compact display.
 * Examples:
 *   42         → "42"
 *   1234       → "1.2K"
 *   12345      → "12.3K"
 *   1234567    → "1.2M"
 * Caps display at "9.9M+" so a runaway counter doesn't blow up the UI.
 */
// O separador Experimental foi removido (auditoria 2026-07-28): existia só
// para o "Safe Tool Pool", que nunca correu em produção — descrevia ao
// utilizador um mecanismo inexistente. O paralelismo real vive no loop
// (query.ts) e não precisa de UI.

// === Skills Tab ===

function SkillsTab(): React.ReactElement {
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
    } catch {
      // Error handled by store
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteSkill(skill: { id: string; name: string; path: string; scope: string }) {
    if (skill.scope === 'bundled') return
    try {
      const skillService = SkillService.getInstance()
      await skillService.deleteSkill(skill as Parameters<typeof skillService.deleteSkill>[0])
      await loadSkills()
    } catch {
      // Error silenced
    }
  }

  const bundledSkills = skills.filter(function (s) { return s.scope === 'bundled' })
  const globalSkills = skills.filter(function (s) { return s.scope === 'global' })
  const projectSkills = skills.filter(function (s) { return s.scope === 'project' })

  return (
    <VStack align="stretch" gap={4}>
      {/* Bundled */}
      <Box>
        <Flex justify="space-between" align="center" mb={2}>
          <Text fontSize="sm" fontWeight="600" color={tokens.colors.text.primary}>
            Bundled (auto-detected)
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled}>read-only</Text>
        </Flex>
        {isLoading ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>Loading skills...</Text>
        ) : bundledSkills.length === 0 ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t("misc.noBundledSkills")}</Text>
        ) : (
          <VStack align="stretch" gap={1}>
            {bundledSkills.map(function (skill) {
              return (
                <SkillRow key={skill.id} name={skill.name} scope="bundled" />
              )
            })}
          </VStack>
        )}
      </Box>

      {/* Global */}
      <Box>
        <Text fontSize="sm" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
          Global (~/.tmcode/skills/)
        </Text>
        {globalSkills.length === 0 ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t("misc.noGlobalSkills")}</Text>
        ) : (
          <VStack align="stretch" gap={1}>
            {globalSkills.map(function (skill) {
              return (
                <SkillRow
                  key={skill.id}
                  name={skill.name}
                  scope="global"
                  onDelete={function () { handleDeleteSkill(skill) }}
                />
              )
            })}
          </VStack>
        )}
      </Box>

      {/* Project */}
      <Box>
        <Text fontSize="sm" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
          Project (.tmcode/skills/)
        </Text>
        {projectSkills.length === 0 ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>{t("misc.noProjectSkills")}</Text>
        ) : (
          <VStack align="stretch" gap={1}>
            {projectSkills.map(function (skill) {
              return (
                <SkillRow
                  key={skill.id}
                  name={skill.name}
                  scope="project"
                  onDelete={function () { handleDeleteSkill(skill) }}
                />
              )
            })}
          </VStack>
        )}
      </Box>

      {/* New Skill */}
      {showNewSkill ? (
        <Box
          p={3}
          borderRadius={tokens.radius.lg}
          border="1px solid"
          borderColor={tokens.colors.border.default}
          bg={tokens.colors.bg.overlay}
        >
          <VStack align="stretch" gap={3}>
            <HStack gap={3}>
              <Box flex={1}>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Name</Text>
                <Input
                  size="sm"
                  value={newSkillName}
                  onChange={function (e) { setNewSkillName(e.target.value) }}
                  placeholder="my-conventions"
                  bg={tokens.colors.bg.input}
                  borderColor={tokens.colors.border.default}
                  color={tokens.colors.text.primary}
                  _placeholder={{ color: tokens.colors.text.placeholder }}
                />
              </Box>
              <Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>{t("misc.scope")}</Text>
                <NativeSelect.Root size="sm" width="120px">
                  <NativeSelect.Field
                    bg={tokens.colors.bg.overlay}
                    borderColor={tokens.colors.border.default}
                    color={tokens.colors.text.primary}
                    value={newSkillScope}
                    onChange={function (e) { setNewSkillScope(e.target.value as 'project' | 'global') }}
                  >
                    <option value="project">{t("settings.project")}</option>
                    <option value="global">{t("settings.global")}</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Box>
            </HStack>
            <Box>
              <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Content (Markdown)</Text>
              <Textarea
                size="sm"
                value={newSkillContent}
                onChange={function (e) { setNewSkillContent(e.target.value) }}
                placeholder="# My Conventions&#10;&#10;Write your coding conventions here..."
                bg={tokens.colors.bg.input}
                borderColor={tokens.colors.border.default}
                color={tokens.colors.text.primary}
                _placeholder={{ color: tokens.colors.text.placeholder }}
                rows={8}
                fontFamily={tokens.fontFamily.mono}
                fontSize="12px"
              />
            </Box>
            <HStack justify="flex-end" gap={2}>
              <Button
                size="sm"
                variant="outline"
                onClick={function () { setShowNewSkill(false) }}
                color={tokens.colors.text.secondary}
                borderColor={tokens.colors.border.default}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCreateSkill}
                disabled={!newSkillName.trim() || !newSkillContent.trim() || isSaving}
                bg={tokens.colors.accent.primary}
                color="white"
                _hover={{ bg: tokens.colors.accent.primaryDark }}
                _disabled={{ opacity: 0.5 }}
              >
                {isSaving ? 'Saving...' : 'Create'}
              </Button>
            </HStack>
          </VStack>
        </Box>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={function () { setShowNewSkill(true) }}
          color={tokens.colors.text.secondary}
          borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }}
        >
          <FiPlus style={{ marginRight: 6 }} />
          New Skill
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled} mt={1}>
        Skills are injected into the agent's context. Project skills override global and bundled.
      </Text>
    </VStack>
  )
}

function SkillRow(props: {
  name: string
  scope: string
  onDelete?: () => void
}): React.ReactElement {
  return (
    <Flex
      align="center"
      justify="space-between"
      px={3}
      py="8px"
      borderRadius={tokens.radius.md}
      bg={tokens.colors.bg.card}
      border="1px solid"
      borderColor={tokens.colors.bg.cardBorder}
      transition={tokens.transition.fast}
      _hover={{ borderColor: tokens.colors.border.default }}
    >
      <HStack gap={2}>
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={
            props.scope === 'bundled'
              ? tokens.colors.accent.purple
              : props.scope === 'global'
                ? tokens.colors.accent.blue
                : tokens.colors.accent.green
          }
        />
        <Text fontSize="13px" color={tokens.colors.text.primary}>
          {props.name}
        </Text>
      </HStack>
      {props.onDelete && (
        <Box
          as="button"
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="24px"
          h="24px"
          borderRadius={tokens.radius.md}
          bg="transparent"
          color={tokens.colors.text.disabled}
          cursor="pointer"
          transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.accent.red, bg: tokens.colors.accent.redSubtle }}
          onClick={props.onDelete}
        >
          <FiTrash2 size={13} />
        </Box>
      )}
    </Flex>
  )
}

// === MCP Servers Tab ===

function McpTab(): React.ReactElement {
  const servers = useMcpStore(function (s) { return s.servers })
  const isLoading = useMcpStore(function (s) { return s.isInitializing })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })

  async function handleStopServer(name: string) {
    try {
      await MCPService.getInstance().stopServer(name)
    } catch {
      // Error handled
    }
  }

  async function handleRestartServer(_name: string) {
    // Re-initialize will restart servers
    if (projectPath) {
      await MCPService.getInstance().initialize(projectPath)
    }
  }

  const statusColors: Record<string, string> = {
    running: tokens.colors.accent.green,
    starting: tokens.colors.accent.orange,
    error: tokens.colors.accent.red,
    stopped: tokens.colors.text.disabled,
  }

  return (
    <VStack align="stretch" gap={4}>
      {isLoading ? (
        <Text fontSize="12px" color={tokens.colors.text.muted}>Initializing MCP servers...</Text>
      ) : servers.length === 0 ? (
        <Box
          p={6}
          textAlign="center"
          borderRadius={tokens.radius.lg}
          border="1px dashed"
          borderColor={tokens.colors.border.default}
        >
          <Text fontSize="13px" color={tokens.colors.text.muted} mb={2}>
            No MCP servers configured
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled}>
            Add servers in <code>.tms/mcp.json</code> (project) or <code>~/.tmcode/mcp.json</code> (global)
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={2}>
          {servers.map(function (server) {
            return (
              <McpServerRow
                key={server.name}
                server={server}
                statusColor={statusColors[server.status] || tokens.colors.text.disabled}
                onStop={function () { handleStopServer(server.name) }}
                onRestart={function () { handleRestartServer(server.name) }}
              />
            )
          })}
        </VStack>
      )}

      <Box
        p={3}
        borderRadius={tokens.radius.lg}
        border="1px solid"
        borderColor={tokens.colors.border.default}
        bg={tokens.colors.bg.overlay}
      >
        <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
          Configuration Format
        </Text>
        <Box
          p={2}
          borderRadius={tokens.radius.md}
          bg={tokens.colors.bg.codeBlock}
          fontFamily={tokens.fontFamily.mono}
          fontSize="11px"
          color={tokens.colors.text.code}
          whiteSpace="pre"
          overflowX="auto"
        >
{`{
  "mcpServers": {
    "server-name": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-name"],
      "env": { "API_KEY": "..." }
    }
  }
}`}
        </Box>
      </Box>

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        MCP tools are automatically registered with the agent and require permission approval.
      </Text>
    </VStack>
  )
}

function McpServerRow(props: {
  server: McpServerState
  statusColor: string
  onStop: () => void
  onRestart: () => void
}): React.ReactElement {
  const { server, statusColor } = props

  return (
    <Box
      p={3}
      borderRadius={tokens.radius.lg}
      border="1px solid"
      borderColor={tokens.colors.border.default}
      bg={tokens.colors.bg.card}
    >
      <Flex justify="space-between" align="center" mb={server.tools.length > 0 || server.error ? 2 : 0}>
        <HStack gap={2}>
          <Box
            w="8px"
            h="8px"
            borderRadius="full"
            bg={statusColor}
            flexShrink={0}
          />
          <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary}>
            {server.name}
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.disabled}>
            ({server.transport})
          </Text>
        </HStack>
        <HStack gap={1}>
          {server.status === 'running' ? (
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              px={2}
              py={1}
              borderRadius={tokens.radius.md}
              bg="transparent"
              color={tokens.colors.accent.red}
              cursor="pointer"
              fontSize="11px"
              fontWeight="500"
              transition={tokens.transition.fast}
              _hover={{ bg: tokens.colors.accent.redSubtle }}
              onClick={props.onStop}
            >
              <FiSquare size={11} style={{ marginRight: 4 }} />
              Stop
            </Box>
          ) : server.status === 'error' ? (
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              px={2}
              py={1}
              borderRadius={tokens.radius.md}
              bg="transparent"
              color={tokens.colors.accent.orange}
              cursor="pointer"
              fontSize="11px"
              fontWeight="500"
              transition={tokens.transition.fast}
              _hover={{ bg: 'rgba(247, 127, 0, 0.1)' }}
              onClick={props.onRestart}
            >
              <FiRefreshCw size={11} style={{ marginRight: 4 }} />
              Restart
            </Box>
          ) : null}
        </HStack>
      </Flex>

      {server.error && (
        <Text fontSize="11px" color={tokens.colors.accent.red} mb={1}>
          {server.error}
        </Text>
      )}

      {server.tools.length > 0 && (
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          Tools: {server.tools.map(function (t) { return t.name }).join(', ')}
        </Text>
      )}
    </Box>
  )
}
