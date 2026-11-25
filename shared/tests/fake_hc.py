#!/usr/bin/env python3
"""A stand-in for herdr-core's `hc`, enough for hd_dispatch.py's tests.

State is $FAKE_HC (a JSON file): {"terminals": {name: {address, state, status, turn, screen, labels,
foreground, cwd, argv}}, "calls": [[arg, ...], ...]}. Calls are appended to "calls" except a `send`
whose `--if` condition fails (exit 10, status_mismatch). Only idle/working conditions are accepted;
other values fail with exit 2 before recording the call. `keys` submits text when it reaches `enter`;
`read` returns the terminal's configured "screen". `send` to a
live terminal answers {"started": true} unless the terminal has "refuse": true; `run --bg` adds a
live terminal. A terminal's "on_send" ({"status": ..., "turn": +1, "write": [path, text]}) is applied
when it is sent a message, to play a helper that answers.
"""
import json
import os
import sys
from pathlib import Path

STATE = Path(os.environ["FAKE_HC"])


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {"terminals": {}, "calls": []}


def find(st, ref):
    for name, t in st["terminals"].items():
        if ref in (name, t.get("address")):
            return name, t
    return None, None


def send(t, text):
    t.setdefault("sent", []).append(text)
    act = t.get("on_send") or {}
    if "status" in act:
        t["status"] = act["status"]
    t["turn"] = t.get("turn", 0) + act.get("turn", 0)
    if act.get("write"):
        Path(act["write"][0]).write_text(act["write"][1])


def main(argv):
    st = load()
    st.setdefault("calls", []).append(argv)
    as_json = "--json" in argv
    args = [a for a in argv if a != "--json"]
    cmd, rest = args[0], args[1:]
    reply, code = None, 0
    if cmd == "get":
        name, t = find(st, rest[0])
        if t is None:
            reply = {"error": "not found"}
        else:
            reply = {"name": name, "address": t.get("address"), "state": t.get("state", "live"),
                     "status": {"state": t.get("status", "idle"), "app": t.get("app", "codex")},
                     "status_ms": t.get("status_ms"),
                     "turn": t.get("turn", 0), "labels": t.get("labels", {}),
                     "parent": t.get("parent"),
                     "foreground": {"argv": t.get("argv", ["codex"]), "cwd": t.get("cwd")}}
    elif cmd == "ls":
        reply = {"terminals": [{"name": n, "address": t.get("address"), "state": t.get("state", "live"),
                                "agent": t.get("app", "codex"), "status": t.get("status", "idle")}
                               for n, t in st["terminals"].items()]}
    elif cmd == "read":
        _, t = find(st, rest[0])
        sys.stdout.write((t or {}).get("screen", ""))
    elif cmd == "send":
        condition = None
        if "--if" in rest:
            index = rest.index("--if")
            condition = rest[index + 1]
            if condition not in ("idle", "working"):
                print(f"error: invalid value '{condition}' for '--if <STATUS>' "
                      "[possible values: idle, working]", file=sys.stderr)
                return 2
            rest = rest[:index] + rest[index + 2:]
        _, t = find(st, rest[0])
        ok = bool(t) and t.get("state", "live") == "live" and not t.get("refuse")
        if condition is not None and t and t.get("status", "idle") != condition:
            st["calls"].pop()
            reply, code = {"error": "status_mismatch"}, 10
        else:
            if ok:
                send(t, rest[1] if len(rest) > 1 else "")
            reply = {"started": ok}
    elif cmd == "keys":
        _, t = find(st, rest[0])
        ok = bool(t) and t.get("state", "live") == "live" and not t.get("refuse")
        if ok:
            text = t.get("key_draft", "")
            for key in rest[1:]:
                if key == "enter":
                    send(t, text)
                    text = ""
                else:
                    text += " " if key == "space" else key
            t["key_draft"] = text
        reply, code = {"ok": ok}, 0 if ok else 3
    elif cmd == "interrupt":
        _, t = find(st, rest[0])
        if t:
            t["status"] = "idle"
        reply = {"ok": bool(t)} if t else {"error": "not found"}
    elif cmd == "kill":
        _, t = find(st, rest[0])
        if t:
            t["state"] = "finished"
    elif cmd == "rm":
        name, _ = find(st, rest[0])
        st["terminals"].pop(name, None)
    elif cmd == "label":
        _, t = find(st, rest[0])
        if t:
            for kv in rest[1:]:
                k, _, v = kv.partition("=")
                if v:
                    t.setdefault("labels", {})[k] = v
                else:
                    t.setdefault("labels", {}).pop(k, None)
    elif cmd == "run":
        name = rest[rest.index("--name") + 1]
        cwd = rest[rest.index("--cwd") + 1] if "--cwd" in rest else None
        labels = dict(rest[i + 1].split("=", 1) for i, a in enumerate(rest) if a == "--label")
        addr = f"t{100 + len(st['terminals'])}"
        pos = [a for i, a in enumerate(rest) if not a.startswith("--") and (i == 0 or rest[i - 1] not in
               ("--name", "--cwd", "--label", "--template")) and a != "--bg"]
        st["terminals"][name] = {"address": addr, "state": "live", "status": "working", "turn": 1,
                                 "labels": labels, "cwd": cwd, "argv": pos[:1], "sent": pos[1:],
                                 "notify": "--no-notify" not in rest}
        reply = {"address": addr, "name": name, "first_message": {"sent": True}}
    elif cmd == "wait":
        pass
    else:
        reply = {"error": f"fake hc: no {cmd}"}
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1))
    if reply is not None and (as_json or cmd in ("run",)):
        print(json.dumps(reply, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
