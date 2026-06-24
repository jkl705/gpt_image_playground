import { useEffect, useRef, useState } from 'react'
import { createInputImageFromFile, useStore } from '../store'
import { deleteAsset, listAssets, renameAsset, uploadAsset, type AssetItem } from '../lib/serverApi'
import { CloseIcon, PlusIcon, TrashIcon } from './icons'

export default function AssetLibraryModal() {
  const visible = useStore((s) => s.showAssetLibraryModal)
  const setVisible = useStore((s) => s.setShowAssetLibraryModal)
  const setShowCompositionModal = useStore((s) => s.setShowCompositionModal)
  const addInputImage = useStore((s) => s.addInputImage)
  const showToast = useStore((s) => s.showToast)
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [query, setQuery] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setAssets(await listAssets())
  }

  useEffect(() => {
    if (!visible) return
    void load().catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
  }, [visible])

  if (!visible) return null

  const filtered = assets.filter((asset) => asset.name.toLowerCase().includes(query.trim().toLowerCase()))

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return
    try {
      for (const file of Array.from(files)) await uploadAsset(file)
      await load()
      showToast('素材已上传', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const addAsReference = async (asset: AssetItem) => {
    const response = await fetch(asset.url)
    const blob = await response.blob()
    const file = new File([blob], `${asset.name}.png`, { type: blob.type || 'image/png' })
    const image = await createInputImageFromFile(file)
    if (!image) return
    addInputImage(image)
    showToast('已添加到参考图', 'success')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col rounded-2xl border border-white/70 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-white/[0.08]">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">素材库</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">共享透明 PNG 素材，可直接合成到参考图。</p>
          </div>
          <button onClick={() => setVisible(false)} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="flex items-center gap-3 p-4">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索素材" className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100" />
          <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600">
            <PlusIcon className="h-4 w-4" />
            上传 PNG
          </button>
          <input ref={fileRef} type="file" accept="image/png" multiple className="hidden" onChange={(e) => void handleUpload(e.target.files)} />
        </div>
        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 pt-0 sm:grid-cols-4">
          {filtered.map((asset) => (
            <div key={asset.id} className="rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <button
                onClick={() => {
                  sessionStorage.setItem('compositionAsset', JSON.stringify(asset))
                  setShowCompositionModal(true)
                }}
                className="flex aspect-square w-full items-center justify-center rounded-lg bg-white checkerboard dark:bg-gray-950"
              >
                <img src={asset.url} alt={asset.name} className="max-h-full max-w-full object-contain" />
              </button>
              <input
                value={asset.name}
                onChange={(e) => setAssets((items) => items.map((item) => item.id === asset.id ? { ...item, name: e.target.value } : item))}
                onBlur={(e) => void renameAsset(asset.id, e.target.value).catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))}
                className="mt-2 w-full rounded-lg border border-transparent bg-transparent px-1 py-1 text-sm font-medium text-gray-800 outline-none focus:border-blue-300 dark:text-gray-100"
              />
              <div className="mt-2 grid grid-cols-3 gap-1">
                <button onClick={() => void addAsReference(asset)} className="rounded-lg bg-gray-200 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-300 dark:bg-white/[0.06] dark:text-gray-200">参考</button>
                <button
                  onClick={() => {
                    sessionStorage.setItem('compositionAsset', JSON.stringify(asset))
                    setShowCompositionModal(true)
                  }}
                  className="rounded-lg bg-blue-500 px-2 py-1.5 text-xs text-white hover:bg-blue-600"
                >
                  合成
                </button>
                <button
                  onClick={async () => {
                    await deleteAsset(asset.id)
                    await load()
                  }}
                  className="flex items-center justify-center rounded-lg bg-red-50 px-2 py-1.5 text-red-600 hover:bg-red-100 dark:bg-red-500/10"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
