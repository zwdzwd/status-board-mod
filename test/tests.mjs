import { load, makeEnv, settle } from './harness.mjs'
const BOARD = 'https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T'
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg) } }
const card = (threads = []) => ({ projects: { methscope: { name: 'MethScope', repo: 'zhou-lab/MethScope', threads } } })
async function env(opts) { const register = await load(); const E = makeEnv(opts); register(E.on); return E }

console.log('A. new thread registers on the card matched by repo; first-turn note waits for the lookup')
{ const E = await env({ db: card([{ label: 'Writing', session: 'cse_X', url: 'u' }]), repo: { remote: 'git@github.com:zhou-lab/MethScope.git', name: 'MethScope', root: '/w/MethScope' } })
  await E.fire('session.start', {})
  ok(/looking up/.test(await E.note()), 'note before lookup is neutral')
  await settle()
  const t = E.entry('methscope'); ok(t && t.label === 'New thread', 'entry added with placeholder')
  ok(E.db.projects.methscope.threads.length === 2, 'other entry kept')
  ok(/placeholder label "New thread"/.test(await E.note()), 'note asks to fix the placeholder')
  ok(E.db.sessions[E.state.id]?.card === 'methscope', 'index written')
  await E.fire('turn.start', {}); await settle(); ok(E.entry('methscope').status === 'thinking', 'thinking at turn start')
  E.state.classify = 0
  t.label = 'Revision'; // the model fixes the label (no url)
  E.db.projects.methscope.threads = E.db.projects.methscope.threads.map(x => x.transcript === E.state.id ? { ...x, label: 'Revision' } : x)
  await E.fire('turn.complete', { answer: 'Shall I push?', reason: 'answer' }); await settle()
  ok(E.entry('methscope').status === 'waiting_on_you', 'waiting_on_you after a question')
  ok(/thread "Revision"/.test(await E.note()), 'placeholder note ends once the label is fixed (no url needed)') }

console.log('B. a folder named like a generic word does not match a card')
{ const E = await env({ db: { projects: { claude: { name: 'Claude', threads: [] } } }, cwd: '/home/claude' })
  await E.fire('session.start', {}); await settle()
  ok(!E.db.projects.claude.threads.length, 'no entry added to the "Claude" card')
  ok(/not on the Status Board\. Tell the user/.test(await E.note()), 'unmatched chat tells the user once')
  await E.fire('turn.start', {}); await E.note(); await E.fire('turn.complete', { answer: 'ok', reason: 'answer' }); await settle()
  ok(!/Tell the user/.test(await E.note()), 'and not again after that turn') }

console.log('C. a long command shows working + job, then the old job comes back')
{ const E = await env({ db: card([{ label: 'HPC', session: 'cse_01REMOTEaaaaaaaaaaaaaaaa', job: 'SLURM 123 running', status: 'idle' }]) })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await settle()
  let release; const slow = new Promise(r => release = r)
  const call = E.handlers['tool.call'][0](E.$, { tool: 'Bash', command: 'curl -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz0123 https://x' }, async () => { await slow; return {} })
  await new Promise(r => setTimeout(r, 120)); await settle()
  const t = E.entry('methscope'); ok(t.status === 'working', 'working while the command runs')
  ok(t.job === 'Bash: curl' && !/abcdef/.test(t.job), 'job shows the command with the secret hidden: ' + t.job)
  release(); await call; await settle()
  ok(E.entry('methscope').job === 'SLURM 123 running', 'old job restored')
  E.state.classify = undefined
  await E.fire('turn.complete', { answer: 'Here it is.', reason: 'answer' }); await settle()
  ok(E.entry('methscope').job === 'SLURM 123 running', 'classifier naming no label leaves the job alone') }

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

