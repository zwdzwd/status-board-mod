import { load, makeEnv, settle } from './harness.mjs'
const BOARD = 'https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T'
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg) } }
const card = (threads = []) => ({ projects: { methscope: { name: 'MethScope', repo: 'zhou-lab/MethScope', threads } } })
async function env(opts) { const register = await load(); const E = makeEnv(opts); register(E.on); return E }

console.log('A. new thread with a listing registers on the card holding its project\'s threads; the note waits for the lookup')
{ const listing = { sessions: [{ session_id: 'cse_01REMOTEaaaaaaaaaaaaaaaa', thread_id: 'cmsg_ME', title: 'New thread', status: 'active' }, { session_id: 'cse_X', thread_id: 'cmsg_X', title: 'Writing', status: 'active' }] }
  const E = await env({ db: card([{ label: 'Writing', session: 'cse_X', url: 'u' }]), tools: ['ArtifactData', 'mcp__hb__list_threads'], listing, repo: { remote: 'git@github.com:zhou-lab/MethScope.git', name: 'MethScope', root: '/w/MethScope' } })
  await E.fire('session.start', {})
  ok(!/looking up/.test(await E.note()), 'note composed after the lookup')
  await settle()
  const t = E.entry('methscope'); ok(t && t.label === 'New thread', 'entry added with placeholder')
  ok(E.db.projects.methscope.threads.length === 2, 'other entry kept')
  ok(/placeholder "New thread"/.test(await E.note()), 'note says the entry waits for its name')
  ok(E.db.sessions[E.state.id]?.card === 'methscope', 'index written')
  await E.fire('turn.start', {}); await settle(); ok(E.entry('methscope').status === 'thinking', 'thinking at turn start')
  E.state.classify = 0
  t.label = 'Revision'; E.state.listing.sessions[0].title = 'Revision' // the thread is named (no url)
  E.db.projects.methscope.threads = E.db.projects.methscope.threads.map(x => x.transcript === E.state.id ? { ...x, label: 'Revision' } : x)
  await E.fire('turn.complete', { answer: 'Shall I push?', reason: 'answer' }); await settle()
  ok(E.entry('methscope').status === 'waiting_on_you', 'waiting_on_you after a question')
  ok(/thread "Revision"/.test(await E.note()), 'placeholder note ends once the label is fixed (no url needed)') }

console.log('B. a folder named like a generic word does not match a card')
{ const E = await env({ db: { projects: { claude: { name: 'Claude', threads: [] } } }, cwd: '/home/claude' })
  await E.fire('session.start', {}); await settle()
  ok(!E.db.projects.claude.threads.length, 'no entry added to the "Claude" card')
  ok(/not on a Status Board card yet/.test(await E.note()) && !/Tell the user/.test(await E.note()), 'unplaced chat: the board shows it, no message to the user') }

