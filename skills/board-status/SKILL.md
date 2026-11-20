---
name: board-status
description: Sync this thread's project card on the Status Board, thread list included. Run when the user sends /board-status, which they do at the start of each fresh session.
---

# /board-status

Run it here, in this thread; never start a thread for it. In a project conversation (the chat
that starts the project's threads) the mod writes nothing: there, update this project's card
yourself by the board's rules. The board is the artifact named in the
board-skill skill (https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T if no such skill is loaded).
Read and write it with the ArtifactData tool; load it with ToolSearch ("select:ArtifactData") if it
is deferred. Its rules are the "rules" field of collection meta, doc_id instruction.

1. **List the project's threads, every time.** Call the project's thread-listing tool (list_thread_sessions,
   or list_threads) once, with no arguments, even when you already know this thread's id: the mod
   syncs the card's thread list only from this call's result, so skipping it leaves new threads off. The row whose session id is this session's names this
   thread (its thread_id, a cmsg_… id). The mod places this thread on its project's card if it is
   not there yet, and, with its next status write (at the end of this turn), makes the card's thread
   list match the project's open threads and names this thread's entry. Do not edit the thread list
   yourself.
2. **Approve the session's board writes.** In auto mode the Status Board mod's own writes are refused
   until this session has written to the board once. Write this thread's check-in record: `get`
   collection "checkins", doc_id = this thread's id from step 1 (or, if the listing did not name it,
   the session id the mod's note gives); then `set` it to `{"at": "<ISO now>"}`, passing its version
   as if_version when it exists.
3. **Report.** Find this project's card (`list` collection "projects"; it is the card whose threads
   include this thread's link or session) and tell the user in one line that the thread is on it and its
   list will match the project's open threads at the end of this turn. If no card holds this project's
   threads, look for a card whose name matches the project's name (letters and digits, ignoring case)
   and lists no threads yet, and add this thread to it with one `update` of its "threads", pinned to its
   version: `[{"label": "<this thread's title>", "url":
   "https://claude.ai/code/project/<this project's id>?thread=<this thread's id>", "session": "<this
   session's id>"}]` (the project's id, chan_…, from your system prompt; leave out "url" when unknown).
   If there is no such card, say so in one line. Do nothing else: no card text, connection checks,
   tables or mail (the mod's note already says when mail is waiting).

## Every turn after this: "Waiting on you"

End each message to the user with `Waiting on you: nothing`, or a `Waiting on you:` heading and one
short bullet per item (#1, #2, ...), bare imperatives under 12 words, listing only what this thread
needs. The mod reads it; any item turns this thread's link red on the board.
