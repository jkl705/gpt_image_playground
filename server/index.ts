import 'dotenv/config'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import fastifyCookie from '@fastify/cookie'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastify from 'fastify'
import Database from 'better-sqlite3'
import { fal } from '@fal-ai/client'

type ApiMode = 'images' | 'responses'
type ApiProvider = 'openai' | 'fal' | string
type TaskParams = {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
  transparent_output: boolean
}
type ApiProfile = {
  id: string
  name: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  responseFormatB64Json?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  customProvider?: CustomProviderDefinition | null
}
type CustomProviderResultMapping = {
  imageUrlPaths?: string[]
  b64JsonPaths?: string[]
}
type CustomProviderSubmitMapping = {
  path: string
  method?: 'GET' | 'POST'
  contentType?: 'json' | 'multipart'
  query?: Record<string, string>
  body?: Record<string, unknown>
  files?: Array<{ field: string; source: 'inputImages' | 'mask'; array?: boolean }>
  taskIdPath?: string
  result?: CustomProviderResultMapping
}
type CustomProviderPollMapping = {
  path: string
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  intervalSeconds?: number
  statusPath: string
  successValues: string[]
  failureValues: string[]
  errorPath?: string
  result: CustomProviderResultMapping
}
type CustomProviderDefinition = {
  id: string
  name: string
  submit: CustomProviderSubmitMapping
  editSubmit?: CustomProviderSubmitMapping
  poll?: CustomProviderPollMapping
}
type CallApiOptions = {
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
}
type CallApiResult = {
  images: string[]
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  revisedPrompts?: Array<string | undefined>
  rawImageUrls?: string[]
  failedRequests?: Array<{ requestIndex: number; error: string }>
}
type ProfileRow = {
  id: string
  name: string
  provider: string
  base_url: string
  api_key: string
  model: string
  timeout: number
  api_mode: ApiMode
  codex_cli: number
  response_format_b64_json: number
  stream_images: number
  stream_partial_images: number | null
  custom_provider_json: string | null
  active: number
  created_at: number
  updated_at: number
}
type AssetRow = {
  id: string
  name: string
  file_name: string
  mime: string
  size: number
  width: number | null
  height: number | null
  created_at: number
  updated_at: number
}

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = resolve(process.env.DATA_DIR || 'data')
const UPLOAD_DIR = join(DATA_DIR, 'uploads', 'assets')
const DIST_DIR = resolve(process.env.DIST_DIR || 'dist')
const SESSION_COOKIE = 'gip_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'
const PASSWORD = process.env.APP_PASSWORD || process.env.USER_PASSWORD || process.env.ADMIN_PASSWORD || 'admin'
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex')
const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

