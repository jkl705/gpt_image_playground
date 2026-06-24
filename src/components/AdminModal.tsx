import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { deleteProfile, listProfiles, saveProfile, type AdminProfile } from '../lib/serverApi'
import { CloseIcon, PlusIcon, TrashIcon } from './icons'

type DraftProfile = Partial<AdminProfile> & { apiKey?: string }

const emptyDraft: DraftProfile = {
  name: '新配置',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-2',
  timeout: 600,
  apiMode: 'images',
  codexCli: false,
  streamImages: false,
  streamPartialImages: 1,
  responseFormatB64Json: false,
  customProviderJson: '',
  active: true,
}

export default function AdminModal() {
  const visible = useStore((s) => s.showAdminModal)
  const setVisible = useStore((s) => s.setShowAdminModal)
  const showToast = useStore((s) => s.showToast)
  const [profiles, setProfiles] = useState<AdminProfile[]>([])
  const [draft, setDraft] = useState<DraftProfile>(emptyDraft)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    const items = await listProfiles()
    setProfiles(items)
    setDraft(items[0] ? { ...items[0], apiKey: '' } : emptyDraft)
  }

  useEffect(() => {
    if (!visible) return
    void load().catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
  }, [visible])

  if (!visible) return null

  const updateDraft = (patch: DraftProfile) => setDraft((current) => ({ ...current, ...patch }))

  const submit = async () => {
    setLoading(true)
    try {
      await saveProfile(draft)
      await load()
      showToast('配置已保存', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('确定删除这个 API 配置吗？')) return
    await deleteProfile(id)
    await load()
    showToast('配置已删除', 'success')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/70 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-900">
        <aside className="w-72 shrink-0 border-r border-gray-200 p-4 dark:border-white/[0.08]">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">管理后台</h2>
            <button onClick={() => setVisible(false)} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={() => setDraft(emptyDraft)}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600"
          >
            <PlusIcon className="h-4 w-4" />
            新建配置
          </button>
          <div className="space-y-1 overflow-y-auto">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                onClick={() => setDraft({ ...profile, apiKey: '' })}
                className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${draft.id === profile.id ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
              >
                <div className="truncate font-medium">{profile.name}</div>
                <div className="truncate text-xs opacity-70">{profile.active ? '当前 · ' : ''}{profile.model}</div>
              </button>
            ))}
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">
              名称
              <input value={draft.name ?? ''} onChange={(e) => updateDraft({ name: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              Provider
              <select value={draft.provider ?? 'openai'} onChange={(e) => updateDraft({ provider: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <option value="openai">OpenAI / 兼容接口</option>
                <option value="fal">fal.ai</option>
                <option value="custom">自定义 Provider JSON</option>
              </select>
            </label>
            <label className="sm:col-span-2 text-sm text-gray-700 dark:text-gray-300">
              API URL
              <input value={draft.baseUrl ?? ''} onChange={(e) => updateDraft({ baseUrl: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              API Key
              <input type="password" value={draft.apiKey ?? ''} placeholder={draft.apiKeyMasked || '留空则保留原 Key'} onChange={(e) => updateDraft({ apiKey: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              模型
              <input value={draft.model ?? ''} onChange={(e) => updateDraft({ model: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              API 模式
              <select value={draft.apiMode ?? 'images'} onChange={(e) => updateDraft({ apiMode: e.target.value as 'images' | 'responses' })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <option value="images">Images API</option>
                <option value="responses">Responses API</option>
              </select>
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              超时秒数
              <input type="number" value={draft.timeout ?? 600} onChange={(e) => updateDraft({ timeout: Number(e.target.value) })} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={draft.active === true} onChange={(e) => updateDraft({ active: e.target.checked })} />
              设为当前配置
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={draft.streamImages === true} onChange={(e) => updateDraft({ streamImages: e.target.checked })} />
              启用流式图片
            </label>
            <label className="sm:col-span-2 text-sm text-gray-700 dark:text-gray-300">
              自定义 Provider JSON
              <textarea value={draft.customProviderJson ?? ''} onChange={(e) => updateDraft({ customProviderJson: e.target.value })} rows={8} className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 font-mono text-xs dark:border-white/[0.08] dark:bg-white/[0.04]" />
            </label>
          </div>
          <div className="mt-5 flex justify-between">
            <button
              disabled={!draft.id}
              onClick={() => draft.id && void remove(draft.id)}
              className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-500/10"
            >
              <TrashIcon className="h-4 w-4" />
              删除
            </button>
            <button disabled={loading} onClick={submit} className="rounded-xl bg-blue-500 px-5 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-gray-300">
              保存
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
