import { useEffect, useRef, useState } from 'react'
import { createInputImageFromFile, useStore } from '../store'
import type { AssetItem } from '../lib/serverApi'
import { CloseIcon } from './icons'

interface LayerState {
  x: number
  y: number
  scale: number
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片导出失败'))
    }, 'image/png')
  })
}

export default function CompositionEditorModal() {
  const visible = useStore((s) => s.showCompositionModal)
  const setVisible = useStore((s) => s.setShowCompositionModal)
  const addInputImage = useStore((s) => s.addInputImage)
  const showToast = useStore((s) => s.showToast)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; layer: LayerState } | null>(null)
  const [asset, setAsset] = useState<AssetItem | null>(null)
  const [layer, setLayer] = useState<LayerState>({ x: 256, y: 256, scale: 1 })

  const draw = () => {
    const canvas = canvasRef.current
    const image = imgRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const width = image.naturalWidth * layer.scale
    const height = image.naturalHeight * layer.scale
    ctx.drawImage(image, layer.x, layer.y, width, height)
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.strokeRect(layer.x, layer.y, width, height)
  }

  useEffect(() => {
    if (!visible) return
    const raw = sessionStorage.getItem('compositionAsset')
    setAsset(raw ? JSON.parse(raw) as AssetItem : null)
  }, [visible])

  useEffect(() => {
    if (!asset) return
    const image = new Image()
    image.crossOrigin = 'same-origin'
    image.onload = () => {
      imgRef.current = image
      const baseScale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight))
      setLayer({ x: Math.round((1024 - image.naturalWidth * baseScale) / 2), y: Math.round((1024 - image.naturalHeight * baseScale) / 2), scale: baseScale })
    }
    image.src = asset.url
  }, [asset])

  useEffect(draw, [layer, asset])

  if (!visible) return null

  const exportImage = async () => {
    const canvas = canvasRef.current
    const image = imgRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, layer.x, layer.y, image.naturalWidth * layer.scale, image.naturalHeight * layer.scale)
    const blob = await canvasToBlob(canvas)
    const file = new File([blob], `${asset?.name || 'composition'}.png`, { type: 'image/png' })
    const input = await createInputImageFromFile(file)
    if (input) {
      addInputImage(input)
      showToast('合成图已添加到参考图', 'success')
      setVisible(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-5xl rounded-2xl border border-white/70 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-white/[0.08]">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">素材定位合成</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">{asset?.name || '未选择素材'}</p>
          </div>
          <button onClick={() => setVisible(false)} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr_240px]">
          <div className="flex justify-center overflow-auto rounded-xl bg-gray-100 p-3 dark:bg-gray-950">
            <canvas
              ref={canvasRef}
              width={1024}
              height={1024}
              className="h-auto w-full max-w-[640px] rounded-lg bg-white checkerboard"
              onPointerDown={(e) => {
                dragRef.current = { startX: e.clientX, startY: e.clientY, layer }
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (!dragRef.current) return
                const rect = e.currentTarget.getBoundingClientRect()
                const scale = 1024 / rect.width
                setLayer({
                  ...dragRef.current.layer,
                  x: dragRef.current.layer.x + (e.clientX - dragRef.current.startX) * scale,
                  y: dragRef.current.layer.y + (e.clientY - dragRef.current.startY) * scale,
                })
              }}
              onPointerUp={() => {
                dragRef.current = null
              }}
            />
          </div>
          <aside className="space-y-4">
            <label className="block text-sm text-gray-700 dark:text-gray-300">
              缩放
              <input type="range" min="0.05" max="3" step="0.01" value={layer.scale} onChange={(e) => setLayer((current) => ({ ...current, scale: Number(e.target.value) }))} className="mt-2 w-full" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm text-gray-700 dark:text-gray-300">
                X
                <input type="number" value={Math.round(layer.x)} onChange={(e) => setLayer((current) => ({ ...current, x: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 dark:border-white/[0.08] dark:bg-white/[0.04]" />
              </label>
              <label className="text-sm text-gray-700 dark:text-gray-300">
                Y
                <input type="number" value={Math.round(layer.y)} onChange={(e) => setLayer((current) => ({ ...current, y: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1 dark:border-white/[0.08] dark:bg-white/[0.04]" />
              </label>
            </div>
            <button onClick={() => void exportImage()} disabled={!asset} className="w-full rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-gray-300">
              添加到参考图
            </button>
          </aside>
        </div>
      </div>
    </div>
  )
}
