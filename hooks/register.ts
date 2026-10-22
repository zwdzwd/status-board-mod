import type { Register, EngineInterface as Engine } from 'claude-code'

// Status Board mod. Keeps this chat's entry on the Status Board current: thinking at the start of a
// turn, waiting on you or idle at the end, and the background jobs still running. The board is an
// artifact with a document database; each project is a card in "projects", and a card lists its chats
// under "threads". An entry names its chat by "session" (the remote session id, cse_… / session_…,
// which the project's own tools use) and "transcript" (this process's session id). The card's thread
// list changes only when the user sends /board-status (the board-status skill): the thread's listing
// call then places it and makes the list match the project's open threads. What the thread waits on
// the user for is the "Waiting on you" line the thread writes in its message each turn: the mod reads
// it and keeps it as the entry's "asks" list, written with the turn's status writes. Only the thread
// changes the list: an item it stops listing is gone.

const VERSION = '0.14.2'
const PLUGIN = 'status-board'
// The board's address comes from the user's board-skill skill (see findBoard), so a new
// board needs only the skill changed. This one is used where no such skill is on disk.
const FALLBACK = 'https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T'
let BOARD = FALLBACK
let boardFrom = 'built in'
const NOTE_ID = 'status-board:note'
// /board-status is handled in the chat where it is typed; a project conversation must not start a thread for it.
const IN_PLACE = ' When the user sends /board-status here, update this project\'s card yourself by the board\'s rules, in this chat; never start a thread for it.'
const PLACEHOLDER = 'New thread'
// The project's thread listing, under either name; threads have one too.
const LIST = /(^|__)(list_threads|list_thread_sessions)$/
// Tools only a project conversation has: those that start threads.
const PROJECT = /(^|__)(start_thread|start_thread_session|start_rc_session|list_thread_connectors)$/

type Job = { text: string; type: string; id: string }
// One thing a thread waits on the user for.
type Ask = { id: string; text: string; at: string }
type Thread = { jobs?: Job[]; asks?: Ask[]; todo?: unknown; label?: string; url?: string; session?: string; transcript?: string; status?: string; at?: string; job?: string; waiting?: string; ended?: string }
type Card = { id: string; version: number; data: Record<string, unknown> }
type Found = { cardId: string; name: string; label: string }
type ToolResult = { deny?: unknown; isError?: boolean; text?: string; result?: unknown; missing?: boolean }
type ProjThread = { ids: string[]; name: string; open: boolean }

// ---- State of this session ----
let sessionId = ''                       // $.session.id(): the transcript's id; changes after /clear
let remoteId = ''                        // the remote session id (cse_…), when this is a remote session
let priorIds: string[] = []              // this chat's ids before a /clear, until its entry is moved
let threadId = ''                        // this thread's cmsg_ id, once a listing has named it
let found: Found | null = null           // this chat's card and entry
let removed = false                      // the entry was taken off the card (the thread was resolved)
let lastWrite = ''                       // the last status written, for /board-info
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
let probed: ToolResult | null = null     // the probe's listing, reused by the first placement
let partial = false                      // the last listing had more pages: remove nothing on it
// The model's thread-listing call (on /board-status): applied with the next status write.
let seenList: { list: ProjThread[]; paged: boolean } | null = null
// Notes to this thread's project on the board ("messages", see the rules), unread: shown in the note.
let unread: string[] = []
// The background work still running at the end of the last turn, as Claude Code reports it to Stop
// hooks: the thread's "jobs" on the card. null until a report has come.
let jobsNow: Job[] | null = null
let jobsWritten = ''
// The "Waiting on you" items the thread wrote this turn, for the next status write; null when this
// turn's message had no such line (the list then stays as it was).
let asksSaid: string[] | null = null
let replyText = ''                       // the turn's last message to the user through a reply tool
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
const myIds = () => [sessionId, remoteId, threadId].filter(Boolean)
// An entry is this chat's by its transcript, its session, or the thread id in its link.
const isMine = (t: Thread, ids: string[]) => !!t && ids.some(id => same(t.transcript, id) || same(t.session, id) || same(threadIdOf(t), id))
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

// The mod's status line, also kept in ~/.claude/status-board.log (the last 20 kB), since a Remote
// Control or project session shows no status line to anyone.
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

