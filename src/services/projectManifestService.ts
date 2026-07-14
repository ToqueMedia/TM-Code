import { invoke } from '@/utils/invokeMetrics'
import type { Template } from './templateService'

export type ProjectManifestRuntime = 'web' | 'api' | 'fullstack' | 'native' | 'unknown'
export type ProjectManifestSource = 'template' | 'import' | 'manual'
export type ProjectManifestTarget =
  | 'tm-code-static'
  | 'tm-code-fullstack'
  | 'external'
  | 'unsupported'

export interface ProjectCapability {
  supported: boolean
  command?: string
  target?: ProjectManifestTarget
  frontendPort?: number
  outputDir?: string
  warnings?: string[]
  blockers?: string[]
}

export interface ProjectManifest {
  schemaVersion: 1
  projectKind: 'tm-code-project'
  source: ProjectManifestSource
  createdAt: string
  updatedAt: string
  stack: {
    id?: string
    name: string
    framework: string
    runtime: ProjectManifestRuntime
    category: Template['category'] | 'unknown'
    managedDefaults: boolean
  }
  commands: {
    install?: string
    dev?: string
    build?: string
    preview?: string
    test?: string
  }
  capabilities: {
    edit: ProjectCapability
    preview: ProjectCapability
    check: ProjectCapability
    deploy: ProjectCapability
  }
  compatibility: {
    warnings: string[]
    blockers: string[]
  }
}

export const PROJECT_MANIFEST_RELATIVE_PATH = '.toquemedia/project.json'

function runtimeForTemplate(template: Template): ProjectManifestRuntime {
  if (template.category === 'fullstack') return 'fullstack'
  if (template.category === 'backend') return 'api'
  return 'web'
}

function deployCapabilityForTemplate(template: Template, buildCommand?: string): ProjectCapability {
  if (template.category === 'fullstack') {
    return {
      supported: true,
      command: buildCommand,
      target: 'tm-code-fullstack',
      frontendPort: template.frontendPort,
    }
  }

  if (template.category === 'backend') {
    return {
      supported: false,
      target: 'unsupported',
      blockers: [
        'Backend-only Node.js projects are editable and testable in Chat, but TM Code deploy expects a web/fullstack project manifest.',
      ],
    }
  }

  if (template.framework === 'nextjs' || template.framework === 'nuxt') {
    return {
      supported: false,
      command: buildCommand,
      target: 'unsupported',
      blockers: [
        `${template.name} needs a runtime-specific deploy adapter before TM Code can publish it safely.`,
      ],
    }
  }

  return {
    supported: true,
    command: buildCommand,
    target: 'tm-code-static',
    outputDir: 'dist',
  }
}

export function buildTemplateProjectManifest(template: Template, commands: {
  installCommand: string
  devCommand: string
  buildCommand?: string
  scaffoldedAt: string
}): ProjectManifest {
  const deploy = deployCapabilityForTemplate(template, commands.buildCommand)
  const warnings = [
    ...(deploy.warnings ?? []),
  ]
  const blockers = [
    ...(deploy.blockers ?? []),
  ]

  return {
    schemaVersion: 1,
    projectKind: 'tm-code-project',
    source: 'template',
    createdAt: commands.scaffoldedAt,
    updatedAt: commands.scaffoldedAt,
    stack: {
      id: template.id,
      name: template.name,
      framework: template.framework,
      runtime: runtimeForTemplate(template),
      category: template.category,
      managedDefaults: true,
    },
    commands: {
      install: commands.installCommand,
      dev: commands.devCommand,
      build: commands.buildCommand,
    },
    capabilities: {
      edit: { supported: true },
      preview: {
        supported: true,
        command: commands.devCommand,
        frontendPort: template.frontendPort,
        ...(template.category === 'backend'
          ? { warnings: ['API-only projects use the HTTP Client instead of a browser preview.'] }
          : {}),
      },
      check: {
        supported: Boolean(commands.buildCommand),
        command: commands.buildCommand,
      },
      deploy,
    },
    compatibility: {
      warnings,
      blockers,
    },
  }
}

export async function readProjectManifest(projectPath: string): Promise<ProjectManifest | null> {
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/${PROJECT_MANIFEST_RELATIVE_PATH}` })
    const parsed = JSON.parse(raw) as ProjectManifest
    return parsed?.schemaVersion === 1 && parsed.projectKind === 'tm-code-project'
      ? parsed
      : null
  } catch {
    return null
  }
}
