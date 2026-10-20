import type { Register, EngineInterface as Engine } from 'claude-code'

// The Status Board artifact. Each project has a card in its "projects" collection; each card lists
// its chats under "threads", and a thread entry carries the chat's Claude Code session id.
const BOARD = 'https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF'

type Thread = { label?: string; url?: string; session?: string; status?: string; at?: string }
type Card = { id: string; version: number; data: Record<string, unknown> }
type Found = { cardId: string; name: string; label: string }

let sessionId = ''
let found: Found | null = null
let lastWrite = ''
let busy: Promise<void> = Promise.resolve()

// Session ids are stored as "session_…", "cse_…" or a bare UUID; compare loosely, against any
// string field of the thread entry (session, or a transcript id a thread chose to store).
function norm(s: unknown): string { return String(s ?? '').trim().replace(/^cse_/, 'session_') }
function same(a: unknown, b: unknown): boolean {
  const x = norm(a), y = norm(b)
  return x !== '' && y !== '' && (x === y || x.endsWith(y) || y.endsWith(x))
}

function mine(t: Thread): boolean {
  return Object.values(t).some(v => typeof v === 'string' && !/^https?:/.test(v) && same(v, sessionId))
}

// ArtifactData prints each document as one JSON line between BEGIN/END markers.
function parseDocs(text: string): Card[] {
  const out: Card[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { const d = JSON.parse(t); if (d && typeof d.id === 'string' && d.data) out.push(d) } catch {}
  }
  return out
}

async function call($: Engine, args: Record<string, unknown>): Promise<string> {
  const r = await $.tool.call({ tool: 'ArtifactData', url: BOARD, ...args } as any)
  if (r.deny !== undefined) throw new Error(r.deny)
  if (r.isError) throw new Error(String(r.text ?? 'ArtifactData failed'))
  return String(r.text ?? '')
}

// Which card and thread this session is: the thread entry whose session id is ours.
async function locate($: Engine): Promise<Found | null> {
  const docs = parseDocs(await call($, { action: 'list', collection: 'projects', query: { limit: 200 } }))
  for (const d of docs) {
    const th = Array.isArray(d.data.threads) ? (d.data.threads as Thread[]) : []
    const t = th.find(t => t && mine(t))
    if (t) return { cardId: d.id, name: String(d.data.name ?? d.id), label: String(t.label ?? 'Thread') }
  }
  return null
}

// Write this thread's status, touching nothing else on the card. Re-reads first so other
// threads' entries are kept and the write is pinned to the current version.
function setStatus($: Engine, status: string): Promise<void> {
  const job = busy.then(async () => {
    if (!found) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: found.cardId }))[0]
      if (!card) return
      const now = new Date().toISOString()
      const th = (Array.isArray(card.data.threads) ? (card.data.threads as Thread[]) : [])
        .map(t => (t && mine(t)) ? { ...t, status, at: now } : t)
      try {
        await call($, { action: 'update', collection: 'projects', doc_id: found.cardId, if_version: card.version, data: { threads: th } })
        lastWrite = status
        $.ui.status(`board: ${found.name} / ${found.label} → ${status.replace(/_/g, ' ')}`)
        return
      } catch (err) {
        if (!/version/i.test(String(err))) throw err   // a concurrent write: read again and retry once
      }
    }
  }).catch((err: unknown) => { $.ui.status(`board: write failed (${String(err).slice(0, 60)})`) })
  busy = job
  return job
}

function describe(): string {
  return found
    ? `This chat is "${found.label}" on the ${found.name} card.${lastWrite ? ` Last status written: ${lastWrite.replace(/_/g, ' ')}.` : ''}`
    : `This chat is not on the Status Board yet (no card lists session ${sessionId}). Say "update the board" once so the project registers it, then run /board again.`
}

async function decide($: Engine, answer: string): Promise<string> {
  try {
    const k = await $.model.classify(
      `The assistant's final message of a turn:\n\n${answer.slice(-3000)}`,
      ['the message asks the user a question, or waits for the user to decide, approve, confirm or provide something',
       'the message reports finished work or information and asks nothing of the user'])
    return k && k.startsWith('the message asks') ? 'waiting_on_you' : 'idle'
  } catch {
    return /\?\s*$/m.test(answer) ? 'waiting_on_you' : 'idle'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Show which Status Board card and thread this chat updates' })
    try {
      sessionId = await $.session.id()
      found = await locate($)
      $.ui.status(found ? `board: ${found.name} / ${found.label}` : 'board: thread not registered (say "update the board" once)')
    } catch (err) {
      $.ui.status(`board: could not read the board (${String(err).slice(0, 60)})`)
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e, next) => {
    if (!found) { try { found = await locate($) } catch {} }
    return { text: describe() }
  })

  // Main-loop turns only: thinking at the start; waiting on you / idle at the end. The thread's "job" field
  // (a machine job it started) is left alone: the board shows an idle thread with a job as working.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && found) void setStatus($, 'thinking')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || !found) return out
    const status = e.isAborted ? 'idle' : await decide($, e.answer || '')
    void setStatus($, status)
    return out
  })
}
