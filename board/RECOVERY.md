# Rebuilding the Status Board

Use this if the board artifact is ever lost. The board's link lives in three places: the board's
own data (`meta/instruction.board`), your `board-skill` skill, and the plugin (`BOARD` in
`hooks/register.ts`). The cards and threads live only on the board; there is no backup, so the
projects recreate them.

1. **Publish the page.** In any Claude session: "Publish `board/project-board.html` from
   zwdzwd/status-board-mod as an artifact titled Status Board, with capabilities `db` and `user`."
   Pin it to the sidebar.
2. **Write the rules and the link.** Into the new board's data, `meta/instruction` =
   `{ rules: <the "rules" section of board/rules.md>, version: <VERSION>, board: <the new link>,
   updated: <now> }`.
3. **Update the skill.** Open the new board, press **Copy skill setup**, paste it into any Claude
   session and save the skill it offers. Every cloud session then has the new link.
4. **Release the plugin with the new link.** Change `BOARD` in `hooks/register.ts` and the link in
   the README, bump the version in the five places, run the tests, commit and push. Then Check for
   updates on claude.ai, and run `claude plugin update status-board` on each machine that runs
   `claude rc`. Until then, threads keep writing their status to the old link.
5. **Recreate the cards.** Paste this into each project's own conversation (the coordinator):

   > The Status Board was rebuilt. Read your board-skill skill for its address and the
   > board's rules, then create this project's card on it from what you know of the project, with
   > its open threads from your thread list. If you cannot write to the board yourself, start a
   > thread to do it. Add no thread entry for yourself.

   Threads then register themselves on their cards as they run. The `sessions` and `diagnostics`
   collections need nothing.
