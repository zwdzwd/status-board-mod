# status-board

A Claude Code mod that keeps a chat's status current on a shared Status Board artifact.

In any Claude Code thread, the mod:

- registers the thread on its project's card at session start (matched by the card's `repo` field or name; label "New thread" until the thread's own Claude fills in the name and link on its first turn);
- writes `thinking` at the start of every turn and `working` while a command runs on a machine for more than a few seconds;
- writes `waiting_on_you` or `idle` at the end of every turn, judged from the reply, and sets or clears a `job` line when the reply says work is still running elsewhere (a remote session, a SLURM job, CI), which the board shows as working;
- stamps the entry `ended` when the session ends; the board dims it at once and removes it after an hour unless the thread is reopened (a resolved thread never is);
- adds one line to the system prompt naming this session's id and what it did, so the thread's Claude keeps the entry right;
- adds a `/board` command that says which card and thread the chat updates.

It writes only its own thread's entry.

The board's link is the `BOARD` constant at the top of `hooks/register.ts`.

## Install

At the prompt of a terminal session:

```
/plugin install status-board --marketplace zwdzwd/status-board-mod
```

Answer `y` to add the marketplace, then pick a scope (user is fine).

From a shell:

```
claude plugin install status-board --marketplace zwdzwd/status-board-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `zwdzwd/status-board-mod`, then Add plugin.
