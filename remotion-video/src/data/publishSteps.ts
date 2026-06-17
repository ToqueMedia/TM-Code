// Deploy steps + live URL shown in the publish modal (scene 7).

export const PUBLISH_STEPS = [
  'Building project',
  'Uploading bundle',
  'Creating deployment',
  'SSL ready',
  'Live',
] as const

export const DEPLOY_URL = 'https://saas-demo.toquemedia.net'

export const PUBLISH_COPY = {
  title: 'Publish project',
  subtitle: 'Make your project live with a one-click deploy.',
  live: 'Live!',
  liveMessage: 'A tua landing está agora pública.',
  copied: 'URL copiada',
} as const
