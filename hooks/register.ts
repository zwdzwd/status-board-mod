import type { Register, EngineInterface as Engine } from 'claude-code'

// Status Board mod. Keeps this chat's entry on the Status Board current: thinking at the start of a
// turn, working while a shell or remote command runs, waiting on you / idle (+ a job line) at the end.
// The board is an artifact with a document database; each project is a card in "projects", and a
// card lists its chats under "threads". An entry names its chat by "session" (the remote session id,
// cse_… / session_…, which the project's own tools use) and "transcript" (this process's session id).

const VERSION = '0.9.0'
const PLUGIN = 'status-board'
const BOARD = 'https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF'
const NOTE_ID = 'status-board:note'
const PLACEHOLDER = 'New thread'

type Thread = { label?: string; url?: string; session?: string; transcript?: string; status?: string; at?: string; job?: string; ended?: string }
type Card = { id: string; version: number; data: Record<string, unknown> }
type Found = { cardId: string; name: string; label: string }
type ToolResult = { deny?: unknown; isError?: boolean; text?: string; result?: unknown; missing?: boolean }
type ProjThread = { ids: string[]; name: string; open: boolean }

// Job values with a meaning of their own (see setStatus).
const KEEP = '__keep__'          // keep the entry's job, or start a generic one
const TOOL = '__tool__:'         // a command is running: show it as the job, remembering the old one
const RESTORE = '__restore__'    // the command ended: put the old job back

// ---- State of this session ----
let sessionId = ''                       // $.session.id(): the transcript's id; changes after /clear
let remoteId = ''                        // the remote session id (cse_…), when this is a remote session
let found: Found | null = null           // this chat's card and entry
let removed = false                      // the entry was taken off the card (the thread was resolved)
let lastWrite = ''                       // the last status written, for /board
let registeredHere = false               // the entry still has the placeholder label
let coordinator: { cardId: string; name: string } | null = null   // a project conversation, not a thread
let initDone = false                     // the lookup at start has finished
let initPromise: Promise<void> = Promise.resolve()
let initFailed = 0                       // lookups that failed on a board error (retried at the next turns)
let turnActive = false
let turnSeq = 0                          // bumps at every main-loop turn start
let pendingClear = false                 // a /clear ended the conversation; the thread goes on under a new id
let busy: Promise<void> = Promise.resolve()   // board writes run one at a time, in order
// Tools available to the mod
let noBoard = false                      // this session has no ArtifactData tool
let loadedTool = false                   // ToolSearch was tried for ArtifactData
let listTool: string | null = null       // the thread-listing tool, '' once probed and absent
let probed: ToolResult | null = null     // the probe's listing, reused by the first sync
let projectTools = false                 // the session can start the project's threads: a project conversation
// Problems to tell the user about, once each
let lastError = ''                       // the last unexpected board failure, cleared by a success
let report = ''                          // what the user should hear about, if anything
let reportedText = ''                    // what the model was already told to say
let composedReport = ''                  // what the note asked for during this turn

// ---- Small helpers ----
// Ids are stored as "session_…", "cse_…" or a bare UUID. Equal after normalising, or one ends with
// the other when both are long enough to be ids rather than words.
function norm(s: unknown): string { return String(s ?? '').trim().replace(/^cse_/, 'session_') }
function same(a: unknown, b: unknown): boolean {
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  return Math.min(x.length, y.length) >= 20 && (x.endsWith(y) || y.endsWith(x))
}
const myIds = () => [sessionId, remoteId].filter(Boolean)
const isMine = (t: Thread, ids: string[]) => !!t && ids.some(id => same(t.transcript, id) || same(t.session, id))
const mine = (t: Thread) => isMine(t, myIds())
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const threadsOf = (c: Card): Thread[] => Array.isArray(c.data.threads) ? (c.data.threads as Thread[]) : []
const nameOf = (c: Card) => String(c.data.name ?? c.id)
const now = () => new Date().toISOString()
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ArtifactData prints each document as one JSON line between BEGIN/END markers.
function parseDocs(text: string): Card[] {
  const out: Card[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { const d = JSON.parse(t); if (d && typeof d.id === 'string' && d.data && typeof d.version === 'number') out.push(d) } catch {}
  }
  return out
}

