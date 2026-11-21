#!/usr/bin/env python3
# Claude Code status line for the Status Board: saves the account's 5-hour and weekly usage to
# ~/.claude/usage.json (the status-board plugin forwards it to the board) and prints a short line.
import json, os, sys, time
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
rl = d.get("rate_limits") or {}
out = {"at": int(time.time())}
for k in ("five_hour", "seven_day"):
    w = rl.get(k)
    if isinstance(w, dict) and isinstance(w.get("used_percentage"), (int, float)):
        out[k] = {"pct": round(w["used_percentage"]), "resets_at": w.get("resets_at")}
if len(out) > 1:
    p = os.path.expanduser("~/.claude/usage.json")
    try:
        with open(p + ".tmp", "w") as f:
            json.dump(out, f)
        os.replace(p + ".tmp", p)
    except OSError:
        pass
    print(" · ".join(f"{n} {out[k]['pct']}%" for k, n in (("five_hour", "5h"), ("seven_day", "week")) if k in out))
