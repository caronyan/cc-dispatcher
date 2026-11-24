"""Topic delivery and lifecycle controls use temporary repos and fake_hc.py only."""
import argparse
import contextlib
import fcntl
import io
import json
import os
import shutil
import subprocess
import unittest
from unittest import mock

from test_hd_dispatch import Env, module


class TopicControl(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        self.w.patch("parent", status="idle", screen="previous output\n❯ ")
        self.topic = self.init()

    def command(self, name, *args, code=0):
        result = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args))
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return self.w.kv(result)

    def init(self, owner=None):
        args = ["--title", "Topic"]
        if owner:
            args += ["--owner", owner]
        return self.command("init", *args)["TOPIC"]

    def task(self, topic=None):
        return self.command("task-add", "--topic", topic or self.topic, "--title", "Task",
                            "--kind", "dev")["TASK"]

    def item(self, topic=None):
        return self.command("backlog-add", "--topic", topic or self.topic, "--text", "Backlog")["ITEM"]

    def request(self, *args, task=None, items=None, topic=None):
        return self.command("request", "--topic", topic or self.topic,
                            "--task" if task else "--items", task or ",".join(items), *args)

    def start(self, task, run=None, topic=None):
        run = run or self.w.run_dir
        run.mkdir(exist_ok=True)
        self.command("start", "--run", run, "--topic", topic or self.topic, "--task", task)
        return run

    def data(self, topic=None):
        return self.hd.load_topic(self.w.repo, topic or self.topic)

    def backlog(self, topic=None):
        return self.hd.load_backlog(self.w.repo, topic or self.topic)

    def alter(self, topic=None, **changes):
        topic = topic or self.topic
        with self.hd.topic_lock(self.w.repo, topic):
            data = self.data(topic)
            data.update(changes)
            self.hd.save_topic(self.w.repo, topic, data)

    def set_task(self, task, topic=None, **changes):
        topic = topic or self.topic
        with self.hd.topic_lock(self.w.repo, topic):
            data = self.data(topic)
            data["tasks"][task].update(changes)
            self.hd.save_topic(self.w.repo, topic, data)

    def direct(self, name, **extra):
        args = argparse.Namespace(repo=str(self.w.repo), topic=self.topic, **extra)
        with mock.patch.dict(os.environ, self.w.env()), contextlib.redirect_stdout(io.StringIO()) as output:
            getattr(self.hd, "cmd_topic_" + name)(args)
        return dict(line.split("=", 1) for line in output.getvalue().splitlines()
                    if "=" in line and line.split("=", 1)[0].isupper())

    def delivery(self):
        return self.command("deliver")["DELIVERED"]

    def owner_sent(self):
        return self.w.hc_state()["terminals"]["parent"].get("sent", [])

    def test_fake_conditional_send_does_not_record_a_status_mismatch(self):
        before = self.w.hc_state()
        result = subprocess.run(["hc", "send", "t1", "blocked", "--if", "working", "--json"],
                                capture_output=True, text=True, env=self.w.env())
        self.assertEqual(result.returncode, 10)
        self.assertEqual(json.loads(result.stdout)["error"], "status_mismatch")
        self.assertEqual(self.w.hc_state(), before)
        result = subprocess.run(["hc", "send", "--if", "idle", "t1", "delivered", "--json"],
                                capture_output=True, text=True, env=self.w.env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.owner_sent(), ["delivered"])
        result = subprocess.run(["hc", "read", "t1"], capture_output=True, text=True, env=self.w.env())
        self.assertEqual(result.stdout, "previous output\n❯ ")

    def test_fake_keys_join_characters_and_submit_only_at_enter(self):
        for keys, expected in ((["/", "x", "space", "-", "-", "a"], []),
                               (["enter"], ["/x --a"])):
            result = subprocess.run(["hc", "keys", "t1", *keys], capture_output=True, text=True,
                                    env=self.w.env())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.owner_sent(), expected)
        self.assertEqual(self.w.hc_state()["calls"][-1], ["keys", "t1", "enter"])

    def test_claude_dispatch_keys_and_resend_do_not_duplicate_delivery(self):
        task = self.task()
        request = self.request(task=task)
        expected = f"{self.topic}:{request['REQUEST']}"
        self.assertEqual(self.delivery(), expected)
        message = json.loads(request["MESSAGE"])
        self.assertEqual(self.owner_sent(), [message])
        keys = [call for call in self.w.hc_state()["calls"] if call[0] == "keys"]
        self.assertEqual(keys, [["keys", "t1", *("space" if c == " " else c for c in message), "enter"]])
        at = self.data()["tasks"][task]["request"]["delivered_at"]
        self.assertIsInstance(at, (float, int))
        self.assertEqual(self.delivery(), "")
        self.assertEqual(self.data()["tasks"][task]["request"]["delivered_at"], at)
        self.command("request", "--topic", self.topic, "--task", task, "--resend")
        self.assertEqual(self.delivery(), expected)
        self.assertEqual(self.owner_sent(), [message, message])

    def test_claude_checks_only_the_last_prompt_and_allows_done(self):
        task = self.task()
        self.request(task=task)
        self.w.patch("parent", screen="❯ earlier\noutput\n│ ❯ draft still being typed")
        self.assertEqual(self.delivery(), "")
        self.assertFalse(self.owner_sent())
        self.w.patch("parent", status="done", screen="❯ earlier\noutput\n❯ ")
        self.assertTrue(self.delivery())
        self.assertEqual(len(self.owner_sent()), 1)

    def test_deliver_skips_new_tabs_topic_states_and_unavailable_owners(self):
        task = self.task()
        self.request(task=task, *("--target", "new_tab"))
        self.assertEqual(self.delivery(), "")
        self.request(task=task)
        for field in ("archived", "paused_at", "deleting"):
            with self.subTest(field=field):
                self.alter(**{field: 0})
                self.assertEqual(self.delivery(), "")
                self.alter(**{field: None})
        for change in ({"state": "finished"}, {"status": "working"}, {"status": "blocked"},
                       {"status": "error"}):
            with self.subTest(change=change):
                self.w.patch("parent", **dict({"state": "live", "status": "idle"}, **change))
                self.assertEqual(self.delivery(), "")
        self.w.patch("parent", state="live", status="idle")
        owner = self.data()["owner"]
        for terminal in (None, "missing"):
            self.alter(owner=dict(owner, terminal=terminal))
            self.assertEqual(self.delivery(), "")
        self.assertFalse(self.owner_sent())

    def test_refine_groups_items_into_one_conditional_send_even_with_active_task(self):
        self.start(self.task())
        items = [self.item(), self.item()]
        request = self.request(items=items)
        self.assertEqual(self.delivery(), f"{self.topic}:{request['REQUEST']}")
        self.assertEqual(self.owner_sent(), [json.loads(request["MESSAGE"])])
        sends = [call for call in self.w.hc_state()["calls"] if call[0] == "send"]
        self.assertEqual(sends, [["send", "t1", json.loads(request["MESSAGE"]), "--if", "idle", "--json"]])
        delivered = [item["request"]["delivered_at"] for item in self.backlog()["items"]]
        self.assertTrue(all(at is not None for at in delivered))
        self.assertEqual(len(set(delivered)), 1)
        self.assertEqual(self.delivery(), "")

    def test_non_claude_dispatch_uses_owner_agent_and_conditional_send(self):
        owner = dict(self.data()["owner"], agent="codex")
        self.alter(owner=owner)
        self.w.patch("parent", app="codex", argv=["codex"], screen="❯ user draft")
        task = self.task()
        request = self.request(task=task, *("--agent", "claude"))
        self.assertTrue(self.delivery())
        self.assertEqual(self.owner_sent(),
                         [f"按 cc-herdr-dispatch-dev skill 执行，参数：--topic {self.topic} --task {task}"
                          f" --request {request['REQUEST']}"])
        self.assertFalse(any(call[0] in ("keys", "read") for call in self.w.hc_state()["calls"]))
        self.assertEqual(self.w.hc_state()["calls"][-1][-3:], ["--if", "idle", "--json"])

    def test_failed_send_keys_or_read_leave_request_undelivered(self):
        task = self.task()
        self.request(task=task)
        self.w.patch("parent", refuse=True)
        self.assertEqual(self.delivery(), "")
        self.assertIsNone(self.data()["tasks"][task]["request"]["delivered_at"])
        self.alter(owner=dict(self.data()["owner"], agent="codex"))
        self.assertEqual(self.delivery(), "")
        self.assertIsNone(self.data()["tasks"][task]["request"]["delivered_at"])
        self.alter(owner=dict(self.data()["owner"], agent="claude"))
        real_hc = self.hd.hc

        def failed_read(*args, **kwargs):
            if args[0] == "read":
                return subprocess.CompletedProcess(args, 1, "", "read failed")
            return real_hc(*args, **kwargs)

        self.w.patch("parent", refuse=False)
        with mock.patch.object(self.hd, "hc", side_effect=failed_read):
            self.assertEqual(self.direct("deliver")["DELIVERED"], "")
        self.assertIsNone(self.data()["tasks"][task]["request"]["delivered_at"])

    def test_conditional_send_closes_the_status_change_race(self):
        self.alter(owner=dict(self.data()["owner"], agent="codex"))
        task = self.task()
        self.request(task=task)
        real_hc = self.hd.hc

        def change_status(*args, **kwargs):
            if args[0] == "send":
                self.w.patch("parent", status="working")
            return real_hc(*args, **kwargs)

        with mock.patch.object(self.hd, "hc", side_effect=change_status):
            self.assertEqual(self.direct("deliver")["DELIVERED"], "")
        self.assertIsNone(self.data()["tasks"][task]["request"]["delivered_at"])
        self.assertFalse(self.owner_sent())
        self.assertFalse(any(call[0] == "send" for call in self.w.hc_state()["calls"]))

    def test_dispatch_waits_for_active_tasks_in_same_or_other_topic(self):
        task = self.task()
        request = self.request(task=task)
        other = self.init()
        active = self.task(other)
        run = self.start(active, topic=other)
        self.assertEqual(self.delivery(), "")
        self.set_task(active, topic=other, finished_at=0)
        self.assertEqual(self.delivery(), f"{self.topic}:{request['REQUEST']}")
        self.command("request", "--topic", self.topic, "--task", task, "--resend")
        self.set_task(active, topic=other, finished_at=None)
        state = self.hd.read_json(run / "state.json", {})
        state["finished"] = 0
        self.hd.write_json(run / "state.json", state)
        self.assertTrue(self.delivery())
        self.command("request", "--topic", self.topic, "--task", task, "--resend")
        state.pop("finished")
        self.hd.write_json(run / "state.json", state)
        for control in ({"state": "paused"}, {"state": "stopping"}, {"state": "handoff"}):
            self.hd.set_control(run, **control)
            self.assertEqual(self.delivery(), "")
        for control in ({"state": "stopped"}, {"state": "running", "retired": {"at": 0}}):
            self.hd.set_control(run, **control)
            self.assertTrue(self.delivery())
            self.command("request", "--topic", self.topic, "--task", task, "--resend")
        self.set_task(active, topic=other, run=None)
        self.hd.set_control(run, state="running")
        local = self.task()
        self.start(local, run=run)
        self.assertEqual(self.delivery(), "")

    def test_delivery_picks_oldest_and_limits_each_owner_across_topics(self):
        old = self.item()
        first = self.request(items=[old])["REQUEST"]
        task = self.task()
        self.request(task=task)
        other = self.init()
        other_task = self.task(other)
        self.request(task=other_task, topic=other)
        self.w.set_terminals({"another": {"address": "t9", "status": "idle", "argv": ["codex"]}})
        separate = self.init("t9")
        separate_task = self.task(separate)
        separate_request = self.request(task=separate_task, topic=separate)["REQUEST"]
        delivered = self.delivery().split(",")
        owner_topics = {entry.split(":")[0] for entry in delivered} - {separate}
        self.assertEqual(len(owner_topics), 1)
        if self.topic in owner_topics:
            self.assertIn(f"{self.topic}:{first}", delivered)
        self.assertIn(f"{separate}:{separate_request}", delivered)
        self.assertEqual(len(self.owner_sent()), 1)

    def test_repository_delivery_lock_does_not_wait_or_send(self):
        self.request(task=self.task())
        path = self.w.repo / ".cc-dispatch" / "topics" / ".deliver.lock"
        with path.open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            self.assertEqual(self.delivery(), "")
        self.assertFalse(self.owner_sent())
        self.assertTrue(self.delivery())

    def test_pause_resume_preserves_independently_paused_runs_and_is_idempotent(self):
        run = self.start(self.task())
        meta = self.w.dispatch()
        separate = self.start(self.task(), run=run.parent / "dev-separate")
        independent = self.start(self.task(), run=run.parent / "dev-independent")
        self.w.hd("pause", "--run", str(independent))
        before = self.hd.control(independent)
        result = self.command("pause", "--topic", self.topic)
        self.assertEqual(set(result["PAUSED"].split(",")), {run.name, separate.name})
        self.assertEqual(set(self.data()["paused_runs"]), {run.name, separate.name})
        self.assertIsNotNone(self.data()["paused_at"])
        self.assertEqual(self.hd.control(run)["held"], ["a"])
        self.assertEqual(self.w.hc_state()["terminals"][meta["name"]]["status"], "idle")
        self.command("pause", "--topic", self.topic)
        self.assertEqual(set(self.data()["paused_runs"]), {run.name, separate.name})
        result = self.command("resume", "--topic", self.topic)
        self.assertEqual(set(result["RESUMED"].split(",")), {run.name, separate.name})
        self.assertIsNone(self.data()["paused_at"])
        self.assertEqual(self.data()["paused_runs"], [])
        self.assertEqual(self.hd.control(run)["state"], "running")
        self.assertEqual(self.hd.control(separate)["state"], "running")
        self.assertEqual(self.hd.control(independent), before)
        self.assertEqual(self.command("resume", "--topic", self.topic)["RESUMED"], "")

    def test_pause_blocks_start_and_queued_requests_deliver_after_resume(self):
        task = self.task()
        request = self.request(task=task)["REQUEST"]
        self.command("pause", "--topic", self.topic)
        self.assertEqual(self.delivery(), "")
        self.assertEqual(self.command("start", "--run", self.w.run_dir, "--topic", self.topic,
                                      "--task", task, code=3)["FAILURE"], "TOPIC_PAUSED")
        self.command("resume", "--topic", self.topic)
        self.assertEqual(self.delivery(), f"{self.topic}:{request}")

    def test_resume_preserves_activation_changes_in_topic_and_state(self):
        task = self.task()
        run = self.start(task)
        self.command("pause", "--topic", self.topic)
        self.command("finish", "--run", run, "--line", "Finished")
        self.alter(archived=123)
        (run / "archived").write_text("123\n")
        self.command("resume", "--topic", self.topic)
        self.assertIsNone(self.data()["archived"])
        self.assertIsNone(self.data()["tasks"][task]["finished_at"])
        self.assertNotIn("finished", self.hd.read_json(run / "state.json", {}))
        self.assertFalse((run / "archived").exists())
        self.assertEqual(self.data()["paused_runs"], [])

    def test_stop_cancels_delivered_and_queued_requests_keeps_drafts_and_notifies(self):
        run = self.start(self.task())
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="idle", on_send={"status": "done", "turn": 1,
                     "write": [meta["report"], '{"status": "partial"}']})
        item = self.item()
        self.request(items=[item])
        draft = self.task()
        self.request(task=draft)
        self.assertTrue(self.delivery())
        finished_task = self.task()
        finished_run = self.start(finished_task, run=run.parent / "dev-finished")
        self.command("finish", "--run", finished_run, "--line", "Already done")
        with mock.patch.object(self.hd, "cmd_stop", wraps=self.hd.cmd_stop) as stop:
            result = self.direct("stop", wait=0)
        self.assertEqual(result["STOPPED"], run.name)
        self.assertEqual(stop.call_count, 1)
        self.assertEqual(stop.call_args.args[0].wait, 0)
        self.assertEqual(self.hd.control(run)["state"], "stopped")
        self.assertEqual(self.hd.control(finished_run)["state"], "running")
        self.assertTrue((run / "stop.md").exists())
        self.assertIn(draft, self.data()["tasks"])
        self.assertIsNone(self.data()["tasks"][draft]["request"])
        self.assertEqual((self.backlog()["items"][0]["status"],
                          self.backlog()["items"][0]["request"]), ("open", None))
        self.assertTrue(any("终止了运行" in text for text in self.owner_sent()))

    def test_archive_reports_all_unfinished_tasks_and_unanswered_items_without_changes(self):
        task = self.task()
        run = self.start(task)
        other_task = self.task()
        other_run = self.start(other_task, run=run.parent / "dev-child")
        self.hd.write_json(other_run / "asks.json", {"choice": {"title": "Choose", "asked": 10}})
        draft = self.task()
        request = self.request(task=draft)["REQUEST"]
        before = self.data()
        result = self.w.hd("topic", "archive", "--repo", str(self.w.repo), "--topic", self.topic)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual(self.w.kv(result)["FAILURE"], "ARCHIVE_BLOCKED")
        for reason in (task, other_task, "choice", other_run.name):
            self.assertIn(reason, result.stdout)
        self.assertEqual(self.data(), before)
        self.assertEqual(self.data()["tasks"][draft]["request"]["id"], request)
        self.assertFalse((run / "archived").exists())
        self.assertFalse((other_run / "archived").exists())

    def test_archive_accepts_each_completion_source_and_unarchive_removes_all_markers(self):
        runs = []
        for name in ("task", "state", "stopped", "retired"):
            task = self.task()
            run = self.start(task, run=self.w.run_dir.parent / ("dev-" + name))
            runs.append(run)
            if name == "task":
                self.set_task(task, finished_at=0)
            elif name == "state":
                state = self.hd.read_json(run / "state.json", {})
                self.hd.write_json(run / "state.json", dict(state, finished=0))
            elif name == "stopped":
                self.hd.set_control(run, state="stopped")
            else:
                self.hd.set_control(run, state="running", retired={"at": 0})
        draft = self.task()
        self.request(task=draft)
        item = self.item()
        self.request(items=[item])
        self.assertEqual(self.command("archive", "--topic", self.topic)["ARCHIVED"], self.topic)
        self.assertIsNotNone(self.data()["archived"])
        self.assertTrue(all((run / "archived").exists() for run in runs))
        self.assertIn(draft, self.data()["tasks"])
        self.assertIsNone(self.data()["tasks"][draft]["request"])
        self.assertEqual((self.backlog()["items"][0]["status"],
                          self.backlog()["items"][0]["request"]), ("open", None))
        self.assertEqual(self.command("request", "--topic", self.topic, "--task", draft,
                                      code=3)["FAILURE"], "TOPIC_ARCHIVED")
        self.assertEqual(self.command("start", "--run", self.w.run_dir, "--topic", self.topic,
                                      "--task", draft, code=3)["FAILURE"], "TOPIC_ARCHIVED")
        self.assertEqual(self.delivery(), "")
        self.assertEqual(self.command("unarchive", "--topic", self.topic)["UNARCHIVED"], self.topic)
        self.assertIsNone(self.data()["archived"])
        self.assertTrue(all(not (run / "archived").exists() for run in runs))

    def test_archive_requires_current_answers_including_parked_cards_and_legacy_pending(self):
        task = self.task()
        run = self.start(task)
        self.set_task(task, finished_at=1)
        state = self.hd.read_json(run / "state.json", {})
        state.update(tasks={"card": {"status": "parked", "note": "user"}},
                     pending_decisions={"other": "Choose"})
        self.hd.write_json(run / "state.json", state)
        self.hd.write_json(run / "asks.json", {"ask": {"title": "Question", "asked": 10}})
        (run / "answers.jsonl").write_text('{"id": "ask", "at": 9}\n')
        result = self.w.hd("topic", "archive", "--repo", str(self.w.repo), "--topic", self.topic)
        self.assertEqual(result.returncode, 3)
        for key in ("ask", "card:card", "pending:other"):
            self.assertIn(key, result.stdout)
        with (run / "answers.jsonl").open("a") as stream:
            for key in ("ask", "card:card", "pending:other"):
                stream.write(json.dumps({"id": key, "at": 20}) + "\n")
        self.command("archive", "--topic", self.topic)

    def archived_runs(self):
        runs = [self.start(self.task()), self.start(self.task(), run=self.w.run_dir.parent / "dev-second")]
        for task in self.data()["tasks"]:
            self.set_task(task, finished_at=1)
        self.command("archive", "--topic", self.topic)
        return runs

    def test_delete_requires_archiving_and_preflights_all_runs_before_deleting_any(self):
        self.assertEqual(self.command("delete", "--topic", self.topic, code=3)["FAILURE"], "NOT_ARCHIVED")
        first, second = self.archived_runs()
        before = self.data()
        for state in ("paused", "stopping", "handoff"):
            with self.subTest(state=state):
                self.hd.set_control(second, state=state)
                result = self.w.hd("topic", "delete", "--repo", str(self.w.repo), "--topic", self.topic)
                self.assertEqual(result.returncode, 3)
                self.assertEqual(self.w.kv(result)["FAILURE"], "DELETE_BLOCKED")
                self.assertIn(second.name, result.stdout)
                self.assertIn(state, result.stdout)
                self.assertTrue(first.exists())
                self.assertTrue(second.exists())
                self.assertEqual(self.data(), before)
        self.hd.set_control(second, state="running")
        (second / "archived").unlink()
        self.assertEqual(self.command("delete", "--topic", self.topic, code=3)["FAILURE"], "DELETE_BLOCKED")
        self.assertTrue(first.exists())
        self.assertIsNone(self.data()["deleting"])

    def test_delete_blocks_live_working_helpers_using_retire_rule(self):
        task = self.task()
        self.start(task)
        meta = self.w.dispatch()
        self.set_task(task, finished_at=1)
        self.command("archive", "--topic", self.topic)
        result = self.w.hd("topic", "delete", "--repo", str(self.w.repo), "--topic", self.topic)
        self.assertEqual(result.returncode, 3)
        self.assertIn("HELPERS_AT_WORK", result.stdout)
        self.assertTrue(self.w.run_dir.exists())
        self.assertIsNone(self.data()["deleting"])
        self.assertFalse(any(call[0] in ("kill", "rm") for call in self.w.hc_state()["calls"]))
        self.w.patch(meta["name"], status="done")
        self.command("delete", "--topic", self.topic)
        self.assertFalse(self.w.run_dir.exists())

    def test_delete_removes_bound_runs_topic_and_preserves_external_lock(self):
        runs = self.archived_runs()
        result = self.command("delete", "--topic", self.topic)
        self.assertEqual(result["DELETED"], self.topic)
        self.assertEqual(result["RUNS"], "2")
        self.assertTrue(all(not run.exists() for run in runs))
        self.assertFalse(self.hd.topic_dir(self.w.repo, self.topic).exists())
        self.assertTrue((self.w.repo / ".cc-dispatch" / "topics" / f".{self.topic}.lock").exists())

    def test_partial_delete_preserves_deleting_blocks_send_and_resumes_missing_runs(self):
        first, second = self.archived_runs()
        real_delete = self.hd.cmd_delete

        def fail_second(args):
            if args.run == str(second):
                raise OSError("injected delete failure")
            real_delete(args)

        with mock.patch.object(self.hd, "cmd_delete", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "injected delete failure"):
                self.direct("delete")
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        deleting = self.data()["deleting"]
        self.assertIsNotNone(deleting)
        prompt = self.w.root / "send.md"
        prompt.write_text("Continue")
        result = self.w.hd("send", "--run", str(second), "--call", "missing", "--prompt", str(prompt))
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual(self.w.kv(result)["FAILURE"], "TOPIC_DELETING")
        self.assertEqual(self.data()["deleting"], deleting)
        self.assertEqual(self.delivery(), "")
        self.assertEqual(self.command("delete", "--topic", self.topic)["RUNS"], "2")
        self.assertFalse(second.exists())
        self.assertFalse(self.hd.topic_dir(self.w.repo, self.topic).exists())


if __name__ == "__main__":
    unittest.main()