// The remote session id (cse_…). Cloud sessions carry it in CLAUDE_CODE_REMOTE_SESSION_ID; a Remote
// Control session on a computer does not, but its process was started with --session-id cse_….
async function findRemoteId($: Engine): Promise<string> {
  try { const v = await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID'); if (v) return v } catch {}
  try {
    const r = await $.process.run(['sh', '-c', 'ps -o command= -p $PPID'], { timeoutMs: 5000 })
    return /--session-id[= ](cse_[A-Za-z0-9]+)/.exec(r.stdout)?.[1] ?? ''
  } catch { return '' }
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
  if (/gave no verdict/i.test(refusal)) r = await boardCall($, args, ms)
  if (r.missing) { noBoard = true; throw new Error('no ArtifactData tool in this session') }
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

// A card matched by this repository's owner/name, else by the repository's or a specific folder's
// name. Only a tie-break for threadCard: several projects can share one repository.
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

// The card a new thread registers on: the card holding one of its project's other threads, by the
// project's thread listing. Failing that, a card matched by repository or name, but only one that
// holds no other project's threads (a new project's card). Without a listing nothing is placed:
// several projects can share a repository or folder (writing, labjournal).
async function threadCard($: Engine, docs: Card[], given?: ProjThread[]): Promise<Card | null> {
  const list = given ?? (listTool ? await projectThreads($) : null)
  if (!list) return null
  const own = docs.find(c => threadsOf(c).some(t => t && !mine(t) && list.some(p => matchesThread(p, t))))
  if (own) return own
  const c = await guessCard($, docs)
  if (!c || belongsTo(c, list)) return c
  skipped = nameOf(c)
  return null
}
// A card's entries other than this chat's that name a thread (by url or session).
const othersOn = (c: Card) => threadsOf(c).filter(t => t && !mine(t) && (threadIdOf(t) || t.session))
// The card holds threads of the project the listing is from, or none at all.
const belongsTo = (c: Card, list: ProjThread[]) => { const o = othersOn(c); return !o.length || o.some(t => list.some(p => matchesThread(p, t))) }

// Add this session as a thread of a card, with a placeholder label; the next listing names it.
async function registerThread($: Engine, card: Card): Promise<Found | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await getCard($, card.id)
    if (!fresh) return null
    const existing = findIn([fresh]); if (existing) return existing
    const entry: Thread = { label: PLACEHOLDER, transcript: sessionId, status: turnActive ? 'thinking' : 'idle', at: now() }
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
// for, not when it runs, so a /clear in between cannot point it at the wrong entry. A model listing
// waiting in seenList is applied in the same write. status: "" keeps the entry's status. ended: true
// stamps the entry as ended, false clears the stamp. waiting: what the user is asked for, kept while
// the status is waiting_on_you.
function setStatus($: Engine, status: string, ended?: boolean, waiting?: string): Promise<void> {
  const f = found, ids = myIds(), transcript = sessionId, remote = remoteId
  if (!f) return Promise.resolve()
  return enqueue($, 'status write', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = await getCard($, f.cardId)
      if (!card) return
      if (!threadsOf(card).some(t => isMine(t, ids))) {
        if (priorIds.length && threadsOf(card).some(t => isMine(t, priorIds))) {
          // The entry still carries the ids from before a /clear: move it, then write.
          void moveEntry($, priorIds, transcript); void setStatus($, status, ended, waiting)
          return
        }
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
        // A thread that keeps a list says on the board what it says in the thread: its newest open item.
        const list = asksSaid !== null ? mergedAsks(n.asks) : undefined
        if (status === 'waiting_on_you' && list && list.length) n.waiting = list[0]!.text
        if (!n.transcript) n.transcript = transcript               // fill in what the entry lacks
        if (!n.session && remote) n.session = remote
        if (jobsNow) { n.jobs = jobsNow; delete n.job }            // "job" was the old single job line
        if (list) { if (list.length) n.asks = list; else delete n.asks }
        delete n.todo                                               // the 0.13 progress checklist, retired
        if (ended === true) n.ended = at
        if (ended === false) delete n.ended
        return n
      })
      // A card none of whose other entries is in this project's listing is either another project's
      // card (an old repository guess put this chat there) or this project's card carrying strays.
      // It is another project's only when some other card holds this project's threads.
      const home = seen && !seen.paged && !belongsTo(card, seen.list)
        ? (await cards($)).find(c => c.id !== card.id && threadsOf(c).some(t => t && !isMine(t, ids) && seen.list.some(p => matchesThread(p, t))))
        : undefined
      if (seen && home) {
        // Leave that card's list alone, take this chat's entry off it, and let the listing place it.
        try {
          await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th.filter(t => !isMine(t, ids)) } })
        } catch (err) { if (isConflict(err)) continue; throw err }
        if (found === f) { found = null; registeredHere = false }
        say($, `board: left the ${f.name} card, which holds another project's threads`)
        if (seenList === seen) await placeNow($, seen.list)
        return
      }
      if (seen && seen.list.some(p => p.open)) th = syncedThreads(th, seen.list, seen.paged, ids)
      try {
        await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th } })
        if (seen && seenList === seen) seenList = null
        asksSaid = null
        if (status) lastWrite = status
        if (jobsNow) jobsWritten = JSON.stringify(jobsNow)
        say($, `board: ${f.name} / ${f.label}${status ? ' → ' + status.replace(/_/g, ' ') : ''}${ended ? ' (ended)' : ''}${seen ? ' (thread list synced)' : ''}`)
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
      if (!card || !threadsOf(card).some(t => isMine(t, fromIds))) { priorIds = []; return }
      const th = threadsOf(card).map(t => {
        if (!isMine(t, fromIds)) return t
        const n: Thread = { ...t, transcript: to }
        delete n.ended
        return n
      })
      try { await call($, { action: 'update', collection: 'projects', doc_id: f.cardId, if_version: card.version, data: { threads: th } }); priorIds = []; return }
      catch (err) { if (!isConflict(err)) throw err }
    }
    say($, 'board: entry not moved after /clear (the card kept changing)')
  })
}

