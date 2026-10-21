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

1. **Approve the session's board writes.** In auto mode the Status Board mod's own writes are refused
   until this session has written to the board once. Write this thread's check-in record:
   `get` collection "checkins", doc_id = this thread's id (the cmsg_… id of its first message);
   then `set` it to `{"at": "<ISO now>"}`, passing its version as if_version when it exists.
2. **List the project's threads.** Call the project's thread-listing tool (list_thread_sessions, or
   list_threads) once, with no arguments. The mod places this thread on its project's card at once
   if it is not there yet, and, with its next status write (at the end of this turn), makes the
   card's thread list match the project's open threads and names this thread's entry. Do not edit
   the thread list yourself.
3. **Report.** Find this project's card (`list` collection "projects"; it is the card whose threads
   include this thread's link or session) and tell the user in a line or two what it shows: the
   summary, the next step, and its threads with their status. The thread list is synced at the end
   of this turn, so say that it will match then. If no card holds this project's threads, say so;
   the board lists this thread under "not on any card".
