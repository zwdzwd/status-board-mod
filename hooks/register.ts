import type { Register, EngineInterface as Engine } from 'claude-code'

// The Status Board artifact. Each project has a card in its "projects" collection; each card lists
// its chats under "threads", and a thread entry carries this session's id in its transcript field.
const BOARD = 'https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF'

type Thread = { label?: string; url?: string; session?: string; transcript?: string; status?: string; at?: string; job?: string; ended?: string }
type Card = { id: string; version: number; data: Record<string, unknown> }
type Found = { cardId: string; name: string; label: string }
// Job values with a meaning of their own: keep (or start) a job; a tool run's temporary job; restore
// the job the entry had before the tool run.
const KEEP = '__keep__'
const TOOL = '__tool__:'
const RESTORE = '__restore__'
let prevJob: string | undefined       // the entry's job before a tool run replaced it

let sessionId = ''
let found: Found | null = null
let lastWrite = ''
let registeredHere = false     // this session added its own entry (label and url still to be filled by the thread)
let coordinator: { cardId: string; name: string } | null = null   // this session is a project conversation, not a thread
let coordinatorProblem = ''   // why the coordinator could not be tied to a card (or write its record); shown to the model so it tells the user
let busy: Promise<void> = Promise.resolve()
let lastCard: Card | null = null      // the card as last read or written, for the one-call write at session end

// Session ids are stored as "session_…", "cse_…" or a bare UUID; compare loosely, against any
// string field of the thread entry (transcript, session, or whatever the thread stored).
function norm(s: unknown): string { return String(s ?? '').trim().replace(/^cse_/, 'session_') }
function same(a: unknown, b: unknown): boolean {
  const x = norm(a), y = norm(b)
  return x !== '' && y !== '' && (x === y || x.endsWith(y) || y.endsWith(x))
}
function mine(t: Thread): boolean {
  return Object.values(t).some(v => typeof v === 'string' && !/^https?:/.test(v) && same(v, sessionId))
}
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, '') }

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

let lastError = ''   // the last failed board call, shown in the note when the mod could not do its work
async function call($: Engine, args: Record<string, unknown>, ms = 15000): Promise<string> {
  try { return await callRaw($, args, ms) } catch (err) { lastError = `${String(args.action)} ${String(args.collection ?? '')}: ${String(err).slice(0, 160)}`; throw err }
}
let loadedTool = false   // whether ArtifactData was loaded through ToolSearch (a session may list it as deferred)
async function callRaw($: Engine, args: Record<string, unknown>, ms = 15000): Promise<string> {
  const once = async (): Promise<ToolResult> => Promise.race([
    $.tool.call({ tool: 'ArtifactData', url: BOARD, ...args } as any) as Promise<ToolResult>,
    $.clock.sleep(ms).then(() => { throw new Error('board call timed out') }),
  ])
  let r: ToolResult
  try { r = await once() } catch (err) { r = { isError: true, text: String(err) } }
  const missing = (x: ToolResult) => /unknown tool|not found|no such tool|not available|not loaded|deferred|unavailable/i.test(String(x.deny ?? x.text ?? ''))
  if ((r.isError || r.deny !== undefined) && missing(r) && !loadedTool) {
    loadedTool = true
    try { await $.tool.call({ tool: 'ToolSearch', query: 'select:ArtifactData', max_results: 1 } as any) } catch {}
    try { r = await once() } catch (err) { r = { isError: true, text: String(err) } }
  }
  if (r.deny !== undefined) throw new Error(String(r.deny))
  if (r.isError) throw new Error(String(r.text ?? 'ArtifactData failed'))
  return String(r.text ?? '')
}

