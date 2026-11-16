"""hd_dispatch.py against a fake hc (fake_hc.py). Run: python3 -m unittest discover -s shared/tests"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HD = HERE.parent / "scripts" / "hd_dispatch.py"
SCHEMA = {"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}


class Env:
    """A temp world: a git repo with a run folder, CC_HD_HOME, a fake hc on PATH and its state."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="hd-test-")).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        hc = self.bin / "hc"
        hc.write_text(f"#!/bin/sh\nexec {sys.executable} {HERE / 'fake_hc.py'} \"$@\"\n")
        hc.chmod(0o755)
        codex = self.bin / "codex"
        codex.write_text("#!/bin/sh\nexit 0\n")
        codex.chmod(0o755)
        self.state = self.root / "hc.json"
        self.home = self.root / "hd"
        self.repo = self.root / "repo"
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        self.run_dir = self.repo / ".cc-dispatch" / "dev-x"
        self.run_dir.mkdir(parents=True)
        self.schema = self.root / "schema.json"
        self.schema.write_text(json.dumps(SCHEMA))
        self.set_terminals({"parent": {"address": "t1", "status": "working", "app": "claude-code",
                                       "argv": ["claude"], "labels": {"herdr.space": "s1"}}})

    def env(self, **extra):
        e = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", FAKE_HC=str(self.state),
                 CC_HD_HOME=str(self.home), HC_TERMINAL_ID="t1", CODEX_HOME=str(self.root / "nocodex"),
                 CC_HD_RETRY_DELAYS="0", CC_HD_NET="up",
                 CC_HD_QUOTA_JSON=str(self.root / "no-quota.json"))
        e.update(extra)
        return e

    def hd(self, *args, **env):
        r = subprocess.run([sys.executable, str(HD), *args], capture_output=True, text=True, env=self.env(**env))
        return r

    def kv(self, r):
        return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l and l.split("=", 1)[0].isupper())

    def hc_state(self):
        return json.loads(self.state.read_text())

    def set_terminals(self, terms):
        st = self.hc_state() if self.state.exists() else {"terminals": {}, "calls": []}
        st["terminals"].update(terms)
        self.state.write_text(json.dumps(st))

    def patch(self, name, **kv):
        st = self.hc_state()
        st["terminals"][name].update(kv)
        self.state.write_text(json.dumps(st))

    def dispatch(self, call="a", mode="write", prompt="do it"):
        p = self.root / f"prompt-{call}.md"
        p.write_text(prompt)
        r = self.hd("run", "--run", str(self.run_dir), "--call", call, "--mode", mode, "--effort", "high",
                    "--dir", str(self.repo), "--prompt", str(p), "--schema", str(self.schema))
        assert r.returncode == 0, r.stdout + r.stderr
        return self.meta(call)

    def meta(self, call="a"):
        return json.loads((self.run_dir / "agents" / call / "meta.json").read_text())

    def events(self, call="a"):
        f = self.run_dir / "agents" / call / "events.jsonl"
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []


class Archive(unittest.TestCase):
    def test_dispatching_again_takes_the_run_out_of_the_archive(self):
        w = Env()
        w.dispatch("a")
        (w.run_dir / "archived").write_text("1\n")
        w.dispatch("b")
        self.assertFalse((w.run_dir / "archived").exists())


class ReportBackup(unittest.TestCase):
    def test_collect_and_send_keep_a_copy_in_the_run_folder(self):
        w = Env()
        m = w.dispatch()
        Path(m["report"]).write_text('{"status": "done"}')
        w.patch(m["name"], status="done", turn=1)
        r = w.hd("collect", "--run", str(w.run_dir))
        self.assertIn("REPORT_OK", r.stdout, r.stdout + r.stderr)
        kept = Path(m["agent_dir"]) / "report-r1.json"
        self.assertEqual(json.loads(kept.read_text()), {"status": "done"})
        # send moves round 1's report aside; the run folder still has it, and round 2's lands beside it
        p = w.root / "p2.md"
        p.write_text("again")
        w.hd("send", "--run", str(w.run_dir), "--call", "a", "--prompt", str(p))
        Path(m["report"]).write_text('{"status": "r2"}')
        w.patch(m["name"], status="done", turn=2)
        w.hd("collect", "--run", str(w.run_dir))
        self.assertEqual(json.loads((Path(m["agent_dir"]) / "report-r2.json").read_text()), {"status": "r2"})
        self.assertTrue(kept.exists())


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True).stdout


