import type { ApiMode, ApiProvider, CustomProviderDefinition, TaskParams } from '../types'
import type { CallApiResult } from './imageApiShared'

export interface RuntimeProfile {
  id: string
  name: string
  provider: ApiProvider
  baseUrl: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  streamImages?: boolean
  streamPartialImages?: number
  active: boolean
  customProvider?: CustomProviderDefinition | null
}

export interface AdminProfile extends RuntimeProfile {
  apiKeyMasked: string
  responseFormatB64Json?: boolean
  customProviderJson: string
}

export interface AssetItem {
  id: string
  name: string
  url: string
  mime: string
  size: number
  width?: number | null
  height?: number | null
  createdAt: number
  updatedAt: number
}

export interface SessionInfo {
  authenticated: boolean
}

async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    /* ignore */
  }
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    throw new Error(typeof record.error === 'string' ? record.error : `HTTP ${response.status}`)
  }
  return payload as T
}

export async function getSession(): Promise<SessionInfo> {
  const response = await fetch('/api/session', { cache: 'no-store' })
  return readJson<SessionInfo>(response)
}

export async function login(password: string): Promise<SessionInfo> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return readJson<SessionInfo>(response)
}

export async function logout(): Promise<SessionInfo> {
  const response = await fetch('/api/logout', { method: 'POST' })
  return readJson<SessionInfo>(response)
}

export async function getRuntimeConfig(): Promise<{ authenticated: boolean; activeProfile: RuntimeProfile | null }> {
  const response = await fetch('/api/runtime-config', { cache: 'no-store' })
  return readJson(response)
}

export async function callServerImageApi(opts: {
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
}): Promise<CallApiResult> {
  const response = await fetch('/api/images/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(opts),
  })
  return readJson<CallApiResult>(response)
}

export async function listProfiles(): Promise<AdminProfile[]> {
  const response = await fetch('/api/admin/profiles', { cache: 'no-store' })
  const payload = await readJson<{ profiles: AdminProfile[] }>(response)
  return payload.profiles
}

export async function saveProfile(profile: Partial<AdminProfile> & { id?: string; apiKey?: string }): Promise<void> {
  const response = await fetch(profile.id ? `/api/admin/profiles/${encodeURIComponent(profile.id)}` : '/api/admin/profiles', {
    method: profile.id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
  await readJson(response)
}

export async function deleteProfile(id: string): Promise<void> {
  const response = await fetch(`/api/admin/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await readJson(response)
}

export async function listAssets(): Promise<AssetItem[]> {
  const response = await fetch('/api/assets', { cache: 'no-store' })
  const payload = await readJson<{ assets: AssetItem[] }>(response)
  return payload.assets
}

export async function uploadAsset(file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/assets', {
    method: 'POST',
    body: form,
  })
  await readJson(response)
}

export async function renameAsset(id: string, name: string): Promise<void> {
  const response = await fetch(`/api/assets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  await readJson(response)
}

export async function deleteAsset(id: string): Promise<void> {
  const response = await fetch(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await readJson(response)
}