// A promise with a time limit. The timer is cancelled as soon as the promise settles, since a
// pending $.clock wait counts against the hook's budget.
class Timeout extends Error {}
async function limit<T>($: Engine, p: Promise<T>, ms: number, what: string): Promise<T> {
  const ac = new AbortController()
  try {
    return await Promise.race([p, $.clock.sleep(ms, { signal: ac.signal }).then((): never => { throw new Timeout(`${what} timed out`) })])
  } finally { ac.abort() }
}

// ---- Board access ----
// $.tool.call rejects when no tool has the name (or the call is aborted); a tool's own failure
// resolves with isError. Only the first means the session lacks ArtifactData.
async function boardCall($: Engine, args: Record<string, unknown>, ms: number): Promise<ToolResult> {
  try { return await limit($, $.tool.call({ tool: 'ArtifactData', url: BOARD, ...args } as any) as Promise<ToolResult>, ms, 'board call') }
  catch (err) { return { isError: true, text: msg(err), missing: !(err instanceof Timeout) && !/abort/i.test(msg(err)) } }
}

async function call($: Engine, args: Record<string, unknown>, ms = 15000): Promise<string> {
  if (noBoard) throw new Error('no ArtifactData tool in this session')
  let r = await boardCall($, args, ms)
  if (r.missing && !loadedTool) {
    // A session may hold ArtifactData as a deferred tool: load it once and try again.
    loadedTool = true
    try { await limit($, $.tool.call({ tool: 'ToolSearch', query: 'select:ArtifactData', max_results: 1 } as any), 10000, 'tool search') } catch {}
    r = await boardCall($, args, ms)
  }
  if (r.missing) { noBoard = true; throw new Error('no ArtifactData tool in this session') }
  if (r.isError || r.deny !== undefined) {
    const text = String(r.deny ?? r.text ?? 'ArtifactData failed')
    if (!/^No document /i.test(text)) lastError = `${String(args.action)} ${String(args.collection ?? '')}: ${text.slice(0, 160)}`
    throw new Error(text)
  }
  lastError = ''
  return String(r.text ?? '')
}
const isConflict = (err: unknown) => /version/i.test(msg(err))

// Board writes go through one queue, so they land in the order they were asked for.
function enqueue($: Engine, what: string, fn: () => Promise<void>): Promise<void> {
  const run = busy.then(fn).catch((err: unknown) => { $.ui.status(`board: ${what} failed (${msg(err).slice(0, 60)})`) })
  busy = run
  return run
}

