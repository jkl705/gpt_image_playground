import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { getRuntimeConfig, getSession, login } from '../lib/serverApi'

export default function LoginModal() {
  const authenticated = useStore((s) => s.authenticated)
  const setAuthenticated = useStore((s) => s.setAuthenticated)
  const setShowLoginModal = useStore((s) => s.setShowLoginModal)
  const setSettings = useStore((s) => s.setSettings)
  const showToast = useStore((s) => s.showToast)
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getSession()
      .then(async (session) => {
        if (cancelled) return
        setAuthenticated(session.authenticated)
        setShowLoginModal(!session.authenticated)
        if (session.authenticated) {
          const config = await getRuntimeConfig()
          if (config.activeProfile) {
            setSettings({
              activeProfileId: config.activeProfile.id,
              profiles: [{
                id: config.activeProfile.id,
                name: config.activeProfile.name,
                provider: config.activeProfile.provider,
                baseUrl: 'server-managed',
                apiKey: 'server-managed',
                model: config.activeProfile.model,
                timeout: config.activeProfile.timeout,
                apiMode: config.activeProfile.apiMode,
                codexCli: config.activeProfile.codexCli,
                apiProxy: false,
                streamImages: config.activeProfile.streamImages,
                streamPartialImages: config.activeProfile.streamPartialImages,
              }],
            })
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthenticated(false)
          setShowLoginModal(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [setAuthenticated, setSettings, setShowLoginModal])

  if (authenticated && !useStore.getState().showLoginModal) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return
    setLoading(true)
    try {
      await login(password)
      const config = await getRuntimeConfig()
      setAuthenticated(true)
      setShowLoginModal(false)
      if (config.activeProfile) {
        setSettings({
          activeProfileId: config.activeProfile.id,
          profiles: [{
            id: config.activeProfile.id,
            name: config.activeProfile.name,
            provider: config.activeProfile.provider,
            baseUrl: 'server-managed',
            apiKey: 'server-managed',
            model: config.activeProfile.model,
            timeout: config.activeProfile.timeout,
            apiMode: config.activeProfile.apiMode,
            codexCli: config.activeProfile.codexCli,
            apiProxy: false,
            streamImages: config.activeProfile.streamImages,
            streamPartialImages: config.activeProfile.streamPartialImages,
          }],
        })
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/60 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-white/70 bg-white p-6 shadow-2xl dark:border-white/[0.08] dark:bg-gray-900">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">访问验证</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">请输入访问密码。</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mt-5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400/30 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100"
        />
        <button
          type="submit"
          disabled={loading || !password.trim()}
          className="mt-4 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {loading ? '验证中...' : '进入'}
        </button>
      </form>
    </div>
  )
}