class Freeze(unittest.TestCase):
    def test_asks_for_a_note_snapshots_the_worktree_and_leaves_a_package(self):
        w = Env()
        (w.repo / "kept.txt").write_text("v1\n")
        git(w.repo, "add", "kept.txt")
        git(w.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "kept")
        m = w.dispatch(prompt="implement the thing")
        (w.repo / "kept.txt").write_text("v2\n")
        (w.repo / "new.txt").write_text("fresh\n")
        progress = Path(m["report"]).parent / "progress-r1.md"
        w.patch(m["name"], status="working", on_send={"status": "done", "turn": 1,
                                                     "write": [str(progress), "## 已完成\n- kept.txt 改成 v2\n"]})
        head = git(w.repo, "rev-parse", "HEAD")
        r = w.hd("freeze", "--run", str(w.run_dir), "--call", "a", "--ask", "20", "--why", "manual")
        kv = w.kv(r)
        self.assertEqual(kv.get("FROZEN"), "a", r.stdout + r.stderr)
        self.assertEqual(kv["PROGRESS"], "yes")
        ref = kv["SNAPSHOT"]
        self.assertEqual(ref, "refs/cc-dispatch/dev-x/a/r1")
        # the snapshot has the uncommitted and untracked files; HEAD, index and worktree are untouched
        self.assertEqual(git(w.repo, "show", f"{ref}:new.txt"), "fresh\n")
        self.assertEqual(git(w.repo, "show", f"{ref}:kept.txt"), "v2\n")
        self.assertEqual(git(w.repo, "rev-parse", "HEAD"), head)
        self.assertIn("?? new.txt", git(w.repo, "status", "--short"))
        self.assertIn(" M kept.txt", git(w.repo, "status", "--short"))
        # the helper was interrupted, asked, and its terminal closed
        st = w.hc_state()
        self.assertNotIn(m["name"], st["terminals"])
        self.assertTrue(any(c[0] == "interrupt" for c in st["calls"]))
        meta = w.meta()
        self.assertFalse(meta["open"])
        self.assertEqual(meta["frozen"]["round"], 1)
        self.assertEqual(meta["acked"], "gone")
        pkg = Path(kv["HANDOFF"])
        data = json.loads((pkg / "handoff.json").read_text())
        self.assertEqual(data["format"], "cc-dispatch-handoff/1")
        self.assertEqual((data["level"], data["call"], data["round"], data["mode"]), ("helper", "a", 1, "write"))
        self.assertEqual(data["snapshot"]["ref"], ref)
        self.assertEqual(sorted(data["files"]), sorted(["handoff.json", "handoff.md", "prompt.md", "changes.diff", "progress.md"]))
        md = (pkg / "handoff.md").read_text()
        self.assertIn("implement the thing", md)
        self.assertIn("kept.txt 改成 v2", md)
        self.assertIn("+v2", md)
        self.assertIn("handoff.md", (pkg / "prompt.md").read_text())
        self.assertEqual([e["ev"] for e in w.events()][-1], "freeze")
        # wait does not report the closed terminal; a second freeze changes nothing
        self.assertIn("WAIT=nothing_running", w.hd("wait", "--run", str(w.run_dir), "--timeout", "5").stdout)
        self.assertEqual(w.kv(w.hd("freeze", "--run", str(w.run_dir), "--call", "a"))["HANDOFF"], str(pkg))

    def test_a_full_context_is_frozen_at_collect_without_asking(self):
        w = Env()
        m = w.dispatch(mode="read")
        w.patch(m["name"], status="error", turn=1,
                screen="■ Codex ran out of room in the model's context window. Start a new thread.\n")
        r = w.hd("collect", "--run", str(w.run_dir))
        kv = w.kv(r)
        self.assertEqual(kv.get("FAILURE"), "context_limit", r.stdout)
        self.assertTrue(Path(kv["HANDOFF"], "handoff.json").exists())
        st = w.hc_state()
        self.assertNotIn(m["name"], st["terminals"])
        self.assertFalse(any(c[0] == "send" for c in st["calls"]))
        meta = w.meta()
        self.assertIsNone(meta["frozen"]["snapshot"])
        self.assertIn("context window", Path(m["agent_dir"], "screen-r1.txt").read_text())