// The whole board. A long listing comes back as a saved file rather than text; read that file then.
async function cards($: Engine): Promise<Card[]> {
  const text = await call($, { action: 'list', collection: 'projects', query: { limit: 1000 } })
  let docs = parseDocs(text)
  const file = docs.length ? undefined : /(\/[^\s"']+\.(?:txt|json|md))/.exec(text)?.[1]
  if (file) { try { docs = parseDocs(await $.fs.read(file)) } catch {} }
  return docs
}
// One document, or null when there is none (whether ArtifactData reports that as an error or not).
async function getDoc($: Engine, collection: string, id: string): Promise<Card | null> {
  try { return parseDocs(await call($, { action: 'get', collection, doc_id: id }))[0] ?? null }
  catch (err) { if (/^No document /i.test(msg(err))) return null; throw err }
}
const getCard = ($: Engine, id: string) => getDoc($, 'projects', id)

// Which card and entry this session is.
function findIn(docs: Card[], ids = myIds()): Found | null {
  for (const d of docs) {
    const t = threadsOf(d).find(t => isMine(t, ids))
    if (t) return { cardId: d.id, name: nameOf(d), label: String(t.label ?? 'Thread') }
  }
  return null
}

// The index, sessions/<session id> -> { card }, so a session finds its card with two small reads.
async function indexLookup($: Engine): Promise<Found | null> {
  const d = await getDoc($, 'sessions', sessionId)
  if (!d || typeof d.data.card !== 'string' || !d.data.card || d.data.role === 'coordinator') return null
  const card = await getCard($, d.data.card)
  return card ? findIn([card]) : null
}
async function indexWrite($: Engine, f: Found): Promise<void> {
  try {
    const d = await getDoc($, 'sessions', sessionId)
    const args: Record<string, unknown> = { action: 'set', collection: 'sessions', doc_id: sessionId, data: { card: f.cardId, label: f.label, version: VERSION, at: now() } }
    if (d) args.if_version = d.version
    await call($, args)
  } catch {}
}

// The card of this session's project, for a chat not on the board yet: the card whose repo field is
// this repository's owner/name, else the card named like the repository or a specific folder.
const GENERIC = new Set(['home', 'users', 'user', 'root', 'claude', 'app', 'apps', 'src', 'repo', 'repos', 'code', 'work', 'workspace', 'projects', 'tmp', 'mnt', 'outputs', 'documents', 'desktop'])
async function guessCard($: Engine, docs: Card[]): Promise<Card | null> {
  const names: string[] = []
  let remote = ''
  try {
    const repo = await $.session.repo()
    if (repo) {
      if (repo.remote) { remote = repo.remote.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase(); names.push(remote.split(/[/:]/).pop() || '') }
      if (repo.name) names.push(repo.name.split('/').pop() || '')
      names.push(repo.root.split('/').pop() || '')
    }
  } catch {}
  try { names.push((await $.session.root()).split('/').pop() || '') } catch {}
  try { names.push((await $.session.cwd()).split('/').pop() || '') } catch {}
  if (remote) {
    const ownerName = remote.split(/[/:]/).slice(-2).join('/')
    for (const d of docs) {
      const r = typeof d.data.repo === 'string' ? d.data.repo.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '') : ''
      if (r.includes('/') && (r === ownerName || remote.endsWith('/' + r) || remote.endsWith(':' + r))) return d
    }
  }
  for (const n of names.map(slug).filter(n => n.length >= 3 && !GENERIC.has(n))) {
    const d = docs.find(d => slug(d.id) === n || slug(String(d.data.name ?? '')) === n)
    if (d) return d
  }
  return null
}

// Add this session as a thread of a card. The label and url are unknown to the mod; the thread's
// own Claude fills them in (the note asks for that until it is done).
async function registerThread($: Engine, card: Card): Promise<Found | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await getCard($, card.id)
    if (!fresh) return null
    const existing = findIn([fresh]); if (existing) return existing
    const entry: Thread = { label: PLACEHOLDER, transcript: sessionId, status: turnActive ? 'thinking' : 'idle', at: now(), job: '' }
    if (remoteId) entry.session = remoteId
    try {
      await call($, { action: 'update', collection: 'projects', doc_id: card.id, if_version: fresh.version, data: { threads: threadsOf(fresh).concat([entry]) } })
      return { cardId: fresh.id, name: nameOf(fresh), label: PLACEHOLDER }
    } catch (err) { if (!isConflict(err)) throw err }
  }
  return null
}

// ---- Writing this chat's status ----
// Writes this chat's entry and nothing else, re-reading the card first and pinning the write to its
// version, so other chats' entries are kept. The entry and ids are taken when the write is asked
// for, not when it runs, so a /clear in between cannot point it at the wrong entry.
// status: "" keeps the entry's status. job: undefined leaves the job alone, "" clears it, KEEP keeps
// it (or starts a generic one), TOOL+text shows a running command, RESTORE puts the old job back.
// ended: true stamps the entry as ended, false clears the stamp.
let prevJob: string | undefined          // the job a running command replaced
let toolJob = ''                         // the text shown for that command
function setStatus($: Engine, status: string, job?: string, ended?: boolean): Promise<void> {
  const f = found, ids = myIds(), transcript = sessionId, remote = remoteId
  if (!f) return Promise.resolve()
  return enqueue($, 'status write', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = await getCard($, f.cardId)
      if (!card) return
      if (!threadsOf(card).some(t => isMine(t, ids))) {
        // The entry is gone (the thread was resolved, or removed by hand): stop writing.
        if (found === f) { found = null; removed = true; registeredHere = false }
        $.ui.status('board: this chat is no longer on its card')
        return
      }
      const at = now()
      const th = threadsOf(card).map(t => {
        if (!isMine(t, ids)) return t
        const n: Thread = { ...t }
        if (status) { n.status = status; n.at = at }
        if (!n.transcript) n.transcript = transcript               // fill in what the entry lacks
        if (!n.session && remote) n.session = remote
        if (job === KEEP) n.job = (typeof t.job === 'string' && t.job.trim() && t.job !== toolJob) ? t.job : (prevJob || `background work since ${at.slice(11, 16)} UTC`)
        else if (job !== undefined && job.startsWith(TOOL)) { if (prevJob === undefined) prevJob = typeof t.job === 'string' ? t.job : ''; toolJob = job.slice(TOOL.length); n.job = toolJob }
        else if (job === RESTORE) { n.job = prevJob !== undefined ? prevJob : (t.job === toolJob ? '' : (t.job ?? '')) }
        else if (job !== undefined) n.job = job
        if (ended === true) n.ended = at
        if (ended === false) delete n.ended
        return n
      })
      try {
        await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th } })
        if (job !== undefined && !job.startsWith(TOOL)) { prevJob = undefined; toolJob = '' }
        if (status) lastWrite = status
        $.ui.status(`board: ${f.name} / ${f.label}${status ? ' → ' + status.replace(/_/g, ' ') : ''}${ended ? ' (ended)' : ''}`)
        return
      } catch (err) { if (!isConflict(err)) throw err }   // someone else wrote the card: read again, once
    }
    $.ui.status('board: status not written (the card kept changing)')
  })
}