// The whole board, for finding or guessing a card. A long listing comes back as a saved file, not as
// text, so read that file when the text holds no documents.
async function cards($: Engine): Promise<Card[]> {
  const text = await call($, { action: 'list', collection: 'projects', query: { limit: 200 } })
  let docs = parseDocs(text)
  if (!docs.length) {
    const m = /(\/[^\s"']+\.(?:txt|json|md))/.exec(text)
    if (m) { try { docs = parseDocs(await $.fs.read(m[1])) } catch {} }
  }
  return docs
}

// The index: sessions/<session id> -> { card, label }, so a session finds its card with one small read.
async function indexLookup($: Engine): Promise<Found | null> {
  try {
    const d = parseDocs(await call($, { action: 'get', collection: 'sessions', doc_id: sessionId }))[0]
    const cardId = d && typeof d.data.card === 'string' ? d.data.card : ''
    if (!cardId) return null
    const card = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: cardId }))[0]
    if (!card) return null
    if (d.data.role === 'coordinator') return null
    return findIn([card])
  } catch { return null }
}
async function indexWrite($: Engine, f: Found): Promise<void> {
  try {
    const d = parseDocs(await call($, { action: 'get', collection: 'sessions', doc_id: sessionId }))[0]
    const args: Record<string, unknown> = { action: 'set', collection: 'sessions', doc_id: sessionId, data: { card: f.cardId, label: f.label, version: VERSION, at: new Date().toISOString() } }
    if (d) args.if_version = d.version
    await call($, args)
  } catch {}
}
async function locate($: Engine): Promise<Found | null> {
  return (await indexLookup($)) || findIn(await cards($))
}
function threadsOf(c: Card): Thread[] { return Array.isArray(c.data.threads) ? (c.data.threads as Thread[]) : [] }

// Which card and thread this session is: the thread entry that carries our session id.
function findIn(docs: Card[]): Found | null {
  for (const d of docs) {
    const t = threadsOf(d).find(t => t && mine(t))
    if (t) return { cardId: d.id, name: String(d.data.name ?? d.id), label: String(t.label ?? 'Thread') }
  }
  return null
}

// Which card this session's project is, when the thread isn't registered yet: the card whose repo
// field matches the session's git remote, or whose id matches the repository or working folder's name.
async function guessCard($: Engine, docs: Card[]): Promise<Card | null> {
  const names: string[] = []
  let remote = ''
  try {
    const repo = await $.session.repo()
    if (repo) {
      if (repo.name) names.push(repo.name.split('/').pop() || '')
      if (repo.remote) { remote = repo.remote.replace(/\.git$/, '').toLowerCase(); names.push(remote.split(/[/:]/).pop() || '') }
      names.push(repo.root.split('/').pop() || '')
    }
  } catch {}
  try { names.push((await $.session.root()).split('/').pop() || '') } catch {}
  try { names.push((await $.session.cwd()).split('/').pop() || '') } catch {}
  if (remote) {
    const tail = remote.split(/[/:]/).slice(-2).join('/')
    for (const d of docs) {
      const r = typeof d.data.repo === 'string' ? d.data.repo.toLowerCase().replace(/\.git$/, '') : ''
      if (r && (remote.endsWith(r) || r.endsWith(tail))) return d
    }
  }
  for (const n of names.map(slug).filter(Boolean)) {
    const d = docs.find(d => slug(d.id) === n || slug(String(d.data.name ?? '')) === n)
    if (d) return d
  }
  return null
}

// Add this session as a thread of a card. Label and url are unknown to the mod; the thread's own
// Claude fills them in on its first turn (the system-prompt note asks for that).
async function registerThread($: Engine, card: Card): Promise<Found | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: card.id }))[0]
    if (!fresh) return null
    const existing = findIn([fresh]); if (existing) return existing
    const now = new Date().toISOString()
    const th = threadsOf(fresh).concat([{ label: 'New thread', session: sessionId, transcript: sessionId, status: 'idle', at: now, job: '' }])
    try {
      await call($, { action: 'update', collection: 'projects', doc_id: card.id, if_version: fresh.version, data: { threads: th } })
      registeredHere = true
      const f = { cardId: fresh.id, name: String(fresh.data.name ?? fresh.id), label: 'New thread' }
      void indexWrite($, f)
      return f
    } catch (err) { if (!/version/i.test(String(err))) throw err }
  }
  return null
}

