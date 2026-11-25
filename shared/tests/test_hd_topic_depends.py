"""Task dependencies and notices use temporary repositories and fake hc terminals."""
import argparse
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from test_hd_dispatch import Env, HD, module


class TopicDepends(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        self.w.set_terminals({"other": {"address": "t2", "status": "working", "argv": ["codex"],
                                        "app": "codex", "labels": {"herdr.space": "s1"}}})
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        self.a = self.command("init", "--title", "First")["TOPIC"]
        self.b = self.command("init", "--title", "Second", HC_TERMINAL_ID="t2")["TOPIC"]
        self.ka = self.task(self.a, "Consumer")
        self.kb = self.task(self.b, "Producer")

    def raw(self, name, *args, code=0, **env):
        result = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args), **env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def command(self, name, *args, code=0, **env):
        return self.w.kv(self.raw(name, *args, code=code, **env))

    def invoke(self, *args, **env):
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.w.env(**env)), mock.patch.object(
                sys, "argv", [str(HD), *map(str, args)]), contextlib.redirect_stdout(output):
            self.hd.main()
        return output.getvalue()

    def topic_path(self, topic):
        return self.w.repo / ".cc-dispatch" / "topics" / topic / "topic.json"

    def data(self, topic):
        return self.hd.read_json(self.topic_path(topic), {})

    def set_task(self, topic, tid, **changes):
        with self.hd.topic_lock(self.w.repo, topic):
            data = self.data(topic)
            data["tasks"][tid].update(changes)
            self.hd.save_topic(self.w.repo, topic, data)

    def task(self, topic, title="Task", depends=None):
        args = ["--topic", topic, "--title", title, "--kind", "dev"]
        if depends is not None:
            args += ["--depends", depends]
        return self.command("task-add", *args)["TASK"]

    def depend(self, topic=None, tid=None, refs=None, code=0):
        return self.command("task-edit", "--topic", topic or self.a, "--task", tid or self.ka,
                            "--depends", refs if refs is not None else f"{self.b}:{self.kb}", code=code)

    def start(self, topic=None, tid=None, run=None):
        run = run or self.w.run_dir
        self.command("start", "--run", run, "--topic", topic or self.b, "--task", tid or self.kb)
        return run

    def new_run(self, name):
        run = self.w.run_dir.parent / name
        run.mkdir()
        return run

    def finish(self, run=None, line="Ready", artifact="result.md"):
        return self.command("finish", "--run", run or self.w.run_dir, "--line", line,
                            "--artifact", artifact)

    def mailbox_path(self, topic, suffix=".json"):
        return self.hd.MSG_DIR(self.w.repo) / f"{topic}{suffix}"

    def messages(self, topic=None):
        return self.hd.load_messages(self.w.repo, topic or self.a)["items"]

    def events(self, topic=None):
        return self.hd.read_json(self.mailbox_path(topic or self.b, ".outbox.json"),
                                 {"events": []})["events"]

    def state(self, ref=None):
        return self.hd.depends_state(self.w.repo, self.a, ref or f"{self.b}:{self.kb}")

    def request(self, topic=None, tid=None, *args, code=0):
        return self.command("request", "--topic", topic or self.a, "--task", tid or self.ka,
                            *args, code=code)

    def test_reference_formats_and_invalid_references(self):
        self.assertEqual(self.hd.parse_ref(self.a, "k2"), (self.a, "k2"))
        self.assertEqual(self.hd.parse_ref(self.a, "Other-Topic_1:k2"), ("Other-Topic_1", "k2"))
        for ref in ("", "k0", "k01", "k-1", "B", ":k1", "../B:k1", "B:k1:extra",
                    "B:task", "B:k1\n", None):
            with self.subTest(ref=ref), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as error:
                    self.hd.parse_ref(self.a, ref)
                self.assertEqual(error.exception.code, 3)
                self.assertIn("FAILURE=DEPENDS_INVALID", output.getvalue())

    def test_missing_self_and_invalid_dependencies_do_not_modify_topics(self):
        before = self.topic_path(self.a).read_bytes()
        for ref, failure in (("missing:k2", "DEPENDS_MISSING"),
                             (f"{self.b}:k99", "DEPENDS_MISSING"), ("k2", "DEPENDS_SELF"),
                             ("bad-ref", "DEPENDS_INVALID")):
            with self.subTest(ref=ref):
                result = self.command("task-add", "--topic", self.a, "--title", "New", "--kind", "dev",
                                      "--depends", ref, code=3)
                self.assertEqual(result["FAILURE"], failure)
                self.assertEqual(self.topic_path(self.a).read_bytes(), before)
        for ref, failure in ((self.ka, "DEPENDS_SELF"), (f"{self.a}:{self.ka}", "DEPENDS_SELF"),
                             ("k99", "DEPENDS_MISSING"), (f"{self.b}:k99", "DEPENDS_MISSING")):
            with self.subTest(ref=ref):
                self.assertEqual(self.depend(refs=ref, code=3)["FAILURE"], failure)
                self.assertEqual(self.topic_path(self.a).read_bytes(), before)

    def test_same_topic_and_cross_topic_cycles_report_the_complete_path(self):
        local = self.task(self.a, depends=self.ka)
        result = self.depend(refs=local, code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertEqual(result["CYCLE"].split("\u2192"),
                         [f"{self.a}:{self.ka}", f"{self.a}:{local}", f"{self.a}:{self.ka}"])
        self.assertEqual(self.data(self.a)["tasks"][self.ka]["depends_on"], [])
        self.depend()
        result = self.depend(self.b, self.kb, f"{self.a}:{self.ka}", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertEqual(result["CYCLE"].split("\u2192"),
                         [f"{self.b}:{self.kb}", f"{self.a}:{self.ka}", f"{self.b}:{self.kb}"])
        self.assertEqual(self.data(self.b)["tasks"][self.kb]["depends_on"], [])

    def test_shared_ancestor_graph_is_visited_linearly(self):
        count = 200
        data = self.data(self.a)
        data["tasks"] = {
            f"k{i}": {"depends_on": [f"k{j}" for j in range(max(1, i - 2), i)]}
            for i in range(1, count + 1)}
        snapshot = self.hd.dependency_snapshot
        visits = 0

        def bounded_snapshot(*args):
            nonlocal visits
            visits += 1
            self.assertLessEqual(visits, count * 3, "shared ancestors were traversed repeatedly")
            return snapshot(*args)

        with mock.patch.object(self.hd, "dependency_snapshot", side_effect=bounded_snapshot):
            self.assertEqual(self.hd.dependency_cycle(
                self.w.repo, self.a, f"k{count}", {self.a: data}, []), [])
        self.assertLessEqual(visits, count * 3)
        data["tasks"]["k1"]["depends_on"] = [f"k{count}"]
        cycle = self.hd.dependency_cycle(self.w.repo, self.a, f"k{count}", {self.a: data}, [])
        self.assertEqual(cycle[0], cycle[-1])
        self.assertIn(f"{self.a}:k1", cycle)

    def test_dependency_chains_longer_than_the_call_stack_are_checked(self):
        count = 3000
        data = self.data(self.a)
        data["tasks"] = {f"k{i}": {"depends_on": [f"k{i + 1}"] if i < count else []}
                         for i in range(1, count + 1)}
        self.assertEqual(self.hd.dependency_cycle(self.w.repo, self.a, "k1", {self.a: data}, []), [])
        data["tasks"][f"k{count}"]["depends_on"] = ["k1"]
        cycle = self.hd.dependency_cycle(self.w.repo, self.a, "k1", {self.a: data}, [])
        self.assertEqual((len(cycle), cycle[0], cycle[-1]), (count + 1, f"{self.a}:k1", f"{self.a}:k1"))

    def test_null_historical_dependency_entries_do_not_hide_later_edges(self):
        self.set_task(self.a, self.ka, depends_on=[None, f"{self.b}:{self.kb}"])
        result = self.command("task-edit", "--topic", self.b, "--task", self.kb,
                              "--depends", f"{self.a}:{self.ka}", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")

    def test_an_unreadable_dependency_blocks_instead_of_reading_as_missing(self):
        self.set_task(self.a, self.ka, depends_on=[f"{self.b}:{self.kb}"])
        path, read = self.topic_path(self.b), self.hd.Path.read_text

        def unreadable(current, *args, **kwargs):
            if current == path:
                raise OSError("topic unavailable")
            return read(current, *args, **kwargs)

        with mock.patch.object(self.hd.Path, "read_text", new=unreadable), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            self.hd.depends_blockers(self.w.repo, self.a, self.data(self.a)["tasks"][self.ka])

    def test_concurrent_dependency_edits_in_two_topics_cannot_commit_a_cycle(self):
        validate = self.hd.validate_task_depends

        def slow_validate(*args):
            validate(*args)
            time.sleep(0.2)

        def edit(topic, tid, depends):
            args = argparse.Namespace(repo=str(self.w.repo), topic=topic, topic_cmd="task-edit", task=tid,
                                      title=None, kind=None, detail=None, depends=depends)
            try:
                self.hd.cmd_topic_task(args)
                return "ok"
            except SystemExit:
                return "refused"

        with mock.patch.object(self.hd, "validate_task_depends", side_effect=slow_validate), \
                contextlib.redirect_stdout(io.StringIO()), ThreadPoolExecutor(max_workers=2) as pool:
            results = sorted(pool.map(lambda job: edit(*job), [
                (self.a, self.ka, f"{self.b}:{self.kb}"), (self.b, self.kb, f"{self.a}:{self.ka}")]))
        self.assertEqual(results, ["ok", "refused"])
        self.assertEqual(self.hd.dependency_cycle(self.w.repo, self.a, self.ka, {}, []), [])

    def test_readonly_dependency_checks_treat_invalid_historical_references_as_missing(self):
        self.request()
        self.set_task(self.a, self.ka, depends_on=["broken:k0", None, 12])
        for ref in ("broken:k0", None, 12):
            with self.subTest(ref=ref), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(self.hd.depends_state(self.w.repo, self.a, ref)["state"], "missing")
                self.assertEqual(output.getvalue(), "")
        self.assertEqual(self.hd.dependency_cycle(self.w.repo, self.a, self.ka, {}, []), [])
        self.w.patch("parent", status="idle", screen="\u276f ")
        self.assertTrue(self.command("deliver")["DELIVERED"])
        self.assertEqual(self.depend(refs="broken:k0", code=3)["FAILURE"], "DEPENDS_INVALID")

    def test_task_state_is_committed_before_any_end_notice_is_queued(self):
        self.depend()
        self.start()
        save = self.hd.save_topic

        def interrupt_commit(repo, topic, data):
            if topic == self.b:
                raise KeyboardInterrupt
            save(repo, topic, data)

        with mock.patch.object(self.hd, "save_topic", side_effect=interrupt_commit):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("topic", "finish", "--run", self.w.run_dir, "--line", "Durable")
        self.assertIsNone(self.data(self.b)["tasks"][self.kb]["finished_at"])
        self.assertEqual(self.events(), [])
        self.hd.flush_outbox(self.w.repo)
        self.assertEqual(self.messages(), [])
        self.finish()
        self.assertEqual(len(self.messages()), 1)

    def test_pending_end_notices_recover_from_the_committed_task_with_the_same_event_id(self):
        self.depend()
        self.start()
        with mock.patch.object(self.hd, "queue_task_notices", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("topic", "finish", "--run", self.w.run_dir, "--line", "Committed")
        task = self.data(self.b)["tasks"][self.kb]
        self.assertIsNotNone(task["finished_at"])
        marker = task["end_event"]
        self.assertRegex(marker["id"], r"^e\d+-[0-9a-f]{4}$")
        self.command("deliver")
        self.assertEqual([item["event"] for item in self.messages()], [marker["id"]])
        self.finish()
        self.assertEqual([item["event"] for item in self.messages()], [marker["id"]])

    def test_end_notice_retry_after_queue_commit_deduplicates_all_recipients(self):
        self.depend()
        follower = self.command("init", "--title", "Follower", HC_TERMINAL_ID="")["TOPIC"]
        self.command("follow", "--topic", follower, "--target", self.b, HC_TERMINAL_ID="")
        self.start()
        queued = self.hd.queue_task_notices

        def interrupt_after_queue(*args, **kwargs):
            queued(*args, **kwargs)
            raise KeyboardInterrupt

        with mock.patch.object(self.hd, "queue_task_notices", side_effect=interrupt_after_queue):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("topic", "finish", "--run", self.w.run_dir, "--line", "Committed")
        self.hd.flush_outbox(self.w.repo)
        ids = {target: self.messages(target)[0]["event"] for target in (self.a, follower)}
        self.finish()
        for target in (self.a, follower):
            self.assertEqual([item["event"] for item in self.messages(target)], [ids[target]])

    def test_abandon_and_stop_persist_their_end_state_before_queueing_notices(self):
        self.depend()
        self.start()
        with mock.patch.object(self.hd, "queue_task_notices", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("topic", "abandon", "--repo", self.w.repo, "--topic", self.b,
                            "--task", self.kb, "--reason", "Removed", HC_TERMINAL_ID="t2")
        task = self.data(self.b)["tasks"][self.kb]
        self.assertIsNotNone(task.get("abandoned_at"))
        self.assertEqual(task["end_event"]["kind"], "abandoned")
        self.command("deliver")
        self.assertEqual(len(self.messages()), 1)
        run = self.new_run("dev-stopped")
        tid = self.task(self.b, "Stop producer")
        self.depend(refs=f"{self.b}:{tid}")
        self.start(self.b, tid, run)
        with mock.patch.object(self.hd, "queue_task_notices", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.hd.record_run_end(run, "stopped", "Stopped")
        self.assertEqual(self.data(self.b)["tasks"][tid]["end_event"]["kind"], "stopped")
        self.command("deliver")
        self.assertEqual(len(self.messages()), 2)

    def test_notice_text_explains_follow_and_dependency_reasons(self):
        self.depend()
        self.command("follow", "--topic", self.a, "--target", self.b)
        follower = self.command("init", "--title", "Follower", HC_TERMINAL_ID="")["TOPIC"]
        self.command("follow", "--topic", follower, "--target", self.b, HC_TERMINAL_ID="")
        self.start()
        self.finish()
        self.assertIn("\u5173\u6ce8 + \u4f9d\u8d56", self.messages()[0]["text"])
        self.assertIn("\u5173\u6ce8", self.messages(follower)[0]["text"])
        self.assertNotIn("\u4f9d\u8d56", self.messages(follower)[0]["text"])

    def test_refinement_validates_all_drafts_together_without_partial_writes(self):
        item = self.command("backlog-add", "--topic", self.a, "--text", "Plan")["ITEM"]
        rid = self.command("request", "--topic", self.a, "--items", item)["REQUEST"]
        before = {p.name: p.read_bytes() for p in self.topic_path(self.a).parent.iterdir() if p.is_file()}
        invalid = [
            ([{"title": "Missing", "kind": "dev", "depends_on": [f"{self.b}:k99"]}], "DEPENDS_MISSING"),
            ([{"title": "Self", "kind": "dev", "depends_on": ["k2"]}], "DEPENDS_SELF"),
            ([{"title": "Invalid", "kind": "dev", "depends_on": ["bad-ref"]}], "DEPENDS_INVALID"),
            ([{"title": "One", "kind": "dev", "depends_on": ["k3"]},
              {"title": "Two", "kind": "dev", "depends_on": ["k2"]}], "DEPENDS_CYCLE"),
        ]
        for drafts, failure in invalid:
            with self.subTest(failure=failure):
                result = self.command("refined", "--topic", self.a, "--ack", rid,
                                      "--drafts", json.dumps(drafts), code=3)
                self.assertEqual(result["FAILURE"], failure)
                self.assertEqual({p.name: p.read_bytes() for p in self.topic_path(self.a).parent.iterdir()
                                  if p.is_file()}, before)
        self.set_task(self.b, self.kb, depends_on=[f"{self.a}:k2"])
        result = self.command("refined", "--topic", self.a, "--ack", rid, "--drafts", json.dumps([
            {"title": "Cross", "kind": "dev", "depends_on": [f"{self.b}:{self.kb}"]}]), code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertIn(f"{self.b}:{self.kb}", result["CYCLE"])
        drafts = [{"title": "Earlier", "kind": "dev", "depends_on": ["k3"]},
                  {"title": "Later", "kind": "dev"}]
        result = self.command("refined", "--topic", self.a, "--ack", rid, "--drafts", json.dumps(drafts))
        self.assertEqual(result["TASKS"], "k2,k3")
        self.assertEqual(self.data(self.a)["tasks"]["k2"]["depends_on"], ["k3"])

    def test_snapshot_cycles_block_both_sides_and_keep_queued_requests(self):
        ra, rb = self.request(), self.request(self.b, self.kb)
        self.set_task(self.a, self.ka, depends_on=[f"{self.b}:{self.kb}"])
        self.set_task(self.b, self.kb, depends_on=[f"{self.a}:{self.ka}"])
        for topic, tid, ref in ((self.a, self.ka, f"{self.b}:{self.kb}"),
                                (self.b, self.kb, f"{self.a}:{self.ka}")):
            with self.subTest(topic=topic):
                state = self.hd.depends_state(self.w.repo, topic, ref)
                self.assertEqual(state["state"], "cycle")
                self.assertEqual(state["path"][0], state["path"][-1])
                self.assertEqual(set(state["path"]), {f"{self.a}:{self.ka}", f"{self.b}:{self.kb}"})
                self.assertEqual(self.request(topic, tid, code=3)["FAILURE"], "DEPENDS_PENDING")
                result = self.command("start", "--run", self.w.run_dir, "--topic", topic,
                                      "--task", tid, code=3)
                self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        self.w.patch("parent", status="idle", screen="\u276f ")
        self.w.patch("other", status="idle")
        result = self.command("deliver")
        self.assertEqual(result["DELIVERED"], "")
        self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        for topic, tid, request in ((self.a, self.ka, ra), (self.b, self.kb, rb)):
            self.assertEqual(self.data(topic)["tasks"][tid]["request"]["id"], request["REQUEST"])
            self.assertIsNone(self.data(topic)["tasks"][tid]["request"]["delivered_at"])

    def test_pending_dependency_blocks_requests_and_binding_until_finish(self):
        self.depend()
        before = self.topic_path(self.a).read_bytes()
        for target in ("owner", "new_tab"):
            result = self.request(None, None, "--kind", "dispatch", "--target", target, code=3)
            self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
            self.assertEqual(result["DEPENDS"], f"{self.b}:{self.kb}\tpending\tProducer")
        result = self.command("start", "--run", self.w.run_dir, "--topic", self.a,
                              "--task", self.ka, code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        self.assertEqual(self.topic_path(self.a).read_bytes(), before)
        self.assertFalse((self.w.run_dir / "state.json").exists())
        self.start()
        self.finish()
        self.assertEqual(self.state()["state"], "done")
        self.assertIn("REQUEST", self.request())
        run = self.new_run("dev-consumer")
        self.start(self.a, self.ka, run)
        self.assertEqual(self.data(self.a)["tasks"][self.ka]["run"], run.name)

    def test_resend_is_gated_but_cancel_can_clear_a_blocked_request(self):
        rid = self.request()["REQUEST"]
        request = dict(self.data(self.a)["tasks"][self.ka]["request"], delivered_at=1.0)
        self.set_task(self.a, self.ka, request=request)
        self.depend()
        result = self.request(None, None, "--resend", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        self.assertEqual(self.data(self.a)["tasks"][self.ka]["request"], request)
        self.start()
        self.finish()
        self.assertEqual(self.request(None, None, "--resend")["REQUEST"], rid)
        self.assertIsNone(self.data(self.a)["tasks"][self.ka]["request"]["delivered_at"])
        self.depend(refs=self.ka, code=3)
        self.set_task(self.a, self.ka, depends_on=[self.ka])
        self.assertEqual(self.request(None, None, "--cancel")["CANCELLED"], rid)
        self.assertIsNone(self.data(self.a)["tasks"][self.ka]["request"])

    def test_delivery_skips_blocked_requests_and_later_delivers_them(self):
        blocked = self.request()["REQUEST"]
        self.depend()
        ready = self.task(self.a, "Ready task")
        deliverable = self.request(self.a, ready)["REQUEST"]
        self.w.patch("parent", status="idle", screen="previous output\n\u276f ")
        result = self.command("deliver")
        self.assertEqual(result["DELIVERED"], f"{self.a}:{deliverable}")
        self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        pending = self.data(self.a)["tasks"][self.ka]["request"]
        self.assertEqual(pending["id"], blocked)
        self.assertIsNone(pending["delivered_at"])
        self.request(self.a, ready, "--cancel")
        self.start()
        self.finish()
        # Finishing the dependency hands the unblocked request over right away.
        self.assertIsNotNone(self.data(self.a)["tasks"][self.ka]["request"]["delivered_at"])
        self.w.patch("parent", status="idle", screen="\u276f ")
        self.assertNotIn(f"{self.a}:{blocked}", self.command("deliver").get("DELIVERED", ""))

    def test_same_topic_dependencies_gate_dispatch_without_self_notices(self):
        consumer = self.task(self.b, "Local consumer", depends=self.kb)
        result = self.request(self.b, consumer, code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_PENDING")
        self.start()
        self.finish()
        self.assertEqual(self.messages(self.b), [])
        self.assertIn("REQUEST", self.request(self.b, consumer))
        self.start(self.b, consumer, self.new_run("dev-local"))

    def test_finish_combines_dependency_and_follow_reasons_once_per_recipient(self):
        self.depend()
        self.task(self.a, "Second consumer", depends=f"{self.b}:{self.kb}")
        self.task(self.b, "Local consumer", depends=self.kb)
        follower = self.command("init", "--title", "Follower", HC_TERMINAL_ID="")["TOPIC"]
        self.command("follow", "--topic", self.a, "--target", self.b)
        self.command("follow", "--topic", follower, "--target", self.b, HC_TERMINAL_ID="")
        self.start()
        with mock.patch.object(self.hd, "flush_outbox", return_value=0):
            self.invoke("topic", "finish", "--run", self.w.run_dir, "--line", "API ready",
                        "--artifact", "api.md")
        events = self.events()
        self.assertEqual({e["to"]: e["reason"] for e in events},
                         {self.a: "depends,follow", follower: "follow"})
        marker = self.data(self.b)["tasks"][self.kb]["end_event"]
        self.assertEqual(marker["kind"], "finished")
        self.assertIsInstance(marker["at"], float)
        self.hd.flush_outbox(self.w.repo)
        self.assertEqual(self.messages(self.b), [])
        for topic in (self.a, follower):
            notice, = self.messages(topic)
            self.assertEqual((notice["kind"], notice["refs"], notice["from"]["task"]),
                             ("notice", ["api.md"], self.kb))
            for text in ("Second", "Producer", self.kb, "API ready", "api.md", "\u5df2\u5b8c\u6210"):
                self.assertIn(text, notice["text"])
        self.finish(line="Updated conclusion", artifact="updated.md")
        self.assertEqual(self.data(self.b)["tasks"][self.kb]["end_event"], marker)
        self.assertEqual(len(self.messages()), 1)
        self.assertEqual(len(self.messages(follower)), 1)

    def test_finish_retries_after_interruption_before_flush_without_duplicate_notices(self):
        self.depend()
        self.start()
        with mock.patch.object(self.hd, "flush_outbox", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("topic", "finish", "--run", self.w.run_dir,
                            "--line", "Durable", "--artifact", "durable.md")
        self.assertEqual(self.state()["state"], "done")
        self.assertEqual(self.messages(), [])
        event, = self.events()
        self.assertRegex(event["id"], r"^e\d+-[0-9a-f]{4}$")
        self.finish(line="Durable", artifact="durable.md")
        self.assertEqual(self.messages()[0]["event"], event["id"])
        self.assertEqual(self.hd.flush_outbox(self.w.repo), 0)
        self.finish()
        self.assertEqual(len(self.messages()), 1)
        self.assertEqual(self.events(), [])

    def test_abandon_notifies_once_and_allows_dispatch(self):
        self.depend()
        self.start()
        result = self.command("abandon", "--topic", self.b, "--task", self.kb,
                              "--reason", "Scope removed", HC_TERMINAL_ID="t2")
        self.assertEqual(result["ABANDONED"], self.kb)
        task = self.data(self.b)["tasks"][self.kb]
        self.assertEqual(task["end_event"]["kind"], "abandoned")
        self.assertEqual(self.state()["state"], "abandoned")
        notice, = self.messages()
        self.assertIn("Scope removed", notice["text"])
        self.assertIn("\u5df2\u653e\u5f03", notice["text"])
        self.assertIn("REQUEST", self.request())
        self.command("abandon", "--topic", self.b, "--task", self.kb, "--reason", "Different",
                     HC_TERMINAL_ID="t2")
        self.assertEqual(len(self.messages()), 1)
        self.start(self.a, self.ka, self.new_run("dev-after-abandon"))

    def test_abandon_retries_its_outbox_when_the_run_has_disappeared(self):
        self.depend()
        self.start()
        shutil.rmtree(self.w.run_dir)
        with mock.patch.object(self.hd, "flush_outbox", return_value=0):
            self.invoke("topic", "abandon", "--repo", self.w.repo, "--topic", self.b,
                        "--task", self.kb, "--reason", "Run missing", HC_TERMINAL_ID="t2")
        self.assertEqual(self.events()[0]["reason"], "depends")
        self.assertEqual(self.state()["state"], "abandoned")
        self.command("abandon", "--topic", self.b, "--task", self.kb, "--reason", "Retry")
        self.assertEqual(len(self.messages()), 1)
        self.assertEqual(self.events(), [])

    def test_stop_blocks_dependents_until_reopened_and_finished(self):
        self.depend()
        self.start()
        for _ in range(2):
            result = self.w.hd("stop", "--run", self.w.run_dir, "--wait", "0")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.data(self.b)["tasks"][self.kb]["end_event"]["kind"], "stopped")
        self.assertEqual(self.state()["state"], "stopped")
        self.assertEqual(len(self.messages()), 1)
        self.assertIn("\u5df2\u7ec8\u6b62", self.messages()[0]["text"])
        self.assertEqual(self.request(code=3)["FAILURE"], "DEPENDS_PENDING")
        result = self.w.hd("resume", "--run", self.w.run_dir)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNone(self.data(self.b)["tasks"][self.kb]["end_event"])
        self.assertEqual(self.state()["state"], "pending")
        self.finish()
        self.assertEqual(len(self.messages()), 2)
        self.assertEqual(self.state()["state"], "done")
        self.assertIn("REQUEST", self.request())

    def test_retirement_is_stopped_despite_its_finished_timestamp_and_can_reopen(self):
        self.depend()
        self.start()
        with mock.patch.dict(os.environ, self.w.env(HC_TERMINAL_ID="t2")):
            self.hd.retire_run(self.w.run_dir, keep=True)
            self.hd.retire_run(self.w.run_dir, keep=True)
        self.assertIsNotNone(self.hd.read_json(self.w.run_dir / "state.json", {}).get("finished"))
        self.assertEqual(self.state()["state"], "stopped")
        self.assertEqual(self.data(self.b)["tasks"][self.kb]["end_event"]["kind"], "stopped")
        self.assertEqual(len(self.messages()), 1)
        self.assertIn("\u9000\u5f79", self.messages()[0]["text"])
        self.assertEqual(self.request(code=3)["FAILURE"], "DEPENDS_PENDING")
        result = self.w.hd("resume", "--run", self.w.run_dir)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNone(self.data(self.b)["tasks"][self.kb]["end_event"])
        self.finish()
        self.assertEqual(len(self.messages()), 2)
        self.assertEqual(self.state()["state"], "done")

    def test_completion_sources_and_missing_targets_resolve_from_snapshots(self):
        self.assertEqual(self.state()["state"], "pending")
        self.assertEqual(self.state("missing:k1"),
                         {"state": "missing", "topic": "missing", "task": "k1", "title": "", "path": []})
        self.assertEqual(self.state(f"{self.b}:k99")["state"], "missing")
        self.start()
        for changes, run_state, run_control, expected in (
                ({"finished_at": 0}, {}, {"state": "running"}, "done"),
                ({"finished_at": None}, {"finished": 0}, {"state": "running"}, "done"),
                ({}, {}, {"state": "stopped"}, "stopped"),
                ({}, {"finished": 0}, {"state": "running", "retired": {"at": 0}}, "stopped"),
                ({"abandoned_at": 0}, {}, {"state": "stopped"}, "abandoned")):
            with self.subTest(expected=expected, changes=changes):
                self.set_task(self.b, self.kb, **changes)
                self.hd.write_json(self.w.run_dir / "state.json", run_state)
                self.hd.write_json(self.w.run_dir / "control.json", run_control)
                self.assertEqual(self.state()["state"], expected)

    def test_task_removal_notifies_dependents_once_and_missing_dependency_allows_dispatch(self):
        self.depend()
        self.task(self.a, depends=f"{self.b}:{self.kb}")
        self.command("follow", "--topic", self.a, "--target", self.b)
        with mock.patch.object(self.hd, "flush_outbox", return_value=0):
            self.invoke("topic", "task-rm", "--repo", self.w.repo, "--topic", self.b, "--task", self.kb)
        self.assertEqual(self.state()["state"], "missing")
        event, = self.events()
        self.assertEqual(event["reason"], "deleted")
        self.hd.flush_outbox(self.w.repo)
        notice, = self.messages()
        self.assertIn("\u5df2\u5220\u9664", notice["text"])
        self.assertEqual(notice["from"]["task"], self.kb)
        self.assertIn("REQUEST", self.request())
        self.start(self.a, self.ka)
        self.assertEqual(self.messages(self.b), [])

    def test_topic_deletion_keeps_the_outbox_until_notifications_are_flushed(self):
        self.depend()
        self.command("follow", "--topic", self.a, "--target", self.b)
        self.command("archive", "--topic", self.b)
        with mock.patch.object(self.hd, "flush_outbox", return_value=0):
            self.invoke("topic", "delete", "--repo", self.w.repo, "--topic", self.b)
        self.assertFalse(self.topic_path(self.b).exists())
        self.assertEqual(self.state()["state"], "missing")
        event, = self.events()
        self.assertEqual(event["reason"], "deleted")
        self.assertEqual(self.messages(), [])
        self.assertEqual(self.hd.flush_outbox(self.w.repo), 1)
        self.assertEqual(self.hd.flush_outbox(self.w.repo), 0)
        self.assertEqual(len(self.messages()), 1)
        self.assertIn("REQUEST", self.request())

    def test_dependency_diamond_is_not_a_cycle(self):
        left = self.task(self.b, depends=self.kb)
        right = self.task(self.b, depends=self.kb)
        top = self.task(self.b, depends=f"{left},{right}")
        self.assertEqual(self.state(f"{self.b}:{top}")["state"], "pending")
        self.start()
        self.finish()
        self.assertEqual(self.state(f"{self.b}:{top}")["state"], "pending")

    def test_dependency_reads_never_acquire_a_topic_lock(self):
        self.depend()
        task = self.data(self.a)["tasks"][self.ka]
        with self.hd.topic_lock(self.w.repo, self.a), mock.patch.object(
                self.hd, "topic_lock", side_effect=AssertionError("dependency reads acquired a lock")):
            self.assertEqual(self.state()["state"], "pending")
            self.assertEqual(len(self.hd.depends_blockers(self.w.repo, self.a, task)), 1)
            self.hd.validate_task_depends(self.w.repo, self.a, self.ka, self.data(self.a))

    def test_lifecycle_and_dependency_operations_never_hold_distinct_topic_locks(self):
        original = self.hd.topic_lock
        held = []

        @contextlib.contextmanager
        def checked(repo, topic):
            self.assertTrue(not held or all(value == topic for value in held), (held, topic))
            with original(repo, topic):
                held.append(topic)
                try:
                    yield
                finally:
                    held.pop()

        self.start()
        with mock.patch.object(self.hd, "topic_lock", side_effect=checked):
            self.invoke("topic", "task-edit", "--repo", self.w.repo, "--topic", self.a,
                        "--task", self.ka, "--depends", f"{self.b}:{self.kb}")
            self.assertEqual(self.state()["state"], "pending")
            self.invoke("stop", "--run", self.w.run_dir, "--wait", "0")
            self.invoke("resume", "--run", self.w.run_dir)
            self.invoke("topic", "finish", "--run", self.w.run_dir, "--line", "Ready")
            self.invoke("topic", "archive", "--repo", self.w.repo, "--topic", self.b)
            self.invoke("topic", "delete", "--repo", self.w.repo, "--topic", self.b)
        self.assertEqual(held, [])

    def test_simultaneous_cross_topic_finishes_do_not_deadlock_or_duplicate_notices(self):
        other_run = self.new_run("dev-other")
        self.start(self.a, self.ka)
        self.start(self.b, self.kb, other_run)
        self.set_task(self.a, self.ka, depends_on=[f"{self.b}:{self.kb}"])
        self.set_task(self.b, self.kb, depends_on=[f"{self.a}:{self.ka}"])
        gate = self.w.root / "finish-gate"
        script = (
            "import pathlib,sys,time\n"
            "sys.path.insert(0,sys.argv[1])\n"
            "import hd_dispatch as hd\n"
            "while not pathlib.Path(sys.argv[2]).exists(): time.sleep(.005)\n"
            "sys.argv=['hd_dispatch.py',*sys.argv[3:]]\n"
            "hd.main()\n"
        )
        processes = [subprocess.Popen(
            [sys.executable, "-c", script, str(HD.parent), str(gate), "topic", "finish",
             "--run", str(run), "--line", "Ready"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=self.w.env(HC_TERMINAL_ID=terminal))
            for run, terminal in ((self.w.run_dir, "t1"), (other_run, "t2"))]
        gate.touch()
        try:
            for process in processes:
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stdout + stderr)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        self.assertEqual(len(self.messages(self.a)), 1)
        self.assertEqual(len(self.messages(self.b)), 1)
        self.assertEqual(self.events(self.a), [])
        self.assertEqual(self.events(self.b), [])


if __name__ == "__main__":
    unittest.main()
