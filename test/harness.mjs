// Run from the repo root: npm i --no-save typescript && node test/tests.mjs
import fs from 'fs'; import os from 'os'; import path from 'path'; import ts from 'typescript'
const BOARD = 'https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF'
export async function load() {
  const src = fs.readFileSync(process.env.SRC || new URL('../hooks/register.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const f = path.join(os.tmpdir(), `status-board-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`); fs.writeFileSync(f, js)
  try { return (await import(f)).register } finally { fs.rmSync(f, { force: true }) }
}
const tick = (ms) => new Promise(r => setTimeout(r, ms))
export const settle = () => tick(60)
export function makeEnv(opts) {
  const db = { projects: {}, sessions: {}, diagnostics: {}, ...structuredClone(opts.db || {}) }
  const ver = {}; const writes = []; const statuses = []
  const doc = (c, id) => db[c]?.[id]
  const fmt = (c, id) => JSON.stringify({ id, data: db[c][id], version: ver[c + '/' + id] || 1 })
  function artifact(a) {
    if (a.url !== BOARD) return { isError: true, text: 'wrong board' }
    const c = a.collection, id = a.doc_id, key = c + '/' + id
    if (a.action === 'get') { if (!doc(c, id)) return { isError: true, text: `No document "${id}" in collection "${c}".` }; return { text: '=== BEGIN ===\n' + fmt(c, id) + '\n=== END ===' } }
    if (a.action === 'list') return { text: '=== BEGIN ===\n' + Object.keys(db[c] || {}).map(i => fmt(c, i)).join('\n') + '\n=== END ===' }
    if (a.action === 'set' || a.action === 'update') {
      const exists = !!doc(c, id)
      if (exists && a.if_version !== (ver[key] || 1)) return { isError: true, text: `Write refused: document is at version ${ver[key] || 1}` }
      if (!db[c]) db[c] = {}
      db[c][id] = a.action === 'set' ? structuredClone(a.data) : { ...db[c][id], ...structuredClone(a.data) }
      ver[key] = exists ? (ver[key] || 1) + 1 : 1; writes.push({ c, id, data: structuredClone(a.data) })
      return { text: `Database ${a.action} committed. The document is now at version ${ver[key]}.` }
    }
    return { isError: true, text: 'bad action' }
  }
  const handlers = {}
  const on = (ev, a, b) => { const h = b || a; (handlers[ev] ||= []).push(h); return { catch: () => {} } }
  const state = { id: opts.sessionId || 'aaaaaaaa-1111-2222-3333-444444444444', remote: opts.remote === undefined ? 'cse_01REMOTEaaaaaaaaaaaaaaaa' : opts.remote, latency: opts.latency, classify: opts.classify, tools: opts.tools || ['Bash', 'ArtifactData'], listing: opts.listing }
  const $ = {
    plugin: { name: 'status-board' },
    tool: {
      list: async () => state.tools.map(name => ({ name })),
      call: async (i) => {
        if (i.tool === 'ArtifactData') { if (opts.noArtifactData) throw new Error('No tool matches ArtifactData'); await tick(state.latency ?? 2); if (state.boardError) return { isError: true, text: state.boardError }; return artifact(i) }
        if (i.tool === 'ToolSearch') return { text: 'no match' }
        if (/list_thread_sessions$/.test(i.tool) && state.listing) return { text: JSON.stringify(state.listing) }
        throw new Error('No tool matches ' + i.tool)
      },
    },
    clock: {
      sleep: (ms, o) => new Promise((res, rej) => { const t = setTimeout(res, ms / 100); o?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }) }),
      after: (ms, fn) => { const t = setTimeout(fn, ms / 100); return { cancel: () => clearTimeout(t) } },
    },
    env: { get: async (n) => n === 'CLAUDE_CODE_REMOTE_SESSION_ID' ? (state.remote || undefined) : undefined },
    session: { id: async () => state.id, repo: async () => opts.repo || null, root: async () => opts.cwd || '/home/x', cwd: async () => opts.cwd || '/home/x' },
    ui: { status: (s) => statuses.push(s), invalidate: () => {} },
    model: { classify: async (t, labels) => { const k = typeof state.classify === 'function' ? await state.classify(t) : state.classify; return k === undefined ? undefined : labels[k] },
      complete: async (req) => { state.lastPrompt = req.prompt; return state.summary ? { isAnswered: true, text: state.summary } : { isAnswered: false, reason: 'api-error' } } },
    command: { register: async () => {} },
    fs: { read: async () => '' },
  }
  const next = (r) => { const f = async (e) => r ?? e; f.budget = { remainingMs: 5000 }; f.origin = { plugin: 'engine' }; return f }
  async function fire(ev, e = {}, nextResult) { let out = nextResult; for (const h of handlers[ev] || []) out = await h($, e, next(nextResult)); return out }
  async function note(traits = []) { const r = await fire('prompt.compose', { traits }, { sections: [] }); return r.sections.find(s => s.id === 'status-board:note')?.text || '' }
  return { db, writes, statuses, handlers, $, fire, note, state, on, entry: (card) => (db.projects[card]?.threads || []).find(t => t.transcript === state.id || (state.remote && t.session === state.remote)) }
}
