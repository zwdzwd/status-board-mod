# Status Board rules (meta/instruction) — v0.7.1

Source of the rules every project reads from the board. To change them, edit this file and write it back to meta/instruction (fields: text, rules, updated).

## text (pasted once into each project's instructions)

## Status Board
Inside a Claude project, keep this project's card current on my status
board: https://claude.ai/artifact/LYx5fKvoHhPNbceSvStkRF
Read the current rules from the "rules" field of the board's
"meta/instruction" record and follow them: they say how thread status
(thinking / waiting on you / idle) and running jobs are recorded, and
when the status-board mod does it for you. Outside a project, ignore
this unless I ask about the board.


## rules

## Status Board rules (read by Claude inside a project before updating)
- My card id = the project's name, lowercased, letters and digits only
  (e.g. "Immune5hmC" -> immune5hmc). List the board's "projects"
  collection first and reuse a card with my name if one exists;
  otherwise create it. If unsure of the project name, ask me once.

## Who you are
- THE PROJECT CONVERSATION (the coordinator: the session where I give
  the project its tasks and Claude starts threads). It owns the card's
  thread list and has NO thread entry of its own. When the status-board
  mod's note says it syncs the thread list itself (mod v0.6.0 and
  later), leave the thread list to it: it calls list_thread_sessions
  at the end of every turn. Without that note, do it yourself: at the
  END OF EVERY TURN, whatever the turn was about: read the card, then make its
  threads match the project's OPEN threads exactly (the Overview's
  open list; resolved and archived threads are not open). Match an
  entry to a thread by the thread id in its url (the ?thread=cmsg_…
  part), never by name: remove entries whose thread is not open, add
  an entry {label, url} for an open thread that has none (the mod
  fills transcript and status once the thread runs), and set every
  entry's label to the thread's name as YOUR list shows it. An entry
  with no url is matched by label. Keep every other field of entries
  that stay. Skip the write only when nothing differs. I resolve
  threads rather than delete them, so a thread you cannot see any more
  counts as not open. Write the index record
  sessions/<your own session UUID, from the mod's note> = {card:
  <card id>, role: "coordinator"} once, so the mod knows not to track
  you as a thread. If an entry on the card carries your UUID (as
  transcript or coordinator), remove that id from it.
- A THREAD (a session started for one task; it may run in the cloud
  or on my computer through Remote Control). It owns its own entry:
  status, job, and its label and url if the coordinator has not set
  them. See the mod rules below.
- A REMOTE CONTROL helper session that works for a thread writes that
  thread's entry, never one of its own.

## The status-board mod
Its "Status Board mod" note is in your system prompt when it runs. It
does the per-turn bookkeeping by itself:
  - it finds this session's entry through the index record
    sessions/<session UUID>; failing that, by the entry carrying the
    UUID; failing that, it registers a new entry (label "New thread",
    transcript = the UUID) on the card whose repo or name matches this
    repository. On your first turn, fix that entry's label (the
    thread's name as the project's thread list shows it) and url (this
    thread's link), touching nothing else. When the mod says it could
    not match a card (a folder shared by several projects, such as the
    writing repo), add the entry yourself on THIS project's card:
    label, url (the project link plus ?thread=<id>; if you cannot find
    the id, leave url empty), session, transcript from the mod's note.
    Never invent a label. ONE ENTRY PER THREAD: if an entry for this
    thread already exists (same url, or added by the coordinator with
    your label), fill it instead of adding another. Whenever you add or
    change this thread's entry, also write sessions/<your UUID> =
    {card: <card id>, label};
  - it writes the thread's status: "thinking" while Claude is on a
    turn, "working" while a command runs on a machine for more than a
    few seconds, "waiting_on_you" when the reply asks me something,
    "idle" otherwise; and a job line when the reply says work is still
    running elsewhere;
  - it stamps the entry ended when the session ends. The board shows a
    thread while it has been active in the last 8 hours and its session
    has not ended since; otherwise the thread is quiet (one click away
    on the card) and comes back when used again.
Without the mod's note, do that bookkeeping yourself: write status
"thinking" before other work and the end state after the reply is
settled, each with at = ISO now; set job (one short line) when you
start a machine job that outlives the turn and clear it to "" when it
finishes.

## The card
- Set the card's repo field once to this repository's owner/name (from
  git remote), so the mod can match new threads to the card.
- Update the rest of the card at the end of a session where something
  real changed (result, decision, new blocker, finished step), or when
  I say "update the board". Skip it when nothing changed.
- Read my card, then write ONLY my card, pinned to the version read
  (on a version mismatch, re-read and write once more). Keep it short:
  - name: project name
  - repo: owner/name of the git remote
  - status: the card's own fallback, same values as a thread's
    (threads decide the color when they have one)
  - summary: one sentence on where it stands
  - next: the single next step, one line
  - blocker: what it is waiting on, one line, or "" if none
  - threads: [{label, url, session, transcript, status, at, job}], one
    entry per open thread of this project and nothing else. label = the
    thread's name as the project's thread list shows it. url = the
    thread's link. session = its Claude Code session id (cse_… or
    session_…). transcript = that session's UUID (the mod's note names
    it). A thread writes only its own entry; the coordinator maintains
    the list. No montage, artifact, repo, Zenodo or other links
    anywhere on the card: remove a links or montage field if present.
  - coordinator: {status, at, transcript, ended?} — the project
    conversation's own status, written by the mod only (the board shows
    it as the stripe on the card's left edge). Never write or remove it;
    when you update the card, leave this field as it is.
  - category: paper | software | grant | talk | personal. It picks the
    board section. Set it only when creating the card (ask me if
    unclear); never change it afterwards.
  - updated: ISO time now
  Leave everything else (url, priority, category) unchanged.
- Tell me in one line what you changed. If you can't write to the
  board, give me the update as a short block to paste elsewhere.