// Write this thread's status, touching nothing else on the card. Re-reads first so other
// threads' entries are kept and the write is pinned to the current version.
// job: undefined leaves the thread's job field alone; "" clears it; KEEP keeps or starts one.
// ended: true stamps the entry as ended (the board dims it after a day); false clears the stamp.
function setStatus($: Engine, status: string, job?: string, ended?: boolean): Promise<void> {
  const run = busy.then(async () => {
    if (!found) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: found.cardId }))[0]
      if (!card) return
      lastCard = card
      const now = new Date().toISOString()
      const th = threadsOf(card).map(t => {
        if (!t || !mine(t)) return t
        const n: Thread = { ...t, status, at: now }
        if (job !== undefined) {
          if (job === KEEP) n.job = (typeof t.job === 'string' && t.job.trim()) || ('background work since ' + now.slice(11, 16) + ' UTC')
          else if (job.startsWith(TOOL)) { prevJob = typeof t.job === 'string' ? t.job : ''; n.job = job.slice(TOOL.length) }
          else if (job === RESTORE) { n.job = prevJob ?? ''; prevJob = undefined }
          else n.job = job
        }
        if (ended === true) n.ended = now
        if (ended === false) delete n.ended
        return n
      })
      try {
        const res = await call($, { action: 'update', collection: 'projects', doc_id: found.cardId, if_version: card.version, data: { threads: th } })
        const v = /version (\d+)/.exec(res); if (v) lastCard = { ...card, version: Number(v[1]), data: { ...card.data, threads: th } }
        lastWrite = status
        $.ui.status(`board: ${found.name} / ${found.label} → ${status.replace(/_/g, ' ')}${job !== undefined && job !== '' && job !== RESTORE ? ' + job running' : ''}`)
        return
      } catch (err) {
        if (!/version/i.test(String(err))) throw err   // a concurrent write: read again and retry once
      }
    }
  }).catch((err: unknown) => { $.ui.status(`board: write failed (${String(err).slice(0, 60)})`) })
  busy = run
  return run
}

// ---- Coordinator: reconcile the card's thread list with the project's threads, as code ----
type ProjThread = { ids: string[]; name: string; open: boolean }