console.log('M. project conversation with list_threads; listing parser: open/closed words, wrapper objects and text')
{ const E = await env({ db: { projects: { methscope: { name: 'MethScope', threads: [{ label: 'Writing', session: 'cse_A', url: 'https://claude.ai/code/project/chan_1?thread=cmsg_A' }, { label: 'Old', session: 'cse_C' }] } } },
    tools: ['ArtifactData', 'mcp__hb__list_threads', 'mcp__hb__start_thread'], wrap: true,
    listing: { project: { id: 'cmsg_project', name: 'proj' }, sessions: [{ session_id: 'cse_A', thread_id: 'cmsg_A', title: 'Writing', status: 'unresolved' }, { session_id: 'cse_B', thread_id: 'cmsg_B', title: 'Analysis', status: 'active' }, { session_id: 'cse_C', thread_id: 'cmsg_C', title: 'Old', status: 'resolved' }] } })
  await E.fire('session.start', {}); await settle()
  const labels = E.db.projects.methscope.threads.map(t => t.label).join(',')
  ok(labels === 'Writing,Analysis', 'card synced to open threads: ' + labels)
  ok(E.db.projects.methscope.threads[1].url === 'https://claude.ai/code/project/chan_1?thread=cmsg_B', 'new entry gets its url') }


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
  ok(/MethScope card shares this repository/.test(await E.note()), 'says why')

  console.log('M4. a thread registers on the card holding its project\'s threads, whatever the repo')
  E = await env({ db: { projects: { ...card([other]).projects, mine: { name: 'Mine', threads: [{ label: 'Writing', session: 'cse_A', url: 'https://claude.ai/code/project/chan_1?thread=cmsg_A' }] } } },
    repo, tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('mine')?.session === RID && E.db.projects.methscope.threads.length === 1, 'registered on its project\'s card') }

console.log('M5. a thread keeps its card\'s thread list in step with the project\'s open threads')
{ const RID = 'cse_01REMOTEaaaaaaaaaaaaaaaa', U = 'https://claude.ai/code/project/chan_1?thread='
  const threads = [{ label: 'New thread', session: RID, transcript: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'idle' },
    { label: 'Old', session: 'cse_C', url: U + 'cmsg_C' }, { label: 'BoardMac', session: 'cse_OTHER', url: 'https://claude.ai/code/project/chan_2?thread=cmsg_OTHER', at: '2020-01-01T00:00:00Z' }]
  const listing = { sessions: [{ session_id: RID, thread_id: 'cmsg_ME', title: 'Mac', status: 'active' }, { session_id: 'cse_B', thread_id: 'cmsg_B', title: 'Analysis', status: 'active' }, { session_id: 'cse_C', thread_id: 'cmsg_C', title: 'Old', status: 'active', resolved: true }] }
  let E = await env({ db: card(threads), tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing, wrap: true })
  await E.fire('session.start', {}); await settle()
  await E.fire('turn.start', {}); await E.fire('turn.complete', { answer: 'done', reason: 'answer' }); await settle()
  const th = E.db.projects.methscope.threads
  ok(th.map(t => t.label).join(',') === 'Mac,Analysis', 'resolved and foreign removed, missing added, own label set: ' + th.map(t => t.label).join(','))
  ok(th[0].status === 'idle' && th[0].transcript, 'own entry keeps its fields')
  ok(th[1].url === U + 'cmsg_B' && th[1].session === 'cse_B', 'added entry has url and session')
  console.log('M6. a listing with more pages removes nothing')
  E = await env({ db: card(threads), tools: ['ArtifactData', 'mcp__hb__list_thread_sessions'], listing: { ...listing, next_cursor: 'abc' } })
  await E.fire('session.start', {}); await settle()
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
{ const E = await env({ db: card([]), repo: { remote: 'git@github.com:zhou-lab/MethScope.git', root: '/w/MethScope' } })
  await E.fire('session.start', {}); await settle()
  ok(E.entry('methscope')?.session === R, 'session = remote id') }

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

console.log('N13. short secrets after an option never reach the board')
{ const E = await env({ db: card([{ label: 'HPC', session: R }]) })
  await E.fire('session.start', {}); await settle(); await E.fire('turn.start', {}); await settle()
  for (const [cmd, want] of [['sshpass -p hunter2 ssh hpc', 'Bash: sshpass'], ['mysql -pS3cret db', 'Bash: mysql'], ['sbatch run.sh', 'Bash: sbatch run.sh'], ['ssh user@host', 'Bash: ssh']]) {
    let release; const slow = new Promise(r => release = r)
    const c = E.handlers['tool.call'][0](E.$, { tool: 'Bash', command: cmd }, async () => { await slow; return {} })
    await new Promise(r => setTimeout(r, 120)); await settle()
    ok(E.entry('methscope').job === want, `${cmd} -> ${E.entry('methscope').job}`)
    release(); await c; await settle() } }

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
