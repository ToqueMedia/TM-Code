import { useState, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n/useTranslation'
import FirebaseAuthService from '../../services/auth/firebaseAuth'
import { useAuthStore } from '../../stores/authStore'
import WindowControls from '../ui/WindowControls'
import { IS_MAC } from '@/utils/platform'

const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'Email inválido.',
  'auth/user-disabled': 'Conta desactivada.',
  'auth/user-not-found': 'Email ou password incorrectos.',
  'auth/wrong-password': 'Email ou password incorrectos.',
  'auth/invalid-credential': 'Email ou password incorrectos.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
  'auth/network-request-failed': 'Erro de conexão. Verifique a internet.',
}

function getErrorMessage(err: unknown): string {
  const code = (err instanceof Error && 'code' in err ? (err as { code: string }).code : '') || ''
  return ERROR_MESSAGES[code] || (err instanceof Error ? err.message : '') || 'Erro de autenticação.'
}

function LoginScreen() {
  const t = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const error = useAuthStore(s => s.error)
  const setError = useAuthStore(s => s.setError)

  const isFormValid = email.trim() && password.trim()
  const anyLoading = loading

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isFormValid || anyLoading) return

    setLoading(true)
    setError(null)

    try {
      await FirebaseAuthService.getInstance().signIn(email, password)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    const tag = el.tagName?.toLowerCase() || ''
    if (['button', 'input', 'label', 'svg', 'path', 'a'].includes(tag)) return
    if (el.getAttribute?.('role') === 'button') return
    // Don't drag when interacting with the form card
    if (el.closest?.('[data-login-card]')) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  async function handleClose() {
    try { await getCurrentWindow().close() } catch { /* noop */ }
  }

  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch { /* noop */ }
  }

  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      if (/Mac/.test(navigator.platform || '')) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch { /* noop */ }
  }

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100vh"
      bg={tokens.colors.bg.welcome}
      color={tokens.colors.text.primary}
      fontFamily={tokens.fontFamily.ui}
      position="relative"
      overflow="hidden"
      onMouseDown={handleDrag}
    >
      {/* Window controls — macOS: top-left, Windows/Linux: top-right */}
      {IS_MAC ? (
        <Box position="absolute" top={3} left={4} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      ) : (
        <Box position="absolute" top={0} right={0} zIndex={10}>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </Box>
      )}

      {/* Background gradient */}
      <Box
        position="fixed"
        top="0"
        left="0"
        width="100%"
        height="100%"
        zIndex="0"
        background={tokens.gradient.welcomeBg}
        pointerEvents="none"
      />

      {/* Global focus + animation styles */}
      <style>{`
        .auth-input:focus {
          border-color: ${tokens.colors.accent.primary} !important;
        }
        .auth-btn-submit:hover:not(:disabled) {
          filter: brightness(1.1);
        }
        @keyframes authPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>

      {/* Content */}
      <Flex
        direction="column"
        align="center"
        zIndex="1"
        width="100%"
        maxWidth="380px"
        px={4}
      >
        {/* Brand */}
        <Box mb={8} textAlign="center">
          <img
            src="/isologo.svg"
            alt="TM Code"
            width={44}
            height={44}
            style={{ margin: '0 auto 14px', display: 'block' }}
          />
          <Text
            fontSize="13px"
            fontWeight="600"
            letterSpacing="2px"
            textTransform="uppercase"
            mb={3}
            style={{
              background: tokens.gradient.logoTitle,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            TM Code
          </Text>
          <Text
            fontSize="24px"
            fontWeight="700"
            letterSpacing="-0.5px"
            lineHeight="1.2"
          >
            {t('login.welcomeBack')}
          </Text>
          <Text
            fontSize="13px"
            color={tokens.colors.text.secondary}
            mt={2}
          >
            {t('login.signInContinue')}
          </Text>
        </Box>

        {/* Card */}
        <Box
          width="100%"
          bg={tokens.colors.bg.panel}
          borderRadius="16px"
          border={`1px solid ${tokens.colors.border.panel}`}
          p={6}
          boxShadow="0 8px 32px rgba(0, 0, 0, 0.3)"
          data-login-card
        >
          {/* Form */}
          <form onSubmit={handleSubmit}>
            {/* Email */}
            <Box mb={3}>
              <label>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                  {t('login.email')}
                </Text>
                <input
                  type="email"
                  className="auth-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('login.emailPlaceholder')}
                  autoComplete="email"
                  autoFocus
                  disabled={anyLoading}
                  style={inputStyle}
                />
              </label>
            </Box>

            {/* Password */}
            <Box mb={4}>
              <label>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                  {t('login.password')}
                </Text>
                <input
                  type="password"
                  className="auth-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('login.passwordPlaceholder')}
                  autoComplete="current-password"
                  disabled={anyLoading}
                  style={inputStyle}
                />
              </label>
            </Box>

            {/* Error */}
            {error && (
              <Box
                mb={4}
                p={3}
                bg={tokens.colors.accent.redSubtle}
                borderRadius="10px"
                border={`1px solid ${tokens.colors.accent.redMuted}`}
              >
                <Text fontSize="12px" color={tokens.colors.accent.red} lineHeight="1.5">
                  {error}
                </Text>
              </Box>
            )}

            {/* Submit */}
            <button
              type="submit"
              className="auth-btn-submit"
              disabled={!isFormValid || anyLoading}
              style={{
                width: '100%',
                padding: '11px 0',
                background: (!isFormValid || anyLoading) ? tokens.colors.border.panel : tokens.colors.accent.primary,
                border: 'none',
                borderRadius: '10px',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '600',
                cursor: (!isFormValid || anyLoading) ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                opacity: !isFormValid ? 0.5 : 1,
                transition: `all ${tokens.transition.normal}`,
                boxShadow: (isFormValid && !anyLoading) ? tokens.shadow.dialogButton : 'none',
              }}
            >
              {loading ? <LoadingDots /> : 'Entrar'}
            </button>
          </form>
        </Box>

        {/* Signup link */}
        <Flex justify="center" mt={5} gap={1} data-login-card>
          <Text fontSize="12px" color={tokens.colors.text.secondary}>
            Não tem conta?
          </Text>
          <a
            href="https://toquemedia.net"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '12px',
              color: tokens.colors.accent.primary,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Criar conta no site
          </a>
        </Flex>
      </Flex>
    </Flex>
  )
}

function LoadingDots() {
  return (
    <Flex gap="4px" align="center" justify="center" height="18px">
      {[0, 1, 2].map(i => (
        <Box
          key={i}
          width="5px"
          height="5px"
          borderRadius="50%"
          bg="currentColor"
          opacity={0.7}
          style={{
            animation: `authPulse 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </Flex>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: tokens.colors.bg.mainLayout,
  border: `1px solid ${tokens.colors.border.panel}`,
  borderRadius: '10px',
  color: tokens.colors.text.primary,
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: `border-color ${tokens.transition.normal}`,
}

export default LoginScreen
