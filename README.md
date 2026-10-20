# status-board

A Claude Code mod that keeps a chat's status current on a shared Status Board artifact.

In any Claude Code thread that is registered on the board (its card lists the thread with this session's id), the mod:

- writes `thinking` to the thread's entry at the start of every turn;
- writes `waiting_on_you` or `idle` at the end of every turn, judged from the reply;
- adds a `/board` command that says which card and thread the chat updates.

It never touches the thread's `job` field (a running machine job) or any other thread's entry.

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