// After a /clear the same thread goes on under a new transcript id: point the entry at it.
function moveEntry($: Engine, fromIds: string[], to: string): Promise<void> {
  const f = found
  if (!f) return Promise.resolve()
  return enqueue($, 'entry move', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const card = await getCard($, f.cardId)
      if (!card || !threadsOf(card).some(t => isMine(t, fromIds))) return
      const th = threadsOf(card).map(t => {
        if (!isMine(t, fromIds)) return t
        const n: Thread = { ...t, transcript: to }
        delete n.ended
        return n
      })
      try { await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th } }); return }
      catch (err) { if (!isConflict(err)) throw err }
    }
    $.ui.status('board: entry not moved after /clear (the card kept changing)')
  })
}

// ---- Project conversations (coordinators) ----
// The project conversation is the session that can start the project's threads. Its thread-listing
// tool is found by name, or by trying the name under the project tools' prefix. In practice project
// conversations have no ArtifactData, so the sync below only runs where both tools exist.
async function listToolName($: Engine): Promise<string> {
  if (listTool !== null) return listTool
  let names: string[] = []
  try { names = (await $.tool.list()).map(t => t.name) } catch {}
  projectTools = names.some(x => /(^|__)(list_thread_sessions|start_thread_session|start_rc_session|list_thread_connectors)$/.test(x))
  let n = names.find(x => /(^|__)list_thread_sessions$/.test(x)) || ''
  if (!n && projectTools) {
    const prefixes = [...new Set(names.filter(x => /__(list|start)_(thread|rc)/.test(x)).map(x => x.slice(0, x.lastIndexOf('__') + 2)))]
    for (const cand of prefixes.map(p => p + 'list_thread_sessions')) {
      try {
        const r = await limit($, $.tool.call({ tool: cand } as any) as Promise<ToolResult>, 15000, 'thread listing')
        if (r && r.deny === undefined && !r.isError) { n = cand; probed = r; break }
      } catch {}
    }
  }
  listTool = n
  return n
}

