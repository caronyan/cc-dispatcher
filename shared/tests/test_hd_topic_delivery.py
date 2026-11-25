"""Cross-Topic delivery uses temporary repositories and fake hc terminals."""
import contextlib
import fcntl
import io
import json
import os
import shutil
import subprocess
import sys
import time
import unittest
from unittest import mock

from test_hd_dispatch import Env, HD, module


class TopicDelivery(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        self.w.set_terminals({
            "other": {"address": "t2", "status": "working", "app": "codex", "argv": ["codex"]},
            "next": {"address": "t3", "status": "working", "app": "codex", "argv": ["codex"]},
        })
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        self.a = self.command("init", "--title", "First")["TOPIC"]
        self.b = self.command("init", "--title", "Second", HC_TERMINAL_ID="t2")["TOPIC"]

    def raw(self, name, *args, **env):
        result = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args), **env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def command(self, name, *args, **env):
        return self.w.kv(self.raw(name, *args, **env))

    def invoke(self, *args, **env):
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.w.env(**env)), mock.patch.object(
                sys, "argv", [str(HD), *map(str, args)]), contextlib.redirect_stdout(output):
            self.hd.main()
        return output.getvalue()

    def deliver(self):
        return self.command("deliver")

    def invoke_delivery(self):
        return self.invoke("topic", "deliver", "--repo", self.w.repo)

    def send(self, **extra):
        args = {"source": self.a, "target": self.b, "terminal": "t1", "text": "Private question"}
        args.update(extra)
        return self.command("msg", "--topic", args["source"], "--to", args["target"],
                            "--kind", "question", "--text=" + args["text"],
                            HC_TERMINAL_ID=args["terminal"])["MESSAGE"]

    def reply(self, mid):
        return self.command("msg", "--topic", self.b, "--reply-to", mid,
                            "--text=Private answer", HC_TERMINAL_ID="t2")

    def alter(self, topic=None, **changes):
        topic = topic or self.b
        with self.hd.topic_lock(self.w.repo, topic):
            data = self.hd.load_topic(self.w.repo, topic)
            data.update(changes)
            self.hd.save_topic(self.w.repo, topic, data)

    def item(self, mid, topic=None):
        return next(item for item in self.hd.load_messages(self.w.repo, topic or self.b)["items"]
                    if item["id"] == mid)

    def sent(self, name="other"):
        return self.w.hc_state()["terminals"][name].get("sent", [])

    def bind(self, topic=None, run=None, terminal="t2"):
        run = run or self.w.run_dir
        run.mkdir(exist_ok=True)
        task = self.command("task-add", "--topic", topic or self.b, "--title", "Task",
                            "--kind", "dev")["TASK"]
        self.command("start", "--run", run, "--topic", topic or self.b, "--task", task,
                     HC_TERMINAL_ID=terminal)
        return run, task

    def run_command(self, name, run=None, **env):
        result = self.w.hd(name, "--run", str(run or self.w.run_dir),
                           *(("--timeout", "0") if name == "wait" else ()),
                           HC_TERMINAL_ID=env.pop("HC_TERMINAL_ID", "t2"), **env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def dispatch(self, run, terminal):
        prompt = self.w.root / "prompt.md"
        prompt.write_text("Work")
        result = self.w.hd("run", "--run", str(run), "--call", "helper", "--mode", "write",
                           "--effort", "high", "--dir", str(self.w.repo), "--prompt", str(prompt),
                           "--schema", str(self.w.schema), HC_TERMINAL_ID=terminal)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def process(self, script, args, terminal):
        process = subprocess.Popen([sys.executable, "-c", script, str(HD.parent), *map(str, args)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   env=self.w.env(HC_TERMINAL_ID=terminal))

        def close():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

        self.addCleanup(close)
        return process

    def await_files(self, *paths):
        deadline = time.monotonic() + 10
        while not all(path.exists() for path in paths):
            self.assertLess(time.monotonic(), deadline, "background process did not reach the gate")
            time.sleep(.01)

    def background_wait(self, run, terminal, timeout=30):
        ready, proceed = self.w.root / "ready", self.w.root / "proceed"
        script = (
            "import pathlib,subprocess,sys,time\n"
            "sys.path.insert(0,sys.argv.pop(1))\n"
            "import hd_dispatch as hd\n"
            "ready,proceed=map(pathlib.Path,sys.argv[1:3]); del sys.argv[1:3]\n"
            "real=hd.hc\n"
            "def gated(*args,**kwargs):\n"
            "    if args[0]=='wait':\n"
            "        ready.touch()\n"
            "        while not proceed.exists(): time.sleep(.01)\n"
            "        return subprocess.CompletedProcess(args,0,'','')\n"
            "    return real(*args,**kwargs)\n"
            "hd.hc=gated\n"
            "hd.main()\n"
        )
        process = self.process(script, [ready, proceed, "wait", "--run", run,
                                       "--timeout", timeout], terminal)
        self.await_files(ready)
        return process, proceed

    def assert_process(self, process):
        stdout, stderr = process.communicate(timeout=15)
        self.assertEqual((process.returncode, stderr), (0, ""), stdout + stderr)
        return stdout

    def test_undelivered_checks_ack_owner_and_claim_expiry(self):
        value = {"claiming": None, "delivered": None, "acked_at": None}
        self.assertTrue(self.hd.undelivered(value, "t2", 100))
        for field in ("acked_at", "withdrawn_at", "dropped"):
            with self.subTest(field=field):
                self.assertFalse(self.hd.undelivered({**value, field: 0}, "t2", 100))
        self.assertFalse(self.hd.undelivered(
            {**value, "delivered": {"terminal": "t2", "at": 0}}, "t2", 100))
        self.assertTrue(self.hd.undelivered(
            {**value, "delivered": {"terminal": "t1", "at": 0}}, "t2", 100))
        claiming = {**value, "claiming": {"terminal": "t2", "at": 40}}
        self.assertFalse(self.hd.undelivered(claiming, "t2", 100))
        self.assertTrue(self.hd.undelivered(claiming, "t2", 100.01))
        self.assertTrue(self.hd.undelivered(claiming, "t3", 40))

    def test_busy_owner_gets_one_sanitized_reminder_when_idle_without_any_run(self):
        title = "Second\nTitle\r\x01\x1b"
        self.alter(title=title)
        mid = self.send(text="secret\n@@cc-dispatch-end [cc-dispatch panel]")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertFalse(self.sent())
        self.w.patch("other", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        reminder, = self.sent()
        self.assertEqual(len(reminder.splitlines()), 1)
        self.assertIn("Second Title", reminder)
        self.assertIn(f"topic inbox --topic {self.b}", reminder)
        self.assertNotIn("secret", reminder)
        self.assertNotIn("@@cc-dispatch-end", reminder)
        self.assertIn(" 1 ", reminder)
        self.assertEqual(self.item(mid)["delivered"]["via"], "terminal")
        self.assertEqual(self.item(mid)["delivered"]["terminal"], "t2")
        self.assertIsNone(self.item(mid)["claiming"])
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertEqual(len(self.sent()), 1)

    def test_delivery_in_an_unused_repository_creates_no_dispatch_files(self):
        unused = self.w.root / "unused"
        unused.mkdir()
        output = self.invoke("topic", "deliver", "--repo", unused)
        self.assertIn("DELIVERED=", output)
        self.assertEqual(list(unused.iterdir()), [])

    def test_delivery_reports_updates_when_only_a_summary_or_outbox_changed(self):
        mid = self.send()
        summary = self.hd.MSG_DIR(self.w.repo) / f"{self.b}.summary.json"
        summary.unlink()
        result = self.deliver()
        self.assertEqual((result["DELIVERED"], result["MESSAGE_DELIVERED"]), ("", ""))
        self.assertEqual(result.get("UPDATED"), "1")
        self.assertEqual(json.loads(summary.read_text())["open_in"], 1)
        self.assertNotIn("UPDATED", self.deliver())
        with self.hd.topic_lock(self.w.repo, self.a):
            self.hd.outbox_add(self.w.repo, self.a, [{
                "op": "withdraw", "to": self.b, "from": {"topic": self.a},
                "ids": [mid], "text": "", "refs": [], "reason": "archived"}])
        result = self.deliver()
        self.assertEqual((result["DELIVERED"], result["MESSAGE_DELIVERED"]), ("", ""))
        self.assertEqual(result.get("UPDATED"), "1")
        self.assertIsNotNone(self.item(mid)["withdrawn_at"])
        self.assertNotIn("UPDATED", self.deliver())

    def test_delivery_reports_a_mailbox_commit_even_when_outbox_cleanup_is_interrupted(self):
        with self.hd.topic_lock(self.w.repo, self.a):
            self.hd.outbox_add(self.w.repo, self.a, [{
                "op": "notice", "to": self.b, "from": {"topic": self.a},
                "text": "Committed notice", "refs": [], "reason": "follow"}])
        write = self.hd.write_json
        outbox = self.hd.MSG_DIR(self.w.repo) / f"{self.a}.outbox.json"

        def interrupt_cleanup(path, data):
            if path == outbox:
                raise OSError("interrupted source cleanup")
            write(path, data)

        with mock.patch.object(self.hd, "write_json", side_effect=interrupt_cleanup):
            output = self.invoke_delivery()
        self.assertIn("UPDATED=1", output)
        self.assertEqual(len(self.hd.load_messages(self.w.repo, self.b)["items"]), 1)
        self.deliver()
        self.assertEqual(len(self.hd.load_messages(self.w.repo, self.b)["items"]), 1)

    def test_independent_adopted_run_does_not_block_topic_messages_or_requests(self):
        run, _ = self.bind(terminal="t1")
        self.dispatch(run, "t1")
        result = self.w.hd("handoff", "--run", str(run), "--no-notes", HC_TERMINAL_ID="t1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        package = self.w.kv(result)["HANDOFF"]
        result = self.w.hd("adopt", "--run", str(run), "--from", package, HC_TERMINAL_ID="t3")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.hd.load_topic(self.w.repo, self.b)["owner"]["terminal"], "t2")
        item = self.command("backlog-add", "--topic", self.b, "--text", "Plan")["ITEM"]
        self.command("request", "--topic", self.b, "--items", item,
                     HC_TERMINAL_ID="t2")
        mid = self.send()
        self.w.patch("other", status="idle")
        self.assertTrue(self.deliver()["DELIVERED"])
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(self.item(mid)["delivered"]["terminal"], "t2")

    def test_independent_adoption_record_allows_delivery_without_call_metadata(self):
        run, _ = self.bind(terminal="t1")
        self.hd.write_json(run / "control.json", {
            "state": "running", "owner": "t3", "adopted": {"from": "t1"}})
        mid = self.send()
        self.w.patch("other", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(self.item(mid)["delivered"]["terminal"], "t2")

    def test_collect_and_wait_suppress_message_hints_for_ineligible_run_callers(self):
        run, _ = self.bind()
        self.dispatch(run, "t2")
        self.send()
        for state, owner, terminal in (("paused", "t2", "t2"), ("handoff", "t2", "t2"),
                                        ("running", "t3", "t2"), ("running", None, "t1")):
            self.hd.write_json(run / "control.json", {"state": state, "owner": owner})
            for command in ("collect", "wait"):
                with self.subTest(state=state, owner=owner, terminal=terminal, command=command):
                    result = self.run_command(command, HC_TERMINAL_ID=terminal)
                    self.assertNotIn("MESSAGE_HINT", self.w.kv(result))
                    self.assertNotIn("MESSAGES_UNACKED", self.w.kv(result))

    def test_sending_and_replying_nudge_idle_owners_before_return(self):
        self.w.patch("other", status="idle")
        mid = self.send()
        self.assertEqual(len(self.sent()), 1)
        self.w.patch("parent", status="idle", screen="\u276f ")
        self.reply(mid)
        self.assertEqual(len(self.sent("parent")), 1)
        self.assertNotIn("Private answer", self.sent("parent")[0])
        self.assertEqual(self.item(mid)["answer"]["delivered"]["terminal"], "t1")

    def test_terminal_eligibility_and_claude_drafts_match_request_delivery(self):
        mid = self.send()
        owner = self.hd.load_topic(self.w.repo, self.b)["owner"]
        for changes in ({"state": "finished", "status": "idle"},
                        {"state": "live", "status": "blocked"},
                        {"status": "error"}, {"status": "working"},
                        {"status": "idle", "app": "vim", "argv": ["vim"]},
                        {"app": "claude", "argv": ["claude"]}):
            self.w.patch("other", **changes)
            self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.alter(owner={**owner, "agent": "claude-code"})
        self.w.patch("other", screen="\u276f old\noutput\n\u276f unfinished")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.w.patch("other", screen="\u276f old\noutput\n\u276f ", status="done")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(self.item(mid)["delivered"]["via"], "terminal")
        self.assertEqual(self.w.hc_state()["calls"][-1],
                         ["send", "t2", self.sent()[0], "--json"])

    def test_failed_conditional_send_clears_claim_and_can_be_retried(self):
        mid = self.send()
        self.w.patch("other", status="idle")
        real = self.hd.hc

        def become_busy(*args, **kwargs):
            if args[0] == "send":
                self.w.patch("other", status="working")
            return real(*args, **kwargs)

        with mock.patch.object(self.hd, "hc", side_effect=become_busy):
            self.invoke_delivery()
        self.assertIsNone(self.item(mid)["claiming"])
        self.assertIsNone(self.item(mid)["delivered"])
        self.assertFalse(self.sent())
        self.w.patch("other", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(len(self.sent()), 1)

    def test_send_exception_clears_claim(self):
        mid = self.send()
        self.w.patch("other", status="idle")
        real = self.hd.hc

        def fail_send(*args, **kwargs):
            if args[0] == "send":
                raise OSError("send unavailable")
            return real(*args, **kwargs)

        with mock.patch.object(self.hd, "hc", side_effect=fail_send):
            with self.assertRaises(OSError):
                self.invoke_delivery()
        self.assertIsNone(self.item(mid)["claiming"])
        self.assertIsNone(self.item(mid)["delivered"])

    def test_wait_claims_before_nothing_running_and_repeats_unacked_until_ack(self):
        run, _ = self.bind()
        mid = self.send()
        result = self.run_command("wait")
        values = self.w.kv(result)
        self.assertEqual((values["WAIT"], values["MESSAGES"]), ("message", mid))
        self.assertEqual(values["MESSAGES_UNACKED"], mid)
        self.assertIn(f"topic inbox --run {run}", values["MESSAGE_HINT"])
        self.assertEqual(self.item(mid)["delivered"]["via"], "wait")
        self.assertEqual(self.w.kv(self.run_command("wait"))["WAIT"], "nothing_running")
        self.assertEqual(self.w.kv(self.run_command("collect"))["MESSAGES_UNACKED"], mid)
        self.w.patch("other", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertFalse(self.sent())
        self.command("msg-ack", "--topic", self.b, "--ids", mid, HC_TERMINAL_ID="t2")
        self.assertNotIn("MESSAGES_UNACKED", self.w.kv(self.run_command("collect")))

    def test_wait_uses_authoritative_topic_binding_and_reports_answers(self):
        run, _ = self.bind(self.a, terminal="t1")
        state = self.hd.read_json(run / "state.json", {})
        self.hd.write_json(run / "state.json", {**state, "topic": self.b})
        mid = self.send()
        self.reply(mid)
        result = self.run_command("wait", HC_TERMINAL_ID="t1")
        self.assertEqual(self.w.kv(result)["MESSAGES"], mid)
        self.assertEqual(self.item(mid)["answer"]["delivered"]["via"], "wait")
        self.assertEqual(self.w.kv(self.run_command("collect", HC_TERMINAL_ID="t1"))[
            "MESSAGES_UNACKED"], mid)
        self.command("msg-ack", "--topic", self.a, "--ids", mid)
        self.assertNotIn("MESSAGES_UNACKED", self.w.kv(
            self.run_command("collect", HC_TERMINAL_ID="t1")))

    def test_background_wait_wakes_for_new_messages(self):
        run, _ = self.bind()
        self.dispatch(run, "t2")
        process, proceed = self.background_wait(run, "t2")
        mid = self.send()
        proceed.touch()
        stdout = self.assert_process(process)
        self.assertIn("WAIT=message", stdout)
        self.assertIn("MESSAGES=" + mid, stdout)
        self.assertIn("MESSAGES_UNACKED=" + mid, stdout)
        self.assertFalse(self.sent())

    def test_paused_stopping_archived_and_deleting_topics_block_both_channels(self):
        self.bind()
        mid = self.send()
        self.w.patch("other", status="idle")
        for key in ("paused_at", "stopping_at", "archived", "deleting"):
            with self.subTest(key=key):
                self.alter(**{key: 0})
                self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
                result = self.run_command("wait")
                self.assertNotEqual(self.w.kv(result).get("WAIT"), "message")
                self.assertIsNone(self.item(mid)["delivered"])
                self.alter(**{key: None})
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)

    def test_handoff_blocks_until_adopt_then_redelivers_items_and_external_answers(self):
        run, _ = self.bind()
        incoming = self.send()
        question = self.send(source=self.b, target=self.a, terminal="t2")
        self.command("msg", "--topic", self.a, "--reply-to", question, "--text=Answer")
        self.w.patch("other", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(self.item(question, self.a)["answer"]["delivered"]["terminal"], "t2")
        result = self.w.hd("handoff", "--run", str(run), "--no-notes", HC_TERMINAL_ID="t2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        package = self.w.kv(result)["HANDOFF"]
        late = self.send()
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertNotEqual(self.w.kv(self.run_command("wait")).get("WAIT"), "message")
        self.w.patch("next", status="idle")
        result = self.w.hd("adopt", "--run", str(run), "--from", package, HC_TERMINAL_ID="t3")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(len(self.sent("next")), 1)
        self.assertIn(" 3 ", self.sent("next")[0])
        for mid in (incoming, late):
            self.assertEqual(self.item(mid)["delivered"]["terminal"], "t3")
        self.assertEqual(self.item(question, self.a)["answer"]["delivered"]["terminal"], "t3")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")

    def test_owner_control_mismatch_blocks_the_transfer_window(self):
        run, _ = self.bind()
        mid = self.send()
        owner = self.hd.load_topic(self.w.repo, self.b)["owner"]
        self.hd.set_control(run, state="running", owner="t2")
        self.alter(owner={**owner, "terminal": "t3"})
        self.w.patch("next", status="idle")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertNotEqual(self.w.kv(self.run_command("wait")).get("WAIT"), "message")
        self.assertIsNone(self.item(mid)["delivered"])
        self.hd.set_control(run, state="running", owner="t3")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)

    def test_requests_take_priority_over_reminders_for_the_same_owner(self):
        task = self.command("task-add", "--topic", self.b, "--title", "Queued", "--kind", "dev")["TASK"]
        request = self.command("request", "--topic", self.b, "--task", task)["REQUEST"]
        self.send()
        self.w.patch("other", status="idle")
        first = self.deliver()
        self.assertEqual((first["DELIVERED"], first["MESSAGE_DELIVERED"]),
                         (f"{self.b}:{request}", ""))
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)
        self.assertEqual(len(self.sent()), 2)
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")

    def test_one_owner_gets_at_most_one_reminder_across_topics_in_a_round(self):
        other = self.command("init", "--title", "Third", HC_TERMINAL_ID="t2")["TOPIC"]
        first, second = self.send(), self.send(target=other)
        self.w.patch("other", status="idle")
        self.assertIn(self.deliver()["MESSAGE_DELIVERED"], (self.b, other))
        self.assertEqual(len(self.sent()), 1)
        self.assertIn(self.deliver()["MESSAGE_DELIVERED"], (self.b, other))
        self.assertEqual(len(self.sent()), 2)
        self.assertTrue(self.item(first)["delivered"])
        self.assertTrue(self.item(second, other)["delivered"])

    def test_busy_delivery_lock_does_not_block_sending_or_wait_claiming(self):
        self.bind()
        self.w.patch("other", status="idle")
        lock = self.w.repo / ".cc-dispatch" / "topics" / ".deliver.lock"
        with lock.open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            result = self.raw("msg", "--topic", self.a, "--to", self.b, "--text=Queued")
            self.assertEqual(len(result.stdout.splitlines()), 1)
            mid = self.w.kv(result)["MESSAGE"]
            self.assertEqual(self.w.kv(self.run_command("wait"))["MESSAGES"], mid)
        self.assertFalse(self.sent())

    def check_interruption(self, after_send):
        mid = self.send()
        self.w.patch("other", status="idle")
        real = self.hd.hc

        def interrupted(*args, **kwargs):
            if args[0] == "send":
                if after_send:
                    real(*args, **kwargs)
                raise KeyboardInterrupt
            return real(*args, **kwargs)

        with mock.patch.object(self.hd, "hc", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke_delivery()
        claiming = self.item(mid)["claiming"]
        self.assertEqual(claiming["terminal"], "t2")
        self.assertIsNone(self.item(mid)["delivered"])
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        with mock.patch.object(self.hd.time, "time", return_value=claiming["at"] + 61):
            self.assertIn("MESSAGE_DELIVERED=" + self.b, self.invoke_delivery())
        self.assertIsNone(self.item(mid)["claiming"])
        self.assertEqual(self.item(mid)["delivered"]["via"], "terminal")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")
        self.assertEqual(len(self.sent()), 2 if after_send else 1)

    def test_interruption_before_send_retries_after_claim_expires(self):
        self.check_interruption(False)

    def test_interruption_after_send_repeats_once_after_claim_expires(self):
        self.check_interruption(True)

    def test_wait_and_terminal_delivery_claim_the_same_snapshot_once(self):
        run, _ = self.bind()
        mid = self.send()
        self.w.patch("other", status="idle")
        gate = self.w.root / "claim-gate"
        wait_ready, send_ready = self.w.root / "wait-ready", self.w.root / "send-ready"
        script = (
            "import pathlib,sys,time\n"
            "sys.path.insert(0,sys.argv.pop(1))\n"
            "import hd_dispatch as hd\n"
            "ready,gate=map(pathlib.Path,sys.argv[1:3]); del sys.argv[1:3]\n"
            "real_claim,real_lock=hd.claim_messages,hd.topic_lock\n"
            "claiming=False; visited=False\n"
            "def lock(*args,**kwargs):\n"
            "    global visited\n"
            "    if claiming and not visited:\n"
            "        visited=True; ready.touch()\n"
            "        while not gate.exists(): time.sleep(.01)\n"
            "    return real_lock(*args,**kwargs)\n"
            "def claim(*args,**kwargs):\n"
            "    global claiming\n"
            "    claiming=True\n"
            "    try: return real_claim(*args,**kwargs)\n"
            "    finally: claiming=False\n"
            "hd.claim_messages=claim; hd.topic_lock=lock\n"
            "hd.main()\n"
        )
        waiter = self.process(script, [wait_ready, gate, "wait", "--run", run, "--timeout", 0], "t2")
        sender = self.process(script, [send_ready, gate, "topic", "deliver",
                                      "--repo", self.w.repo], "t1")
        self.await_files(wait_ready, send_ready)
        gate.touch()
        stdout = self.assert_process(waiter)
        self.assert_process(sender)
        via_wait = "WAIT=message" in stdout
        self.assertEqual(int(via_wait) + len(self.sent()), 1)
        self.assertEqual(self.item(mid)["delivered"]["via"], "wait" if via_wait else "terminal")
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], "")

    def test_unrelated_wait_delivers_when_recipient_becomes_idle_later(self):
        topic = self.command("init", "--title", "Unrelated", HC_TERMINAL_ID="t3")["TOPIC"]
        run, _ = self.bind(topic, self.w.run_dir, terminal="t3")
        self.dispatch(run, "t3")
        process, proceed = self.background_wait(run, "t3", timeout=2)
        mid = self.send()
        self.w.patch("other", status="idle")
        proceed.touch()
        stdout = self.assert_process(process)
        self.assertIn("WAIT=timeout", stdout)
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(self.item(mid)["delivered"]["via"], "terminal")

    def test_collect_flushes_outbox_and_repairs_summary_before_delivery(self):
        self.bind()
        with self.hd.topic_lock(self.w.repo, self.a):
            self.hd.outbox_add(self.w.repo, self.a, [{
                "op": "notice", "to": self.b, "from": {"topic": self.a},
                "text": "Notice", "refs": [], "reason": "follow"}])
        self.w.patch("other", status="idle")
        self.run_command("collect")
        notice, = self.hd.load_messages(self.w.repo, self.b)["items"]
        self.assertEqual(notice["delivered"]["via"], "terminal")
        summary_path = self.hd.MSG_DIR(self.w.repo) / f"{self.b}.summary.json"
        summary_path.unlink()
        self.deliver()
        self.assertEqual(json.loads(summary_path.read_text())["version"],
                         self.hd.load_messages(self.w.repo, self.b)["version"])
        self.assertEqual(len(self.sent()), 1)

    def test_wait_claims_notices_flushed_during_the_same_poll(self):
        self.bind()
        with self.hd.topic_lock(self.w.repo, self.a):
            self.hd.outbox_add(self.w.repo, self.a, [{
                "op": "notice", "to": self.b, "from": {"topic": self.a},
                "text": "Notice", "refs": [], "reason": "follow"}])
        self.w.patch("other", status="idle")
        result = self.run_command("wait")
        self.assertEqual(self.w.kv(result)["WAIT"], "message")
        self.assertFalse(self.sent())

    def test_finishing_and_abandoning_nudge_followers_and_remain_idempotent(self):
        self.command("follow", "--topic", self.b, "--target", self.a, HC_TERMINAL_ID="t2")
        self.w.patch("other", status="idle")
        for action in ("finish", "abandon"):
            with self.subTest(action=action):
                run, task = self.bind(self.a, self.w.run_dir.parent / ("dev-" + action), "t1")
                args = (("--run", run, "--line", "Ready") if action == "finish" else
                        ("--topic", self.a, "--task", task, "--reason", "No longer needed", "--force"))
                self.command(action, *args)
                count = 1 if action == "finish" else 2
                self.assertEqual(len(self.sent()), count)
                self.command(action, *args)
                self.assertEqual(len(self.sent()), count)

    def test_finishing_flushes_notices_even_when_delivery_round_is_busy(self):
        self.command("follow", "--topic", self.b, "--target", self.a, HC_TERMINAL_ID="t2")
        run, _ = self.bind(self.a, terminal="t1")
        self.w.patch("other", status="idle")
        lock = self.w.repo / ".cc-dispatch" / "topics" / ".deliver.lock"
        with lock.open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            self.command("finish", "--run", run, "--line", "Ready")
            notice, = self.hd.load_messages(self.w.repo, self.b)["items"]
            self.assertIsNone(notice["delivered"])
            self.assertFalse(self.sent())
            outbox = self.hd.MSG_DIR(self.w.repo) / f"{self.a}.outbox.json"
            self.assertEqual(json.loads(outbox.read_text())["events"], [])
        self.assertEqual(self.deliver()["MESSAGE_DELIVERED"], self.b)

    def test_finish_nudge_prioritizes_queued_dispatch_over_its_notice(self):
        run, producer = self.bind()
        consumer = self.command("task-add", "--topic", self.a, "--title", "Consumer",
                                "--kind", "dev")["TASK"]
        request = self.command("request", "--topic", self.a, "--task", consumer)["REQUEST"]
        self.command("task-edit", "--topic", self.a, "--task", consumer,
                     "--depends", f"{self.b}:{producer}")
        self.w.patch("parent", status="idle", screen="\u276f ")
        self.command("finish", "--run", run, "--line", "Ready", HC_TERMINAL_ID="t2")
        task = self.hd.load_topic(self.w.repo, self.a)["tasks"][consumer]
        self.assertIsNotNone(task["request"]["delivered_at"])
        self.assertEqual(task["request"]["id"], request)
        self.assertEqual(len(self.sent("parent")), 1)
        notice, = self.hd.load_messages(self.w.repo, self.a)["items"]
        self.assertIsNone(notice["delivered"])
        next_round = self.deliver()
        self.assertEqual((next_round["DELIVERED"], next_round["MESSAGE_DELIVERED"]), ("", self.a))
        self.assertEqual(len(self.sent("parent")), 2)

    def test_nudge_errors_do_not_change_successful_message_or_finish_results(self):
        with mock.patch.object(self.hd, "deliver_topics", side_effect=OSError("unavailable")):
            output = self.invoke("topic", "msg", "--repo", self.w.repo, "--topic", self.a,
                                 "--to", self.b, "--text=Saved", "--kind", "question")
            mid = dict(line.split("=", 1) for line in output.splitlines())["MESSAGE"]
            self.assertEqual(self.item(mid)["text"], "Saved")
            self.assertIn("ANSWERED=" + mid, self.invoke(
                "topic", "msg", "--repo", self.w.repo, "--topic", self.b, "--reply-to", mid,
                "--text=Saved answer", HC_TERMINAL_ID="t2"))
            run, task = self.bind(self.a, terminal="t1")
            self.assertIn("FINISHED=" + task, self.invoke(
                "topic", "finish", "--run", run, "--line", "Saved result"))


if __name__ == "__main__":
    unittest.main()
