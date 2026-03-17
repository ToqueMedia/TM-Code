import { memo, useState, useCallback, useEffect } from 'react'
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  NativeSelect,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { FiArrowLeft, FiPlus, FiTrash2, FiSquare, FiRefreshCw, FiServer } from 'react-icons/fi'
import { useLayoutStore } from '../../stores/layoutStore'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore, McpServerState } from '../../stores/mcpStore'
import { useProjectStore } from '../../stores/projectStore'
import SkillService from '../../services/agent/skillService'
import MCPService from '../../services/mcp/mcpService'
import { invoke } from '@tauri-apps/api/core'
import { tokens } from '@/theme/tokens'

type SectionId = 'skills' | 'mcp'

const NAV_ITEMS: { id: SectionId; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
]

function SettingsView() {
  const [activeSection, setActiveSection] = useState<SectionId>('skills')

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
        <Flex
          align="center"
          gap={2}
          px={4}
          h="44px"
          cursor="pointer"
          color={tokens.colors.text.secondary}
          transition={tokens.transition.fast}
          _hover={{ color: tokens.colors.text.primary, bg: tokens.colors.bg.hoverSubtle }}
          onClick={function () { useLayoutStore.getState().goBack() }}
          flexShrink={0}
        >
          <FiArrowLeft size={14} />
          <Text fontSize="13px" fontWeight="500">Agent Settings</Text>
        </Flex>

        <Box h="1px" bg={tokens.colors.border.sidebarPanel} />

        <VStack align="stretch" gap={0} pt={2} px={2}>
          {NAV_ITEMS.map(function (item) {
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
                {item.label}
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
            {NAV_ITEMS.find(function (n) { return n.id === activeSection })?.label}
          </Text>
        </Flex>

        <Box flex="1" overflowY="auto" px={8} py={6}>
          <Box maxW="640px">
            {activeSection === 'skills' && <SkillsSection />}
            {activeSection === 'mcp' && <McpSection />}
          </Box>
        </Box>
      </Flex>
    </Flex>
  )
}

// ━━━ Skills Section ━━━

function SkillsSection() {
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
      <SettingsGroup title="Bundled" badge="auto-detected">
        {isLoading ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>Loading skills...</Text>
        ) : bundledSkills.length === 0 ? (
          <EmptyState text="No bundled skills active for this project type" />
        ) : (
          <VStack align="stretch" gap={1}>
            {bundledSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="bundled" />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title="Global" badge="~/.toquemedia-studio/skills/">
        {globalSkills.length === 0 ? (
          <EmptyState text="No global skills" />
        ) : (
          <VStack align="stretch" gap={1}>
            {globalSkills.map(function (skill) {
              return <SkillRow key={skill.id} name={skill.name} scope="global" onDelete={function () { handleDeleteSkill(skill) }} />
            })}
          </VStack>
        )}
      </SettingsGroup>

      <SettingsGroup title="Project" badge=".tms/skills/">
        {projectSkills.length === 0 ? (
          <EmptyState text="No project skills" />
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
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Name</Text>
                <Input size="sm" value={newSkillName} onChange={function (e) { setNewSkillName(e.target.value) }}
                  placeholder="my-conventions" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                  color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }} />
              </Box>
              <Box>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Scope</Text>
                <NativeSelect.Root size="sm" width="120px">
                  <NativeSelect.Field bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                    color={tokens.colors.text.primary} value={newSkillScope}
                    onChange={function (e) { setNewSkillScope(e.target.value as 'project' | 'global') }}>
                    <option value="project">Project</option>
                    <option value="global">Global</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Box>
            </HStack>
            <Box>
              <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Content</Text>
              <Textarea size="sm" value={newSkillContent} onChange={function (e) { setNewSkillContent(e.target.value) }}
                placeholder={"# My Conventions\n\nWrite your coding conventions here..."}
                bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
                color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
                rows={10} fontFamily={tokens.fontFamily.mono} fontSize="12px" />
            </Box>
            <HStack justify="flex-end" gap={2}>
              <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(false) }}
                color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
                _hover={{ bg: tokens.colors.bg.hoverSubtle }}>Cancel</Button>
              <Button size="sm" onClick={handleCreateSkill}
                disabled={!newSkillName.trim() || !newSkillContent.trim() || isSaving}
                bg={tokens.colors.accent.primary} color="white"
                _hover={{ bg: tokens.colors.accent.primaryDark }} _disabled={{ opacity: 0.5 }}>
                {isSaving ? 'Saving...' : 'Create Skill'}</Button>
            </HStack>
          </VStack>
        </Box>
      ) : (
        <Button size="sm" variant="outline" onClick={function () { setShowNewSkill(true) }}
          color={tokens.colors.text.secondary} borderColor={tokens.colors.border.default}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }} w="fit-content">
          <FiPlus style={{ marginRight: 6 }} />New Skill
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        Skills are injected into the agent's context on every prompt. Project skills override global and bundled.
      </Text>
    </VStack>
  )
}

// ━━━ MCP Section ━━━

