// The cabra web client (spec §10): one host, N conversations, each its
// own session on one socket. State is client-side (§10.2); the host is
// a cache. What the page does that the CLI client cannot: stop a turn
// (§10.5), survive a drop (§10.6), hold several conversations (§10.7),
// and show the engine's own diagnostics for a turn (§10.9).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CabraClient,
  type ClientState,
  type DiagLine,
  type Health,
  type Message,
  type Turn,
  type TurnParams,
  type Usage,
} from './protocol/client'
import { Markdown } from './Markdown'
import {
  loadConversations,
  loadToken,
  newConversation,
  saveConversations,
  saveToken,
  titleFrom,
  type Conversation,
} from './store'

interface Live {
  conv: string
  turn: Turn
  text: string
  diag: DiagLine[]
}

interface Ended {
  finish: string
  usage: Usage | null
  error?: string
  notice?: string
  diag?: DiagLine[]
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

export default function App() {
  const [token, setToken] = useState<string>(loadToken())
  const [state, setState] = useState<ClientState>('idle')
  const [authError, setAuthError] = useState<string>('')
  const [health, setHealth] = useState<Health | null>(null)
  const [convs, setConvs] = useState<Conversation[]>(() => loadConversations())
  const [current, setCurrent] = useState<string>(() => loadConversations()[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [ended, setEnded] = useState<Record<string, Ended>>({})
  const [showParams, setShowParams] = useState(false)
  const [showDiag, setShowDiag] = useState(false)
  const clientRef = useRef<CabraClient | null>(null)
  const liveRef = useRef<Live | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => saveConversations(convs), [convs])

  const conv = useMemo(() => convs.find((c) => c.id === current) ?? null, [convs, current])

  // Connect whenever we have a token; a rejected token drops back to
  // the token prompt with the reason (§10.3).
  useEffect(() => {
    if (!token) return
    clientRef.current?.close()
    const c = new CabraClient({ url: wsUrl(), token })
    clientRef.current = c
    c.onState = (s) => {
      setState(s)
      if (s === 'ready') c.health().then(setHealth, () => setHealth(null))
    }
    setAuthError('')
    c.connect().catch((e: Error) => {
      setAuthError(e.message)
      setToken('')
    })
    return () => c.close()
  }, [token])

  const updateConv = useCallback((id: string, f: (c: Conversation) => Conversation) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? f(c) : c)))
  }, [])

  const setLiveBoth = (l: Live | null) => {
    liveRef.current = l
    setLive(l)
  }

  const send = () => {
    const client = clientRef.current
    if (!client || client.state !== 'ready' || !draft.trim() || liveRef.current) return
    if (health && health.state !== 'ready') return
    let target = conv
    if (!target) {
      target = newConversation()
      setConvs((cs) => [target!, ...cs])
      setCurrent(target.id)
    }
    const user: Message = { role: 'user', content: draft.trim() }
    const messages = [...target.messages, user]
    const convId = target.id
    updateConv(convId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? titleFrom(user.content) : c.title,
      messages,
    }))
    setDraft('')
    setEnded((e) => {
      const n = { ...e }
      delete n[convId]
      return n
    })

    const start = (session: number) => {
      const turn = client.chat(session, messages, target!.params, {
        onChunk: (t) => {
          const l = liveRef.current
          if (!l || l.conv !== convId) return
          setLiveBoth({ ...l, text: l.text + t })
        },
        onDiag: (d) => {
          const l = liveRef.current
          if (!l || l.conv !== convId) return
          setLiveBoth({ ...l, diag: [...l.diag, d] })
        },
        onDone: (finish, usage) => {
          const l = liveRef.current
          const text = l?.text ?? ''
          const diag = l?.diag ?? []
          if (text.length > 0) {
            updateConv(convId, (c) => ({
              ...c,
              messages: [...c.messages, { role: 'assistant', content: text }],
            }))
          }
          setEnded((e) => ({ ...e, [convId]: { ...e[convId], finish, usage, diag } }))
          setLiveBoth(null)
        },
        onError: (message) => {
          setEnded((e) => ({ ...e, [convId]: { finish: 'error', usage: null, error: message } }))
          setLiveBoth(null)
        },
        onSessionReplaced: (s, why) => {
          updateConv(convId, (c) => ({ ...c, session: s }))
          setEnded((e) => ({
            ...e,
            [convId]: {
              finish: '',
              usage: null,
              notice: `Session was gone (${why}). Opened session ${s} and resubmitted the conversation.`,
            },
          }))
        },
      })
      setLiveBoth({ conv: convId, turn, text: '', diag: [] })
    }

    if (target.session !== null) {
      start(target.session)
    } else {
      client.openSession().then(
        (s) => {
          updateConv(convId, (c) => ({ ...c, session: s }))
          start(s)
        },
        (e: Error) => setEnded((x) => ({ ...x, [convId]: { finish: 'error', usage: null, error: e.message } })),
      )
    }
  }

  const stop = () => liveRef.current?.turn.cancel()

  const create = () => {
    const c = newConversation()
    setConvs((cs) => [c, ...cs])
    setCurrent(c.id)
    setDraft('')
  }

  const remove = (id: string) => {
    const c = convs.find((x) => x.id === id)
    if (c?.session !== null && c?.session !== undefined) clientRef.current?.closeSession(c.session)
    setConvs((cs) => cs.filter((x) => x.id !== id))
    if (current === id) setCurrent(convs.find((x) => x.id !== id)?.id ?? '')
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [live?.text, conv?.messages.length])

  const busyHere = live !== null && live.conv === current
  const busyElsewhere = live !== null && live.conv !== current
  const hostReady = state === 'ready' && (health === null || health.state === 'ready')
  const endedHere = conv ? ended[conv.id] : undefined

  if (!token) {
    return (
      <div className="gate">
        <form
          className="gate-card"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const t = String(f.get('token') ?? '')
            saveToken(t)
            setToken(t)
          }}
        >
          <h1>cabra</h1>
          <p>This host asks for its token before anything else.</p>
          <input name="token" type="password" placeholder="host token" autoFocus />
          {authError && <p className="err">{authError}</p>}
          <button type="submit">Connect</button>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="side-head">
          <span className="brand">cabra</span>
          <button className="ghost" onClick={create} title="New conversation">
            + New
          </button>
        </div>
        <ul className="convs">
          {convs.map((c) => (
            <li key={c.id} className={c.id === current ? 'sel' : ''}>
              <button className="conv" onClick={() => setCurrent(c.id)}>
                <span className="conv-title">{c.title}</span>
                {live?.conv === c.id && <span className="dot" title="generating" />}
              </button>
              <button className="x" onClick={() => remove(c.id)} title="Delete">
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="side-foot">
          <HealthBadge state={state} health={health} />
        </div>
      </aside>

      <main className="main">
        <div className="transcript">
          {conv === null || conv.messages.length === 0 ? (
            <p className="empty">Say something to the model. Each conversation is its own session on the host.</p>
          ) : (
            conv.messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="role">{m.role}</div>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <div className="plain">{m.content}</div>}
              </div>
            ))
          )}
          {busyHere && (
            <div className="msg assistant streaming">
              <div className="role">assistant</div>
              <div className="plain">{live!.text || <span className="cursor" />}</div>
            </div>
          )}
          {endedHere?.notice && <div className="notice">{endedHere.notice}</div>}
          {endedHere?.error && <div className="notice err">Error: {endedHere.error}</div>}
          {endedHere && endedHere.finish && (
            <div className="usage">
              finish: {endedHere.finish}
              {endedHere.usage && (
                <>
                  {' · '}
                  {endedHere.usage.prompt_tokens ?? '?'} prompt / {endedHere.usage.gen_tokens ?? '?'} generated
                  {' · '}prefill {endedHere.usage.prefill_ms ?? '?'} ms, decode {endedHere.usage.decode_ms ?? '?'} ms
                </>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {showDiag && conv && (
          <DiagPanel
            lines={live?.conv === conv.id ? live.diag : (endedHere?.diag ?? [])}
            enabled={conv.params.diag === true}
          />
        )}

        {showParams && conv && (
          <ParamsPanel params={conv.params} onChange={(p) => updateConv(conv.id, (c) => ({ ...c, params: p }))} />
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={
              !hostReady
                ? state === 'ready'
                  ? 'The host is still loading the model…'
                  : `Host: ${state}…`
                : busyElsewhere
                  ? 'Another conversation is generating; wait for it or stop it.'
                  : 'Message (Enter to send, Shift+Enter for a newline)'
            }
            disabled={!hostReady}
            rows={3}
          />
          <div className="composer-row">
            <button type="button" className="ghost" onClick={() => setShowParams((v) => !v)}>
              Sampling
            </button>
            <button type="button" className="ghost" onClick={() => setShowDiag((v) => !v)}>
              Diagnostics
            </button>
            <span className="spacer" />
            {busyHere ? (
              <button type="button" className="stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!hostReady || !draft.trim() || live !== null}>
                Send
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  )
}

function HealthBadge({ state, health }: { state: ClientState; health: Health | null }) {
  const label =
    state === 'ready'
      ? health
        ? health.state === 'ready'
          ? 'ready'
          : health.state
        : 'connected'
      : state
  const model = health?.model ? health.model.split('/').pop() : ''
  return (
    <div className={`health ${label}`}>
      <span className="pip" />
      <span className="health-text">
        {label}
        {model && (
          <span className="model" title={health?.model}>
            {model}
          </span>
        )}
      </span>
    </div>
  )
}

function ParamsPanel({ params, onChange }: { params: TurnParams; onChange: (p: TurnParams) => void }) {
  const num = (k: keyof TurnParams, v: string) => {
    const n = v === '' ? undefined : Number(v)
    onChange({ ...params, [k]: n !== undefined && Number.isNaN(n) ? undefined : n })
  }
  return (
    <div className="panel params">
      <label>
        temperature
        <input type="number" step="0.05" min="0" value={params.temp ?? ''} onChange={(e) => num('temp', e.target.value)} />
      </label>
      <label>
        max tokens
        <input type="number" step="1" min="1" value={params.n ?? ''} onChange={(e) => num('n', e.target.value)} />
      </label>
      <label>
        top-k
        <input type="number" step="1" min="0" value={params.top_k ?? ''} onChange={(e) => num('top_k', e.target.value)} />
      </label>
      <label>
        top-p
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          value={params.top_p ?? ''}
          onChange={(e) => num('top_p', e.target.value)}
        />
      </label>
      <label>
        repeat penalty
        <input
          type="number"
          step="0.01"
          min="0"
          value={params.repeat_penalty ?? ''}
          onChange={(e) => num('repeat_penalty', e.target.value)}
        />
      </label>
      <label>
        seed
        <input type="number" step="1" value={params.seed ?? ''} onChange={(e) => num('seed', e.target.value)} />
      </label>
      <label className="wide">
        stop strings (one per line)
        <textarea
          rows={2}
          value={(params.stop ?? []).join('\n')}
          onChange={(e) => onChange({ ...params, stop: e.target.value.split('\n').filter((s) => s.length > 0) })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={params.diag === true}
          onChange={(e) => onChange({ ...params, diag: e.target.checked ? true : undefined })}
        />
        ask the host for this conversation's diagnostics
      </label>
    </div>
  )
}

function DiagPanel({ lines, enabled }: { lines: DiagLine[]; enabled: boolean }) {
  return (
    <div className="panel diag">
      {!enabled ? (
        <p className="hint">Diagnostics are off for this conversation — turn them on under Sampling.</p>
      ) : lines.length === 0 ? (
        <p className="hint">No records yet. They arrive with the next turn.</p>
      ) : (
        <pre>{lines.map((l) => l.text).join('\n')}</pre>
      )}
    </div>
  )
}
