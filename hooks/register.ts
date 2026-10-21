import type { Register, EngineInterface as Engine } from 'claude-code'

// Status Board mod. Keeps this chat's entry on the Status Board current: thinking at the start of a
// turn, working while a shell or remote command runs, waiting on you / idle (+ a job line) at the end.
// The board is an artifact with a document database; each project is a card in "projects", and a
// card lists its chats under "threads". An entry names its chat by "session" (the remote session id,
// cse_… / session_…, which the project's own tools use) and "transcript" (this process's session id).

const VERSION = '0.9.16'
const PLUGIN = 'status-board'
// The board's address comes from the user's board-skill skill (see findBoard), so a new
// board needs only the skill changed. This one is used where no such skill is on disk.
const FALLBACK = 'https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T'
let BOARD = FALLBACK
let boardFrom = 'built in'
const NOTE_ID = 'status-board:note'
// /board-status is handled in the chat where it is typed; a project conversation must not start a thread for it.
const IN_PLACE = ' When the user sends /board-status, answer it in this chat and update this project\'s card yourself by the board\'s rules; never start a thread for it.'
const PLACEHOLDER = 'New thread'
// The project's thread listing, under either name; threads have one too.
const LIST = /(^|__)(list_threads|list_thread_sessions)$/
// Tools only a project conversation has: those that start threads.
const PROJECT = /(^|__)(start_thread|start_thread_session|start_rc_session|list_thread_connectors)$/

type Thread = { label?: string; url?: string; session?: string; transcript?: string; status?: string; at?: string; job?: string; waiting?: string; ended?: string }
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
let lastWrite = ''                       // the last status written, for /board-status
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
let partial = false                      // the last listing had more pages: remove nothing on it
let toolsSeen: string[] = []             // the tool names that matter here, for the diagnostic record
let lastSync = ''                        // the last thread-list sync's outcome
// Where the mod cannot call the listing itself, the model calls it once a turn; its result waits here
// and is applied with the next status write.
let seenList: { list: ProjThread[]; paged: boolean } | null = null
let projectTools = false                 // the session can start the project's threads: a project conversation
// Problems to tell the user about, once each
let lastError = ''                       // the last unexpected board failure, cleared by a success
let skipped = ''                         // a card matched by repository but held by another project
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

// ---- Where the board is ----
// The user's "board-skill" skill names the board (the names board and update-status-board still count). It
// sits in the config folder's skills/, or for a skill synced from claude.ai in skills/synced/<ids>/;
// the newest copy wins. A board link has the
// form https://claude.ai/artifact/<id> (or …/code/artifact/<id>).
const SKILLS = ['board-skill', 'board', 'update-status-board']
const LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/
async function findBoard($: Engine): Promise<void> {
  let dir = ''
  try { dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || '' } catch {}
  if (!dir) { try { const home = await $.env.get('HOME'); if (home) dir = home + '/.claude' } catch {} }
  if (!dir) return
  const dirs = [dir + '/skills']
  try { for (const e of await $.fs.list(dir + '/skills/synced')) dirs.push(`${dir}/skills/synced/${e.name}`) } catch {}
  const files = dirs.flatMap(d => SKILLS.map(n => `${d}/${n}/SKILL.md`))
  let best: { link: string; at: number; file: string } | null = null
  for (const file of files) {
    try {
      const at = (await $.fs.stat(file, { resolve: true })).mtimeMs
      const link = LINK.exec(await $.fs.read(file))?.[0]
      if (link && (!best || at > best.at)) best = { link, at, file }
    } catch {}
  }
  if (best) { BOARD = best.link; boardFrom = 'from ' + best.file }
}