// Pull thread-like records out of whatever the listing tool returns (JSON text, nested lists).
function harvest(v: unknown, out: ProjThread[], depth = 0): void {
  if (!v || depth > 8) return
  if (Array.isArray(v)) { v.forEach(x => harvest(x, out, depth + 1)); return }
  if (typeof v === 'string') { try { harvest(JSON.parse(v), out, depth + 1) } catch {} return }
  if (typeof v !== 'object') return
  const o = v as Record<string, unknown>
  const idKeys = ['thread_id', 'threadId', 'id', 'session_id', 'sessionId', 'cmsg_id', 'message_id']
  const ids = idKeys.map(k => o[k]).filter(x => typeof x === 'string' && x.length > 3) as string[]
  const name = ['name', 'title', 'label', 'thread_name'].map(k => o[k]).find(x => typeof x === 'string' && x.trim()) as string | undefined
  const st = ['status', 'state', 'thread_status', 'session_status', 'resolution'].map(k => o[k]).find(x => typeof x === 'string') as string | undefined
  const flag = ['resolved', 'is_resolved', 'archived', 'is_archived', 'closed'].some(k => o[k] === true)
  if (ids.length && name) {
    const open = !flag && !/resolved|archived|closed|deleted/i.test(st || '')
    out.push({ ids, name: name.trim(), open })
  }
  for (const k of Object.keys(o)) { const x = o[k]; if (x && (typeof x === 'object' || (typeof x === 'string' && x.length > 20 && /[\[{]/.test(x)))) harvest(x, out, depth + 1) }
}

const VERSION = '0.7.12'

// The project conversation is the one session that has the thread-listing tool. The tool list
// handed to a mod does not always include it, so when the list has no such name the mod tries
// the call itself once: a session that can list threads is the coordinator, whatever the list says.
let listTool: string | null = null      // '' once probed and absent
let probed: ToolResult | null = null    // the probe's listing, used by the first projectThreads
let toolNames: string[] = []
type ToolResult = { deny?: unknown; isError?: boolean; text?: string; result?: unknown }
async function listToolName($: Engine): Promise<string> {
  if (listTool !== null) return listTool
  try { toolNames = (await $.tool.list()).map(t => t.name) } catch { toolNames = [] }
  // Exact name only (there are other list_thread_* tools); any server prefix is fine.
  let n = toolNames.find(x => /(^|__)list_thread_sessions$/.test(x)) || ''
  if (!n) {
    // Not listed: try the call under the prefixes the sibling project tools use, then bare.
    const prefixes = [...new Set(toolNames.filter(x => /__(list|start|rename|set)_thread/.test(x)).map(x => x.slice(0, x.lastIndexOf('__') + 2)))]
    for (const cand of [...prefixes.map(p => p + 'list_thread_sessions'), 'mcp__hearthbot__list_thread_sessions', 'list_thread_sessions']) {
      try {
        const r = await Promise.race([
          $.tool.call({ tool: cand } as any) as Promise<ToolResult>,
          $.clock.sleep(15000).then(() => { throw new Error('probe timed out') }),
        ])
        if (r && r.deny === undefined && !r.isError) { n = cand; probed = r; break }
      } catch {}
    }
  }
  listTool = n
  return n
}

// A coordinator's card: the one whose thread entries carry this project's thread or session ids;
// else the index record; else nothing (the note then asks the model to write the record once).
async function detectCoordinator($: Engine): Promise<void> {
  const tool = await listToolName($)
  if (!tool) return
  let cardId = '', name = '', cardsSeen = -1, how = ''
  const list = await projectThreads($)
  let all: Card[] = []
  try { all = await cards($) } catch (err) { void diag($, 'cards failed', String(err).slice(0, 500)) }
  cardsSeen = all.length
  if (list) {
    const ids = list.flatMap(p => p.ids)
    for (const c of all) {
      if (threadsOf(c).some(t => t && ids.some(i => sameId(i, threadIdOf(t)) || sameId(i, String(t.session || ''))))) { cardId = c.id; name = String(c.data.name ?? c.id); how = 'thread ids'; break }
    }
  }
  // No card carries this project's threads yet: fall back to the card named like the project
  // (its repo, remote or folder name), so a fresh project still lands on its card.
  if (!cardId && all.length) {
    try { const g = await guessCard($, all); if (g) { cardId = g.id; name = String(g.data.name ?? g.id); how = 'project name' } } catch {}
  }
  if (!cardId) {
    try {
      const d = parseDocs(await call($, { action: 'get', collection: 'sessions', doc_id: sessionId }))[0]
      if (d && typeof d.data.card === 'string') { cardId = d.data.card; how = 'index record'; const c = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: cardId }))[0]; name = c ? String(c.data.name ?? cardId) : cardId }
    } catch {}
  }
  coordinator = cardId ? { cardId, name } : { cardId: '', name: '' }
  let note = ''
  try {
    const d = parseDocs(await call($, { action: 'get', collection: 'sessions', doc_id: sessionId }))[0]
    const args: Record<string, unknown> = { action: 'set', collection: 'sessions', doc_id: sessionId, data: { card: cardId, role: 'coordinator', version: VERSION, tool, matched: how, at: new Date().toISOString() } }
    if (d) args.if_version = d.version
    await call($, args)
  } catch (err) { note = 'record write failed: ' + String(err).slice(0, 200) }
  if (!cardId) coordinatorProblem = `no card matched: ${list ? list.length + ' thread(s) listed' : 'thread listing unreadable'}, ${cardsSeen < 0 ? 'board unreadable' : cardsSeen + ' cards read'}, no card named like this project${note ? '; ' + note : ''}`
  else coordinatorProblem = note
  if (!cardId || note) void diag($, 'coordinator detection', JSON.stringify({ tool, listed: list ? list.map(p => ({ name: p.name, ids: p.ids, open: p.open })) : null, cardsSeen, cardId, how, note }).slice(0, 6000))
}