class Network(unittest.TestCase):
    def test_offline_waits_without_using_a_retry_then_carries_on(self):
        w = Env()
        m = w.dispatch()
        w.patch(m["name"], status="error", turn=1, screen="■ stream disconnected before completion: error sending request\n")
        r = w.hd("collect", "--run", str(w.run_dir), CC_HD_NET="down")
        kv = w.kv(r)
        self.assertEqual((kv["RETRYING"], kv.get("NET"), kv.get("FAILURE")), ("a(network)", "down", None), r.stdout)
        t = w.hc_state()["terminals"][m["name"]]
        self.assertEqual(t["labels"].get("cc.net"), "down")
        self.assertNotIn("cc.retry", t["labels"])
        self.assertEqual(len(t["sent"]), 1)  # just the dispatch
        # still down a long while later: still waiting, still no retry used, nothing reported
        meta = w.meta()
        meta["retry"]["at"] = 0
        (w.run_dir / "agents" / "a" / "meta.json").write_text(json.dumps(meta))
        r = w.hd("wait", "--run", str(w.run_dir), "--timeout", "1", CC_HD_NET="down")
        self.assertIn("WAIT=timeout", r.stdout)
        self.assertEqual(w.meta()["retry"]["n"], 0)
        self.assertEqual(len(w.hc_state()["terminals"][m["name"]]["sent"]), 1)
        # back online: told to carry on, the label goes, and the four retries are all still there
        meta = w.meta()
        meta["retry"]["at"] = 0
        (w.run_dir / "agents" / "a" / "meta.json").write_text(json.dumps(meta))
        w.patch(m["name"], on_send={"status": "working", "turn": 1})
        r = w.hd("collect", "--run", str(w.run_dir))
        t = w.hc_state()["terminals"][m["name"]]
        self.assertIn("网络中断", t["sent"][-1])
        self.assertNotIn("cc.net", t["labels"])
        self.assertNotIn("NET", w.kv(r))
        self.assertEqual(w.meta()["retry"]["n"], 0)
        evs = [json.loads(l)["ev"] for l in (Path(m["agent_dir"]) / "events.jsonl").read_text().splitlines()]
        self.assertIn("offline", evs)

    def test_offline_marks_working_helpers_and_auth_is_still_reported(self):
        w = Env()
        m = w.dispatch("a")
        n = w.dispatch("b")
        w.patch(m["name"], status="working", turn=0)
        w.patch(n["name"], status="error", turn=1, screen="error: 401 Unauthorized, run codex login\n")
        r = w.hd("collect", "--run", str(w.run_dir), CC_HD_NET="down")
        self.assertEqual(w.kv(r).get("FAILURE"), "auth", r.stdout)
        self.assertEqual(w.hc_state()["terminals"][m["name"]]["labels"].get("cc.net"), "down")


class Quota(unittest.TestCase):
    def test_wait_asks_any_main_agent_once_per_window_past_the_threshold(self):
        w = Env()
        w.dispatch()
        st = w.hc_state()
        st["terminals"]["parent"]["argv"] = ["/opt/bin/codex", "--sandbox", "danger-full-access"]
        w.state.write_text(json.dumps(st))
        q = w.root / "quota.json"
        reset = int(time.time()) + 3600
        q.write_text(json.dumps([
            {"provider": "claude", "kind": "subscription", "windows": [{"name": "5 hours", "used": 99}]},
            {"provider": "codex", "kind": "subscription", "user": "old", "windows": [{"name": "7 days", "used": 95}]},
            {"provider": "codex", "kind": "subscription", "user": "me", "last": True,
             "windows": [{"name": "5 hours", "used": 92, "resetsAt": reset}, {"name": "7 days", "used": 40}]}]))
        r = w.hd("collect", "--run", str(w.run_dir), CC_HD_QUOTA_JSON=str(q))
        self.assertIn("CC_HANDOFF=usage USAGE=codex:5h:92", r.stdout)
        self.assertIn(str(w.run_dir), r.stdout)
        self.assertIn("先问用户要不要现在交接", r.stdout)
        self.assertNotIn("7d", r.stdout.split("CC_HANDOFF")[1].splitlines()[0])
        r = w.hd("collect", "--run", str(w.run_dir), CC_HD_QUOTA_JSON=str(q))
        self.assertNotIn("CC_HANDOFF", r.stdout)  # once per window until it resets
        r = w.hd("collect", "--run", str(w.run_dir), CC_HD_QUOTA_JSON=str(q), HC_TERMINAL_ID="t9")
        self.assertNotIn("CC_HANDOFF", r.stdout)  # not this run's main agent


class Handover(unittest.TestCase):
    def test_codex_to_a_fresh_codex_keeps_call_report_and_worktree(self):
        w = Env()
        m = w.dispatch()
        w.patch(m["name"], status="error", turn=1,
                screen="■ Codex ran out of room in the model's context window.\n")
        w.hd("collect", "--run", str(w.run_dir))  # freezes it
        Path(m["report"]).write_text('{"status": "partial"}')
        r = w.hd("handover", "--run", str(w.run_dir), "--call", "a", "--why", "context_limit", "--note", "先跑测试")
        kv = w.kv(r)
        self.assertEqual((kv.get("AGENT"), kv.get("ROUND"), kv.get("FIRST_MESSAGE")), ("codex", "2", "sent"), r.stdout + r.stderr)
        meta = w.meta()
        self.assertEqual((meta["call"], meta["round"], meta["agent"], meta["open"]), ("a", 2, "codex", True))
        self.assertEqual(meta["report"], m["report"])
        self.assertEqual(meta["handovers"][0]["from"], "codex")
        self.assertTrue(Path(m["report"]).with_name("report.r1.json").exists())
        task = Path(m["agent_dir"], "task-2.md").read_text()
        self.assertIn("handoff.md", task)
        self.assertIn("先跑测试", task)
        self.assertIn(f"回报文件：{m['report']}", task)
        t = w.hc_state()["terminals"][meta["name"]]
        self.assertEqual((t["argv"], t["labels"]["cc.agent"], t["labels"]["cc.round"], t["cwd"]),
                         (["cc-hd-write-high"], "codex", "2", str(w.repo)))
        self.assertEqual(w.events()[-1]["ev"], "handover")
        # the new terminal is simply working: wait reports nothing until it settles
        self.assertIn("WAIT=timeout", w.hd("wait", "--run", str(w.run_dir), "--timeout", "1").stdout)

    def test_to_claude_from_the_panel_tells_the_dispatcher(self):
        w = Env()
        m = w.dispatch(mode="read")
        w.patch(m["name"], status="working",
                on_send={"status": "done", "turn": 1, "write": [str(Path(m["report"]).parent / "progress-r1.md"), "进度"]})
        r = w.hd("handover", "--run", str(w.run_dir), "--call", "a", "--to", "claude", "--ask", "10", "--notify")
        kv = w.kv(r)
        self.assertEqual((kv.get("AGENT"), kv.get("ISOLATION"), kv.get("NOTIFIED")), ("claude", "weak", "yes"), r.stdout + r.stderr)
        meta = w.meta()
        st = w.hc_state()
        run_call = [c for c in st["calls"] if c[0] == "run"][-1]
        argv = run_call[run_call.index("--") + 1:]
        self.assertEqual(argv[:3], ["claude", "--session-id", meta["agent_session"]])
        self.assertIn("--disallowedTools", argv)
        self.assertIn("--add-dir", argv)
        self.assertIn("task-2.md", argv[-1])
        self.assertIn("移交给了 Claude Code", st["terminals"]["parent"]["sent"][-1])
        self.assertEqual(meta["claude_sessions"], [meta["agent_session"]])
        self.assertIn(["label", m["address"], "cc.handover=claude"], [c[:3] for c in st["calls"]])

    def test_refused_while_paused(self):
        w = Env()
        w.dispatch()
        w.hd("pause", "--run", str(w.run_dir))
        r = w.hd("handover", "--run", str(w.run_dir), "--call", "a")
        self.assertEqual(r.returncode, 3)
        self.assertEqual(w.meta()["round"], 1)


