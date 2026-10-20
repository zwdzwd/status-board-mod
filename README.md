# status-board

A Claude Code mod that keeps a chat's status current on a shared Status Board artifact.

In any Claude Code thread that is registered on the board (its card lists the thread with this session's id), the mod:

- writes `thinking` to the thread's entry at the start of every turn;
- writes `waiting_on_you` or `idle` at the end of every turn, judged from the reply, and sets or clears the thread's `job` field when the reply says work is still running elsewhere (a remote session, a SLURM job, CI), which the board shows as working;
- adds a `/board` command that says which card and thread the chat updates;
- adds one line to the system prompt naming this session's id, so the thread records it on its card entry (`transcript`) and the mod can find itself.

It never touches any other thread's entry, and keeps a `job` line the thread wrote itself while the work is still running.

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
