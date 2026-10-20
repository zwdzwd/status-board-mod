# Status Board

One board for every Claude project, kept current by the projects themselves.
Three parts, one version number (see `VERSION`; currently the same string is in
`.claude-plugin/plugin.json`, `hooks/register.ts`, `board/project-board.html` and
`board/rules.md`, and in `meta/instruction.version` on the board):

- **The mod** (`.claude-plugin/`, `hooks/`): a Claude Code plugin. In a thread it
  registers the thread on its project's card and writes the thread's status
  (thinking / working / waiting on you / idle, plus a job line) at the start and end
  of every turn. In the project conversation (the coordinator) it keeps the card's
  thread list equal to `list_thread_sessions` after every turn and writes the
  coordinator's own status to `card.coordinator`.
- **The board page** (`board/project-board.html`): the source of the Status Board
  artifact (https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF, capabilities `db`
  and `user`). Publish it to that URL after changing it.
- **The rules** (`board/rules.md`): what every project's Claude reads from the board
  (`meta/instruction`: `text` is the short pointer pasted once into each project's
  instructions; `rules` is the full text). Write it back to the board after changing it.

## Install

    claude plugin install status-board --marketplace zwdzwd/status-board-mod

On claude.ai: Customize → Plugins → Add marketplace `zwdzwd/status-board-mod`, then
"Check for updates" after each release; project conversations pick it up after
Project settings → Restart Claude. A Mac running `claude rc` needs
`claude plugin update status-board` and a restart of `claude rc`.

## Release

Bump the version in the five places above, commit, push, then Check for updates.