class DispatcherHandoff(unittest.TestCase):
    def test_needs_notes_then_stops_new_work_and_leaves_a_package(self):
        w = Env()
        w.dispatch()
        r = w.hd("handoff", "--run", str(w.run_dir))
        self.assertEqual(r.returncode, 2)
        self.assertIn("NOTES_MISSING", r.stdout + r.stderr)
        (w.run_dir / "handoff-notes.md").write_text("用户要修 X；T1 在跑，下一步验收")
        (w.run_dir / "state.json").write_text(json.dumps({"phase": "implement", "children": ["fix-1"]}))
        r = w.hd("handoff", "--run", str(w.run_dir), "--why", "usage")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        kv = w.kv(r)
        pkg = Path(kv["HANDOFF"])
        self.assertEqual(pkg, w.run_dir / "handoff" / "1")
        self.assertIn("----- prompt for the next main agent -----", r.stdout)
        data = module("hd_handoff").read(pkg)
        self.assertEqual((data["level"], data["skill"], data["from"]["agent"], data["from"]["terminal"]),
                         ("dispatcher", "cc-herdr-dispatch-dev", "claude", "t1"))
        self.assertEqual([c["call"] for c in data["calls"]], ["a"])
        self.assertEqual(data["children"], ["fix-1"])
        self.assertIn("notes.md", data["files"])
        md = (pkg / "handoff.md").read_text()
        self.assertIn("用户要修 X", md)
        self.assertIn(f"adopt --run {w.run_dir} --from {pkg}", md)
        self.assertIn("自己的用量快到上限", md)
        ctl = json.loads((w.run_dir / "control.json").read_text())
        self.assertEqual((ctl["state"], ctl["prev"]["state"]), ("handoff", "running"))
        # no new work, and the old dispatcher's wait ends at once
        p = w.root / "p.md"
        p.write_text("more")
        r = w.hd("send", "--run", str(w.run_dir), "--call", "a", "--prompt", str(p))
        self.assertEqual((r.returncode, w.kv(r).get("RUN_CONTROL")), (3, "handoff"))
        r = w.hd("wait", "--run", str(w.run_dir), "--timeout", "30")
        self.assertEqual(w.kv(r).get("RUN_CONTROL"), "handoff")
        self.assertNotIn("WAIT=timeout", r.stdout)
        # a second handoff is the next package, keeping the state from before the first
        r = w.hd("handoff", "--run", str(w.run_dir))
        self.assertEqual(Path(w.kv(r)["HANDOFF"]).name, "2")
        self.assertEqual(json.loads((w.run_dir / "control.json").read_text())["prev"]["state"], "running")
        # resume cancels it
        r = w.hd("resume", "--run", str(w.run_dir))
        self.assertEqual(w.kv(r).get("HANDOFF"), "cancelled")
        self.assertEqual(json.loads((w.run_dir / "control.json").read_text())["state"], "running")

    def test_a_paused_run_goes_back_to_paused_when_cancelled(self):
        w = Env()
        w.dispatch()
        w.hd("pause", "--run", str(w.run_dir))
        w.hd("handoff", "--run", str(w.run_dir), "--no-notes")
        w.hd("resume", "--run", str(w.run_dir))
        self.assertEqual(json.loads((w.run_dir / "control.json").read_text())["state"], "paused")

    def test_adopt_moves_the_run_to_the_new_main_agent(self):
        w = Env()
        w.dispatch()
        w.set_terminals({"next": {"address": "t2", "status": "working", "app": "codex",
                                  "argv": ["/usr/local/bin/codex"], "labels": {"herdr.space": "s1"}}})
        # nothing to adopt before a handoff
        r = w.hd("adopt", "--run", str(w.run_dir), "--from", str(w.run_dir / "handoff" / "1"), HC_TERMINAL_ID="t2")
        self.assertNotEqual(r.returncode, 0)
        pkg = w.kv(w.hd("handoff", "--run", str(w.run_dir), "--no-notes"))["HANDOFF"]
        r = w.hd("adopt", "--run", str(w.run_dir), "--from", pkg, HC_TERMINAL_ID="t2")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        kv = w.kv(r)
        self.assertEqual((kv["ADOPTED"], kv["CALLS"], kv["RUN_CONTROL"], kv["AGENT"]), ("dev-x", "a", "running", "codex"))
        m = w.meta()
        self.assertEqual((m["parent"], m["dispatcher_agent"], m["adopted"]["from"]), ("t2", "codex", "t1"))
        self.assertEqual(w.events()[-1]["ev"], "adopt")
        ctl = json.loads((w.run_dir / "control.json").read_text())
        self.assertEqual((ctl["state"], ctl["owner"]), ("running", "t2"))
        # adopting again is a no-op; the old main agent is shut out
        r = w.hd("adopt", "--run", str(w.run_dir), "--from", pkg, HC_TERMINAL_ID="t2")
        self.assertEqual(w.kv(r).get("ALREADY"), "yes")
        p = w.root / "p.md"
        p.write_text("more")
        r = w.hd("send", "--run", str(w.run_dir), "--call", "a", "--prompt", str(p))
        self.assertEqual((r.returncode, w.kv(r).get("RUN_CONTROL")), (3, "adopted"))
        r = w.hd("wait", "--run", str(w.run_dir), "--timeout", "30")
        self.assertEqual(w.kv(r).get("RUN_CONTROL"), "adopted")
        # pause by the new owner keeps it the owner
        w.hd("pause", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        ctl = json.loads((w.run_dir / "control.json").read_text())
        self.assertEqual((ctl["state"], ctl["owner"]), ("paused", "t2"))


class Lost(unittest.TestCase):
    def vanish(self, w, call):
        st = w.hc_state()
        st["terminals"].pop(w.meta(call)["name"])
        w.state.write_text(json.dumps(st))

    def test_a_terminal_that_vanished_while_open_is_lost(self):
        w = Env()
        w.dispatch("a")
        w.dispatch("b")
        Path(w.meta("b")["report"]).write_text('{"status": "done"}')  # b handed in a good report
        w.patch(w.meta("b")["name"], status="done")
        w.hd("collect", "--run", str(w.run_dir))
        self.assertEqual(w.meta("b")["report_check"], "ok")
        self.vanish(w, "a")
        self.vanish(w, "b")
        r = w.hd("collect", "--run", str(w.run_dir))
        self.assertIn("FAILURE=lost", r.stdout)
        self.assertEqual(w.meta("a")["failure"], "lost")
        self.assertEqual(w.meta("a")["lost"]["round"], 1)
        self.assertIn("lost", [e["ev"] for e in w.events("a")])
        self.assertNotEqual(w.meta("b").get("failure"), "lost")  # its work is in
        st = w.hd("status", "--run", str(w.run_dir)).stdout
        self.assertIn("\tlost\t", st.splitlines()[0])
        # cleanup is the main agent dealing with it
        w.hd("cleanup", "--run", str(w.run_dir), "--call", "a")
        self.assertNotIn("lost", w.meta("a"))

    def test_cleaned_up_is_not_lost(self):
        w = Env()
        w.dispatch("a")
        w.hd("cleanup", "--run", str(w.run_dir), "--call", "a")
        r = w.hd("collect", "--run", str(w.run_dir))
        self.assertNotIn("FAILURE=lost", r.stdout)


class Recover(unittest.TestCase):
    def lose(self, w, call):
        st = w.hc_state()
        st["terminals"].pop(w.meta(call)["name"])
        w.state.write_text(json.dumps(st))
        w.hd("collect", "--run", str(w.run_dir))
        self.assertEqual(w.meta(call)["failure"], "lost")

    def thread(self, w, call):
        home = w.root / "nocodex"
        home.mkdir(exist_ok=True)
        log = home / "rollout-x.jsonl"
        log.write_text("")
        subprocess.run(["sqlite3", str(home / "state_5.sqlite"),
                        "create table threads (id text, rollout_path text, created_at integer, first_user_message text);"
                        f"insert into threads values ('th-1', '{log}', 5, '读取任务文件 {w.run_dir}/agents/{call}/task-1.md');"],
                       check=True)
        return home

    def test_reopens_its_own_session_idle_and_holds_it(self):
        w = Env()
        w.dispatch("a")
        w.dispatch("b")
        home = self.thread(w, "a")
        self.lose(w, "a")
        r = w.hd("recover", "--run", str(w.run_dir))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        kv = w.kv(r)
        self.assertEqual((kv["RECOVERED"], kv["FRESH"], kv["FAILED"], kv["MAIN"]), ("a", "none", "none", "live"))
        run_call = [c for c in w.hc_state()["calls"] if c[0] == "run"][-1]
        argv = run_call[run_call.index("--") + 1:]
        self.assertEqual(argv[:4], ["env", f"CODEX_HOME={home}", "codex", "resume"])
        self.assertEqual(argv[-1], "th-1")
        self.assertIn("workspace-write", argv)
        m = w.meta("a")
        self.assertNotIn("lost", m)
        self.assertEqual((m["open"], m["recovered"][-1]["how"]), (True, "resume"))
        ctl = json.loads((w.run_dir / "control.json").read_text())
        self.assertEqual((ctl["state"], ctl["held"]), ("paused", ["a"]))
        # resume tells it to carry on with its task
        w.patch(m["name"], status="idle", turn=0)
        r = w.hd("resume", "--run", str(w.run_dir))
        self.assertEqual(w.kv(r)["RESUMED"], "a")
        self.assertIn("task-1.md", w.hc_state()["terminals"][m["name"]]["sent"][-1])

    def test_without_its_session_a_new_one_reads_the_task(self):
        w = Env()
        w.dispatch("a")
        self.lose(w, "a")
        r = w.hd("recover", "--run", str(w.run_dir))
        self.assertEqual(w.kv(r)["FRESH"], "a")
        t = w.hc_state()["terminals"][w.meta("a")["name"]]
        self.assertIn("被意外中断", " ".join(t["sent"]))
        self.assertIn("task-1.md", " ".join(t["sent"]))

    def test_main_agent_gone_too_hands_the_run_off_paused(self):
        w = Env()
        w.dispatch("a")
        self.lose(w, "a")
        st = w.hc_state()
        st["terminals"].pop("parent")
        w.state.write_text(json.dumps(st))
        r = w.hd("recover", "--run", str(w.run_dir), HC_TERMINAL_ID="")
        kv = w.kv(r)
        self.assertEqual(kv["MAIN"], "gone")
        self.assertIn("claude --resume", kv.get("RESUME_MAIN", "") or "claude --resume")
        self.assertIn("----- prompt for the next main agent -----", r.stdout)
        md = (Path(kv["HANDOFF"]) / "handoff.md").read_text()
        self.assertIn("recover", md)
        self.assertIn(" resume --run ", md)
        ctl = json.loads((w.run_dir / "control.json").read_text())
        self.assertEqual((ctl["state"], ctl["prev"]["state"], ctl["prev"]["held"]), ("handoff", "paused", ["a"]))
        w.set_terminals({"next": {"address": "t2", "status": "working", "argv": ["claude"], "labels": {}}})
        r = w.hd("adopt", "--run", str(w.run_dir), "--from", kv["HANDOFF"], HC_TERMINAL_ID="t2")
        self.assertEqual(w.kv(r)["RUN_CONTROL"], "paused")

    def test_nothing_lost_nothing_done(self):
        w = Env()
        w.dispatch("a")
        r = w.hd("recover", "--run", str(w.run_dir))
        self.assertEqual((w.kv(r)["RECOVERED"], w.kv(r)["FRESH"]), ("none", "none"))


class Takeover(unittest.TestCase):
    """A new main agent (any program) carries a run on with one command; runs lists the ones to carry on."""

    def gone(self, w, name):
        st = w.hc_state()
        st["terminals"].pop(name)
        w.state.write_text(json.dumps(st))

    def newcomer(self, w, app="codex", argv=("codex",)):
        w.set_terminals({"next": {"address": "t2", "status": "working", "app": app, "argv": list(argv), "labels": {}}})

    def ctl(self, w):
        return json.loads((w.run_dir / "control.json").read_text())

    def test_main_agent_and_a_helper_gone_recovers_and_adopts_in_one_step(self):
        w = Env()
        p = w.root / "p.md"
        p.write_text("x")
        r = w.hd("run", "--run", str(w.run_dir), "--call", "a", "--mode", "write", "--effort", "high", "--dir",
                 str(w.repo), "--prompt", str(p), "--schema", str(w.schema), CLAUDE_CODE_SESSION_ID="sess-1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.gone(w, w.meta()["name"])
        self.gone(w, "parent")
        self.newcomer(w)
        r = w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        kv = w.kv(r)
        self.assertEqual((kv["TAKEOVER"], kv["VIA"], kv["FRESH"], kv["RUN_CONTROL"], kv["AGENT"]),
                         ("adopted", "recover", "a", "paused", "codex"))
        self.assertIn("claude --resume sess-1", kv["RESUME_MAIN"])
        self.assertIn("handoff.md", kv["READ"])
        ctl = self.ctl(w)
        self.assertEqual((ctl["state"], ctl["owner"], ctl["held"]), ("paused", "t2", ["a"]))
        self.assertEqual((w.meta()["parent"], w.meta()["dispatcher_agent"]), ("t2", "codex"))
        r = w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        self.assertEqual(w.kv(r)["TAKEOVER"], "self")

    def test_refused_while_the_old_main_agent_runs_unless_forced(self):
        w = Env()
        w.dispatch()
        self.newcomer(w, app="claude-code", argv=("claude",))
        r = w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        self.assertEqual(r.returncode, 3)
        kv = w.kv(r)
        self.assertEqual((kv["TAKEOVER"], kv["MAIN"], kv["MAIN_TERMINAL"]), ("refused", "live", "t1"))
        self.assertIn("准备交接", r.stdout)
        self.assertFalse((w.run_dir / "control.json").exists())
        r = w.hd("takeover", "--run", str(w.run_dir), "--force", HC_TERMINAL_ID="t2")
        kv = w.kv(r)
        self.assertEqual((kv["TAKEOVER"], kv["VIA"], kv["RUN_CONTROL"], kv["AGENT"]), ("adopted", "forced", "running", "claude"))
        self.assertNotIn("RESUME_MAIN", kv)
        p = w.root / "p.md"
        p.write_text("more")
        r = w.hd("send", "--run", str(w.run_dir), "--call", "a", "--prompt", str(p))  # the old one, from t1
        self.assertEqual(w.kv(r).get("RUN_CONTROL"), "adopted")

    def test_a_terminal_back_at_its_shell_is_a_gone_main_agent(self):
        w = Env()
        w.dispatch()
        w.patch("parent", argv=["-zsh"], app=None)
        self.newcomer(w)
        r = w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        kv = w.kv(r)
        self.assertEqual((kv["TAKEOVER"], kv["VIA"], kv["RECOVERED"], kv["RUN_CONTROL"]), ("adopted", "takeover", "none", "running"))
        self.assertIn("没来得及交接", (Path(kv["HANDOFF"]) / "handoff.md").read_text())

    def test_a_run_being_handed_off_is_adopted(self):
        w = Env()
        w.dispatch()
        w.hd("handoff", "--run", str(w.run_dir), "--no-notes")
        self.newcomer(w)
        r = w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2")
        kv = w.kv(r)
        self.assertEqual((kv["TAKEOVER"], kv["VIA"], kv["RUN_CONTROL"]), ("adopted", "handoff", "running"))
        self.assertEqual(self.ctl(w)["owner"], "t2")

    def test_a_codex_main_agent_is_reopened_by_its_thread(self):
        w = Env()
        w.patch("parent", argv=["/opt/bin/codex"], app="codex")
        p = w.root / "p.md"
        p.write_text("x")
        w.hd("run", "--run", str(w.run_dir), "--call", "a", "--mode", "write", "--effort", "high", "--dir",
             str(w.repo), "--prompt", str(p), "--schema", str(w.schema), CODEX_THREAD_ID="th-9", CLAUDE_CODE_SESSION_ID="")
        self.assertEqual((w.meta()["dispatcher_agent"], w.meta()["session"]), ("codex", "th-9"))
        self.gone(w, "parent")
        self.newcomer(w, app="claude-code", argv=("claude",))
        kv = w.kv(w.hd("takeover", "--run", str(w.run_dir), HC_TERMINAL_ID="t2"))
        self.assertIn("codex resume --sandbox danger-full-access th-9", kv["RESUME_MAIN"])

    def test_runs_lists_what_is_left_to_carry_on(self):
        w = Env()
        w.dispatch()
        (w.run_dir / "state.json").write_text(json.dumps({"tasks": {
            "a": {"status": "running"}, "b": {"status": "merged"}, "c": {"status": "parked", "note": "superseded by b"},
            "d": {"status": "parked", "parked_why": "user"}, "a-check-r1": {"status": "merged"}}}))
        done = w.repo / ".cc-dispatch" / "test-y"
        done.mkdir()
        (done / "state.json").write_text(json.dumps({"finished": 1}))
        hidden = w.repo / ".cc-dispatch" / "review-z"
        hidden.mkdir()
        (hidden / "state.json").write_text("{}")
        (hidden / "control.json").write_text(json.dumps({"state": "paused"}))
        (hidden / "archived").write_text("1")
        r = w.hd("runs", "--repo", str(w.repo))
        kv = w.kv(r)
        self.assertEqual(kv["RUNS"], "1")
        line = [l for l in r.stdout.splitlines() if l.startswith("RUN=")][0]
        self.assertIn("skill=cc-herdr-dispatch-dev", line)
        self.assertIn("main=live(claude)", line)
        self.assertIn("cards=1/2 merged", line)  # parked ones are not meant to be merged
        self.assertIn("open=1 cards open, 1 parked for you", line)
        rows = json.loads(w.hd("runs", "--repo", str(w.repo), "--all", "--json").stdout)
        self.assertEqual(sorted(r["name"] for r in rows), ["dev-x", "review-z", "test-y"])
        self.gone(w, "parent")
        self.assertIn("main=gone(claude)", w.hd("runs", "--repo", str(w.repo)).stdout)


class Digest(unittest.TestCase):
    def test_codex_and_claude_logs(self):
        lib = module("hd_handoff")
        d = Path(tempfile.mkdtemp())
        rows = [
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "读取任务文件 /t.md"}]}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": json.dumps({"cmd": "npm test"})}},
            {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "Chunk ID: x\nProcess exited with code 1\nOutput:\nok 1\nnot ok 2 - boom\n"}},
            {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "c2", "input": "*** Begin Patch\n*** Update File: /w/a.py\n@@\n"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "update_plan", "call_id": "c3", "arguments": json.dumps({"plan": [{"step": "fix", "status": "in_progress"}]})}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "测试还差一个"}]}},
        ]
        f = d / "rollout.jsonl"
        f.write_text("".join(json.dumps(r) + "\n" for r in rows))
        g = lib.codex_digest([str(f)])
        self.assertEqual(g["commands"], [{"cmd": "npm test", "exit": 1, "tail": "ok 1 | not ok 2 - boom"}])
        self.assertEqual(g["files"], ["/w/a.py"])
        self.assertEqual(g["plan"][0]["step"], "fix")
        self.assertEqual(g["messages"], ["测试还差一个"])
        self.assertEqual(g["asked"], ["读取任务文件 /t.md"])
        md = "\n".join(lib.digest_md(g))
        self.assertIn("`[1]` `npm test` → ok 1 | not ok 2 - boom", md)
        t = d / "s.jsonl"
        t.write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "user", "message": {"content": "读取任务文件 /t.md"}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "u1", "name": "Bash", "input": {"command": "pytest -q"}},
                                                           {"type": "tool_use", "id": "u2", "name": "Edit", "input": {"file_path": "/w/b.py"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "u1", "content": "1 failed", "is_error": True}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "还差一个"}]}},
        ]))
        c = lib.claude_digest(str(t))
        self.assertEqual(c["commands"], [{"cmd": "pytest -q", "exit": 1, "tail": "1 failed"}])
        self.assertEqual((c["files"], c["messages"], c["asked"]), (["/w/b.py"], ["还差一个"], ["读取任务文件 /t.md"]))