// ---- Trace ----
// Everything the mod shows on its status line also goes to ~/.claude/status-board.log (the last
// 20 kB), since a Remote Control or project session shows no status line to anyone.
let logPath: string | null = null
let logging: Promise<void> = Promise.resolve()
function say($: Engine, text: string): void {
  try { $.ui.status(text) } catch {}
  trace($, text)
}
function trace($: Engine, text: string): void {
  const line = `${now()} ${sessionId.slice(0, 8) || '-'} v${VERSION} ${text}\n`
  logging = logging.then(async () => {
    if (logPath === null) {
      let dir = ''
      try { dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || '' } catch {}
      if (!dir) { try { const home = await $.env.get('HOME'); if (home) dir = home + '/.claude' } catch {} }
      logPath = dir ? dir + '/status-board.log' : ''
    }
    if (!logPath) return
    let old = ''
    try { old = await $.fs.read(logPath) } catch {}
    await $.fs.write(logPath, (old + line).slice(-20000))
  }).catch(() => {})
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
  // Auto mode may refuse a call no request asked for, asking for it to be issued once more: do that.
  const refusal = String(r.deny ?? (r.isError ? r.text : '') ?? '')
  if (/gave no verdict/i.test(refusal)) { trace($, 'auto mode gave no verdict, retrying once: ' + refusal); r = await boardCall($, args, ms) }
  if (r.missing) { noBoard = true; trace($, 'ArtifactData missing: ' + String(r.text ?? '').slice(0, 160)); throw new Error('no ArtifactData tool in this session') }
  if (r.isError || r.deny !== undefined) {
    const text = String(r.deny ?? r.text ?? 'ArtifactData failed')
    if (!/^No document /i.test(text)) { lastError = `${String(args.action)} ${String(args.collection ?? '')}: ${text.slice(0, 160)}`; trace($, 'board error: ' + lastError) }
    throw new Error(text)
  }
  lastError = ''
  return String(r.text ?? '')
}
const isConflict = (err: unknown) => /version/i.test(msg(err))

// Board writes go through one queue, so they land in the order they were asked for.
function enqueue($: Engine, what: string, fn: () => Promise<void>): Promise<void> {
  const run = busy.then(fn).catch((err: unknown) => { say($, `board: ${what} failed (${msg(err).slice(0, 60)})`) })
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

// The card a new thread registers on. Where the session can list its project's threads, the card
// holding one of them is the project's. A card matched only by repository or name is then refused
// when it lists threads the listing does not know: another project working in the same repository.
async function threadCard($: Engine, docs: Card[]): Promise<Card | null> {
  const list = listTool ? await projectThreads($) : null
  if (list) {
    const own = docs.find(c => threadsOf(c).some(t => t && list.some(p => matchesThread(p, t))))
    if (own) return own
  }
  const c = await guessCard($, docs)
  if (!c || !list || !threadsOf(c).some(t => t && (threadIdOf(t) || t.session))) return c
  skipped = nameOf(c)
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
// ended: true stamps the entry as ended, false clears the stamp. waiting: what the user is asked
// for, kept while the status is waiting_on_you and dropped with any other status.
let prevJob: string | undefined          // the job a running command replaced
let toolJob = ''                         // the text shown for that command
function setStatus($: Engine, status: string, job?: string, ended?: boolean, waiting?: string): Promise<void> {
  const f = found, ids = myIds(), transcript = sessionId, remote = remoteId
  if (!f) return Promise.resolve()
  return enqueue($, 'status write', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = await getCard($, f.cardId)
      if (!card) return
      if (!threadsOf(card).some(t => isMine(t, ids))) {
        // The entry is gone (the thread was resolved, or removed by hand): stop writing.
        if (found === f) { found = null; removed = true; registeredHere = false }
        say($, 'board: this chat is no longer on its card')
        return
      }
      const at = now()
      const seen = seenList
      let th = threadsOf(card).map(t => {
        if (!isMine(t, ids)) return t
        const n: Thread = { ...t }
        if (status) { n.status = status; n.at = at; if (status !== 'waiting_on_you') delete n.waiting }
        if (waiting && status === 'waiting_on_you') n.waiting = waiting
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
      if (seen && seen.list.some(p => p.open)) th = syncedThreads(th, seen.list, seen.paged)
      try {
        await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th } })
        if (seen && seenList === seen) { seenList = null; lastSync = `synced from the model's listing: ${th.length} thread${th.length === 1 ? '' : 's'}` }
        if (job !== undefined && !job.startsWith(TOOL)) { prevJob = undefined; toolJob = '' }
        if (status) lastWrite = status
        say($, `board: ${f.name} / ${f.label}${status ? ' → ' + status.replace(/_/g, ' ') : ''}${ended ? ' (ended)' : ''}`)
        return
      } catch (err) { if (!isConflict(err)) throw err }   // someone else wrote the card: read again, once
    }
    say($, 'board: status not written (the card kept changing)')
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
    say($, 'board: entry not moved after /clear (the card kept changing)')
  })
}