console.log('C. background jobs reported at stop become the entry\'s jobs list; none clears it')
{ const E = await env({ db: card([{ label: 'HPC', session: 'cse_01REMOTEaaaaaaaaaaaaaaaa', job: 'SLURM 123 running', status: 'idle' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('classic.Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Run the test suite' }, { id: 'b2', type: 'subagent', status: 'completed', description: 'old' }] }); await settle()
  let t = E.entry('methscope')
  ok(JSON.stringify(t.jobs) === JSON.stringify([{ text: 'Run the test suite', type: 'shell', id: 'b1' }]) && t.job === undefined, 'running jobs listed, legacy job removed: ' + JSON.stringify(t.jobs))
  ok(t.status === 'thinking', 'status untouched by the jobs write: ' + t.status)
  await E.fire('turn.complete', { answer: 'Started the tests.', reason: 'answer' }); await settle()
  await E.fire('classic.Stop', { background_tasks: [] }); await settle()
  ok(Array.isArray(E.entry('methscope').jobs) && !E.entry('methscope').jobs.length, 'empty list once the job is done') }

console.log('D. /clear moves the entry to the new session id instead of ending it')
{ const E = await env({ db: card([{ label: 'HPC', transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('session.end', { reason: 'clear' }); await settle()
  ok(!E.db.projects.methscope.threads[0].ended, 'no ended stamp on /clear')
  E.state.id = 'bbbbbbbb-1111-2222-3333-444444444444'
  await E.fire('turn.start', {}); await settle()
  const t = E.db.projects.methscope.threads[0]
  ok(t.transcript === E.state.id, 'entry now carries the new id'); ok(t.status === 'thinking', 'and shows thinking')
  ok(E.db.projects.methscope.threads.length === 1, 'no duplicate entry') }

console.log('E. a real exit stamps ended')
{ const E = await env({ db: card([{ label: 'HPC', transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('session.end', { reason: 'prompt_input_exit' }); await settle()
  ok(!!E.db.projects.methscope.threads[0].ended, 'ended stamped') }

console.log('F. project conversation without ArtifactData stays quiet')
{ const E = await env({ noArtifactData: true, tools: ['mcp__hearthbot__list_thread_connectors', 'mcp__hearthbot__start_thread_session'] })
  await E.fire('session.start', {}); await settle()
  const n = await E.note(); ok(/project conversation has no ArtifactData/.test(n) && !/Tell the user/.test(n), 'quiet note: ' + n.slice(0, 80))
  ok(E.writes.length === 0, 'nothing written') }

console.log('G. a thread without ArtifactData says so once')
{ const E = await env({ noArtifactData: true })
  await E.fire('session.start', {}); await settle()
  ok(/no ArtifactData tool.*Tell the user/.test(await E.note()), 'tells the user')
  await E.fire('turn.start', {}); await E.note(); await E.fire('turn.complete', { answer: 'x', reason: 'answer' }); await settle()
  ok(!/Tell the user/.test(await E.note()), 'only once') }

console.log('H. entry removed from the card: the mod stops writing')
{ const E = await env({ db: card([{ label: 'HPC', transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }, { label: 'Other', transcript: 'zzzzzzzz-1111-2222-3333-444444444444' }]) })
  await E.fire('session.start', {}); await settle()
  E.db.projects.methscope.threads = [{ label: 'Other', transcript: 'zzzzzzzz-1111-2222-3333-444444444444' }]
  const before = E.writes.length
  await E.fire('turn.start', {}); await settle()
  ok(E.writes.length === before, 'no empty write'); ok(E.db.projects.methscope.threads.length === 1, 'not re-added') }

console.log('I. a slow end-of-turn classification does not overwrite the next turn\'s thinking')
{ const E = await env({ db: card([{ label: 'HPC', transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  let release; E.state.classify = () => new Promise(r => release = () => r(0))
  await E.fire('turn.complete', { answer: 'Question?', reason: 'answer' })
  await E.fire('turn.start', {}); await settle()
  release(); await settle()
  ok(E.entry('methscope').status === 'thinking', 'still thinking: ' + E.entry('methscope').status) }

console.log('J. ids: a label that ends with the session id is not "mine"; short strings never match')
{ const E = await env({ db: card([{ label: 'blocked on aaaaaaaa-1111-2222-3333-444444444444', transcript: 'other-xxxxxxxxxxxxxxxxxxxxxxxx' }]), repo: null, cwd: '/home/x' })
  await E.fire('session.start', {}); await settle()
  ok(E.db.projects.methscope.threads[0].label.startsWith('blocked'), 'other entry untouched') }

console.log('K. tool.check: allows only the mod\'s own board calls')
{ const E = await env({})
  const h = E.handlers['tool.check'][0]
  const mk = (plugin) => { const f = async () => 'NEXT'; f.origin = { plugin }; return f }
  ok((await h(E.$, { tool: 'ArtifactData', input: { url: BOARD } }, mk('status-board')))?.decision === 'allow', 'own board call allowed')
  ok(await h(E.$, { tool: 'ArtifactData', input: { url: 'https://claude.ai/artifact/other' } }, mk('status-board')) === 'NEXT', 'other artifact not auto-allowed')
  ok(await h(E.$, { tool: 'Bash', input: { command: 'rm -rf /' } }, mk('status-board')) === 'NEXT', 'other tools not auto-allowed')
  ok(await h(E.$, { tool: 'ArtifactData', input: { url: BOARD } }, mk('x-status-board')) === 'NEXT', 'look-alike plugin not allowed')
  ok(await h(E.$, { tool: 'ArtifactData', input: { url: BOARD } }, mk('engine')) === 'NEXT', 'model\'s own calls untouched') }

console.log('L. teammates do not get the note')
{ const E = await env({ db: card([]) }); await E.fire('session.start', {}); await settle()
  const r = await E.fire('prompt.compose', { traits: ['teammate'] }, { sections: [] }); ok(!r.sections.length, 'no section for a teammate') }

console.log('M. a project conversation writes nothing to the board')
{ const E = await env({ db: { projects: { methscope: { name: 'MethScope', threads: [{ label: 'Writing', session: 'cse_A', url: 'https://claude.ai/code/project/chan_1?thread=cmsg_A' }, { label: 'Old', session: 'cse_C' }] } } },
    tools: ['ArtifactData', 'mcp__hb__list_threads', 'mcp__hb__start_thread'], wrap: true,
    listing: { project: { id: 'cmsg_project', name: 'proj' }, sessions: [{ session_id: 'cse_A', thread_id: 'cmsg_A', title: 'Writing', status: 'unresolved' }, { session_id: 'cse_B', thread_id: 'cmsg_B', title: 'Analysis', status: 'active' }, { session_id: 'cse_C', thread_id: 'cmsg_C', title: 'Old', status: 'resolved' }] } })
  await E.fire('session.start', {}); await settle()
  ok(E.db.projects.methscope.threads.map(t => t.label).join(',') === 'Writing,Old', 'card untouched')
  ok(/project conversation for the MethScope card/.test(await E.note()), 'note knows it is the project conversation') }


{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa'
  const repo = { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' }
  const other = { label: 'BoardMac', session: 'cse_OTHER', url: 'https://claude.ai/code/project/chan_2?thread=cmsg_OTHER' }
  const listing = { sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Mac', status: 'active' }, { session_id: 'cse_A', thread_id: 'cmsg_A', title: 'Writing', status: 'active' }] }

  console.log('M2. a thread with either listing tool is not taken for the project conversation')
  let E
  for (const tool of ['mcp__hb__list_thread_sessions', 'mcp__hb__list_threads']) {
    E = await env({ db: card([]), repo, tools: ['ArtifactData', tool], listing, wrap: true })
    await E.fire('session.start', {}); await settle()
    ok(!/project conversation/.test(await E.note()), 'not a coordinator with ' + tool)
    ok(E.entry('methscope')?.session === RID, 'registered on the empty card matched by repo with ' + tool)
  }

  console.log('M3. a card matched by repo but listing another project\'s threads is refused')
  E = await env({ db: card([other]), repo, tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing, wrap: true })
  await E.fire('session.start', {}); await settle()
  ok(E.db.projects.methscope.threads.length === 1, 'nothing added to the other project\'s card')
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(/MethScope card shares this repository/.test(E.db.unmatched?.['aaaaaaaa-1111-2222-3333-444444444444']?.why || ''), 'unmatched record says why')

  console.log('M4. a thread registers on the card holding its project\'s threads, whatever the repo')
  E = await env({ db: { projects: { ...card([other]).projects, mine: { name: 'Mine', threads: [{ label: 'Writing', session: 'cse_A', url: 'https://claude.ai/code/project/chan_1?thread=cmsg_A' }] } } },
    repo, tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('mine')?.session === RID && E.db.projects.methscope.threads.length === 1, 'registered on its project\'s card') }

console.log('M5. an ordinary turn leaves the card\'s thread list alone; the listing call on /board-status syncs it')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const threads = [{ label: 'New thread', session: RID, transcript: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'idle' },
    { label: 'Old', session: 'cse_C', url: U + 'cmsg_C' }, { label: 'BoardMac', session: 'cse_OTHER', url: 'https://claude.ai/code/project/chan_2?thread=cmsg_OTHER', at: '2020-01-01T00:00:00Z' }]
  const listing = { sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Mac', status: 'active' }, { session_id: 'cse_B', thread_id: 'cmsg_B', title: 'Analysis', status: 'active' }, { session_id: 'cse_C', thread_id: 'cmsg_C', title: 'Old', status: 'active', resolved: true }] }
  let E = await env({ db: card(threads), tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing, wrap: true })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  ok(E.db.projects.methscope.threads.length === 3, 'plain turn: list untouched')
  ok(/sends \/board-status: load the board-status skill/.test(await E.note()), 'note points /board-status to its skill')
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify(listing) })
  await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  const th = E.db.projects.methscope.threads
  ok(th.map(t => t.label).join(',') === 'Mac,Analysis', 'resolved and foreign removed, missing added, own label set: ' + th.map(t => t.label).join(','))
  ok(th[0].status === 'idle' && th[0].transcript, 'own entry keeps its fields')
  ok(th[1].url === U + 'cmsg_B' && th[1].session === 'cse_B', 'added entry has url and session')
  console.log('M5c. without its own listing tool, the mod syncs from the model\'s listing call in the status write; the note asks for that call')
  E = await env({ db: card([{ ...threads[0], label: 'Mac' }, ...threads.slice(1)]), tools: ['ArtifactData'] })
  await E.fire('session.start', {}); await settle()
  ok(/board-status skill/.test(await E.note(['print'])), 'note shown to a print session on a card')
  await E.fire('turn.start', {}); await settle()
  const before = E.writes.length
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: 'Untrusted content follows.\n    ' + JSON.stringify(listing) })
  await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  ok(E.db.projects.methscope.threads.map(t => t.label).join(',') === 'Mac,Analysis', 'synced: ' + E.db.projects.methscope.threads.map(t => t.label).join(','))
  ok(E.writes.filter(w => w.c === 'projects').length - E.writes.slice(0, before).filter(w => w.c === 'projects').length === 1, 'one card write for status and list together')
  ok(E.entry('methscope').status === 'idle', 'own status written')
  console.log('M6. a listing with more pages removes nothing')
  E = await env({ db: card(threads) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ ...listing, next_cursor: 'abc' }) })
  await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  ok(E.db.projects.methscope.threads.some(t => t.label === 'BoardMac'), 'unknown entries kept on a partial listing')
  ok(!E.db.projects.methscope.threads.some(t => t.label === 'Old'), 'a listed resolved thread still goes') }

const R = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'aaaaaaaa-1111-2222-3333-444444444444'
console.log('N1. an entry written by the coordinator (session id, no transcript) is found, not duplicated')
{ const E = await env({ db: card([{ label: 'Writing', session: R, url: 'https://claude.ai/code/project/chan_1?thread=cmsg_W' }]), repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  ok(E.db.projects.methscope.threads.length === 1, 'no duplicate entry')
  ok(E.db.projects.methscope.threads[0].transcript === U, 'transcript filled in')
  ok(/thread "Writing"/.test(await E.note()), 'note names the thread') }

console.log('N1b. a registered entry carries the remote session id, so a coordinator sync keeps it')
{ const E = await env({ db: card([]), tools: ['ArtifactData', 'mcp__hb__list_threads'], listing: { sessions: [{ session_id: R, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }] }, repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('methscope')?.session === R, 'session = remote id') }

console.log('N1c. without any listing, a repository match alone places nothing (shared repositories)')
{ const E = await env({ db: card([]), repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  ok(!E.db.projects.methscope.threads.length, 'not registered on a repo guess') }

console.log('N1d. a thread misfiled on another project\'s card leaves it untouched and moves to its own card')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const E = await env({ db: { projects: {
      brain: { name: 'BrainRegion', repo: 'zhou-lab/labjournal', threads: [{ label: 'Brain A', session: 'cse_B1', url: 'https://claude.ai/code/project/chan_2?thread=cmsg_B1' }, { label: 'New thread', session: RID, transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }] },
      adapt: { name: 'AdaptSampling', threads: [{ label: 'Writing', url: U + 'cmsg_W' }] } } } })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_A', title: 'Analysis', status: 'active' }, { session_id: 'cse_W', thread_id: 'cmsg_W', title: 'Writing', status: 'active' }] }) })
  await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle(); await settle()
  ok(E.db.projects.brain.threads.map(t => t.label).join(',') === 'Brain A', 'BrainRegion keeps only its own thread: ' + E.db.projects.brain.threads.map(t => t.label).join(','))
  ok(E.db.projects.adapt.threads.some(t => t.session === RID), 'moved to AdaptSampling') }

console.log('N2. a tool error mentioning ArtifactData does not switch the mod off; only a missing tool does')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  E.state.boardError = 'ArtifactData: document not found'
  await E.fire('session.start', {}); await settle()
  ok(!/no ArtifactData tool/.test(await E.note()), 'not treated as a missing tool')
  E.state.boardError = undefined
  await E.fire('turn.start', {}); await settle(); await settle()
  ok(E.entry('methscope')?.status === 'thinking', 'recovers at the next turn: ' + E.entry('methscope')?.status) }

console.log('N3. /clear with a write already queued and a slow board still moves the entry')
{ const E = await env({ db: card([{ label: 'HPC', transcript: U }]), remote: '', latency: 40 })
  await E.fire('session.start', {}); await new Promise(r => setTimeout(r, 400))
  await E.fire('turn.start', {})                       // queues "thinking" with the old id
  await E.fire('session.end', { reason: 'clear' })
  E.state.id = 'bbbbbbbb-1111-2222-3333-444444444444'
  await E.fire('turn.start', {}); await new Promise(r => setTimeout(r, 800))
  const t = E.db.projects.methscope.threads[0]
  ok(t.transcript === E.state.id, 'entry moved to the new id: ' + t.transcript); ok(t.status === 'thinking', 'shows thinking') }

console.log('N4. a first turn that ends before the lookup still gets its final status')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]), latency: 40 })
  E.state.classify = 0
  await E.fire('session.start', {}); await E.fire('turn.start', {})
  await E.fire('turn.complete', { answer: 'Which one?', reason: 'answer' })
  await new Promise(r => setTimeout(r, 800))
  ok(E.entry('methscope').status === 'waiting_on_you', 'waiting_on_you: ' + E.entry('methscope').status) }

console.log('N7. a removed entry is not re-invited')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  await E.fire('session.start', {}); await settle()
  E.db.projects.methscope.threads = []
  await E.fire('turn.start', {}); await settle()
  const n = await E.note(); ok(/taken off its card/.test(n) && !/find or create/.test(n), 'note says leave the board alone') }

console.log('N9. the end stamp keeps "waiting on you"')
{ const E = await env({ db: card([{ label: 'HPC', session: R, status: 'waiting_on_you' }]) })
  await E.fire('session.start', {}); await settle()
  E.db.projects.methscope.threads[0].status = 'waiting_on_you'
  await E.fire('session.end', { reason: 'other' }); await settle()
  const t = E.entry('methscope'); ok(t.status === 'waiting_on_you' && !!t.ended, 'status kept, ended stamped') }

console.log('N13. a job without a description shows its command, short secrets never reach the board')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  await E.fire('session.start', {}); await settle(); await E.fire('turn.start', {}); await settle()
  for (const [cmd, want] of [['sshpass -p hunter2 ssh hpc', 'shell: sshpass'], ['mysql -pS3cret db', 'shell: mysql'], ['sbatch run.sh', 'shell: sbatch run.sh'], ['ssh user@host', 'shell: ssh']]) {
    await E.fire('classic.Stop', { background_tasks: [{ id: 'x', type: 'shell', status: 'running', command: cmd }] }); await settle()
    const got = (E.entry('methscope').jobs || [])[0]?.text
    ok(got === want, `${cmd} -> ${got}`) } }

console.log('N15. a Remote Control session finds its remote id from its process and gets the note')
{ const E = await env({ db: card([{ label: 'HPC', session: 'cse_01RCabcdefghijklmnopqrst', url: 'u' }]), remote: '', ps: '/x/claude --print --session-id cse_01RCabcdefghijklmnopqrst --input-format stream-json\n' })
  await E.fire('session.start', {}); await settle()
  ok(/thread "HPC"/.test(await E.note(['print'])), 'found by the remote id from ps, note shown under print') }

console.log('N16. a new Remote Control thread not matched at start registers from the model\'s listing, then its label is set by the sync')
{ const RID = 'cse_01RCnewthreadaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const E = await env({ db: { projects: { mine: { name: 'Mine', threads: [{ label: 'Writing', session: 'cse_A', url: U + 'cmsg_A' }] } } }, remote: '', ps: '--session-id ' + RID, repo: null, cwd: '/hpc/work' })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  ok(!E.db.projects.mine.threads.some(t => t.session === RID), 'not placed at start')
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_NEW', title: 'HPC run', status: 'active' }, { session_id: 'cse_A', thread_id: 'cmsg_A', title: 'Writing', status: 'active' }] }) }); await settle()
  await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  const t = E.db.projects.mine.threads.find(t => t.session === RID)
  ok(t && t.label === 'HPC run' && t.url === U + 'cmsg_NEW' && t.status === 'idle', 'registered, named and linked: ' + JSON.stringify(t)) }

console.log('N17. without its own listing tool, a remote thread is asked for the listing from the first turn, before the lookup ends')
{ const E = await env({ db: card([]), tools: ['ArtifactData'], latency: 200 })
  await E.fire('session.start', {})
  const n = await E.note()
  ok(/looking up this chat/.test(n) && /board-status skill/.test(n), 'first-turn note points to /board-status: ' + n.slice(0, 120))
  await settle(); await new Promise(r => setTimeout(r, 300)) }

console.log('N18. the note shows the unread notes for the thread\'s card, and drops them once read')
{ const E = await env({ db: { ...card([{ label: 'HPC', session: R }]), messages: { '20261021-grants-x': { from: 'grants', to: 'methscope', subject: 'Sync bug', body: 'b', at: 't', re: '', read_at: '' }, '20261021-grants-y': { from: 'grants', to: 'other', subject: 'Not ours', read_at: '' } } } })
  await E.fire('session.start', {}); await settle()
  const n = await E.note()
  ok(/1 unread note on the Status Board \(grants: Sync bug\)/.test(n) && /status-board-messaging/.test(n), 'unread shown: ' + n.slice(n.indexOf('unread') - 30, n.indexOf('unread') + 80))
  E.db.messages['20261021-grants-x'].read_at = '2026-10-21T17:20:00Z'
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle()
  ok(!/unread note/.test(await E.note()), 'gone once read') }

console.log('N19. Remote Control: the listing comes from the hearthbot server directly; the thread places itself at start')
{ const RID = 'cse_01RCmcpaaaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const E = await env({ db: { projects: { adapt: { name: 'AdaptSampling', threads: [{ label: 'Writing', url: U + 'cmsg_W' }] }, brain: { name: 'BrainRegion', repo: 'zhou-lab/labjournal', threads: [{ label: 'B', session: 'cse_B' }] } } },
    remote: '', ps: '--session-id ' + RID, repo: { remote: 'git@github.com:zhou-lab/labjournal.git', root: '/hpc/labjournal' },
    mcpListing: { sessions: [{ session_id: RID, thread_id: 'cmsg_A', title: 'Analysis', status: 'active' }, { session_id: 'cse_W', thread_id: 'cmsg_W', title: 'Writing', status: 'active' }] } })
  await E.fire('session.start', {}); await settle(); await settle()
  ok(E.db.projects.adapt.threads.some(t => t.session === RID), 'placed on AdaptSampling, not BrainRegion')
  ok(!/Once in every turn/.test(await E.note()), 'no per-turn listing request to the model') }

console.log('N20. a thread taken off its card by hand places itself again from the listing; a resolved one does not')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const sessions = [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }, { session_id: 'cse_W', thread_id: 'cmsg_W', title: 'Writing', status: 'active' }]
  const E = await env({ db: { projects: { mine: { name: 'Mine', threads: [{ label: 'Me', session: RID }, { label: 'Writing', session: 'cse_W', url: U + 'cmsg_W' }] } } }, tools: ['ArtifactData', 'mcp__hb__list_threads'], listing: { sessions } })
  await E.fire('session.start', {}); await settle()
  E.db.projects.mine.threads = E.db.projects.mine.threads.filter(t => t.session !== RID)
  await E.fire('turn.start', {}); await settle()
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(E.db.projects.mine.threads.some(t => t.session === RID), 'back on its card')
  E.db.projects.mine.threads = E.db.projects.mine.threads.filter(t => t.session !== RID)
  E.state.listing = { sessions: [{ ...sessions[0], resolved: true }, sessions[1]] }
  await E.fire('turn.start', {}); await settle()
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(!E.db.projects.mine.threads.some(t => t.session === RID), 'a resolved thread stays off') }

console.log('N21. a fresh thread no listing has reached shows no warning; a stale unmatched record goes once the thread is placed')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'aaaaaaaa-1111-2222-3333-444444444444'
  const E = await env({ db: { ...card([]), unmatched: { [U]: { session: RID, why: 'old', at: '2026-10-21T00:00:00Z' } } }, repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  delete E.db.unmatched[U]
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(!(E.db.unmatched || {})[U], 'no warning before any listing')
  E.db.unmatched[U] = { session: RID, why: 'old', at: '2026-10-21T00:00:00Z' }
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }] }) }); await settle()
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(E.entry('methscope') && !(E.db.unmatched || {})[U], 'placed, stale record removed') }

console.log('N22. review fixes: own entry kept by the sync, a paged listing evicts nothing, a resolved thread is not shown as unmatched')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const old = '2020-01-01T00:00:00Z'
  let E = await env({ db: card([{ label: 'New thread', transcript: 'aaaaaaaa-1111-2222-3333-444444444444', at: old }, { label: 'W', session: 'cse_W', url: U + 'cmsg_W' }]) , remote: '' })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_threads' }, { text: JSON.stringify({ sessions: [{ session_id: 'cse_W', thread_id: 'cmsg_W', title: 'W', status: 'active' }] }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle()
  ok(E.db.projects.methscope.threads.some(t => t.transcript === 'aaaaaaaa-1111-2222-3333-444444444444'), 'own entry kept although the listing does not show it')
  E = await env({ db: { projects: { a: { name: 'A', threads: [{ label: 'Me', session: RID }, { label: 'X', session: 'cse_X', url: U + 'cmsg_X' }] } } } })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_threads' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }], next_cursor: 'p2' }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(E.db.projects.a.threads.some(t => t.session === RID) && E.db.projects.a.threads.some(t => t.session === 'cse_X'), 'paged listing: nothing evicted')
  E = await env({ db: { projects: { a: { name: 'A', threads: [{ label: 'Me', session: RID }, { label: 'X', session: 'cse_X', url: U + 'cmsg_X' }] } } }, tools: ['ArtifactData', 'mcp__hb__list_threads'], listing: { sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active', resolved: true }, { session_id: 'cse_X', thread_id: 'cmsg_X', title: 'X', status: 'active' }] } })
  await E.fire('session.start', {}); await settle()
  E.db.projects.a.threads = E.db.projects.a.threads.filter(t => t.session !== RID)
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(!(E.db.unmatched || {})['aaaaaaaa-1111-2222-3333-444444444444'], 'resolved thread not recorded as unmatched') }

console.log('N23. an entry that carries only this thread\'s link is claimed, not duplicated')
{ const RID = 'cse_01Tvs66rBJwAKEbsBc9LPv2b', U = 'https://claude.ai/code/project/chan_1?thread='
  const E = await env({ db: { projects: { adapt: { name: 'AdaptSampling', threads: [{ label: 'Analysis', url: U + 'cmsg_A' }, { label: 'Writing', session: 'cse_W', url: U + 'cmsg_W' }] } } }, remote: '', ps: '--session-id ' + RID })
  await E.fire('session.start', {}); await settle()
  for (let i = 0; i < 2; i++) {
    await E.fire('turn.start', {}); await settle()
    await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_A', title: 'Analysis', status: 'active' }, { session_id: 'cse_W', thread_id: 'cmsg_W', title: 'Writing', status: 'active' }] }) }); await settle()
    await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  }
  const th = E.db.projects.adapt.threads
  ok(th.length === 2 && th[0].label === 'Analysis' && th[0].session === RID && th[0].transcript && th[0].status === 'idle', 'Analysis claimed and written: ' + JSON.stringify(th.map(t => [t.label, t.session, t.status]))) }

console.log('N24. a project\'s own card carrying another project\'s strays keeps its thread and drops the strays')
{ const RID = 'cse_01E6R9ARPL1E7prvWztiVnPY', B = 'https://claude.ai/code/project/chan_B?thread='
  const E = await env({ db: { projects: {
      brain: { name: 'BrainRegion', threads: [{ label: 'Analysis', session: RID, url: B + 'cmsg_BA' }, { label: 'Writing', session: 'cse_AW', url: B + 'cmsg_AW' }] },
      adapt: { name: 'AdaptSampling', threads: [{ label: 'Writing', session: 'cse_AW', url: 'https://claude.ai/code/project/chan_A?thread=cmsg_AW' }] } } }, remote: RID })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_BA', title: 'Analysis', status: 'active' }] }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(E.db.projects.brain.threads.map(t => t.label).join(',') === 'Analysis', 'stays on its card, stray dropped: ' + E.db.projects.brain.threads.map(t => t.label).join(','))
  ok(!(E.db.unmatched || {})['aaaaaaaa-1111-2222-3333-444444444444'], 'not recorded as unmatched') }

console.log('N25. second review: tolerant listing parser, unmatched reason, jobs cleared on resume, duplicate own entries merged, no-verdict retry')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  // a listing with one unreadable row still counts
  let E = await env({ db: card([{ label: 'Me', session: RID }, { label: 'Old', session: 'cse_C', url: U + 'cmsg_C' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }, { session_id: 'cse_X', thread_id: 'cmsg_X', title: '', status: 'active' }, { session_id: 'cse_C', thread_id: 'cmsg_C', title: 'Old', status: 'resolved' }] }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle()
  ok(E.db.projects.methscope.threads.map(t => t.label).join(',') === 'Me', 'bad row skipped, sync applied: ' + E.db.projects.methscope.threads.map(t => t.label).join(','))
  // the unmatched reason after the model's listing found no card
  E = await env({ db: { projects: { other: { name: 'Other', threads: [{ label: 'O', session: 'cse_O', url: 'https://claude.ai/code/project/chan_9?thread=cmsg_O' }] } } }, repo: null, cwd: '/x/y' })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }] }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle(); await settle()
  ok(/no card holds this project/.test(E.db.unmatched?.['aaaaaaaa-1111-2222-3333-444444444444']?.why || ''), 'unmatched reason names the real cause: ' + E.db.unmatched?.['aaaaaaaa-1111-2222-3333-444444444444']?.why)
  // jobs do not carry over to a resumed session's entry
  E = await env({ db: card([{ label: 'A', transcript: 'aaaaaaaa-1111-2222-3333-444444444444' }, { label: 'B', transcript: 'bbbbbbbb-1111-2222-3333-444444444444' }]), remote: '' })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('classic.Stop', { background_tasks: [{ id: 'j', type: 'shell', status: 'running', description: 'old job' }] }); await settle()
  E.state.id = 'bbbbbbbb-1111-2222-3333-444444444444'
  await E.fire('turn.start', {}); await settle(); await settle()
  ok(!(E.db.projects.methscope.threads[1].jobs || []).length, 'resumed entry has no stale jobs')
  // two entries for one thread merge into one
  E = await env({ db: card([{ label: 'Me', session: RID, status: 'idle' }, { label: 'New thread', transcript: 'aaaaaaaa-1111-2222-3333-444444444444', url: U + 'cmsg_ME' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  await E.fire('tool.call', { tool: 'mcp__hearthbot__list_thread_sessions' }, { text: JSON.stringify({ sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Me', status: 'active' }] }) })
  await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle()
  const th = E.db.projects.methscope.threads
  ok(th.length === 1 && th[0].session === RID && th[0].transcript && th[0].url === U + 'cmsg_ME', 'merged into one entry: ' + JSON.stringify(th))
  // a "gave no verdict" refusal is retried once
  E = await env({ db: card([{ label: 'Me', session: RID }]) })
  await E.fire('session.start', {}); await settle()
  E.state.denyWrites = 'once'
  await E.fire('turn.start', {}); await settle()
  ok(E.entry('methscope').status === 'thinking', 'write retried after a no-verdict refusal') }

console.log('N26. waiting on you always carries a line; a summary of NONE means idle')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  await E.fire('session.start', {}); await settle()
  E.state.classify = 0; E.state.summary = 'NONE'
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'All done. Nothing else needed.', reason: 'answer' }); await settle()
  ok(E.entry('methscope').status === 'idle', 'NONE summary: idle')
  E.state.summary = undefined
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'The draft is ready. Please review section 2 before Friday.', reason: 'answer' }); await settle()
  const t = E.entry('methscope')
  ok(t.status === 'waiting_on_you' && /review section 2/.test(t.waiting || ''), 'no summary: the last sentence stands in: ' + t.waiting) }

console.log('N14. one-shot (-p) and local runs: no note, no registration')
{ const E = await env({ db: card([]), remote: '', repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  ok(!E.db.projects.methscope.threads.length, 'local session does not register')
  ok(!(await E.note(['print'])), 'no note in -p') }

console.log('N12. a /context render or an aborted turn does not count as telling the user')
{ const E = await env({ noArtifactData: true, remote: '' })
  await E.fire('session.start', {}); await settle()
  await E.note(['analysis']); await E.fire('turn.start', {}); await E.note(); await E.fire('turn.complete', { answer: '', reason: 'aborted' }); await settle()
  ok(/Tell the user/.test(await E.note()), 'still to be told') }


console.log('W. a thread waiting on you says what for, and the line goes away when it moves on')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  await E.fire('session.start', {}); await settle()
  E.state.classify = 0; E.state.summary = '"Push the repo and restart Claude in MethScope."\n'
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'Done. Can you push and restart?', reason: 'answer' }); await settle()
  let t = E.entry('methscope'); ok(t.status === 'waiting_on_you' && t.waiting === 'Push the repo and restart Claude in MethScope.', 'summary stored: ' + t.waiting)
  E.state.summary = undefined
  await E.fire('turn.start', {}); await settle()
  t = E.entry('methscope'); ok(t.status === 'thinking' && !('waiting' in t), 'line dropped when thinking')
  await E.fire('turn.complete', { answer: 'Here are two layouts. Use `a?b` here. Which one should I keep for Figure 2?', reason: 'answer' }); await settle()
  t = E.entry('methscope'); ok(t.waiting === 'Which one should I keep for Figure 2?', 'fallback to the last question: ' + t.waiting)
  E.state.classify = 2
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'All done.', reason: 'answer' }); await settle()
  ok(!('waiting' in E.entry('methscope')), 'gone once idle') }


console.log('X. every note after the lookup gives the board address and where the rules are')
{ for (const opts of [{ db: card([{ label: 'HPC', session: R }]) }, { db: card([]), cwd: '/home/x' }, { noArtifactData: true, tools: ['mcp__hb__start_thread_session'] }]) {
    const E = await env(opts); await E.fire('session.start', {}); await settle()
    const n = await E.note(); ok(n.includes(BOARD) && /collection meta, doc_id instruction/.test(n), 'address in: ' + n.slice(0, 60)) } }

console.log('Y. the board address comes from the board skill (or its old name), newest copy first')
{ const NEW = 'https://claude.ai/artifact/NEWBOARDaaaa', OLD = 'https://claude.ai/artifact/OLDBOARDbbbb', S = '/u/.claude/skills'
  const skill = (link) => `---\nname: update-status-board\n---\nThe Status Board is the artifact ${link}. Read and write it with the ArtifactData tool.`
  const files = { [S + '/synced/a_b/update-status-board/SKILL.md']: { text: skill(OLD), at: 1 }, [S + '/synced/c_d/board/SKILL.md']: { text: skill(NEW), at: 2 } }
  let E = await env({ db: card([{ label: 'HPC', session: R }]), home: '/u', files, board: NEW })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('methscope') && (await E.note()).includes(NEW), 'synced skill names the board')
  const h = E.handlers['tool.check'][0], mk = (plugin) => Object.assign(async () => 'NEXT', { origin: { plugin } })
  ok((await h(E.$, { tool: 'ArtifactData', input: { url: NEW } }, mk('status-board')))?.decision === 'allow', 'calls to the skill\'s board allowed')
  ok((await h(E.$, { tool: 'ArtifactData', input: { url: BOARD } }, mk('status-board'))) === 'NEXT', 'calls to the built-in board not auto-allowed')
  E = await env({ db: card([{ label: 'HPC', session: R }]), home: '/u' })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('methscope') && (await E.note()).includes(BOARD), 'no skill on disk: the built-in board') }