// A diagnostic the board's owner can read: what the thread listing looked like when it could not be used.
async function diag($: Engine, what: string, sample: string): Promise<void> {
  try {
    const d = parseDocs(await call($, { action: 'get', collection: 'diagnostics', doc_id: sessionId }))[0]
    const args: Record<string, unknown> = { action: 'set', collection: 'diagnostics', doc_id: sessionId, data: { what, sample, version: VERSION, at: new Date().toISOString() } }
    if (d) args.if_version = d.version
    await call($, args)
  } catch {}
}

async function projectThreads($: Engine): Promise<ProjThread[] | null> {
  const name = await listToolName($)
  if (!name) return null
  let r: ToolResult
  if (probed) { r = probed; probed = null }
  else r = await Promise.race([
    $.tool.call({ tool: name } as any) as Promise<ToolResult>,
    $.clock.sleep(20000).then(() => { throw new Error('thread listing timed out') }),
  ])
  if (r.deny !== undefined || r.isError) { void diag($, 'listing failed', String(r.deny ?? r.text ?? '').slice(0, 1500)); return null }
  const out: ProjThread[] = []
  harvest(r.result, out); if (!out.length) harvest(r.text, out)
  if (!out.length) void diag($, 'listing not understood', JSON.stringify({ text: String(r.text ?? '').slice(0, 3000), result: r.result }).slice(0, 6000))
  // one record per thread: merge duplicates by shared id
  const merged: ProjThread[] = []
  for (const t of out) { const m = merged.find(x => x.ids.some(i => t.ids.includes(i))); if (m) { m.ids = [...new Set([...m.ids, ...t.ids])]; m.open = m.open && t.open } else merged.push(t) }
  return merged.length ? merged : null
}

const threadIdOf = (t: Thread) => { const m = /[?&]thread=([A-Za-z0-9_]+)/.exec(String(t.url || '')); return m ? m[1] : '' }
const sameId = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x)) }

async function syncThreadList($: Engine, cardId: string): Promise<string> {
  const list = await projectThreads($)
  if (!list) return 'no thread list'
  for (let attempt = 0; attempt < 2; attempt++) {
    const card = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: cardId }))[0]
    if (!card) return 'no card'
    const before = threadsOf(card)
    const matchOf = (t: Thread) => list.find(p => p.ids.some(i => sameId(i, threadIdOf(t)) || sameId(i, String(t.session || ''))) ) || list.find(p => p.name.toLowerCase() === String(t.label || '').toLowerCase())
    const kept: Thread[] = []
    const used = new Set<ProjThread>()
    for (const t of before) {
      if (!t) continue
      const m = matchOf(t)
      if (!m) continue                       // not a thread the project knows: resolved, archived or gone
      if (!m.open) continue                  // resolved
      if (used.has(m)) continue              // a duplicate entry for the same thread
      used.add(m)
      kept.push(m.name && m.name !== t.label ? { ...t, label: m.name } : t)
    }
    const base = (before.map(t => String((t && t.url) || '')).find(u => /\?thread=/.test(u)) || '').split('?')[0]
    for (const p of list) {
      if (!p.open || used.has(p)) continue
      const tid = p.ids.find(i => /^cmsg_/.test(i)) || ''
      kept.push({ label: p.name, url: base && tid ? `${base}?thread=${tid}` : undefined, session: p.ids.find(i => /^(cse|session)_/.test(i)) })
    }
    const changed = JSON.stringify(kept) !== JSON.stringify(before)
    if (!changed) return 'in sync'
    try {
      await call($, { action: 'update', collection: 'projects', doc_id: cardId, if_version: card.version, data: { threads: kept } })
      return `synced: ${kept.length} open thread${kept.length === 1 ? '' : 's'}`
    } catch (err) { if (!/version/i.test(String(err))) throw err }
  }
  return 'retry later'
}

