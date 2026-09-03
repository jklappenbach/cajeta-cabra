// Client-held state (spec §10.2): every conversation lives in the
// browser. The host holds only a cache, so a reload loses nothing.

import type { Message, TurnParams } from './protocol/client'

export interface Conversation {
  id: string
  title: string
  session: number | null
  messages: Message[]
  params: TurnParams
  createdAt: number
}

const KEY = 'cabra.conversations'
const TOKEN_KEY = 'cabra.token'

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as Conversation[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function saveConversations(cs: Conversation[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cs))
  } catch {
    /* storage unavailable: the page still works for this visit */
  }
}

export function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t)
  } catch {
    /* ignore */
  }
}

export function newConversation(): Conversation {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New conversation',
    session: null,
    messages: [],
    params: { temp: 0.7, n: 512 },
    createdAt: Date.now(),
  }
}

export function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'New conversation'
}