// ---- The project's thread listing ----
// The project conversation is the session that can start the project's threads; the mod leaves it
// off the board. A thread uses the listing to find its card. The listing tool is found by name, or by
// trying the names, then the hearthbot server directly. On Mac Remote Control none of these reach it,
// so there only the model's own listing call (on /board-status) places the thread.
// One call of the project's thread listing: the tool by name, or the hearthbot server directly
// ("mcp:<tool>"), which a hook can reach where $.tool.call cannot (Remote Control).
async function callListing($: Engine, name: string): Promise<ToolResult> {
  if (name.startsWith('mcp:')) {
    const r = await limit($, $.mcp.call('hearthbot', name.slice(4)), 20000, 'thread listing')
    return { isError: r.isError, text: r.content.map(b => String((b as { text?: unknown }).text ?? '')).join('\n'), result: r.structuredContent }
  }
  return await limit($, $.tool.call({ tool: name } as any) as Promise<ToolResult>, 20000, 'thread listing')
}
let listProbedAt = 0                     // when a probe last found no listing; tried again a minute on
async function listToolName($: Engine): Promise<string> {
  if (listTool !== null && (listTool || Date.now() - listProbedAt < 60000)) return listTool
  let names: string[] = []
  try { names = (await $.tool.list()).map(t => t.name) } catch {}
  projectTools = names.some(x => PROJECT.test(x))
  let n = names.find(x => /(^|__)list_threads$/.test(x)) || names.find(x => LIST.test(x)) || ''
  if (!n) {
    // The tool list a hook sees may leave out tools the session can still call: try the names.
    const prefixes = [...new Set(['mcp__hearthbot__', ...names.filter(x => /__(list|start)_(thread|rc)/.test(x)).map(x => x.slice(0, x.lastIndexOf('__') + 2))])]
    const why: string[] = []
    for (const cand of [...prefixes.flatMap(p => [p + 'list_threads', p + 'list_thread_sessions']), 'mcp:list_thread_sessions', 'mcp:list_threads']) {
      try {
        const r = await callListing($, cand)
        if (r && r.deny === undefined && !r.isError && readListing(r)) { n = cand; probed = r; break }
        why.push(`${cand}: ${String(r?.deny ?? r?.text ?? 'no listing').slice(0, 80)}`)
      } catch (err) { why.push(`${cand}: ${msg(err).slice(0, 80)}`) }
    }
    trace($, n ? `thread listing through ${n}` : `no thread listing reachable (${why.join('; ')})`)
  }
  if (!n) listProbedAt = Date.now()
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
  if (typeof v === 'string') {
    // The listing may come wrapped in a notice, its JSON then on a line of its own.
    const s = v.trim()
    for (const part of /^[[{]/.test(s) ? [s] : s.split('\n').map(l => l.trim()).filter(l => /^[[{]/.test(l))) {
      try { const r = threadRecords(JSON.parse(part), depth + 1); if (r) return r } catch {}
    }
    return null
  }
  if (Array.isArray(v)) {
    // An array of thread records, allowing a few rows the parser cannot read (an empty title).
    const recs = v.map(threadRecord).filter((x): x is ProjThread => !!x)
    if (recs.length && recs.length * 2 >= v.length) return recs
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
  else { try { r = await callListing($, name) } catch { return null } }
  const l = readListing(r)
  if (l) partial = l.paged
  return l ? l.list : null
}
// A listing's thread records, from the mod's own call or the model's; partial is set when it has more pages.
type Listing = { list: ProjThread[]; paged: boolean }
function readListing(r: ToolResult): Listing | null {
  if (!r || r.deny !== undefined || r.isError) return null
  const paged = /"?next_cursor"?\s*:\s*"[^"]/.test(String(r.text ?? '') + JSON.stringify(r.result ?? null))
  const list = threadRecords(r.result) || threadRecords(r.text)
  if (!list) return null
  // The listing names this chat's thread: its cmsg_ id identifies an entry that has only a link.
  const me = list && remoteId ? list.find(p => p.ids.some(i => same(i, remoteId))) : null
  const tid = me ? me.ids.find(i => /^cmsg_/.test(i)) : ''
  if (tid) threadId = tid
  return { list, paged }
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

// The card's threads made to match a listing: entries of threads the listing shows resolved or does
// not know go, open threads without an entry are added, names and missing links are filled in.
// Entries are matched by thread id or session, never by name. This chat's own entry always stays, as
// does one added in the last 15 minutes that the listing may not show yet, and, when the listing is
// only a first page, every entry it does not know.
function syncedThreads(before: Thread[], list: ProjThread[], paged: boolean, ids: string[]): Thread[] {
  const used = new Set<ProjThread>()
  // New links take the project link from an entry of this project (one the listing knows), never
  // from a stray of another project.
  const base = (before.filter(t => t && list.some(p => matchesThread(p, t))).map(t => String(t.url || '')).find(u => /\?thread=/.test(u)) || '').split('?')[0]
  const kept: Thread[] = []
  for (const t of before) {
    if (!t) continue
    const m = list.find(p => matchesThread(p, t))
    const own = isMine(t, ids)
    const fresh = !m && !!t.at && Date.now() - Date.parse(t.at) < 15 * 60000 && (t.label === PLACEHOLDER || !t.url)
    if (!m && (own || fresh || paged)) { kept.push(t); continue }
    if (!m || (!m.open && !own)) continue
    if (used.has(m)) {
      // Two entries for one thread (one by session, one by link): merge this one into the kept one.
      const k = kept.findIndex(x => matchesThread(m, x))
      if (k >= 0) kept[k] = { ...t, ...kept[k], transcript: kept[k].transcript || t.transcript, session: kept[k].session || t.session }
      continue
    }
    used.add(m)
    const tid = !t.url && base ? m.ids.find(i => /^cmsg_/.test(i)) : ''
    kept.push(m.name !== t.label || tid ? { ...t, label: m.name, ...(tid ? { url: `${base}?thread=${tid}` } : {}) } : t)
  }
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

// Register this chat from a project listing, on the card holding its project's other threads. A
// thread the listing shows resolved stays off the board; one taken off a card by hand returns.
async function placeNow($: Engine, list: ProjThread[]): Promise<void> {
  if (found) return
  const me = list.find(p => p.ids.some(i => myIds().some(m => same(i, m))))
  if (me && !me.open) { removed = true; return }
  const c = await threadCard($, await cards($), list)
  if (!c) { unmatchedWhy = skipped ? `the ${skipped} card shares this repository but lists another project's threads` : 'no card holds this project\'s threads'; return }
  found = await registerThread($, c)
  if (found) { removed = false; registeredHere = found.label === PLACEHOLDER; void indexWrite($, found); say($, `board: registered on ${found.name} from the project's thread list`) }
}
const placeFrom = ($: Engine, list: ProjThread[]) => enqueue($, 'registration', () => placeNow($, list))

// A thread the mod cannot place shows on the board as unmatched (collection "unmatched"), never on a
// guessed card; the record goes once the thread is placed.
let unmatchedWhy = ''
let unmatchedWritten = false
let unmatchedChecked = false             // the record for this id was looked for once after placement
async function dropUnmatched($: Engine, id: string): Promise<void> {
  try { const d = await getDoc($, 'unmatched', id); if (d) await call($, { action: 'delete', collection: 'unmatched', doc_id: id, if_version: d.version }) } catch {}
}
const markUnmatched = ($: Engine) => enqueue($, 'unmatched record', () => unmatched($))
async function unmatched($: Engine): Promise<void> {
  if (noBoard || !sessionId || coordinator) return
  try {
    if (found || removed) {
      if (unmatchedChecked && !unmatchedWritten) return
      await dropUnmatched($, sessionId)
      unmatchedWritten = false; unmatchedChecked = true
      return
    }
    // Only a thread a listing could not place is shown: a fresh Remote Control thread, which no
    // listing has reached yet, waits for /board-status without a warning on the board.
    if (!remoteId || (!unmatchedWhy && !listTool)) return
    let folder = ''
    try { folder = await $.session.cwd() } catch {}
    const why = unmatchedWhy || 'no card holds this project\'s threads'
    const d = await getDoc($, 'unmatched', sessionId)
    if (d && d.data.why === why) { unmatchedWritten = true; return }
    const args: Record<string, unknown> = { action: 'set', collection: 'unmatched', doc_id: sessionId, data: { session: remoteId, transcript: sessionId, folder, why, version: VERSION, at: now() } }
    if (d) args.if_version = d.version
    await call($, args)
    unmatchedWritten = true
    trace($, 'unmatched: ' + why)
  } catch {}
}

// The unread notes addressed to a card, as "from: subject".
async function checkMail($: Engine, cardId: string): Promise<void> {
  try {
    const docs = parseDocs(await call($, { action: 'query', collection: 'messages', query: { where: [['to', '==', cardId], ['read_at', '==', '']] } }))
    unread = docs.map(d => `${String(d.data.from ?? '?')}: ${oneLine(String(d.data.subject ?? ''))}`)
  } catch {}
}
const mailNote = (f: Found) => unread.length ? ` The ${f.name} project has ${unread.length} unread note${unread.length === 1 ? '' : 's'} on the Status Board (${unread.slice(0, 3).join('; ')}${unread.length > 3 ? '; …' : ''}). Load the status-board-messaging skill to read ${unread.length === 1 ? 'it' : 'them'} and tell the user what ${unread.length === 1 ? 'it asks' : 'they ask'}.` : ''

// ---- What the thread waits on the user for ----
// ---- What the thread waits on the user for ----
// The entry's list as the thread last said it: items it still lists keep their id and time, new ones
// are added, and ones it no longer lists are gone.
function mergedAsks(cur: Ask[] | undefined): Ask[] {
  const at = now(), old = (Array.isArray(cur) ? cur : []).filter(a => a && a.id && a.text && !(a as { done_at?: string }).done_at)
  return (asksSaid || []).map((text, k) => {
    const kept = old.find(a => a.text.toLowerCase() === text.toLowerCase())
    return kept ? { id: kept.id, text, at: kept.at } : { id: `${(remoteId || sessionId).slice(-6)}-${Date.now().toString(36)}${k}`, text, at }
  })
}
// The "Waiting on you" line in a message: "Waiting on you: X" (several items split by ";"), or that
// heading followed by bullet lines. "Waiting on you: nothing" (or none) clears the list. null when
// the message has no such line.
function waitingSaid(text: string): string[] | null {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(?:[#>*_\s-]*)waiting on you\b[*_]*\s*[:：]?[*_]*\s*(.*)$/i.exec(lines[i] || '')
    if (!m) continue
    const items: string[] = []
    const rest = (m[1] || '').replace(/^[*_\s]+|[*_\s]+$/g, '')
    if (rest) items.push(...rest.split(/;\s*/))
    for (let k = i + 1; k < lines.length; k++) {
      const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(lines[k] || '')
      if (!b) { if ((lines[k] || '').trim()) break; if (items.length) break; continue }
      items.push(b[1] || '')
    }
    const clean = items.map(lean).filter(Boolean)
    return clean.length === 1 && /^(nothing|none|no(thing)? (is )?waiting)\b/i.test(clean[0]!) ? [] : clean.slice(0, 12)
  }
  return null
}

// ---- Startup ----
// Runs in the background: it must never hold up the session.
async function init($: Engine): Promise<void> {
  try {
    await detectCoordinator($)
    if (coordinator) { say($, `board: project conversation${coordinator.cardId ? ' for ' + coordinator.name : ''}; the mod writes nothing here`); return }
    let viaIndex = true
    found = await indexLookup($)
    if (!found && !noBoard) {
      viaIndex = false
      const docs = await cards($)
      found = findIn(docs)
      // Only a remote session (a project's thread) registers itself; a local or one-shot run does not.
      if (!found && remoteId) { const list = await projectThreads($); if (list) await placeNow($, list) }
    }
    if (found) {
      registeredHere = found.label === PLACEHOLDER
      if (!viaIndex) void indexWrite($, found)
      void setStatus($, turnActive ? 'thinking' : 'idle', false)
      say($, `board: ${found.name} / ${found.label}`)
      void checkMail($, found.cardId)
    } else if (noBoard) {
      report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
      say($, 'board: no ArtifactData tool in this session')
    } else {
      if (remoteId && lastError) report = `the Status Board mod could not read the board (${lastError})`
      say($, 'board: no card matched this chat yet')
    }
  } catch (err) {
    if (noBoard) report = 'this chat has no ArtifactData tool, so its status will not appear on the Status Board'
    else { initFailed++; if (initFailed >= 3) report = `the Status Board mod could not read the board (${msg(err).slice(0, 120)})` }
    say($, `board: could not read the board (${msg(err).slice(0, 60)})`)
  } finally {
    initDone = true
  }
}
function startInit($: Engine): void { initDone = false; initPromise = init($) }

function reset(): void {
  found = null; removed = false; lastWrite = ''; registeredHere = false; coordinator = null; skipped = ''
  report = ''; reportedText = ''; composedReport = ''; lastError = ''; initFailed = 0
  unread = []; unmatchedWhy = ''; unmatchedWritten = false; unmatchedChecked = false; seenList = null; jobsWritten = ''
  jobsNow = null; threadId = ''; priorIds = []; asksSaid = null
}

// After a /clear or a resume the process goes on under another session id, with no session.start.
async function refreshSession($: Engine): Promise<void> {
  let id = ''
  try { id = await $.session.id() } catch {}
  if (!id || id === sessionId) { pendingClear = false; return }
  const oldIds = myIds(), oldId = sessionId
  sessionId = id
  remoteId = await findRemoteId($)
  const wasClear = pendingClear
  pendingClear = false
  if (wasClear && found) {
    const f = found
    priorIds = oldIds                     // until the entry is moved, it still carries the old id
    void moveEntry($, oldIds, id).then(() => { if (found === f) void indexWrite($, f) })
    return
  }
  reset()
  if (oldId && !noBoard) void dropUnmatched($, oldId)   // a record keyed by the old id would linger
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
  if (!initDone) return `${v}: looking up this chat on the Status Board.${remoteId ? ASK_STATUS : ''}`
  return noteBody(count, v) + WHERE()
}
// /board-status runs the board-status skill: the thread's check-in write and its listing call.
const ASK_STATUS = ' At the start of each fresh session the user sends /board-status: load the board-status skill and follow it here; never start a thread for it. End each message to the user with a "Waiting on you:" heading and one bullet per item (or "Waiting on you: nothing"), as bare imperatives without the user\'s name; the mod puts that list on the board.'
function noteBody(count: boolean, v: string): string {
  const sync = 'The card\'s thread list is synced when the user sends /board-status in a thread.'
  if (noBoard && coordinator) return `${v}: this project conversation has no ArtifactData tool, so the mod writes nothing to the Status Board from here; that is expected and needs no mention. ${sync}${IN_PLACE}`
  if (noBoard) return `${v}: this chat has no ArtifactData tool, so the mod cannot show its status on the Status Board.${tell(count)}`
  if (coordinator) return `${v}: this is a project conversation${coordinator.cardId ? ` for the ${coordinator.name} card (id ${coordinator.cardId})` : ''}; the mod writes nothing here and adds no entry for it. ${sync}${IN_PLACE}`
  if (found && registeredHere) return `${v}: this chat is on the ${found.name} card (id ${found.cardId}) under the placeholder "${PLACEHOLDER}"; /board-status names it from the project's thread list. Do not invent a label. The mod writes this chat's status and its running background jobs by itself.${ASK_STATUS}${mailNote(found)}`
  if (found) return `${v}: this chat is thread "${found.label}" on the ${found.name} card (id ${found.cardId}). The mod writes its status (thinking / waiting_on_you / idle) and its running background jobs by itself.${ASK_STATUS}${mailNote(found)} If you update the card, keep this entry's transcript (${sessionId})${remoteId ? ' and session (' + remoteId + ')' : ''} as they are.`
  if (removed) return `${v}: this chat's entry was taken off its card on the Status Board (usually because the thread was resolved). Leave the board alone.`
  const told = tell(count)
  if (!remoteId) return `${v}: this chat is not on the Status Board.${told}`
  return `${v}: this chat (transcript ${sessionId}${remoteId ? ', session ' + remoteId : ''}) is not on a Status Board card yet; the board lists it as not on any card.${told} /board-status places it from the project's thread list.${ASK_STATUS} Do not add it to a card by hand unless the user asks.`
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

// What a turn's final message means for the board: a question or a decision for the user, or not.
// What still runs is the jobs list's business.
const ASK = 'the message asks the user a question, or waits for the user to decide, approve, confirm or provide something'
const OTHER = 'the message reports work or information and asks nothing of the user'
async function decide($: Engine, answer: string): Promise<{ status: string; waiting?: string }> {
  if (!answer.trim()) return { status: 'idle' }
  let k: string | undefined
  try { k = await $.model.classify(`The assistant's final message of a turn:\n\n${answer.slice(-3000)}`, [ASK, OTHER]) } catch {}
  const last = answer.trim().split('\n').pop() || ''
  if (k === ASK || (k === undefined && /\?\s*$/.test(last))) {
    // Waiting on the user always comes with a line saying what for; a summary that finds nothing
    // asked means the message asks nothing after all.
    const w = await askedFor($, answer)
    return w ? { status: 'waiting_on_you', waiting: w } : { status: 'idle' }
  }
  return { status: 'idle' }
}

// What the user is asked for, in one short line for the board: a summary by the small model, or the
// reply's last question when that fails.
function lastQuestion(answer: string): string {
  const qs = answer.replace(/`[^`]*`/g, '').match(/[^.!?\n]{3,}\?/g)
  return qs ? oneLine(qs[qs.length - 1]) : ''
}
// A waiting line is about the user already: no "Wanding:", "the user should", "waiting on you" lead-in.
const LEAD = /^\s*(?:waiting on (?:you|wanding|the user)\s*(?:for|to|:|,|-)?\s*|(?:wanding|the user|user|you)\s*(?:needs? to|should|must|to|:|,|-)\s*)/i
function lean(s: string): string {
  let t = oneLine(s)
  for (let i = 0; i < 2 && LEAD.test(t); i++) t = t.replace(LEAD, '')
  if (/^(in|on|at)\b/i.test(t)) t = 'Reply ' + t                  // "Waiting on Wanding in Writing" -> "Reply in Writing"
  return t ? t[0].toUpperCase() + t.slice(1) : t
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
      prompt: `Below is an assistant's last message to a user. In at most 10 words, say what the user needs to do or decide next, as a bare imperative with no name or "you" (for example "Push the repo and restart Claude in MethScope" or "Choose between the two figure layouts"). If the message asks nothing of the user, reply NONE. Reply with that line only.\n\n<message>\n${answer.slice(-4000)}\n</message>`,
    }), 15000, 'summary')
    if (r.isAnswered && r.text && r.text.trim()) { const t = lean(r.text); return /^none\b/i.test(t) ? '' : t }
  } catch {}
  // No summary: the last question, or else the message's last sentence, so the card always says what.
  return lean(lastQuestion(answer) || (answer.replace(/`[^`]*`/g, '').match(/[^.!?\n]{3,}[.!?]?/g) || ['']).pop() || '')
}

// A background command shown on the shared board (a job with no description): the program and up to
// two plain arguments after it, stopping at the first option, so passwords and tokens never show.
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
    // The board tool by any name the host gives it (ArtifactData, or a prefixed form of it).
    const ok = (/(^|__)ArtifactData$/.test(String(e.tool)) && input.url === BOARD)
      || LIST.test(e.tool)
      || (e.tool === 'ToolSearch' && input.query === 'select:ArtifactData')
    return ok ? { decision: 'allow' as const } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // /board-status is the plugin's skill (skills/board-status); this command only shows what the mod sees.
    try { await $.command.register({ name: 'board-info', description: 'Show which Status Board card and thread this chat updates' }) } catch {}
    try { sessionId = await $.session.id() } catch {}
    remoteId = await findRemoteId($)
    try { await limit($, findBoard($), 3000, 'board lookup') } catch {}
    trace($, `session.start: remote ${remoteId || 'none'}, board ${BOARD}`)
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
      if (ms > 500) { try { await limit($, setStatus($, '', true), ms, 'end stamp') } catch {} }
    }
    return next(e)
  })

  // One section at the end of the system prompt, telling the model what the mod did and needs.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const traits = e.traits || []
    // A one-shot run (-p) gets no note; a Remote Control thread also runs as print, but has a remote id.
    if (!sessionId || traits.includes('teammate') || (traits.includes('print') && !found && !remoteId)) return r
    // The note may be composed once for the whole session: give the lookup a few seconds first, so
    // it says what this chat needs rather than "looking up".
    if (!initDone) { try { await limit($, initPromise, 4000, 'lookup') } catch {} }
    const text = boardNote(!traits.includes('analysis'))
    return { sections: [...r.sections.filter(s => s.id !== NOTE_ID), { id: NOTE_ID, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board-info' }, async () => ({ text: describe() }))

  // The model's own thread-listing call (on /board-status): kept for the next status write, and used
  // at once to place a chat that is not on a card yet.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool || '')
    // A message the thread sends the user (a project thread's reply tool): its "Waiting on you" line.
    if (e.agentId === undefined && /(^|__)reply$/.test(tool)) {
      replyText = String((e as unknown as Record<string, unknown>).text ?? '')
      const said = waitingSaid(replyText)
      if (said) asksSaid = said
      return next(e)
    }
    if (e.agentId !== undefined || !LIST.test(tool)) return next(e)
    const r = await next(e)
    const l = readListing(r as unknown as ToolResult)
    if (l) {
      seenList = l
      if (!found && remoteId && initDone && !noBoard) void placeFrom($, l.list)
    }
    return r
  })

  // What still runs when the main loop stops: the thread's jobs list, written when it changes.
  on('classic.Stop', async ($, e, next) => {
    const tasks = Array.isArray((e as any).background_tasks) ? (e as any).background_tasks as Record<string, unknown>[] : []
    jobsNow = tasks.filter(t => t && !/^(completed|failed|killed|stopped|done)$/i.test(String(t.status || ''))).map(t => ({
      text: oneLine(String(t.description || '') || jobText(String(t.type || 'job'), t.command)).slice(0, 80),
      type: String(t.type || ''), id: String(t.id || ''),
    }))
    if (found && initDone && JSON.stringify(jobsNow) !== jobsWritten) void setStatus($, '')
    return next(e)
  })

  // Main-loop turns only.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnSeq++
      turnActive = true
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
    const reason = e.reason
    if (composedReport && reason === 'answer') reportedText = composedReport
    composedReport = ''
    if (!sessionId) return out
    const seq = turnSeq
    // What the user read this turn: a project thread's reply when it sent one, else the final answer.
    const answer = replyText || String(e.answer || '')
    replyText = ''
    { const said = waitingSaid(String(e.answer || '')); if (said) asksSaid = said }
    // The rest runs in the background so the turn ends at once; a newer turn's status wins.
    void (async () => {
      try {
        await initPromise                     // a first turn can end before the lookup has
        if (noBoard || coordinator || seq !== turnSeq) return
        if (!found) found = await indexLookup($)                     // the user may have placed this chat
        if (!found && remoteId) {                                   // a listing this turn, the model's or the mod's
          const l = seenList ? seenList.list : await projectThreads($)
          if (l) await placeFrom($, l)
        }
        if (found && registeredHere) {                               // a listing may have named the entry
          const card = await getCard($, found.cardId)
          const f = card ? findIn([card]) : null
          if (f) { found = f; registeredHere = f.label === PLACEHOLDER }
        }
        if (seq !== turnSeq) return
        if (!found) { await markUnmatched($); return }
        let d: { status: string; waiting?: string } = reason === 'answer' ? await decide($, answer) : { status: 'idle' }
        // A turn that lists what waits on the user is waiting on the user, whatever the classifier said.
        if (asksSaid && asksSaid.length) d = { status: 'waiting_on_you', waiting: asksSaid[0] }
        if (seq !== turnSeq) return
        await setStatus($, d.status, undefined, d.waiting)
        if (found) await checkMail($, found.cardId)
        await markUnmatched($)
      } catch (err) { say($, `board: end of turn failed (${msg(err).slice(0, 60)})`) }
    })()
    return out
  })
}
