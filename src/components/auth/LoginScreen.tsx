import { useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import FirebaseAuthService from '../../services/auth/firebaseAuth'
import { useAuthStore } from '../../stores/authStore'

type AuthMode = 'signin' | 'signup'

const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'Email inválido.',
  'auth/user-disabled': 'Conta desactivada.',
  'auth/user-not-found': 'Conta não encontrada.',
  'auth/wrong-password': 'Password incorrecta.',
  'auth/invalid-credential': 'Credenciais inválidas.',
  'auth/email-already-in-use': 'Este email já está registado.',
  'auth/weak-password': 'Password demasiado fraca (mín. 6 caracteres).',
  'auth/popup-closed-by-user': 'Login cancelado.',
  'auth/popup-blocked': 'Pop-up bloqueado. Permita pop-ups e tente novamente.',
  'auth/account-exists-with-different-credential': 'Já existe uma conta com este email usando outro método.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
  'auth/network-request-failed': 'Erro de conexão. Verifique a internet.',
}

function getErrorMessage(err: unknown): string {
  const code = (err instanceof Error && 'code' in err ? (err as { code: string }).code : '') || ''
  return ERROR_MESSAGES[code] || (err instanceof Error ? err.message : '') || 'Erro de autenticação.'
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  )
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [mode, setMode] = useState<AuthMode>('signin')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const error = useAuthStore(s => s.error)
  const setError = useAuthStore(s => s.setError)

  const isFormValid = mode === 'signup'
    ? email.trim() && password.trim() && displayName.trim()
    : email.trim() && password.trim()

  const anyLoading = loading || googleLoading

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isFormValid || anyLoading) return

    setLoading(true)
    setError(null)

    try {
      const authService = FirebaseAuthService.getInstance()
      if (mode === 'signin') {
        await authService.signIn(email, password)
      } else {
        await authService.signUp(email, password, displayName.trim())
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    if (anyLoading) return

    setGoogleLoading(true)
    setError(null)

    try {
      const authService = FirebaseAuthService.getInstance()
      await authService.signInWithGoogle()
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setGoogleLoading(false)
    }
  }

  const toggleMode = () => {
    setMode(m => m === 'signin' ? 'signup' : 'signin')
    setError(null)
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
    >
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
        .auth-btn-google:hover:not(:disabled) {
          background: ${tokens.colors.bg.hoverSubtle} !important;
          border-color: ${tokens.colors.text.muted} !important;
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
            alt="ToqueMedia Studio"
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
            ToqueMedia Studio
          </Text>
          <Text
            fontSize="24px"
            fontWeight="700"
            letterSpacing="-0.5px"
            lineHeight="1.2"
          >
            {mode === 'signin' ? 'Bem-vindo de volta' : 'Crie a sua conta'}
          </Text>
          <Text
            fontSize="13px"
            color={tokens.colors.text.secondary}
            mt={2}
          >
            {mode === 'signin'
              ? 'Entre para continuar a desenvolver'
              : 'Comece a criar os seus projectos'
            }
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
        >
          {/* Google button */}
          <button
            type="button"
            className="auth-btn-google"
            onClick={handleGoogleSignIn}
            disabled={anyLoading}
            style={{
              width: '100%',
              padding: '11px 0',
              background: 'transparent',
              border: `1px solid ${tokens.colors.border.panel}`,
              borderRadius: '10px',
              color: tokens.colors.text.primary,
              fontSize: '13px',
              fontWeight: '500',
              cursor: anyLoading ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              opacity: anyLoading ? 0.5 : 1,
              transition: `all ${tokens.transition.normal}`,
            }}
          >
            {googleLoading ? (
              <LoadingDots />
            ) : (
              <>
                <GoogleIcon />
                Continuar com Google
              </>
            )}
          </button>

          {/* Divider */}
          <Flex align="center" my={5} gap={3}>
            <Box flex="1" height="1px" bg={tokens.colors.border.panel} />
            <Text fontSize="11px" color={tokens.colors.text.muted} textTransform="uppercase" letterSpacing="0.5px">
              ou
            </Text>
            <Box flex="1" height="1px" bg={tokens.colors.border.panel} />
          </Flex>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            {/* Display Name (signup only) */}
            {mode === 'signup' && (
              <Box mb={3}>
                <label>
                  <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                    Nome
                  </Text>
                  <input
                    type="text"
                    className="auth-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="O seu nome"
                    autoComplete="name"
                    disabled={anyLoading}
                    style={inputStyle}
                  />
                </label>
              </Box>
            )}

            {/* Email */}
            <Box mb={3}>
              <label>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                  Email
                </Text>
                <input
                  type="email"
                  className="auth-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nome@email.com"
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
                  Password
                </Text>
                <input
                  type="password"
                  className="auth-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'Mínimo 6 caracteres' : 'A sua password'}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
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
              {loading ? (
                <LoadingDots />
              ) : (
                mode === 'signin' ? 'Entrar' : 'Criar conta'
              )}
            </button>
          </form>
        </Box>

        {/* Toggle mode */}
        <Flex justify="center" mt={5} gap={1}>
          <Text fontSize="12px" color={tokens.colors.text.secondary}>
            {mode === 'signin' ? 'Não tem conta?' : 'Já tem conta?'}
          </Text>
          <Text
            fontSize="12px"
            color={tokens.colors.accent.primary}
            cursor="pointer"
            fontWeight="500"
            _hover={{ textDecoration: 'underline' }}
            onClick={toggleMode}
          >
            {mode === 'signin' ? 'Criar conta' : 'Entrar'}
          </Text>
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
