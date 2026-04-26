import { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ConfirmationResult } from 'firebase/auth'
import { tokens } from '@/theme/tokens'
import FirebaseAuthService from '../../services/auth/firebaseAuth'
import { useAuthStore } from '../../stores/authStore'
import { isDisposableEmail } from '../../services/auth/disposableEmails'
import { registerDevice } from '../../services/auth/deviceRegistration'
import WindowControls from '../ui/WindowControls'
import PhoneInput, { toE164 } from './PhoneInput'
import { DEFAULT_COUNTRY, type Country } from '../../services/auth/countries'
import { IS_MAC } from '@/utils/platform'

type AuthMode = 'signin' | 'signup'
type SignupStep = 'form' | 'sms'

const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'Email inválido.',
  'auth/user-disabled': 'Conta desactivada.',
  // Generic message for credential errors to prevent user enumeration
  'auth/user-not-found': 'Email ou password incorrectos.',
  'auth/wrong-password': 'Email ou password incorrectos.',
  'auth/invalid-credential': 'Email ou password incorrectos.',
  'auth/email-already-in-use': 'Este email já está registado.',
  'auth/weak-password': 'Password demasiado fraca (mín. 6 caracteres).',
  'auth/popup-closed-by-user': 'Login cancelado.',
  'auth/popup-blocked': 'Pop-up bloqueado. Permita pop-ups e tente novamente.',
  'auth/account-exists-with-different-credential': 'Já existe uma conta com este email usando outro método.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
  'auth/network-request-failed': 'Erro de conexão. Verifique a internet.',
  'auth/invalid-phone-number': 'Número de telefone inválido.',
  'auth/missing-phone-number': 'Introduza o número de telefone.',
  'auth/quota-exceeded': 'Limite de SMS atingido. Tente novamente mais tarde.',
  'auth/credential-already-in-use': 'Este número já está associado a outra conta.',
  'auth/invalid-verification-code': 'Código incorrecto. Verifique e tente novamente.',
  'auth/code-expired': 'Código expirado. Solicite um novo código.',
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

interface LoginScreenProps {
  initialMode?: AuthMode
}