// The coordinator's own status lives in the card's `coordinator` field (the board shows it as a
// stripe on the card's edge); it is not a thread entry. Pinned write, one retry on a concurrent edit.
let coordBusy: Promise<void> = Promise.resolve()
function setCoordStatus($: Engine, status: string, ended?: boolean): Promise<void> {
  const run = coordBusy.then(async () => {
    const co = coordinator; if (!co || !co.cardId) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const card = parseDocs(await call($, { action: 'get', collection: 'projects', doc_id: co.cardId }))[0]
      if (!card) return
      const prev = (card.data.coordinator && typeof card.data.coordinator === 'object') ? card.data.coordinator as Record<string, unknown> : {}
      const now = new Date().toISOString()
      const rec: Record<string, unknown> = { ...prev, status, at: now, transcript: sessionId }
      if (ended === true) rec.ended = now; else delete rec.ended
      try { await call($, { action: 'update', collection: 'projects', doc_id: co.cardId, if_version: card.version, data: { coordinator: rec } }); return }
      catch (err) { if (!/version/i.test(String(err))) throw err }
    }
  }).catch((err: unknown) => { $.ui.status(`board: coordinator status write failed (${String(err).slice(0, 60)})`) })
  coordBusy = run
  return run
}

function describe(): string {
  if (coordinator) return `Status Board mod v${VERSION}. This session is the project conversation for the ${coordinator.name} card; it keeps the card's thread list and has no thread entry of its own.`
  return found
    ? `This chat is "${found.label}" on the ${found.name} card.${lastWrite ? ` Last status written: ${lastWrite.replace(/_/g, ' ')}.` : ''}`
    : `This chat is not on the Status Board: no card matched this project, and no thread entry carries this session's id ${sessionId}. Say "update the board" once; the project then writes its card and this thread's entry (transcript: ${sessionId}), and the mod takes over.`
}

// The thread's own Claude writes the rest of the card, so tell it what the mod did and needs.
function boardNote(): string {
  if (coordinator && !coordinator.cardId) return `Status Board mod v${VERSION}: active. This session is a project conversation (coordinator), but the mod could not tie it to a card (${coordinatorProblem || 'no card matches this project\'s threads or name'}). Do not stay silent about this: in your next reply, tell the user in one line that the Status Board mod could not find this project's card and why. Then, once, before other work: find or create this project's card by the rules (meta/instruction, field rules) and write sessions/${sessionId} = {card: <card id>, role: "coordinator"}; the mod then keeps the card's thread list in sync by itself. Never add a thread entry for yourself.`
  if (coordinator) return `Status Board mod v${VERSION}: active. This session is the project conversation (coordinator) for the ${coordinator.name} card (id ${coordinator.cardId}). The mod syncs the card's thread list with list_thread_sessions by itself at the end of every turn (resolved threads removed, new ones added, names taken from the list), so you need not touch the thread list. Never add an entry for yourself.${coordinatorProblem ? ` Note: the mod could not write its session record (${coordinatorProblem}); tell the user this in one line of your next reply.` : ''}`
  if (found && registeredHere) return `Status Board mod v${VERSION}: active. It added this chat to the ${found.name} card (id ${found.cardId}) as a thread entry with transcript ${sessionId} and the placeholder label "New thread". On your first turn in this session, before other work, read the board's rules (meta/instruction, field rules) and fix that entry: set label to this thread's name as the project's thread list shows it and url to this thread's link, keeping transcript as is; touch nothing else. The mod writes this thread's status and job by itself from then on.`
  if (found) return `Status Board mod v${VERSION}: active. This chat is thread "${found.label}" on the ${found.name} card (id ${found.cardId}). The mod writes this thread's status (thinking / waiting_on_you / idle) and job by itself; when you update the card, keep this thread's entry's transcript field as ${sessionId}.`
  return `Status Board mod v${VERSION}: active, but it could not match this session to a card on the board (${lastError ? 'its board call failed: ' + lastError : 'no card\'s repo or name matches this repository or folder, and no thread entry carries this session\'s id'}; thread-listing tool: ${listTool === null ? 'not probed yet' : listTool || 'none'}; ${toolNames.length} tools listed, Artifact tools: ${toolNames.filter(x => /artifact/i.test(x)).join(', ') || 'none'}). Do not stay silent about this: tell the user in one line of your next reply, including the reason in parentheses above. If this session is a project conversation (you start threads for the project), write sessions/${sessionId} = {card: <this project's card id>, role: "coordinator"} and keep the card's thread list in sync as the rules say; add no entry for yourself. If this session is a thread, on your first turn, before other work, read the board's rules (meta/instruction, field rules), find or create this project's card, add this thread's entry with transcript ${sessionId} (plus label, url, session), write sessions/${sessionId} = {card, label}, and set the card's repo field to this repository's owner/name so future threads register by themselves. The mod then writes this thread's status by itself.`
}