class Usage(unittest.TestCase):
    def test_codex_and_claude_sessions_add_up(self):
        hd = module()
        root = Path(tempfile.mkdtemp())
        roll = root / "rollout.jsonl"
        roll.write_text("".join(json.dumps(r) + "\n" for r in [
            {"timestamp": "2026-11-08T03:00:00Z", "type": "turn_context", "payload": {"model": "gpt"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": "{}"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {
                "input_tokens": 1000, "cached_input_tokens": 800, "cache_write_input_tokens": 0, "output_tokens": 10}}}}]))
        proj = root / "claude" / "projects" / "-w"
        proj.mkdir(parents=True)
        u = {"input_tokens": 1, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "output_tokens": 5}
        (proj / "s1.jsonl").write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "assistant", "timestamp": "2026-11-08T04:00:00Z", "message": {"id": "m1", "model": "opus", "usage": u,
                                                                               "content": [{"type": "text", "text": "x"}]}},
            {"type": "assistant", "timestamp": "2026-11-08T04:00:01Z", "message": {"id": "m1", "model": "opus", "usage": u,
                                                                               "content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
            {"type": "assistant", "message": {"id": "m2", "usage": u, "content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "/w/n.py"}}]}}]))
        old = os.environ.get("CLAUDE_CONFIG_DIR")
        os.environ["CLAUDE_CONFIG_DIR"] = str(root / "claude")
        try:
            meta = {"agent": "claude", "agent_dir": str(root / "a"), "workdir": "/w", "rollouts": [str(roll)],
                    "claude_sessions": ["s1", "gone"]}
            got = hd.helper_usage(meta)
        finally:
            if old is None:
                os.environ.pop("CLAUDE_CONFIG_DIR")
            else:
                os.environ["CLAUDE_CONFIG_DIR"] = old
        self.assertEqual(got["tokens"], {"input": 1000 + 2 * 121, "cached": 800 + 200, "cache_write": 40, "output": 20})
        self.assertEqual((got["commands"], got["files"], got["sessions"], got["model"]), (2, 1, 2, "opus"))


def module(name="hd_dispatch"):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, HD.with_name(f"{name}.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Classify(unittest.TestCase):
    def test_a_full_conversation_is_not_an_empty_account(self):
        hd = module()
        self.assertEqual(hd.classify("■ Codex ran out of room in the model's context window. Start a new thread"), "context_limit")
        self.assertEqual(hd.classify("error: context_length_exceeded"), "context_limit")
        self.assertEqual(hd.classify("■ You've hit your usage limit. Try again at 3:00 PM."), "quota")
        self.assertEqual(hd.classify("stream disconnected before completion"), "capacity")
        self.assertNotIn("context_limit", hd.RETRYABLE)


if __name__ == "__main__":
    unittest.main()