function LoginScreen({ initialMode = 'signin' }: LoginScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [signupStep, setSignupStep] = useState<SignupStep>('form')
  const [smsCode, setSmsCode] = useState('')
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const confirmationRef = useRef<ConfirmationResult | null>(null)
  const recaptchaContainerRef = useRef<HTMLDivElement | null>(null)
  const verifierCleanupRef = useRef<(() => void) | null>(null)
  const error = useAuthStore(s => s.error)
  const setError = useAuthStore(s => s.setError)

  const phoneDigits = phoneNumber.replace(/\D+/g, '')
  // E.164 max = 15 digits including country code. We bound the national part
  // to [7, 14] which covers every country in our list with margin.
  const phoneValid = phoneDigits.length >= 7 && phoneDigits.length <= 14
  const isFormValid = mode === 'signup'
    ? email.trim() && password.trim() && displayName.trim() && phoneValid
    : email.trim() && password.trim()

  // Resend cooldown — Firebase rejects rapid repeats with `too-many-requests`.
  // 30s matches the typical SMS arrival window.
  const [resendCooldown, setResendCooldown] = useState(0)
  useEffect(() => {
    if (resendCooldown <= 0) return
    const id = setInterval(() => setResendCooldown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(id)
  }, [resendCooldown])

  // Clear the RecaptchaVerifier if the user navigates away mid-SMS step.
  // Firebase keeps internal references to the verifier element that prevent
  // GC otherwise, leaking the iframe across login attempts.
  useEffect(() => {
    return () => {
      try { verifierCleanupRef.current?.() } catch { /* noop */ }
      verifierCleanupRef.current = null
      confirmationRef.current = null
    }
  }, [])

  const anyLoading = loading || googleLoading

  /**
   * On phone-link rollback (limit exceeded, code timeout, etc.) we delete the
   * half-created Firebase user so the email can be re-used. Failures here are
   * logged — the orphaned account will still be blocked by /v1/me.
   */
  async function rollbackHalfCreatedAccount() {
    try {
      const u = FirebaseAuthService.getInstance().getCurrentUser()
      if (u) await u.delete()
    } catch (err) {
      console.warn('[auth] rollback (user.delete) failed:', err)
    }
    try { verifierCleanupRef.current?.() } catch { /* noop */ }
    verifierCleanupRef.current = null
    confirmationRef.current = null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isFormValid || anyLoading) return

    setLoading(true)
    setError(null)

    try {
      const authService = FirebaseAuthService.getInstance()

      if (mode === 'signin') {
        await authService.signIn(email, password)
        return
      }

      // Signup: validate disposable email before burning a Firebase create call
      if (isDisposableEmail(email.trim())) {
        setError('Emails temporários não são permitidos. Use um email pessoal ou de trabalho.')
        return
      }

      // 1) Create the Firebase Auth user (email/password).
      await authService.signUp(email.trim(), password, displayName.trim())

      // 2) Start phone-link flow — sends SMS, waits for the user to enter
      //    the code in the next step.
      const container = recaptchaContainerRef.current
      if (!container) throw new Error('reCAPTCHA container unavailable')
      const phoneE164 = toE164(country, phoneNumber)
      const { confirmation, cleanup } = await authService.startPhoneLink(phoneE164, container)
      confirmationRef.current = confirmation
      verifierCleanupRef.current = cleanup
      setResendCooldown(30)
      setSignupStep('sms')
    } catch (err: unknown) {
      // If we reach here mid-signup (account created but phone link failed),
      // roll back so the user can retry without "email-already-in-use".
      if (mode === 'signup' && FirebaseAuthService.getInstance().getCurrentUser()) {
        await rollbackHalfCreatedAccount()
      }
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (anyLoading) return
    const code = smsCode.trim()
    if (code.length < 6) {
      setError('Código deve ter 6 dígitos.')
      return
    }
    if (!confirmationRef.current) {
      setError('Sessão de verificação expirou. Reinicie a criação de conta.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const authService = FirebaseAuthService.getInstance()
      await authService.confirmPhoneCode(confirmationRef.current, code)

      // Phone linked — register the device fingerprint with the backend.
      // Fail-closed: any non-OK rolls the account back. We never want a
      // network glitch (or a tampered local proxy) to let a user past the
      // device cap.
      const reg = await registerDevice()
      if (!reg.ok) {
        await rollbackHalfCreatedAccount()
        setSignupStep('form')
        const messages: Record<typeof reg.reason, string> = {
          limit_exceeded: 'Este dispositivo já tem o número máximo de contas permitido.',
          disposable_email: 'Emails temporários não são permitidos. Use um email pessoal ou de trabalho.',
          rate_limited: 'Demasiadas tentativas de criação de conta. Aguarde uma hora.',
          appcheck_failed: 'Falha de validação de segurança. Reinicie a aplicação e tente novamente.',
          unauthorized: 'Sessão inválida. Tente novamente.',
          network: 'Falha de rede ao validar o dispositivo. Verifique a ligação e tente outra vez.',
        }
        setError(messages[reg.reason])
        return
      }

      // Cleanup verifier — onAuthStateChanged will swap to the app shell.
      try { verifierCleanupRef.current?.() } catch { /* noop */ }
      verifierCleanupRef.current = null
      confirmationRef.current = null
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleCancelSms = async () => {
    if (anyLoading) return
    await rollbackHalfCreatedAccount()
    setSignupStep('form')
    setSmsCode('')
    setError(null)
  }

  const handleResendSms = async () => {
    if (anyLoading || resendCooldown > 0) return
    const container = recaptchaContainerRef.current
    if (!container) return

    setLoading(true)
    setError(null)
    try {
      // Discard the previous verifier — RecaptchaVerifier instances are
      // single-use; reusing one yields `auth/argument-error`.
      try { verifierCleanupRef.current?.() } catch { /* noop */ }
      verifierCleanupRef.current = null

      const phoneE164 = toE164(country, phoneNumber)
      const { confirmation, cleanup } = await FirebaseAuthService.getInstance()
        .startPhoneLink(phoneE164, container)
      confirmationRef.current = confirmation
      verifierCleanupRef.current = cleanup
      setSmsCode('')
      setResendCooldown(30)
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

    // Watchdog: in Tauri's WebKit WebView, signInWithPopup can hang forever
    // when the user closes the Google popup — Firebase's popup.closed polling
    // doesn't always detect the close across window contexts, so the promise
    // never resolves/rejects and the `finally` block below never runs. That
    // leaves `googleLoading=true` and blocks the whole form.
    //
    // When the popup closes, focus returns to the main window. If Firebase
    // hasn't resolved ~1.5s after that focus event (well past any normal
    // postMessage round-trip), we treat the attempt as cancelled.
    let settled = false
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined
    const handleMainWindowFocus = () => {
      if (settled) return
      watchdogTimer = setTimeout(() => {
        if (settled) return
        settled = true
        setGoogleLoading(false)
        // Silent cancel — the user intentionally closed the popup.
      }, 1500)
    }
    window.addEventListener('focus', handleMainWindowFocus)

    try {
      const authService = FirebaseAuthService.getInstance()
      await authService.signInWithGoogle()
      settled = true
    } catch (err: unknown) {
      if (!settled) {
        settled = true
        setError(getErrorMessage(err))
      }
    } finally {
      window.removeEventListener('focus', handleMainWindowFocus)
      if (watchdogTimer) clearTimeout(watchdogTimer)
      setGoogleLoading(false)
    }
  }

  const toggleMode = () => {
    setMode(m => m === 'signin' ? 'signup' : 'signin')
    setSignupStep('form')
    setSmsCode('')
    setError(null)
  }

  const handleDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'label', 'svg', 'path', 'a'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    // Don't drag when interacting with the form card
    if (t.closest?.('[data-login-card]')) return
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
            {mode === 'signin'
              ? 'Bem-vindo de volta'
              : signupStep === 'sms' ? 'Verifique o telefone' : 'Crie a sua conta'}
          </Text>
          <Text
            fontSize="13px"
            color={tokens.colors.text.secondary}
            mt={2}
          >
            {mode === 'signin'
              ? 'Entre para continuar a desenvolver'
              : signupStep === 'sms'
                ? `Enviámos um código para +${country.dialCode} ${phoneNumber}`
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
          data-login-card
        >
          {/* SMS step — replaces the entire signup card body */}
          {mode === 'signup' && signupStep === 'sms' ? (
            <form onSubmit={handleConfirmCode}>
              <Box mb={4}>
                <label>
                  <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                    Código de verificação
                  </Text>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={6}
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                    placeholder="000000"
                    disabled={anyLoading}
                    style={{
                      ...inputStyle,
                      fontSize: '20px',
                      letterSpacing: '8px',
                      textAlign: 'center',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  />
                </label>
              </Box>

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

              <button
                type="submit"
                className="auth-btn-submit"
                disabled={smsCode.length < 6 || anyLoading}
                style={{
                  width: '100%',
                  padding: '11px 0',
                  background: (smsCode.length < 6 || anyLoading) ? tokens.colors.border.panel : tokens.colors.accent.primary,
                  border: 'none',
                  borderRadius: '10px',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: (smsCode.length < 6 || anyLoading) ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: smsCode.length < 6 ? 0.5 : 1,
                  transition: `all ${tokens.transition.normal}`,
                  boxShadow: (smsCode.length === 6 && !anyLoading) ? tokens.shadow.dialogButton : 'none',
                }}
              >
                {loading ? <LoadingDots /> : 'Confirmar'}
              </button>

              <Flex justify="space-between" align="center" mt={3} gap={2}>
                <button
                  type="button"
                  onClick={handleCancelSms}
                  disabled={anyLoading}
                  style={{
                    padding: '6px 0',
                    background: 'transparent',
                    border: 'none',
                    color: tokens.colors.text.secondary,
                    fontSize: '12px',
                    fontFamily: 'inherit',
                    cursor: anyLoading ? 'not-allowed' : 'pointer',
                    outline: 'none',
                  }}
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={handleResendSms}
                  disabled={anyLoading || resendCooldown > 0}
                  style={{
                    padding: '6px 0',
                    background: 'transparent',
                    border: 'none',
                    color: resendCooldown > 0 ? tokens.colors.text.muted : tokens.colors.accent.primary,
                    fontSize: '12px',
                    fontWeight: 500,
                    fontFamily: 'inherit',
                    cursor: (anyLoading || resendCooldown > 0) ? 'not-allowed' : 'pointer',
                    outline: 'none',
                  }}
                >
                  {resendCooldown > 0 ? `Reenviar em ${resendCooldown}s` : 'Reenviar código'}
                </button>
              </Flex>
            </form>
          ) : (
          <>
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
            <Box mb={mode === 'signup' ? 3 : 4}>
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

            {/* Phone (signup only) */}
            {mode === 'signup' && (
              <Box mb={4}>
                <Text fontSize="12px" color={tokens.colors.text.secondary} mb={1.5} fontWeight="500">
                  Telefone
                </Text>
                <PhoneInput
                  country={country}
                  onCountryChange={setCountry}
                  number={phoneNumber}
                  onNumberChange={setPhoneNumber}
                  disabled={anyLoading}
                />
                <Text fontSize="11px" color={tokens.colors.text.muted} mt={1.5} lineHeight="1.4">
                  Vamos enviar um código por SMS para confirmar.
                </Text>
              </Box>
            )}

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
          </>
          )}
        </Box>

        {/* Invisible reCAPTCHA container — required by Firebase phone auth.
            Stays empty until startPhoneLink renders the widget into it. */}
        <Box
          ref={recaptchaContainerRef}
          id="tmcode-recaptcha-container"
          position="absolute"
          width="0"
          height="0"
          overflow="hidden"
        />

        {/* Toggle mode — hidden during SMS verification to avoid losing
            the half-completed signup */}
        {!(mode === 'signup' && signupStep === 'sms') && (
          <Flex justify="center" mt={5} gap={1} data-login-card>
            <Text fontSize="12px" color={tokens.colors.text.secondary}>
              {mode === 'signin' ? 'Não tem conta?' : 'Já tem conta?'}
            </Text>
            <Text
              fontSize="12px"
              color={tokens.colors.accent.primary}
              cursor="pointer"
              fontWeight="500"
              role="button"
              _hover={{ textDecoration: 'underline' }}
              onClick={toggleMode}
            >
              {mode === 'signin' ? 'Criar conta' : 'Entrar'}
            </Text>
          </Flex>
        )}
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
