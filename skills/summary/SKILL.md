---
name: summary
description: Print a table of every thread in this project, with its connection status and what it waits on the user for. Run only when the user sends /summary; it never runs or updates by itself.
---

# /summary

Print one table, once, in this conversation. It works in a project conversation and in a thread
alike. Nothing is written anywhere: no board write, no file, no scheduled update. The user runs
/summary again for a fresh table.

1. **List the threads.** Call the project's thread-listing tool (list_threads, or
   list_thread_sessions) with no arguments, and follow next_cursor until every thread is listed.
   Leave out threads whose state is done.
2. **Read the board card.** The board is the artifact named in the board-skill skill
   (https://claude.ai/artifact/GKm8qjBy2aV85j85K29S4T if no such skill is loaded); load ArtifactData
   with ToolSearch ("select:ArtifactData") if it is deferred. `list` collection "projects" and take
   the card whose "threads" hold any of the listed threads (by session id, or by `thread=<id>` in an
   entry's url). Each entry's "asks" is that thread's waiting list (`[{text}]`). With no card, go on
   without it.
3. **Read each thread's latest messages.** Call read_thread for each thread with limit 10. From them
   take:
   - **Connection.** The newest message whose body is JSON with "kind" thread_session or
     remote_control_session gives it: phase "offline" or "reconnect" means **offline** (name the
     machine and folder, and since when), phase "online" means **online**. With no such message the
     thread runs in the cloud: **cloud**, or **stopped** when the listing's state is stopped.
   - **Last word.** The newest plain message from the agent, for the waiting column below.
4. **Work out what waits on the user.** Use the card entry's asks when it has any. Otherwise use the
   "Waiting on you:" list at the end of the thread's last agent message. Otherwise, when the state is
   blocked or review_ready, or the newest message is the user's and still unanswered on an offline
   thread, say in under 12 words what the thread needs (for example "Restart Remote Control on the
   Mac mini"). Otherwise write "nothing".
5. **Print the table** as a reply to the user (in a project, through the tool that posts to the
   user), then stop:

   | Thread | Connection | State | Waiting on you |
   |---|---|---|---|
   | [Mac](link) | offline, Mac mini ~/repo/writing, since Oct 29 | blocked | Restart Remote Control on the Mac mini |

   One row per thread, newest activity first. Link each title to its thread (in a project, as
   `[title](#<thread_id>)`). State is the listing's state. Keep each cell short, join several asks
   with "; ", and put one line under the table only if something needs saying (for example that no
   board card was found).