// ---- Project conversations (coordinators) ----
// The project conversation is the session that can start the project's threads. Its thread-listing
// tool is found by name, or by trying the names under the project tools' prefix. A thread has a
// listing too, which finds its card and keeps the card's thread list in sync. In practice project
// conversations have no ArtifactData, so the sync below only runs where both tools exist.
async function listToolName($: Engine): Promise<string> {
  if (listTool !== null) return listTool
  let names: string[] = []
  try { names = (await $.tool.list()).map(t => t.name) } catch {}
  projectTools = names.some(x => PROJECT.test(x))
  toolsSeen = names.filter(x => /thread|project|rc_|ArtifactData/i.test(x)).slice(0, 20)
  let n = names.find(x => /(^|__)list_threads$/.test(x)) || names.find(x => LIST.test(x)) || ''
  if (!n) {
    // The tool list a hook sees may leave out tools the session can still call: try the names.
    const prefixes = [...new Set(['mcp__hearthbot__', ...names.filter(x => /__(list|start)_(thread|rc)/.test(x)).map(x => x.slice(0, x.lastIndexOf('__') + 2))])]
    for (const cand of prefixes.flatMap(p => [p + 'list_threads', p + 'list_thread_sessions'])) {
      try {
        const r = await limit($, $.tool.call({ tool: cand } as any) as Promise<ToolResult>, 15000, 'thread listing')
        if (r && r.deny === undefined && !r.isError) { n = cand; probed = r; break }
      } catch {}
    }
  }
  listTool = n
  trace($, `tools: listing ${n || 'none'}, project conversation ${projectTools}, seen [${toolsSeen.join(' ')}] of ${names.length}`)
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
  if (typeof v === 'string') {
    // The listing may come wrapped in a notice, its JSON then on a line of its own.
    const s = v.trim()
    for (const part of /^[[{]/.test(s) ? [s] : s.split('\n').map(l => l.trim()).filter(l => /^[[{]/.test(l))) {
      try { const r = threadRecords(JSON.parse(part), depth + 1); if (r) return r } catch {}
    }
    return null
  }
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
  return readListing(r)
}
// A listing's thread records, from the mod's own call or the model's; partial is set when it has more pages.
function readListing(r: ToolResult): ProjThread[] | null {
  if (!r || r.deny !== undefined || r.isError) return null
  partial = /"?next_cursor"?\s*:\s*"[^"]/.test(String(r.text ?? '') + JSON.stringify(r.result ?? null))
  return threadRecords(r.result) || threadRecords(r.text)
}

const threadIdOf = (t: Thread) => /[?&]thread=([A-Za-z0-9_]+)/.exec(String(t.url || ''))?.[1] ?? ''
const matchesThread = (p: ProjThread, t: Thread) => p.ids.some(i => same(i, threadIdOf(t)) || same(i, t.session))

async function detectCoordinator($: Engine): Promise<void> {
  await listToolName($)
  if (!projectTools) return
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

// Make the card's thread list match the project's open threads. A thread does this at the end of
// every turn, and so does a project conversation that has ArtifactData. Entries the listing does not
// know are removed, except one a thread added in the last 15 minutes that the listing may not show
// yet, and none at all when the listing is only a first page; a listing with no open thread changes
// nothing.
async function syncThreadList($: Engine, cardId: string): Promise<string> {
  const list = await projectThreads($)
  if (!list) return 'thread list not readable'
  if (!list.some(p => p.open)) return 'no open threads listed; card left as is'
  for (let attempt = 0; attempt < 2; attempt++) {
    const card = await getCard($, cardId)
    if (!card) return 'card not found'
    const before = threadsOf(card)
    const kept = syncedThreads(before, list, partial)
    if (JSON.stringify(kept) === JSON.stringify(before)) return 'in sync'
    try {
      await call($, { action: 'update', collection: 'projects', doc_id: cardId, if_version: card.version, data: { threads: kept } })
      return `synced: ${kept.length} open thread${kept.length === 1 ? '' : 's'}`
    } catch (err) { if (!isConflict(err)) throw err }
  }
  return 'card kept changing; next turn'
}

// The card's threads made to match a listing (see syncThreadList).
function syncedThreads(before: Thread[], list: ProjThread[], paged: boolean): Thread[] {
  {
    const used = new Set<ProjThread>()
    const kept: Thread[] = []
    for (const t of before) {
      if (!t) continue
      const m = list.find(p => matchesThread(p, t)) || list.find(p => p.name.toLowerCase() === String(t.label || '').toLowerCase())
      const fresh = !m && !!t.at && Date.now() - Date.parse(t.at) < 15 * 60000 && (t.label === PLACEHOLDER || !t.url)
      if (fresh || (!m && paged)) { kept.push(t); continue }
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
    return kept
  }
}

// A thread keeps its card's thread list in step with the project's threads, after its own status.
function syncThreads($: Engine): Promise<void> {
  const f = found
  if (!f) return Promise.resolve()
  return enqueue($, 'thread list sync', async () => { lastSync = await syncThreadList($, f.cardId); say($, `board: ${f.name} threads: ${lastSync}`) })
}

// What the mod decided and why, in diagnostics/<session id> on the board, since the user cannot see
// the mod's status line from a project page.
function diagnose($: Engine, when: string): Promise<void> {
  if (noBoard || !sessionId) return Promise.resolve()
  const data = { version: VERSION, at: now(), when, remote: remoteId, role: coordinator ? 'coordinator' : found ? 'thread' : removed ? 'removed' : 'none',
    card: (coordinator && coordinator.cardId) || (found && found.cardId) || '', label: (found && found.label) || '', listTool: listTool || '',
    toolsSeen, partial, lastSync, lastWrite, lastError, report, board: BOARD }
  return enqueue($, 'diagnostic', async () => {
    const d = await getDoc($, 'diagnostics', sessionId)
    const args: Record<string, unknown> = { action: 'set', collection: 'diagnostics', doc_id: sessionId, data }
    if (d) args.if_version = d.version
    await call($, args)
  })
}

// ---- Startup ----
// Runs in the background: it must never hold up the session.
async function init($: Engine): Promise<void> {
  try {
    await detectCoordinator($)
    if (coordinator) {
      if (noBoard) { say($, 'board: project conversation without ArtifactData; nothing to do'); return }
      if (!coordinator.cardId) { report = 'the Status Board mod could not find this project\'s card'; say($, 'board: project conversation, card not matched'); return }
      say($, `board: coordinator of ${coordinator.name}: ${await syncThreadList($, coordinator.cardId)}`)
      return
    }
    let viaIndex = true
    found = await indexLookup($)
    if (!found && !noBoard) {
      viaIndex = false
      const docs = await cards($)
      found = findIn(docs)
      // Only a remote session (a project's thread) registers itself; a local or one-shot run does not.
      if (!found && remoteId) { const c = await threadCard($, docs); if (c) found = await registerThread($, c) }
    }
    if (found) {
      registeredHere = found.label === PLACEHOLDER
      if (!viaIndex) void indexWrite($, found)
      void setStatus($, turnActive ? 'thinking' : 'idle', undefined, false)
      say($, `board: ${found.name} / ${found.label}`)
      if (listTool) void syncThreads($)
    } else if (noBoard) {
      report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
      say($, 'board: no ArtifactData tool in this session')
    } else {
      if (remoteId) report = `the Status Board mod could not match this chat to a project card (${lastError ? 'board call failed: ' + lastError : skipped ? `the ${skipped} card shares this repository but lists another project's threads` : 'no card\'s repo or name matches this repository or folder'})`
      say($, 'board: no card matched this chat')
    }
  } catch (err) {
    if (noBoard) report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
    else { initFailed++; if (initFailed >= 3) report = `the Status Board mod could not read the board (${msg(err).slice(0, 120)})` }
    say($, `board: could not read the board (${msg(err).slice(0, 60)})`)
  } finally {
    initDone = true
    void diagnose($, 'start')
  }
}
function startInit($: Engine): void { initDone = false; initPromise = init($) }

function reset(): void {
  found = null; removed = false; lastWrite = ''; registeredHere = false; coordinator = null; skipped = ''
  report = ''; reportedText = ''; composedReport = ''; lastError = ''; initFailed = 0
  prevJob = undefined; toolJob = ''; lastSync = ''
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
// Where the board and its rules are, added to every note: nothing else tells a session the address.
const WHERE = () => ` (The Status Board is the artifact ${BOARD}, read and written with the ArtifactData tool; its rules are the "rules" field of collection meta, doc_id instruction.)`
function boardNote(count: boolean): string {
  const v = `Status Board mod v${VERSION}`
  if (!initDone) return `${v}: looking up this chat on the Status Board. Nothing is needed from you for it.`
  return noteBody(count, v) + WHERE()
}
function noteBody(count: boolean, v: string): string {
  if (noBoard && coordinator) return `${v}: this project conversation has no ArtifactData tool, so the mod writes nothing to the Status Board from here; that is expected and needs no mention. The project's threads keep the card's thread list in step with the open threads; leave it to them unless the user asks.${IN_PLACE}`
  if (noBoard) return `${v}: this chat has no ArtifactData tool, so the mod cannot show its status on the Status Board.${tell(count)}`
  if (coordinator && !coordinator.cardId) return `${v}: this is a project conversation, but no card on the Status Board matches this project.${tell(count)} Find or create the project's card by the board's rules (meta/instruction, field rules), then write sessions/${sessionId} = {card: <card id>, role: "coordinator"} (pin it to the record's version). Add no thread entry for yourself.${IN_PLACE}`
  if (coordinator) return `${v}: this is the project conversation for the ${coordinator.name} card (id ${coordinator.cardId}). The project's threads keep the card's thread list in step with the open threads at the end of each of their turns, and the mod does the same here. Add no entry for yourself.${IN_PLACE}`
  if (found && registeredHere) return `${v}: this chat's entry on the ${found.name} card (id ${found.cardId}; transcript ${sessionId}${remoteId ? ', session ' + remoteId : ''}) still has the placeholder label "${PLACEHOLDER}". Before other work, read the board's rules (meta/instruction, field rules) and fix that entry: label = this thread's name (a 1–3 word name for its work if you do not know it), url = this thread's link if you know it; keep transcript and session as they are and touch nothing else. The mod writes this chat's status by itself.`
  if (found) return `${v}: this chat is thread "${found.label}" on the ${found.name} card (id ${found.cardId}). The mod writes its status (thinking / working / waiting_on_you / idle) and job line by itself${listTool ? ', and keeps the card\'s thread list in step with the project\'s open threads' : ''}.${listTool ? '' : ' Once in every turn, before your final reply, call the project\'s thread-listing tool (list_thread_sessions or list_threads) with no arguments; the mod reads its result and keeps the card\'s thread list in step with the project\'s open threads. Do not edit the thread list yourself.'} If you update the card, keep this entry's transcript (${sessionId})${remoteId ? ' and session (' + remoteId + ')' : ''} as they are.`
  if (removed) return `${v}: this chat's entry was taken off its card on the Status Board (usually because the thread was resolved). Leave the board alone.`
  const told = tell(count)
  if (!remoteId || (!told && reportedText)) return `${v}: this chat is not on the Status Board.${told}`
  return `${v}: this chat is not on the Status Board.${told} If this chat is work on one of the user's projects: read the board's rules (meta/instruction, field rules), find or create the project's card, add this thread's entry with transcript ${sessionId} and session ${remoteId} (plus label and url), write sessions/${sessionId} = {card, label}, and set the card's repo field to this repository's owner/name so later threads register by themselves; the mod then writes this chat's status. If it is not project work, leave the board alone.`
}
function describe(): string {
  return describeChat() + ` Board: ${BOARD} (${boardFrom}).`
}
function describeChat(): string {
  if (!initDone) return 'Status Board: still looking up this chat.'
  if (noBoard) return 'Status Board: this session has no ArtifactData tool; the mod writes nothing from here.'
  if (coordinator) return (coordinator.cardId ? `Status Board: project conversation for the ${coordinator.name} card.` : 'Status Board: project conversation; no card matched.') + ' Update the card here yourself if needed; do not start a thread for this command.'
  if (found) return `Status Board: this chat is "${found.label}" on the ${found.name} card.${lastWrite ? ` Last status written: ${lastWrite.replace(/_/g, ' ')}.` : ''}`
  if (removed) return 'Status Board: this chat\'s entry was taken off its card.'
  return `Status Board: this chat is not on the board (transcript ${sessionId}${remoteId ? ', session ' + remoteId : ''}).${report ? ' ' + report + '.' : ''}`
}

// What a turn's final message means for the board: a question or a decision for the user; work still
// running elsewhere (a remote session, a SLURM job, a build), shown as "working"; or done.
const ASK = 'the message asks the user a question, or waits for the user to decide, approve, confirm or provide something'
const RUN = 'the message says work is still running and will report later: a job, a remote or background session, a build, a process the assistant is waiting on'
const DONE = 'the message reports finished work or information; nothing is still running and nothing is asked of the user'
async function decide($: Engine, answer: string): Promise<{ status: string; job?: string; waiting?: string }> {
  if (!answer.trim()) return { status: 'idle' }
  let k: string | undefined
  try { k = await $.model.classify(`The assistant's final message of a turn:\n\n${answer.slice(-3000)}`, [ASK, RUN, DONE]) } catch {}
  if (k === ASK) return { status: 'waiting_on_you', waiting: await askedFor($, answer) }
  if (k === RUN) return { status: 'idle', job: KEEP }
  if (k === DONE) return { status: 'idle', job: '' }
  const last = answer.trim().split('\n').pop() || ''
  if (/\?\s*$/.test(last)) return { status: 'waiting_on_you', waiting: lastQuestion(answer) }
  return { status: 'idle' }   // no label: leave the job alone
}

// What the user is asked for, in one short line for the board: a summary by the small model, or the
// reply's last question when that fails.
function lastQuestion(answer: string): string {
  const qs = answer.replace(/`[^`]*`/g, '').match(/[^.!?\n]{3,}\?/g)
  return qs ? oneLine(qs[qs.length - 1]) : ''
}
function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').replace(/^["'*\s-]+|["'*\s]+$/g, '').trim()
  return t.length > 110 ? t.slice(0, 109).trimEnd() + '…' : t
}
async function askedFor($: Engine, answer: string): Promise<string> {
  try {
    const r = await limit($, $.model.complete({
      model: 'haiku',
      maxTokens: 60,
      prompt: `Below is an assistant's last message to a user. In at most 12 words, say what the user needs to do or decide next, as an imperative (for example "Push the repo and restart Claude in MethScope" or "Choose between the two figure layouts"). Reply with that line only.\n\n<message>\n${answer.slice(-4000)}\n</message>`,
    }), 15000, 'summary')
    if (r.isAnswered && r.text && r.text.trim()) return oneLine(r.text)
  } catch {}
  return lastQuestion(answer)
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
      || LIST.test(e.tool)
      || (e.tool === 'ToolSearch' && input.query === 'select:ArtifactData')
    return ok ? { decision: 'allow' as const } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'board-status', description: 'Show and update this chat\'s Status Board card, here in this chat (never start a thread for it)' }) } catch {}
    try { sessionId = await $.session.id() } catch {}
    try { remoteId = (await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')) || '' } catch {}
    try { await limit($, findBoard($), 3000, 'board lookup') } catch {}
    trace($, `session.start: remote ${remoteId || 'none'}, board ${BOARD} (${boardFrom})`)
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
    // A one-shot run (-p) gets no note; a Remote Control thread also runs as print, but is on a card.
    if (!sessionId || traits.includes('teammate') || (traits.includes('print') && !found)) return r
    const text = boardNote(!traits.includes('analysis'))
    return { sections: [...r.sections.filter(s => s.id !== NOTE_ID), { id: NOTE_ID, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board-status' }, async () => ({ text: describe() }))

  // While a command runs on a machine for more than a few seconds (a shell, a remote computer, a
  // browser), the chat is waiting on that machine, not thinking: show it as working.
  let toolDepth = 0, toolTimer: { cancel: () => void } | null = null, toolShown = false
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool || '')
    // The model's own call of the thread listing: keep its result for the next status write.
    if (e.agentId === undefined && LIST.test(name)) {
      const r = await next(e)
      const list = readListing(r as unknown as ToolResult)
      if (list) { seenList = { list, paged: partial }; trace($, `model's listing: ${list.length} threads, ${list.filter(p => p.open).length} open${partial ? ', more pages' : ''}`) }
      return r
    }
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
      trace($, `turn.start: initDone ${initDone}, found ${found ? found.cardId + '/' + found.label : 'none'}, coordinator ${coordinator ? coordinator.cardId || '?' : 'no'}, noBoard ${noBoard}`)
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
          if (coordinator.cardId) say($, `board: coordinator of ${coordinator.name}: ${await syncThreadList($, coordinator.cardId)}`)
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
        await setStatus($, d.status, d.job === undefined && hadTool ? RESTORE : d.job, undefined, d.waiting)
        if (listTool && found) await syncThreads($)
        await diagnose($, 'turn')
      } catch (err) { say($, `board: end of turn failed (${msg(err).slice(0, 60)})`) }
    })()
    return out
  })
}