mkdirSync(UPLOAD_DIR, { recursive: true })
const db = new Database(join(DATA_DIR, 'app.sqlite'))
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS api_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    timeout INTEGER NOT NULL,
    api_mode TEXT NOT NULL,
    codex_cli INTEGER NOT NULL DEFAULT 0,
    response_format_b64_json INTEGER NOT NULL DEFAULT 0,
    stream_images INTEGER NOT NULL DEFAULT 0,
    stream_partial_images INTEGER,
    custom_provider_json TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS asset_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`)

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function createSession() {
  const id = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(id, now, now + SESSION_TTL_MS)
  return id
}

function deleteSession(id: string | undefined) {
  if (!id) return
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

function isValidSession(id: string | undefined) {
  if (!id) return false
  const row = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as { expires_at: number } | undefined
  if (!row) return false
  if (row.expires_at < Date.now()) {
    deleteSession(id)
    return false
  }
  return true
}

function requireSession(req: { cookies: Record<string, string | undefined> }) {
  if (!isValidSession(req.cookies[SESSION_COOKIE])) {
    const err = new Error('请先登录')
    ;(err as Error & { statusCode?: number }).statusCode = 401
    throw err
  }
}

function setSessionCookie(reply: any, id: string) {
  reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

function rowToProfile(row: ProfileRow): ApiProfile {
  const customProvider = parseCustomProvider(row.custom_provider_json)
  return {
    id: row.id,
    name: row.name,
    provider: customProvider?.id || row.provider,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    timeout: row.timeout,
    apiMode: row.api_mode,
    codexCli: row.codex_cli === 1,
    responseFormatB64Json: row.response_format_b64_json === 1,
    streamImages: row.stream_images === 1,
    streamPartialImages: row.stream_partial_images ?? undefined,
    customProvider,
  }
}

function parseCustomProvider(value: string | null): CustomProviderDefinition | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as CustomProviderDefinition
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function sanitizeProfile(row: ProfileRow) {
  const profile = rowToProfile(row)
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: 'server-managed',
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    streamImages: profile.streamImages,
    streamPartialImages: profile.streamPartialImages,
    active: row.active === 1,
    customProvider: profile.customProvider
      ? { ...profile.customProvider }
      : null,
  }
}

function maskApiKey(key: string) {
  if (!key) return ''
  if (key.length <= 8) return '********'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function profileForAdmin(row: ProfileRow) {
  return {
    ...sanitizeProfile(row),
    baseUrl: row.base_url,
    apiKeyMasked: maskApiKey(row.api_key),
    responseFormatB64Json: row.response_format_b64_json === 1,
    customProviderJson: row.custom_provider_json || '',
  }
}

function getActiveProfileRow() {
  return db.prepare('SELECT * FROM api_profiles WHERE active = 1 ORDER BY updated_at DESC LIMIT 1').get() as ProfileRow | undefined
}

function getActiveProfile() {
  const row = getActiveProfileRow()
  if (!row) throw new Error('尚未配置可用的 API 配置')
  return rowToProfile(row)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  let current: unknown[] = [source]
  for (const key of path.split('.').filter(Boolean)) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }
  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function appendQuery(path: string, query?: Record<string, string>) {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

function buildApiUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}/${path.replace(/^\/+/, '')}`
}

function normalizeBase64Image(value: string, fallbackMime: string) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

async function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png') {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: fallbackType })
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal) {
  if (isDataUrl(url)) return url
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  const blob = await response.blob()
  const bytes = Buffer.from(await blob.arrayBuffer())
  return `data:${blob.type || fallbackMime};base64,${bytes.toString('base64')}`
}

async function getApiErrorMessage(response: Response) {
  let errorMsg = `HTTP ${response.status}`
  const textResponse = response.clone()
  try {
    const errJson = await response.json() as Record<string, any>
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail)) errorMsg = errJson.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await textResponse.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}
  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') actualParams.quality = record.quality
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') actualParams.output_format = record.output_format
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n
  return actualParams
}