// The project's threads, from the listing's own array of thread records (e.g. {"sessions":[…]}).
const CLOSED = /\b(resolved|archived|closed|deleted)\b/i
function threadRecord(v: unknown): ProjThread | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const ids = ['thread_id', 'threadId', 'session_id', 'sessionId', 'id'].map(k => o[k])
    .filter((x): x is string => typeof x === 'string' && /^(cmsg|cse|session)_/.test(x))
  const name = ['title', 'name', 'label', 'thread_name'].map(k => o[k]).find((x): x is string => typeof x === 'string' && !!x.trim())
  if (!ids.length || !name) return null
  const st = ['status', 'state', 'thread_status', 'session_status', 'resolution'].map(k => o[k]).find((x): x is string => typeof x === 'string')
  const flag = ['resolved', 'is_resolved', 'archived', 'is_archived', 'closed'].some(k => o[k] === true)
  return { ids, name: name.trim(), open: !flag && !CLOSED.test(st || '') }
}
function threadRecords(v: unknown, depth = 0): ProjThread[] | null {
  if (v == null || depth > 8) return null
  if (typeof v === 'string') { const s = v.trim(); if (!/^[[{]/.test(s)) return null; try { return threadRecords(JSON.parse(s), depth + 1) } catch { return null } }
  if (Array.isArray(v)) {
    const recs = v.map(threadRecord)
    if (v.length && recs.every(Boolean)) return recs as ProjThread[]
    for (const x of v) { const r = threadRecords(x, depth + 1); if (r) return r }
    return null
  }
  if (typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) { const r = threadRecords(x, depth + 1); if (r) return r } }
  return null
}
async function projectThreads($: Engine): Promise<ProjThread[] | null> {
  const name = await listToolName($)
  if (!name) return null
  let r: ToolResult
  if (probed) { r = probed; probed = null }
  else { try { r = await limit($, $.tool.call({ tool: name } as any) as Promise<ToolResult>, 20000, 'thread listing') } catch { return null } }
  if (r.deny !== undefined || r.isError) return null
  return threadRecords(r.result) || threadRecords(r.text)
}

const threadIdOf = (t: Thread) => /[?&]thread=([A-Za-z0-9_]+)/.exec(String(t.url || ''))?.[1] ?? ''
const matchesThread = (p: ProjThread, t: Thread) => p.ids.some(i => same(i, threadIdOf(t)) || same(i, t.session))

async function detectCoordinator($: Engine): Promise<void> {
  await listToolName($)
  if (!listTool && !projectTools) return
  coordinator = { cardId: '', name: '' }
  const list = await projectThreads($)
  let all: Card[] = []
  try { all = await cards($) } catch {}
  let c: Card | null | undefined = list ? all.find(c => threadsOf(c).some(t => t && list.some(p => matchesThread(p, t)))) : undefined
  if (!c && all.length) { try { c = await guessCard($, all) } catch {} }
  if (!c && !noBoard) {
    try { const d = await getDoc($, 'sessions', sessionId); if (d && typeof d.data.card === 'string' && d.data.card) c = await getCard($, d.data.card) } catch {}
  }
  if (c) coordinator = { cardId: c.id, name: nameOf(c) }
  if (noBoard) return
  try {
    const d = await getDoc($, 'sessions', sessionId)
    const args: Record<string, unknown> = { action: 'set', collection: 'sessions', doc_id: sessionId, data: { card: coordinator.cardId, role: 'coordinator', version: VERSION, at: now() } }
    if (d) args.if_version = d.version
    await call($, args)
  } catch {}
}

// Make the card's thread list match the project's open threads. Entries the listing does not know
// are removed, except one a thread added in the last 15 minutes that the listing may not show yet;
// a listing with no open thread changes nothing.
async function syncThreadList($: Engine, cardId: string): Promise<string> {
  const list = await projectThreads($)
  if (!list) return 'thread list not readable'
  if (!list.some(p => p.open)) return 'no open threads listed; card left as is'
  for (let attempt = 0; attempt < 2; attempt++) {
    const card = await getCard($, cardId)
    if (!card) return 'card not found'
    const before = threadsOf(card)
    const used = new Set<ProjThread>()
    const kept: Thread[] = []
    for (const t of before) {
      if (!t) continue
      const m = list.find(p => matchesThread(p, t)) || list.find(p => p.name.toLowerCase() === String(t.label || '').toLowerCase())
      const fresh = !m && !!t.at && Date.now() - Date.parse(t.at) < 15 * 60000 && (t.label === PLACEHOLDER || !t.url)
      if (fresh) { kept.push(t); continue }
      if (!m || !m.open || used.has(m)) continue
      used.add(m)
      kept.push(m.name !== t.label ? { ...t, label: m.name } : t)
    }
    const base = (before.map(t => String((t && t.url) || '')).find(u => /\?thread=/.test(u)) || '').split('?')[0]
    for (const p of list) {
      if (!p.open || used.has(p)) continue
      const tid = p.ids.find(i => /^cmsg_/.test(i)) || ''
      const add: Thread = { label: p.name }
      if (base && tid) add.url = `${base}?thread=${tid}`
      const sid = p.ids.find(i => /^(cse|session)_/.test(i)); if (sid) add.session = sid
      kept.push(add)
    }
    if (JSON.stringify(kept) === JSON.stringify(before)) return 'in sync'
    try {
      await call($, { action: 'update', collection: 'projects', doc_id: cardId, if_version: card.version, data: { threads: kept } })
      return `synced: ${kept.length} open thread${kept.length === 1 ? '' : 's'}`
    } catch (err) { if (!isConflict(err)) throw err }
  }
  return 'card kept changing; next turn'
}

// ---- Startup ----
// Runs in the background: it must never hold up the session.
async function init($: Engine): Promise<void> {
  try {
    await detectCoordinator($)
    if (coordinator) {
      if (noBoard) { $.ui.status('board: project conversation without ArtifactData; nothing to do'); return }
      if (!coordinator.cardId) { report = 'the Status Board mod could not find this project\'s card'; $.ui.status('board: project conversation, card not matched'); return }
      $.ui.status(`board: coordinator of ${coordinator.name}: ${await syncThreadList($, coordinator.cardId)}`)
      return
    }
    let viaIndex = true
    found = await indexLookup($)
    if (!found && !noBoard) {
      viaIndex = false
      const docs = await cards($)
      found = findIn(docs)
      // Only a remote session (a project's thread) registers itself; a local or one-shot run does not.
      if (!found && remoteId) { const c = await guessCard($, docs); if (c) found = await registerThread($, c) }
    }
    if (found) {
      registeredHere = found.label === PLACEHOLDER
      if (!viaIndex) void indexWrite($, found)
      void setStatus($, turnActive ? 'thinking' : 'idle', undefined, false)
      $.ui.status(`board: ${found.name} / ${found.label}`)
    } else if (noBoard) {
      report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
      $.ui.status('board: no ArtifactData tool in this session')
    } else {
      if (remoteId) report = `the Status Board mod could not match this chat to a project card (${lastError ? 'board call failed: ' + lastError : 'no card\'s repo or name matches this repository or folder'})`
      $.ui.status('board: no card matched this chat')
    }
  } catch (err) {
    if (noBoard) report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
    else { initFailed++; if (initFailed >= 3) report = `the Status Board mod could not read the board (${msg(err).slice(0, 120)})` }
    $.ui.status(`board: could not read the board (${msg(err).slice(0, 60)})`)
  } finally {
    initDone = true
  }
}
function startInit($: Engine): void { initDone = false; initPromise = init($) }

function reset(): void {
  found = null; removed = false; lastWrite = ''; registeredHere = false; coordinator = null
  report = ''; reportedText = ''; composedReport = ''; lastError = ''; initFailed = 0
  prevJob = undefined; toolJob = ''
}

// After a /clear or a resume the process goes on under another session id, with no session.start.
async function refreshSession($: Engine): Promise<void> {
  let id = ''
  try { id = await $.session.id() } catch {}
  if (!id || id === sessionId) { pendingClear = false; return }
  const oldIds = myIds()
  sessionId = id
  try { remoteId = (await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')) || '' } catch {}
  const wasClear = pendingClear
  pendingClear = false
  if (wasClear && found) {
    const f = found
    void moveEntry($, oldIds, id).then(() => { if (found === f) void indexWrite($, f) })
    return
  }
  reset()
  startInit($)
}

// ---- What the model is told ----
// A problem is told to the user once: the note asks for it until an answered turn has carried it.
function tell(count: boolean): string {
  if (!report || report === reportedText) return ''
  if (count) composedReport = report
  return ` Tell the user in one line of your reply: ${report}.`
}
function boardNote(count: boolean): string {
  const v = `Status Board mod v${VERSION}`
  if (!initDone) return `${v}: looking up this chat on the Status Board. Nothing is needed from you for it.`
  if (noBoard && coordinator) return `${v}: this project conversation has no ArtifactData tool, so the mod writes nothing to the Status Board from here; that is expected and needs no mention. Keep the card's thread list in step with the project's threads as the board's rules say.`
  if (noBoard) return `${v}: this chat has no ArtifactData tool, so the mod cannot show its status on the Status Board.${tell(count)}`
  if (coordinator && !coordinator.cardId) return `${v}: this is a project conversation, but no card on the Status Board matches this project.${tell(count)} Find or create the project's card by the board's rules (meta/instruction, field rules), then write sessions/${sessionId} = {card: <card id>, role: "coordinator"} (pin it to the record's version). Add no thread entry for yourself.`
  if (coordinator) return `${v}: this is the project conversation for the ${coordinator.name} card (id ${coordinator.cardId}). At the end of each turn the mod tries to make the card's thread list match the project's open threads; if the list still looks wrong, fix it by the board's rules. Add no entry for yourself.`
  if (found && registeredHere) return `${v}: this chat's entry on the ${found.name} card (id ${found.cardId}; transcript ${sessionId}${remoteId ? ', session ' + remoteId : ''}) still has the placeholder label "${PLACEHOLDER}". Before other work, read the board's rules (meta/instruction, field rules) and fix that entry: label = this thread's name (a 1–3 word name for its work if you do not know it), url = this thread's link if you know it; keep transcript and session as they are and touch nothing else. The mod writes this chat's status by itself.`
  if (found) return `${v}: this chat is thread "${found.label}" on the ${found.name} card (id ${found.cardId}). The mod writes its status (thinking / working / waiting_on_you / idle) and job line by itself; if you update the card, keep this entry's transcript (${sessionId})${remoteId ? ' and session (' + remoteId + ')' : ''} as they are.`
  if (removed) return `${v}: this chat's entry was taken off its card on the Status Board (usually because the thread was resolved). Leave the board alone.`
  const told = tell(count)
  if (!remoteId || (!told && reportedText)) return `${v}: this chat is not on the Status Board.${told}`
  return `${v}: this chat is not on the Status Board.${told} If this chat is work on one of the user's projects: read the board's rules (meta/instruction, field rules), find or create the project's card, add this thread's entry with transcript ${sessionId} and session ${remoteId} (plus label and url), write sessions/${sessionId} = {card, label}, and set the card's repo field to this repository's owner/name so later threads register by themselves; the mod then writes this chat's status. If it is not project work, leave the board alone.`
}
function describe(): string {
  if (!initDone) return 'Status Board: still looking up this chat.'
  if (noBoard) return 'Status Board: this session has no ArtifactData tool; the mod writes nothing from here.'
  if (coordinator) return coordinator.cardId ? `Status Board: project conversation for the ${coordinator.name} card.` : 'Status Board: project conversation; no card matched.'
  if (found) return `Status Board: this chat is "${found.label}" on the ${found.name} card.${lastWrite ? ` Last status written: ${lastWrite.replace(/_/g, ' ')}.` : ''}`
  if (removed) return 'Status Board: this chat\'s entry was taken off its card.'
  return `Status Board: this chat is not on the board (transcript ${sessionId}${remoteId ? ', session ' + remoteId : ''}).${report ? ' ' + report + '.' : ''}`
}

// What a turn's final message means for the board: a question or a decision for the user; work still
// running elsewhere (a remote session, a SLURM job, a build), shown as "working"; or done.
const ASK = 'the message asks the user a question, or waits for the user to decide, approve, confirm or provide something'
const RUN = 'the message says work is still running and will report later: a job, a remote or background session, a build, a process the assistant is waiting on'
const DONE = 'the message reports finished work or information; nothing is still running and nothing is asked of the user'
async function decide($: Engine, answer: string): Promise<{ status: string; job?: string }> {
  if (!answer.trim()) return { status: 'idle' }
  let k: string | undefined
  try { k = await $.model.classify(`The assistant's final message of a turn:\n\n${answer.slice(-3000)}`, [ASK, RUN, DONE]) } catch {}
  if (k === ASK) return { status: 'waiting_on_you' }
  if (k === RUN) return { status: 'idle', job: KEEP }
  if (k === DONE) return { status: 'idle', job: '' }
  const last = answer.trim().split('\n').pop() || ''
  return { status: /\?\s*$/.test(last) ? 'waiting_on_you' : 'idle' }   // no label: leave the job alone
}

// A command shown on the shared board: the program and up to two plain arguments after it, stopping
// at the first option, so passwords, tokens and headers never reach the board.
function jobText(tool: string, command: unknown): string {
  const words = typeof command === 'string' ? command.trim().split(/\s+/) : []
  const shown: string[] = []
  for (const w of words.slice(0, 3)) {
    if (shown.length && (/^-/.test(w) || /[=:@]/.test(w) || w.length > 40 || /[A-Za-z0-9+/_-]{24,}/.test(w))) break
    shown.push(w.length > 40 ? w.slice(0, 40) + '…' : w)
  }
  return (tool.replace(/^mcp__/, '') + (shown.length ? ': ' + shown.join(' ') : '')).slice(0, 60)
}

export const register: Register = on => {
  // The mod's own calls need no permission dialog: its reads and writes of this board, the thread
  // listing, and loading ArtifactData. Anything else it might call goes through the normal check.
  on('tool.check', ($, e, next) => {
    const base = (n: unknown) => String(n || '').split('@')[0]?.split('/').pop() ?? ''
    const o = base(next.origin && next.origin.plugin)
    if (!o || (o !== base($.plugin.name) && o !== PLUGIN)) return next(e)
    const input = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>
    const ok = (e.tool === 'ArtifactData' && input.url === BOARD)
      || /(^|__)list_thread_sessions$/.test(e.tool)
      || (e.tool === 'ToolSearch' && input.query === 'select:ArtifactData')
    return ok ? { decision: 'allow' as const } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'board', description: 'Show which Status Board card and thread this chat updates' }) } catch {}
    try { sessionId = await $.session.id() } catch {}
    try { remoteId = (await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')) || '' } catch {}
    if (sessionId) startInit($)
    else initDone = true
    return next(e)
  })

  // The session ends: stamp the entry as ended, keeping its status (the board shows the end in the
  // button's tooltip). A /clear is no end for the thread, which goes on under a new id.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') { pendingClear = true; return next(e) }
    if (found) {
      const left = next.budget.remainingMs
      const ms = Math.min(Number.isFinite(left) ? left : 8000, 8000) - 300
      if (ms > 500) { try { await limit($, setStatus($, '', undefined, true), ms, 'end stamp') } catch {} }
    }
    return next(e)
  })

  // One section at the end of the system prompt, telling the model what the mod did and needs.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const traits = e.traits || []
    if (!sessionId || traits.includes('teammate') || traits.includes('print')) return r
    const text = boardNote(!traits.includes('analysis'))
    return { sections: [...r.sections.filter(s => s.id !== NOTE_ID), { id: NOTE_ID, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async () => ({ text: describe() }))

  // While a command runs on a machine for more than a few seconds (a shell, a remote computer, a
  // browser), the chat is waiting on that machine, not thinking: show it as working.
  let toolDepth = 0, toolTimer: { cancel: () => void } | null = null, toolShown = false
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool || '')
    if (e.agentId !== undefined || !found || !/bash|shell|device|computer|remote|browser|ssh|slurm/i.test(name)) return next(e)
    toolDepth++
    if (toolDepth === 1) {
      toolShown = false
      const text = jobText(name, (e as any).command)
      const seq = turnSeq
      toolTimer = $.clock.after(5000, () => { if (seq === turnSeq && turnActive) { toolShown = true; void setStatus($, 'working', TOOL + text) } })
    }
    try { return await next(e) }
    finally {
      toolDepth = Math.max(0, toolDepth - 1)
      if (toolDepth === 0) {
        if (toolTimer) { toolTimer.cancel(); toolTimer = null }
        if (toolShown && turnActive) { toolShown = false; void setStatus($, 'thinking', RESTORE) }
      }
    }
  })

  // Main-loop turns only.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnSeq++
      turnActive = true
      toolDepth = 0
      await refreshSession($)
      if (initDone && initFailed > 0 && initFailed < 3 && !found && !coordinator) startInit($)   // the board failed at start: try again
      if (found && initDone) void setStatus($, 'thinking')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    turnActive = false
    if (toolTimer) { toolTimer.cancel(); toolTimer = null }
    const hadTool = toolShown; toolShown = false
    const reason = e.reason
    if (composedReport && reason === 'answer') reportedText = composedReport
    composedReport = ''
    if (!sessionId) return out
    const seq = turnSeq
    const answer = String(e.answer || '')
    // The rest runs in the background so the turn ends at once; a newer turn's status wins.
    void (async () => {
      try {
        await initPromise                     // a first turn can end before the lookup has
        if (noBoard || seq !== turnSeq) return
        if (coordinator) {
          if (coordinator.cardId) $.ui.status(`board: coordinator of ${coordinator.name}: ${await syncThreadList($, coordinator.cardId)}`)
          return
        }
        if (!found && !removed) found = await indexLookup($)          // the model may have registered this chat
        else if (found && registeredHere) {                          // the model may have fixed the label
          const card = await getCard($, found.cardId)
          const f = card ? findIn([card]) : null
          if (f) { found = f; registeredHere = f.label === PLACEHOLDER }
        }
        if (!found || seq !== turnSeq) return
        const d = reason === 'answer' ? await decide($, answer) : { status: 'idle', job: undefined as string | undefined }
        if (seq !== turnSeq) return
        await setStatus($, d.status, d.job === undefined && hadTool ? RESTORE : d.job)
      } catch (err) { $.ui.status(`board: end of turn failed (${msg(err).slice(0, 60)})`) }
    })()
    return out
  })
}