// What the reply means for the board: the chat's status, and whether work is still running elsewhere
// (a remote session, a SLURM job, CI, a build), which the board shows as "working" (green).
async function decide($: Engine, answer: string): Promise<{ status: string; job?: string }> {
  const ASK = 'the message asks the user a question, or waits for the user to decide, approve, confirm or provide something'
  const RUN = 'the message says work is still running and will report later: a job, a remote or background session, a build, a process the assistant is waiting on'
  const DONE = 'the message reports finished work or information; nothing is still running and nothing is asked of the user'
  try {
    const k = await $.model.classify(`The assistant's final message of a turn:\n\n${answer.slice(-3000)}`, [ASK, RUN, DONE])
    if (k === ASK) return { status: 'waiting_on_you' }            // leave any running job as it is
    if (k === RUN) return { status: 'idle', job: KEEP }
    return { status: 'idle', job: '' }
  } catch {
    return { status: /\?\s*$/m.test(answer) ? 'waiting_on_you' : 'idle' }
  }
}

export const register: Register = on => {
  // The board's own calls never need a permission dialog: this plugin's reads and writes of the board are allowed here.
  on('tool.check', ($, e, next) => {
    const base = (n: unknown) => String(n || '').split('@')[0].split('/').pop() || ''
    const o = base(next.origin && next.origin.plugin), me = base($.plugin.name)
    const mine = !!o && (o === me || o === 'status-board' || o.endsWith('status-board'))
    const ok = mine && (e.tool !== 'ArtifactData' || (e as any).url === BOARD)
    return ok ? { decision: 'allow' as const } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Show which Status Board card and thread this chat updates' })
    try { sessionId = await $.session.id() } catch {}
    // Board work runs in the background: it must never hold up the session's start.
    void (async () => {
      try {
        await detectCoordinator($)
        if (coordinator) { const co = coordinator; $.ui.invalidate('prompt.section'); if (!co.cardId) { $.ui.status('board: coordinator, card not matched yet'); return } try { $.ui.status(`board: coordinator of ${co.name}: ${await syncThreadList($, co.cardId)}`) } catch (err) { $.ui.status(`board: coordinator sync failed (${String(err).slice(0, 50)})`) } void setCoordStatus($, 'idle', false); return }
        found = await indexLookup($)
        if (!found) { const docs = await cards($); found = findIn(docs); if (!found) { const c = await guessCard($, docs); if (c) found = await registerThread($, c) } }
        if (found) { void indexWrite($, found); void setStatus($, 'idle', undefined, false); $.ui.status(`board: ${found.name} / ${found.label}`); $.ui.invalidate('prompt.section') }
        else {
          $.ui.status('board: project not matched; the thread registers itself on its first turn')
          let repo: unknown = null, root = '', cwd = ''
          try { repo = await $.session.repo() } catch {} try { root = await $.session.root() } catch {} try { cwd = await $.session.cwd() } catch {}
          void diag($, 'no match', JSON.stringify({ listTool, repo, root, cwd, tools: toolNames.slice(0, 80) }).slice(0, 6000))
        }
      } catch (err) {
        if (!lastError) lastError = 'init: ' + String(err).slice(0, 160)
        $.ui.status(`board: could not read the board (${String(err).slice(0, 60)})`)
      } finally {
        $.ui.invalidate('prompt.section')   // the note is read before this finishes; refresh it with the outcome
      }
    })()
    return next(e)
  })

  // When the session ends (the thread was resolved, or stopped after idling), stamp the entry as ended.
  // The board hides an ended entry an hour later unless the thread is reopened, which clears the stamp.
  // One write, pinned to the last version seen, since this hook runs under a short time bound.
  on('session.end', async ($, e, next) => {
    if (coordinator && coordinator.cardId) { try { await Promise.race([setCoordStatus($, 'idle', true), $.clock.sleep(4000)]) } catch {} }
    if (found && lastCard) {
      const now = new Date().toISOString()
      const th = threadsOf(lastCard).map(t => (t && mine(t)) ? { ...t, status: 'idle', at: now, ended: now } : t)
      try { await call($, { action: 'update', collection: 'projects', doc_id: found.cardId, if_version: lastCard.version, data: { threads: th } }, 4000) }
      catch {}
    }
    return next(e)
  })

  // Adds one line to the system prompt so the thread knows what the mod did and what it needs.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!sessionId) return r
    return { sections: [...r.sections.filter(s => s.id !== 'status-board:note'), { id: 'status-board:note', text: boardNote(), scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async ($, e, next) => {
    if (!found) { try { found = await locate($); if (found) void indexWrite($, found) } catch {} }
    return { text: describe() }
  })

  // While a command runs on a machine for more than a few seconds (a shell, a remote computer, a
  // browser), the thread is waiting on that machine, not thinking: show it as working (green).
  let toolDepth = 0, toolTimer: { cancel: () => void } | null = null, toolShown = false
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool || '')
    if (e.agentId !== undefined || !found || !/bash|shell|device|computer|remote|browser|ssh|slurm/i.test(name)) return next(e)
    const cmd = typeof (e as any).command === 'string' ? ': ' + String((e as any).command).replace(/\s+/g, ' ').slice(0, 60) : ''
    toolDepth++
    if (toolDepth === 1) { toolShown = false; toolTimer = $.clock.after(5000, () => { toolShown = true; void setStatus($, 'working', TOOL + name.replace(/^mcp__/, '') + cmd) }) }
    try { return await next(e) }
    finally {
      toolDepth--
      if (toolDepth === 0) { if (toolTimer) toolTimer.cancel(); toolTimer = null; if (toolShown) { toolShown = false; void setStatus($, 'thinking', RESTORE) } }
    }
  })

  // Main-loop turns only: thinking at the start; waiting on you / idle (+ job) at the end.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && found) void setStatus($, 'thinking')
    if (e.agentId === undefined && coordinator && coordinator.cardId) void setCoordStatus($, 'thinking')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    if (!coordinator && !found) { try { await detectCoordinator($) } catch {} }
    if (coordinator) { let co = coordinator; if (!co.cardId) { await detectCoordinator($); co = coordinator || co; if (!co.cardId) return out; $.ui.invalidate('prompt.section') }
      try { $.ui.status(`board: coordinator of ${co.name}: ${await syncThreadList($, co.cardId)}`) } catch (err) { $.ui.status(`board: coordinator sync failed (${String(err).slice(0, 50)})`) }
      const cd = e.isAborted ? { status: 'idle' } : await decide($, e.answer || '')
      void setCoordStatus($, cd.status)
      return out }
    if (!found || registeredHere) {   // the thread may have registered or relabelled itself during this turn
      try { const f = await locate($); const co = coordinator as { cardId: string; name: string } | null
        if (co) { $.ui.invalidate('prompt.section'); try { $.ui.status(`board: coordinator of ${co.name}: ${await syncThreadList($, co.cardId)}`) } catch {} return out }
        if (f) { found = f; registeredHere = false; void indexWrite($, f); $.ui.invalidate('prompt.section'); $.ui.status(`board: ${f.name} / ${f.label}`) } } catch {}
      if (!found) return out
    }
    toolDepth = 0; if (toolTimer) { toolTimer.cancel(); toolTimer = null }
    const d = e.isAborted ? { status: 'idle' } : await decide($, e.answer || '')
    void setStatus($, d.status, d.job === undefined && toolShown ? RESTORE : d.job); toolShown = false
    return out
  })
}
