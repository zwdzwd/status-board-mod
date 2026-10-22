# Status Board

One board for every Claude project, kept current by the projects themselves.
Five parts, one version number (`VERSION`; the same string is in
`.claude-plugin/plugin.json`, `hooks/register.ts`, `board/project-board.html`,
`board/rules.md`, and in `meta/instruction.version` on the board):

- **The plugin** (`.claude-plugin/`, `hooks/register.ts`): a Claude Code plugin. In a
  thread it writes the thread's status (thinking / waiting on you / idle) at the start and end
  of every turn, the thread's running background jobs (the board lights "working"), and its
  "waiting on you" list, read from the "Waiting on you:" line the thread ends each message with
  (see the board-status skill), which you can tick off on the board. It
  places a new thread on the card that holds its project's other threads, by the project's
  thread listing; a thread it cannot place shows on the board as "not on any card", never on a
  guessed card. The card's thread list is synced only by `/board-status`. A project
  conversation is left off the board; the mod writes nothing there. A log of what the mod
  does is kept in `~/.claude/status-board.log`.
  The plugin takes the board's address from your `board-skill` skill (the newest copy
  under `~/.claude/skills/`, synced ones included; the names `board` and `update-status-board` also work), so moving to a new board
  needs only the skill updated (the board's **Copy skill setup** button). Without the
  skill on disk it uses the address built into `hooks/register.ts`.
- **The board-status skill** (`skills/board-status/`): `/board-status`, sent at the start of each
  fresh session, makes the thread write once to the board (in auto mode that lets the plugin write
  for the rest of the session), list the project's threads so the plugin can place the thread and
  sync the card's thread list, and report what the card shows. `/board-info` shows what the
  plugin itself sees.
- **The messaging skill** (`skills/status-board-messaging/`): ships with the plugin, so every
  session that has the plugin can send a note to another project or check its own mail through
  the board's "messages" collection. The plugin's per-turn note shows a thread how many notes
  wait for its project.
- **The board page** (`board/project-board.html`): the source of the Status Board
  artifact (https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T, capabilities `db` and
  `user`). After a change, publish it to that same URL.
- **The rules** (`board/rules.md`): what every project's Claude reads from the board
  (`meta/instruction` in the board's database, field `rules`). After a change, write it
  back there. Nothing needs pasting into a project's own instructions: the plugin's
  note tells every session to read these rules.

## Setting up

Everything is a one-time step per place. Per session, send `/board-status` as the first message.

1. **claude.ai (cloud sessions, including every project conversation and its threads).**
   Customize → Plugins → Add marketplace → `zwdzwd/status-board-mod` → install
   **status-board**. Every cloud session in every project loads it from then on.
   A project conversation that is already open picks it up after
   Project settings → Restart Claude.

2. **Each computer that runs `claude rc` (Remote Control sessions).** Once per machine:

       claude plugin marketplace add zwdzwd/status-board-mod
       claude plugin install status-board@status-board

   (`status-board` is the marketplace's own name.) Every `claude rc` started on that
   machine afterwards has the plugin. A repo can also declare it in
   `.claude/settings.json` so it stays enabled for sessions started there:

       { "extraKnownMarketplaces": { "status-board": { "source": { "source": "github", "repo": "zwdzwd/status-board-mod" } } },
         "enabledPlugins": { "status-board@status-board": true } }

   `claude rc` starts sessions without the interactive install prompt, so the plugin
   still has to be installed once with the two commands above.

3. **The skill.** On the board, press **Copy skill setup**, paste the prompt into any Claude
   session and save the skill it offers. It tells every cloud session where the board is.

4. **Pin the board.** Open the artifact link above once and pin it to the sidebar.

### A brand-new account (no board yet)

- Publish `board/project-board.html` as an artifact with capabilities `db` and `user`,
  and pin it.
- Write `board/rules.md` into that artifact's database as `meta/instruction`
  (fields `rules`, `version`, `updated`).
- Put the new artifact's URL in `FALLBACK` at the top of `hooks/register.ts`, commit, push,
  then do steps 1–3 above.

## If the board is lost

Follow `board/RECOVERY.md`: rebuild the page from this repo, record the rules and the new link in
it, refresh the `board-skill` skill with the board's **Copy skill setup** button, release
the plugin with the new link, and paste one prompt into each project's conversation so it
recreates its card.

## Updating

After each release (a new `VERSION`):

- claude.ai: Plugins → **Check for updates**, then Project settings → Restart Claude in
  any project conversation that is open.
- Each `claude rc` machine: `claude plugin marketplace update status-board`, then
  `claude plugin update status-board@status-board --scope <user|project>` (the scope it was
  installed at), then restart `claude rc`.
- The board page and rules are updated by publishing / writing them back; readers see
  them at once.

## Tests

`test/` drives the plugin through simulated sessions (start, turns, listings, background jobs,
`/clear`, exit, project conversations) against an in-memory board that answers like ArtifactData:

    npm i --no-save typescript && node test/tests.mjs

## Releasing

Bump the version in the five places listed at the top, run the tests, commit, push, then follow
"Updating".

## How it fits together

- Card = one document in `projects/<id>` on the board: name, repo, category, status,
  summary, next, blocker, threads[], updated.
- Thread entry = `{label, url, session, transcript, status, at, jobs, asks?, waiting?, ended?}`:
  `session` is the remote session id (`cse_…`) the project's tools use, `transcript` the CLI
  session id. The thread's own session writes its status and jobs; `/board-status` in any
  thread makes the list match the project's open threads. Resolve threads rather than delete
  them.
- Other collections: `sessions/<uuid>` (the plugin's index: which card and thread a session is),
  `unmatched/<uuid>` (threads the plugin could not place, shown on the board), `checkins/<thread
  id>` (the `/board-status` write that, in auto mode, lets the plugin write for the session),
  `ticks/<ask id>` (items you ticked on the board), `messages` (notes between projects) and `meta/instruction` (the rules).