console.log('T. the thread\'s "Waiting on you" line is the entry\'s asks; only the thread changes it; written only with status writes')
{ const E = await env({ db: card([{ label: 'HPC', session: 'cse_01REMOTEaaaaaaaaaaaaaaaa', status: 'idle', todo: { title: 'old' } }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  const before = E.writes.filter(w => w.c === 'projects').length
  await E.fire('tool.call', { tool: 'mcp__hearthbot__reply', text: 'Draft is up.\n\n**Waiting on you:**\n- Wanding: review Fig 2\n- Pick the title\n\nThanks.' }, { result: 'sent' }); await settle()
  ok(E.writes.filter(w => w.c === 'projects').length === before, 'no write of its own')
  await E.fire('turn.complete', { answer: '', reason: 'answer' }); await settle()
  let a = E.entry('methscope').asks
  ok(a && a.map(x => x.text).join('|') === 'Review Fig 2|Pick the title' && E.entry('methscope').todo === undefined, 'two items, name stripped, old todo removed: ' + JSON.stringify(a))
  ok(E.entry('methscope').status === 'waiting_on_you' && E.entry('methscope').waiting === 'Review Fig 2', 'waiting, its line the first item')
  const id0 = a[0].id
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'All set.\nWaiting on you: Review Fig 2; Send the cover letter', reason: 'answer' }); await settle()
  a = E.entry('methscope').asks
  ok(a.map(x => x.text).join('|') === 'Review Fig 2|Send the cover letter' && a[0].id === id0, 'addressed item gone, new one added, kept item keeps its id: ' + JSON.stringify(a))
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'More work.', reason: 'answer' }); await settle()
  ok(E.entry('methscope').asks.length === 2, 'a turn without the line leaves the list as it was')
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'Done.\nWaiting on you: nothing', reason: 'answer' }); await settle()
  ok(E.entry('methscope').asks === undefined, 'nothing empties the list') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
