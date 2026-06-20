// Deploy steps + live URL for the publish modal (Portuguese), reused as the
// address opened in the browser and the final CTA proof.

export const PUBLISH_STEPS = [
  'Build completo',
  'Bundle enviado',
  'Deploy criado',
  'SSL pronto',
  'Online',
] as const

export const DEPLOY_URL = 'https://startup-demo.toquemedia.net'

export const PUBLISH_COPY = {
  title: 'Publicar projecto',
  subtitle: 'Coloca o teu projecto online com um clique.',
  live: 'Online!',
  liveMessage: 'A tua landing está agora pública.',
  copied: 'URL copiada',
} as const