function McpSection() {
  const servers = useMcpStore(function (s) { return s.servers })
  const isInitializing = useMcpStore(function (s) { return s.isInitializing })
  const projectPath = useProjectStore(function (s) { return s.currentProject?.path })
  const [showAddServer, setShowAddServer] = useState(false)

  async function handleStop(name: string) {
    try { await MCPService.getInstance().stopServer(name) } catch { /* */ }
  }

  async function handleRemove(name: string) {
    if (!projectPath) return
    try { await MCPService.getInstance().removeServer(projectPath, name) } catch { /* */ }
  }

  async function handleRestart() {
    if (projectPath) await MCPService.getInstance().initialize(projectPath)
  }

  return (
    <VStack align="stretch" gap={6}>
      <SettingsGroup title="Active Servers">
        {isInitializing ? (
          <Text fontSize="12px" color={tokens.colors.text.muted}>Initializing MCP servers...</Text>
        ) : servers.length === 0 ? (
          <Box py={6} textAlign="center">
            <Box mb={3} color={tokens.colors.text.disabled}><FiServer size={28} style={{ margin: '0 auto' }} /></Box>
            <Text fontSize="13px" color={tokens.colors.text.muted} mb={1}>No MCP servers configured</Text>
            <Text fontSize="11px" color={tokens.colors.text.disabled}>
              Add a server below or edit .tms/mcp.json
            </Text>
          </Box>
        ) : (
          <VStack align="stretch" gap={2}>
            {servers.map(function (server) {
              return (
                <McpServerCard key={server.name} server={server}
                  onStop={function () { handleStop(server.name) }}
                  onRemove={function () { handleRemove(server.name) }}
                  onRestart={handleRestart} />
              )
            })}
          </VStack>
        )}
      </SettingsGroup>

      {/* Add Server Form */}
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
          <FiPlus style={{ marginRight: 6 }} />Add Server
        </Button>
      )}

      <Text fontSize="11px" color={tokens.colors.text.disabled}>
        MCP tools are registered with the agent and require permission approval before execution.
      </Text>
    </VStack>
  )
}

// ━━━ Add Server Form ━━━

function AddServerForm(props: { projectPath: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envPairs, setEnvPairs] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!name.trim()) { setError('Server name is required'); return }
    if (!command.trim()) { setError('Command is required'); return }

    setIsSaving(true)
    setError('')

    try {
      const configPath = `${props.projectPath}/.tms/mcp.json`
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
      await invoke('create_directories_all', { path: `${props.projectPath}/.tms` })
      await invoke('write_file', { path: configPath, content: JSON.stringify(config, null, 2) })

      await MCPService.getInstance().addSingleServer(props.projectPath, name.trim())
      props.onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Box p={4} borderRadius={tokens.radius.xl} border="1px solid" borderColor={tokens.colors.accent.primaryBorder} bg={tokens.colors.bg.overlay}>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb={3}>Add MCP Server</Text>
      <VStack align="stretch" gap={3}>
        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Name</Text>
          <Input size="sm" value={name} onChange={function (e) { setName(e.target.value) }}
            placeholder="chakra-ui" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }} />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Command</Text>
          <Input size="sm" value={command} onChange={function (e) { setCommand(e.target.value) }}
            placeholder="npx" bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
            fontFamily={tokens.fontFamily.mono} fontSize="12px" />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>Arguments</Text>
          <Input size="sm" value={args} onChange={function (e) { setArgs(e.target.value) }}
            placeholder="-y @chakra-ui/react-mcp"
            bg={tokens.colors.bg.input} borderColor={tokens.colors.border.input}
            color={tokens.colors.text.primary} _placeholder={{ color: tokens.colors.text.placeholder }}
            fontFamily={tokens.fontFamily.mono} fontSize="12px" />
        </Box>

        <Box>
          <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1}>
            Environment variables
            <Text as="span" color={tokens.colors.text.disabled}> (optional, KEY=VALUE per line)</Text>
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
            _hover={{ bg: tokens.colors.bg.hoverSubtle }}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}
            bg={tokens.colors.accent.primary} color="white"
            _hover={{ bg: tokens.colors.accent.primaryDark }} _disabled={{ opacity: 0.5 }}>
            {isSaving ? 'Adding...' : 'Add Server'}</Button>
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
            <ActionButton icon={<FiSquare size={11} />} label="Stop" color={tokens.colors.accent.red}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onStop} />
          )}
          {server.status === 'error' && (
            <ActionButton icon={<FiRefreshCw size={11} />} label="Restart" color={tokens.colors.accent.orange}
              hoverBg="rgba(247, 127, 0, 0.1)" onClick={props.onRestart} />
          )}
          {(server.status === 'stopped' || server.status === 'error') && (
            <ActionButton icon={<FiTrash2 size={11} />} label="Remove" color={tokens.colors.text.disabled}
              hoverBg={tokens.colors.accent.redSubtle} onClick={props.onRemove} />
          )}
        </HStack>
      </Flex>
      {server.error && <Text fontSize="11px" color={tokens.colors.accent.red} mb={1}>{server.error}</Text>}
      {server.tools.length > 0 && (
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          Tools: {server.tools.map(function (t) { return t.name }).join(', ')}
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