function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>) {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const processBlock = async (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n').trim()
    if (!data || data === '[DONE]') return
    const parsed = JSON.parse(data)
    if (isRecord(parsed)) await onEvent(parsed)
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let separatorIndex = buffer.search(/\r?\n\r?\n/)
    while (separatorIndex >= 0) {
      const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
      await processBlock(buffer.slice(0, separatorIndex))
      buffer = buffer.slice(separatorIndex + separator.length)
      separatorIndex = buffer.search(/\r?\n\r?\n/)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) await processBlock(buffer)
}

async function parseImagesApiResponse(payload: any, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const data = Array.isArray(payload) ? payload : payload?.data
  if (!Array.isArray(data) || !data.length) throw new Error('接口没有返回图片数据')
  const images: string[] = []
  const rawImageUrls = data.map((item) => item?.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      images.push(normalizeBase64Image(item.b64_json, mime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    } else if (isHttpUrl(item?.url) || isDataUrl(item?.url)) {
      images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  const actualParams = mergeActualParams(pickActualParams(payload))
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function extractResponsesImages(payload: any, mime: string) {
  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []
  for (const item of payload.output ?? []) {
    if (item?.type !== 'image_generation_call') continue
    const result = item.result
    const b64 = typeof result === 'string'
      ? result
      : result && typeof result === 'object'
      ? result.b64_json || result.base64 || result.image || result.data || ''
      : ''
    if (String(b64).trim()) {
      results.push({
        image: normalizeBase64Image(String(b64), mime),
        actualParams: pickActualParams(item),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }
  if (!results.length) throw new Error('接口未返回图片数据')
  return results
}

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  try {
    let response: Response
    if (opts.inputImageDataUrls.length > 0) {
      const formData = new FormData()
      formData.append('model', profile.model)
      formData.append('prompt', opts.prompt)
      formData.append('size', opts.params.size)
      formData.append('output_format', opts.params.output_format)
      formData.append('moderation', opts.params.moderation)
      if (!profile.codexCli) formData.append('quality', opts.params.quality)
      if (opts.params.output_format !== 'png' && opts.params.output_compression != null) formData.append('output_compression', String(opts.params.output_compression))
      if (opts.params.n > 1) formData.append('n', String(opts.params.n))
      if (profile.responseFormatB64Json) formData.append('response_format', 'b64_json')
      for (let i = 0; i < opts.inputImageDataUrls.length; i += 1) {
        const blob = await dataUrlToBlob(opts.inputImageDataUrls[i])
        formData.append('image[]', blob, `input-${i + 1}.${blob.type.split('/')[1] || 'png'}`)
      }
      if (opts.maskDataUrl) {
        const mask = await dataUrlToBlob(opts.maskDataUrl, 'image/png')
        formData.append('mask', mask, 'mask.png')
      }
      response = await fetch(buildApiUrl(profile.baseUrl, 'images/edits'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}` },
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: profile.model,
        prompt: opts.prompt,
        size: opts.params.size,
        output_format: opts.params.output_format,
        moderation: opts.params.moderation,
      }
      if (!profile.codexCli) body.quality = opts.params.quality
      if (opts.params.output_format !== 'png' && opts.params.output_compression != null) body.output_compression = opts.params.output_compression
      if (opts.params.n > 1) body.n = opts.params.n
      if (profile.responseFormatB64Json) body.response_format = 'b64_json'
      if (profile.streamImages) {
        body.stream = true
        body.partial_images = profile.streamPartialImages ?? 1
      }
      response = await fetch(buildApiUrl(profile.baseUrl, 'images/generations'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    if (profile.streamImages && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let finalPayload: any = null
      const completedItems: any[] = []
      await readJsonServerSentEvents(response, (event) => {
        if (event.object === 'image.generation.result' || event.object === 'image.edit.result') finalPayload = event
        if (event.type === 'image_generation.completed' || event.type === 'image_edit.completed') completedItems.push(event)
      })
      if (finalPayload) return parseImagesApiResponse(finalPayload, mime)
      return parseImagesApiResponse({ data: completedItems }, mime)
    }
    return parseImagesApiResponse(await response.json(), mime, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  try {
    const content = opts.inputImageDataUrls.length
      ? [{
          role: 'user',
          content: [
            { type: 'input_text', text: opts.prompt },
            ...opts.inputImageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
          ],
        }]
      : opts.prompt
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      action: opts.inputImageDataUrls.length > 0 ? 'edit' : 'generate',
      size: opts.params.size,
      output_format: opts.params.output_format,
      moderation: opts.params.moderation,
      quality: opts.params.quality,
    }
    if (opts.params.output_format !== 'png' && opts.params.output_compression != null) tool.output_compression = opts.params.output_compression
    if (opts.maskDataUrl) tool.input_image_mask = { image_url: opts.maskDataUrl }
    if (profile.streamImages) tool.partial_images = profile.streamPartialImages ?? 1
    const body: Record<string, unknown> = {
      model: profile.model,
      input: content,
      tools: [tool],
      tool_choice: 'required',
    }
    if (profile.streamImages) body.stream = true
    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    let payload: any = null
    if (profile.streamImages && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      const outputItems: any[] = []
      await readJsonServerSentEvents(response, (event) => {
        if (isRecord(event.response)) payload = event.response
        if (isRecord(event.item)) outputItems.push(event.item)
      })
      payload ??= { output: outputItems }
    } else {
      payload = await response.json()
    }
    const imageResults = extractResponsesImages(payload, mime)
    return {
      images: imageResults.map((result) => result.image),
      actualParams: mergeActualParams(imageResults[0]?.actualParams),
      actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams)),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function mapFalEndpoint(model: string, isEdit: boolean) {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

async function callFalApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '') || 'https://fal.run'
  fal.config({
    credentials: profile.apiKey,
    suppressLocalCredentialsWarning: true,
    ...(baseUrl !== 'https://fal.run' ? { proxyUrl: baseUrl } : {}),
  })
  const isEdit = opts.inputImageDataUrls.length > 0
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image_size: isEdit && opts.params.size === 'auto' ? 'auto' : opts.params.size === 'auto' ? { width: 1360, height: 1024 } : opts.params.size,
    quality: opts.params.quality === 'auto' ? 'high' : opts.params.quality,
    num_images: Math.min(4, Math.max(1, opts.params.n || 1)),
    output_format: opts.params.output_format,
  }
  if (isEdit) input.image_urls = opts.inputImageDataUrls
  if (opts.maskDataUrl) input.mask_url = opts.maskDataUrl
  const result = await fal.subscribe(mapFalEndpoint(profile.model, isEdit), { input, logs: true })
  const data = result.data as any
  const candidates = [...(Array.isArray(data.images) ? data.images : []), data.image, data.url].filter(Boolean)
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'
  const images: string[] = []
  const rawImageUrls: string[] = []
  for (const candidate of candidates) {
    const value = typeof candidate === 'string'
      ? candidate
      : candidate?.url || candidate?.b64_json || candidate?.base64 || candidate?.data
    if (isHttpUrl(value)) {
      rawImageUrls.push(value)
      images.push(await fetchImageUrlAsDataUrl(value, mime))
    } else if (isDataUrl(value)) {
      images.push(value)
    } else if (typeof value === 'string' && value.trim()) {
      images.push(normalizeBase64Image(value, mime))
    }
  }
  if (!images.length) throw new Error('fal.ai 未返回可用图片数据')
  return { images, rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined }
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return getByPath(context, value.slice(1))
  if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>) {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function extractCustomImages(payload: unknown, result: CustomProviderResultMapping, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const images: string[] = []
  const imageUrls = (result.imageUrlPaths ?? []).flatMap((path) => getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)))
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  for (const path of result.b64JsonPaths ?? []) {
    for (const value of getAllByPath(payload, path)) {
      if (typeof value === 'string' && value.trim()) images.push(normalizeBase64Image(value, mime))
    }
  }
  for (const url of imageUrls) images.push(await fetchImageUrlAsDataUrl(url, mime, signal))
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

function buildTaskPath(path: string, taskId: string) {
  return path.replace(/\{task_id\}/g, encodeURIComponent(taskId)).replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

async function callCustomProvider(opts: CallApiOptions, profile: ApiProfile, customProvider: CustomProviderDefinition): Promise<CallApiResult> {
  const mapping = opts.inputImageDataUrls.length > 0 && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  const context = {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImages: { dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined, count: opts.inputImageDataUrls.length },
    mask: { dataUrl: opts.maskDataUrl },
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  try {
    const method = mapping.method ?? 'POST'
    const contentType = mapping.contentType ?? 'json'
    const headers: Record<string, string> = { Authorization: `Bearer ${profile.apiKey}` }
    let body: BodyInit | undefined
    if (method !== 'GET') {
      if (contentType === 'multipart') {
        const formData = new FormData()
        const resolved = resolveTemplateValue(mapping.body ?? {}, context)
        if (isRecord(resolved)) {
          for (const [key, value] of Object.entries(resolved)) {
            if (Array.isArray(value)) value.forEach((item) => formData.append(key, String(item)))
            else if (value != null) formData.append(key, String(value))
          }
        }
        for (const file of mapping.files ?? []) {
          if (file.source === 'inputImages') {
            for (let i = 0; i < opts.inputImageDataUrls.length; i += 1) {
              const blob = await dataUrlToBlob(opts.inputImageDataUrls[i])
              formData.append(file.field, blob, `input-${i + 1}.${blob.type.split('/')[1] || 'png'}`)
            }
          } else if (file.source === 'mask' && opts.maskDataUrl) {
            formData.append(file.field, await dataUrlToBlob(opts.maskDataUrl, 'image/png'), 'mask.png')
          }
        }
        body = formData
      } else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(resolveTemplateValue(mapping.body ?? {}, context))
      }
    }
    const path = appendQuery(mapping.path, renderQuery(mapping.query, context))
    const response = await fetch(buildApiUrl(profile.baseUrl, path), {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await response.json()
    const taskIdValue = mapping.taskIdPath ? getByPath(payload, mapping.taskIdPath) : undefined
    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
    const mime = MIME_MAP[opts.params.output_format] || 'image/png'
    if (!taskId) return extractCustomImages(payload, mapping.result ?? {}, mime, controller.signal)
    if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, (customProvider.poll?.intervalSeconds ?? 5) * 1000))
      const poll = customProvider.poll
      const pollResponse = await fetch(buildApiUrl(profile.baseUrl, appendQuery(buildTaskPath(poll.path, taskId), poll.query)), {
        method: poll.method ?? 'GET',
        headers: { Authorization: `Bearer ${profile.apiKey}` },
        signal: controller.signal,
      })
      if (!pollResponse.ok) throw new Error(await getApiErrorMessage(pollResponse))
      const pollPayload = await pollResponse.json()
      const status = String(getByPath(pollPayload, poll.statusPath) ?? '')
      if (poll.failureValues.includes(status)) throw new Error(String(getByPath(pollPayload, poll.errorPath) || '异步任务失败'))
      if (poll.successValues.includes(status)) return extractCustomImages(pollPayload, poll.result, mime, controller.signal)
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveProfile()
  if (profile.provider === 'fal') return callFalApi(opts, profile)
  if (profile.customProvider) return callCustomProvider(opts, profile, profile.customProvider)
  return profile.apiMode === 'responses' ? callResponsesImageApi(opts, profile) : callImagesApi(opts, profile)
}

function normalizeProfilePayload(body: any, previous?: ProfileRow) {
  const customProviderJson = typeof body.customProviderJson === 'string' && body.customProviderJson.trim()
    ? JSON.stringify(JSON.parse(body.customProviderJson))
    : null
  const customProvider = parseCustomProvider(customProviderJson)
  return {
    id: previous?.id ?? randomUUID(),
    name: String(body.name || previous?.name || '新配置').trim() || '新配置',
    provider: customProvider?.id || String(body.provider || previous?.provider || 'openai').trim(),
    baseUrl: String(body.baseUrl || previous?.base_url || '').trim(),
    apiKey: typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : previous?.api_key ?? '',
    model: String(body.model || previous?.model || 'gpt-image-2').trim(),
    timeout: Number.isFinite(Number(body.timeout)) ? Math.max(1, Math.trunc(Number(body.timeout))) : previous?.timeout ?? 600,
    apiMode: body.apiMode === 'responses' ? 'responses' as const : 'images' as const,
    codexCli: body.codexCli === true ? 1 : previous?.codex_cli ?? 0,
    responseFormatB64Json: body.responseFormatB64Json === true ? 1 : previous?.response_format_b64_json ?? 0,
    streamImages: body.streamImages === true ? 1 : previous?.stream_images ?? 0,
    streamPartialImages: Number.isFinite(Number(body.streamPartialImages)) ? Math.max(0, Math.trunc(Number(body.streamPartialImages))) : previous?.stream_partial_images ?? 1,
    customProviderJson,
    active: body.active === true,
  }
}

function readPngSize(buffer: Buffer) {
  if (buffer.length < 24) return {}
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return {}
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

const app = fastify({ logger: true, bodyLimit: 512 * 1024 * 1024 })
await app.register(fastifyCookie, { secret: SESSION_SECRET })
await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } })

app.setErrorHandler((err, _req, reply) => {
  const error = err as Error & { statusCode?: number }
  const statusCode = error.statusCode || 500
  reply.status(statusCode).send({ error: error.message || '服务器错误' })
})

app.get('/api/session', async (req) => {
  return { authenticated: isValidSession(req.cookies[SESSION_COOKIE]) }
})

app.post('/api/login', async (req, reply) => {
  const body = req.body as { password?: string }
  if (!safeEqual(String(body.password || ''), PASSWORD)) {
    reply.status(401)
    return { error: '密码错误' }
  }
  const sessionId = createSession()
  setSessionCookie(reply, sessionId)
  return { authenticated: true }
})

app.post('/api/admin/login', async (req, reply) => {
  return app.inject({ method: 'POST', url: '/api/login', payload: req.body as any }).then((res) => {
    if (res.cookies[0]?.value) setSessionCookie(reply, res.cookies[0].value)
    reply.status(res.statusCode)
    return JSON.parse(res.body)
  })
})

app.post('/api/logout', async (req, reply) => {
  deleteSession(req.cookies[SESSION_COOKIE])
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
  return { authenticated: false }
})

app.get('/api/runtime-config', async (req) => {
  requireSession(req)
  const active = getActiveProfileRow()
  return {
    authenticated: true,
    activeProfile: active ? sanitizeProfile(active) : null,
    features: {
      assets: true,
      profiles: true,
    },
  }
})

app.post('/api/images/generate', async (req) => {
  requireSession(req)
  const body = req.body as CallApiOptions
  return callImageApi(body)
})

app.post('/api/agent/responses', async (req, reply) => {
  requireSession(req)
  const profile = getActiveProfile()
  const body = req.body as { body?: Record<string, unknown> }
  const requestBody = { ...(body.body ?? {}), model: profile.model }
  const response = await fetch(buildApiUrl(profile.baseUrl, 'responses'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  reply.status(response.status)
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'content-encoding') reply.header(key, value)
  })
  if (!response.body) return response.text()
  return reply.send(Readable.fromWeb(response.body as any))
})

app.get('/api/admin/profiles', async (req) => {
  requireSession(req)
  const rows = db.prepare('SELECT * FROM api_profiles ORDER BY active DESC, updated_at DESC').all() as ProfileRow[]
  return { profiles: rows.map(profileForAdmin) }
})

app.post('/api/admin/profiles', async (req) => {
  requireSession(req)
  const now = Date.now()
  const profile = normalizeProfilePayload(req.body)
  if (!profile.baseUrl) throw new Error('缺少 API URL')
  if (!profile.apiKey) throw new Error('缺少 API Key')
  if (profile.active) db.prepare('UPDATE api_profiles SET active = 0').run()
  db.prepare(`
    INSERT INTO api_profiles
      (id, name, provider, base_url, api_key, model, timeout, api_mode, codex_cli, response_format_b64_json, stream_images, stream_partial_images, custom_provider_json, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(profile.id, profile.name, profile.provider, profile.baseUrl, profile.apiKey, profile.model, profile.timeout, profile.apiMode, profile.codexCli, profile.responseFormatB64Json, profile.streamImages, profile.streamPartialImages, profile.customProviderJson, profile.active ? 1 : 0, now, now)
  if (!getActiveProfileRow()) db.prepare('UPDATE api_profiles SET active = 1 WHERE id = ?').run(profile.id)
  return { ok: true }
})

app.put('/api/admin/profiles/:id', async (req, reply) => {
  requireSession(req)
  const id = (req.params as { id: string }).id
  const previous = db.prepare('SELECT * FROM api_profiles WHERE id = ?').get(id) as ProfileRow | undefined
  if (!previous) {
    reply.status(404)
    return { error: '配置不存在' }
  }
  const profile = normalizeProfilePayload(req.body, previous)
  if (!profile.baseUrl) throw new Error('缺少 API URL')
  if (!profile.apiKey) throw new Error('缺少 API Key')
  if (profile.active) db.prepare('UPDATE api_profiles SET active = 0').run()
  db.prepare(`
    UPDATE api_profiles
    SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, timeout = ?, api_mode = ?, codex_cli = ?, response_format_b64_json = ?, stream_images = ?, stream_partial_images = ?, custom_provider_json = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(profile.name, profile.provider, profile.baseUrl, profile.apiKey, profile.model, profile.timeout, profile.apiMode, profile.codexCli, profile.responseFormatB64Json, profile.streamImages, profile.streamPartialImages, profile.customProviderJson, profile.active ? 1 : previous.active, Date.now(), id)
  if (!getActiveProfileRow()) db.prepare('UPDATE api_profiles SET active = 1 WHERE id = ?').run(id)
  return { ok: true }
})

app.delete('/api/admin/profiles/:id', async (req) => {
  requireSession(req)
  const id = (req.params as { id: string }).id
  const row = db.prepare('SELECT active FROM api_profiles WHERE id = ?').get(id) as { active: number } | undefined
  db.prepare('DELETE FROM api_profiles WHERE id = ?').run(id)
  if (row?.active) {
    const next = db.prepare('SELECT id FROM api_profiles ORDER BY updated_at DESC LIMIT 1').get() as { id: string } | undefined
    if (next) db.prepare('UPDATE api_profiles SET active = 1 WHERE id = ?').run(next.id)
  }
  return { ok: true }
})

app.get('/api/assets', async (req) => {
  requireSession(req)
  const rows = db.prepare('SELECT * FROM asset_items ORDER BY updated_at DESC').all() as AssetRow[]
  return {
    assets: rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: `/assets/${row.id}/file`,
      mime: row.mime,
      size: row.size,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
})

app.post('/api/assets', async (req) => {
  requireSession(req)
  const file = await req.file()
  if (!file) throw new Error('请选择 PNG 文件')
  const buffer = Buffer.from(await file.toBuffer())
  if (file.mimetype !== 'image/png') throw new Error('素材库只支持透明 PNG 图片')
  const id = randomUUID()
  const fileName = `${id}.png`
  const size = readPngSize(buffer)
  await import('node:fs/promises').then((fs) => fs.writeFile(join(UPLOAD_DIR, fileName), buffer))
  const now = Date.now()
  db.prepare(`
    INSERT INTO asset_items (id, name, file_name, mime, size, width, height, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, file.filename?.replace(/\.[^.]+$/, '') || '未命名素材', fileName, file.mimetype, buffer.length, size.width ?? null, size.height ?? null, now, now)
  return { ok: true, id }
})

app.put('/api/assets/:id', async (req, reply) => {
  requireSession(req)
  const id = (req.params as { id: string }).id
  const body = req.body as { name?: string }
  const name = String(body.name || '').trim()
  if (!name) throw new Error('素材名称不能为空')
  const result = db.prepare('UPDATE asset_items SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
  if (result.changes === 0) {
    reply.status(404)
    return { error: '素材不存在' }
  }
  return { ok: true }
})

app.delete('/api/assets/:id', async (req) => {
  requireSession(req)
  const id = (req.params as { id: string }).id
  const row = db.prepare('SELECT file_name FROM asset_items WHERE id = ?').get(id) as { file_name: string } | undefined
  db.prepare('DELETE FROM asset_items WHERE id = ?').run(id)
  if (row) await import('node:fs/promises').then((fs) => fs.rm(join(UPLOAD_DIR, row.file_name), { force: true }))
  return { ok: true }
})

app.get('/assets/:id/file', async (req, reply) => {
  requireSession(req)
  const id = (req.params as { id: string }).id
  const row = db.prepare('SELECT * FROM asset_items WHERE id = ?').get(id) as AssetRow | undefined
  if (!row) {
    reply.status(404)
    return { error: '素材不存在' }
  }
  reply.header('Content-Type', row.mime)
  reply.header('Cache-Control', 'private, max-age=3600')
  return reply.send(createReadStream(join(UPLOAD_DIR, row.file_name)))
})

if (existsSync(DIST_DIR)) {
  await app.register(fastifyStatic, {
    root: DIST_DIR,
    prefix: '/',
  })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.status(404).send({ error: '接口不存在' })
      return
    }
    reply.sendFile('index.html')
  })
}

app.listen({ port: PORT, host: HOST })
