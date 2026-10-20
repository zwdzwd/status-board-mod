# Status Board

One board for every Claude project, kept current by the projects themselves.
Three parts, one version number (`VERSION`; the same string is in
`.claude-plugin/plugin.json`, `hooks/register.ts`, `board/project-board.html`,
`board/rules.md`, and in `meta/instruction.version` on the board):

- **The plugin** (`.claude-plugin/`, `hooks/register.ts`): a Claude Code plugin. In a
  thread it registers the thread on its project's card and writes the thread's status
  (thinking / working / waiting on you / idle, plus a job line) at the start and end of
  every turn. In the project conversation (the coordinator) it keeps the card's thread
  list equal to `list_thread_sessions` after every turn and writes the coordinator's own
  status to `card.coordinator` (the stripe on the card's left edge).
- **The board page** (`board/project-board.html`): the source of the Status Board
  artifact (https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF, capabilities `db` and
  `user`). After a change, publish it to that same URL.
- **The rules** (`board/rules.md`): what every project's Claude reads from the board
  (`meta/instruction` in the board's database, field `rules`). After a change, write it
  back there. Nothing needs pasting into a project's own instructions: the plugin's
  note tells every session to read these rules.

## Setting up

Everything is a one-time step per place; nothing is done per session.

1. **claude.ai (cloud sessions, including every project conversation and its threads).**
   Customize → Plugins → Add marketplace → `zwdzwd/status-board-mod` → install
   **status-board**. Every cloud session in every project loads it from then on.
   A project conversation that is already open picks it up after
   Project settings → Restart Claude.

2. **Each computer that runs `claude rc` (Remote Control sessions).**

       claude plugin install status-board --marketplace zwdzwd/status-board-mod

   Every `claude rc` started on that machine afterwards has the plugin.

3. **Pin the board.** Open the artifact link above once and pin it to the sidebar.

### A brand-new account (no board yet)

- Publish `board/project-board.html` as an artifact with capabilities `db` and `user`,
  and pin it.
- Write `board/rules.md` into that artifact's database as `meta/instruction`
  (fields `rules`, `version`, `updated`).
- Put the new artifact's URL in `BOARD` at the top of `hooks/register.ts`, commit, push,
  then do steps 1–3 above.

## Updating

After each release (a new `VERSION`):

- claude.ai: Plugins → **Check for updates**, then Project settings → Restart Claude in
  any project conversation that is open.
- Each `claude rc` machine: `claude plugin update status-board`, then restart `claude rc`.
- The board page and rules are updated by publishing / writing them back; readers see
  them at once.

## Releasing

Bump the version in the five places listed at the top, commit, push, then follow
"Updating".

## How it fits together

- Card = one document in `projects/<id>` on the board: name, repo, category, status,
  summary, next, blocker, threads[], coordinator, updated.
- Thread entry = `{label, url, session, transcript, status, at, job, ended?}`. The thread's
  own session writes its status; the coordinator keeps the list in step with the
  project's open threads; resolved threads disappear by themselves. Resolve threads
  rather than delete them.
- `sessions/<uuid>` is the plugin's index (which card and thread a session is, or
  `role: coordinator`), `diagnostics/<uuid>` is what it writes when it cannot match a
  card.
