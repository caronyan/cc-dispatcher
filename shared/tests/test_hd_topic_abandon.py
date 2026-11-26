"""Topic abandonment uses temporary repositories and fake_hc.py; no live terminals are touched."""
import json
import shutil
import time
import unittest
from pathlib import Path

from test_hd_dispatch import Env, module


class TopicAbandon(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        self.hd = module()
        self.topic = self.command("init", "--title", "Topic")["TOPIC"]
        self.task = self.add_task()
        self.folder = self.w.repo / ".cc-dispatch" / "topics" / self.topic

    def command(self, name, *args, code=0, **env):
        result = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args), **env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return self.w.kv(result)

    def add_task(self, title="Task"):
        return self.command("task-add", "--topic", self.topic, "--title", title, "--kind", "dev")["TASK"]

    def bind(self):
        self.command("start", "--run", self.w.run_dir, "--topic", self.topic, "--task", self.task)

    def data(self):
        return json.loads((self.folder / "topic.json").read_text())

    def alter(self, **changes):
        data = self.data()
        data.update(changes)
        self.hd.save_topic(self.w.repo, self.topic, data)

    def abandon(self, reason="No one will continue", *args, code=0, **env):
        return self.command("abandon", "--topic", self.topic, "--task", self.task,
                            "--reason", reason, *args, code=code, **env)

    def snapshot(self, folder):
        return {str(path.relative_to(folder)): path.read_bytes()
                for path in folder.rglob("*") if path.is_file()}

    def test_missing_run_records_reason_and_unblocks_delivery_stop_archive_and_delete(self):
        self.bind()
        shutil.rmtree(self.w.run_dir)
        queued = self.add_task("Next task")
        request = self.command("request", "--topic", self.topic, "--task", queued)
        self.w.patch("parent", status="idle", screen="previous output\n\u276f ")
        self.assertTrue(self.hd.topic_owner_busy(self.w.repo, "t1"))
        self.assertEqual(self.command("deliver")["DELIVERED"], "")
        before = time.time()
        self.assertEqual(self.abandon(), {"ABANDONED": self.task, "RUN": "-", "CLOSED": "-"})
        task = self.data()["tasks"][self.task]
        self.assertGreaterEqual(task["abandoned_at"], before)
        self.assertLessEqual(task["abandoned_at"], time.time())
        self.assertEqual(task["abandon_reason"], "No one will continue")
        self.assertIsNone(task["finished_at"])
        self.assertEqual(task["run"], self.w.run_dir.name)
        self.assertFalse(self.w.run_dir.exists())
        self.assertEqual((self.folder / "summary.md").read_text(),
                         f"## {self.task} Task\uff08dev\uff09\n\u5df2\u653e\u5f03\uff1aNo one will continue\n\n")
        self.assertTrue(self.hd.topic_task_done(task, self.w.run_dir))
        # Abandoning frees the owner, so the queued request is handed over right away.
        self.assertIsNotNone(self.data()["tasks"][queued]["request"]["delivered_at"])
        self.assertEqual(self.command("deliver")["DELIVERED"], "")
        self.assertEqual(self.command("stop", "--topic", self.topic)["STOPPED"], "")
        self.assertEqual(self.command("archive", "--topic", self.topic)["ARCHIVED"], self.topic)
        self.assertEqual(self.command("delete", "--topic", self.topic)["DELETED"], self.topic)
        self.assertFalse(self.folder.exists())

    def test_existing_run_closes_idle_helpers_preserves_reports_and_keeps_directory(self):
        self.bind()
        metas = [self.w.dispatch(call) for call in ("a", "b")]
        for meta in metas:
            self.w.patch(meta["name"], status="done", turn=1)
            Path(meta["report"]).write_text('{"status": "partial"}')
        result = self.abandon()
        self.assertEqual(result, {"ABANDONED": self.task, "RUN": self.w.run_dir.name, "CLOSED": "a,b"})
        self.assertTrue(self.w.run_dir.is_dir())
        self.assertFalse((self.w.run_dir / "archived").exists())
        control = self.hd.control(self.w.run_dir)
        state = self.hd.read_json(self.w.run_dir / "state.json", {})
        self.assertEqual(control["state"], "running")
        self.assertEqual(control["retired"]["from"], "running")
        self.assertEqual(state["finished"], control["retired"]["at"])
        self.assertEqual((state["topic"], state["task"]), (self.topic, self.task))
        self.assertIsNone(self.data()["tasks"][self.task]["finished_at"])
        for meta in metas:
            self.assertEqual(Path(meta["report"]).read_text(), '{"status": "partial"}')
            self.assertFalse(self.w.meta(meta["call"])["open"])
            self.assertEqual(self.w.events(meta["call"])[-1]["ev"], "cleanup")
            self.assertEqual(self.w.events(meta["call"])[-1]["why"], "retire")
            self.assertNotIn(meta["name"], self.w.hc_state()["terminals"])
        topic_before = self.snapshot(self.folder)
        run_before = self.snapshot(self.w.run_dir)
        hc_before = self.w.hc_state()
        self.assertEqual(self.abandon("Another reason")["CLOSED"], "-")
        self.assertEqual(self.snapshot(self.folder), topic_before)
        self.assertEqual(self.snapshot(self.w.run_dir), run_before)
        self.assertEqual(self.w.hc_state(), hc_before)

    def test_working_helper_refuses_without_changes_and_force_closes_it(self):
        self.bind()
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="working")
        topic_before = self.snapshot(self.folder)
        run_before = self.snapshot(self.w.run_dir)
        self.assertEqual(self.abandon(code=3)["FAILURE"], "HELPERS_AT_WORK")
        self.assertEqual(self.snapshot(self.folder), topic_before)
        self.assertEqual(self.snapshot(self.w.run_dir), run_before)
        self.assertIn(meta["name"], self.w.hc_state()["terminals"])
        self.assertEqual(self.abandon("User requested", "--force")["CLOSED"], "a")
        self.assertFalse(self.w.meta()["open"])
        self.assertIn("retired", self.hd.control(self.w.run_dir))
        self.assertFalse((self.w.run_dir / "archived").exists())

    def test_another_live_main_refuses_and_force_can_override(self):
        self.bind()
        self.hd.set_control(self.w.run_dir, state="running", owner="t1")
        self.alter(owner=dict(self.data()["owner"], terminal="t9"))
        topic_before = self.snapshot(self.folder)
        run_before = self.snapshot(self.w.run_dir)
        self.assertEqual(self.abandon(code=3, HC_TERMINAL_ID="t9")["FAILURE"], "MAIN_LIVE")
        self.assertEqual(self.snapshot(self.folder), topic_before)
        self.assertEqual(self.snapshot(self.w.run_dir), run_before)
        self.assertEqual(self.abandon("User requested", "--force", HC_TERMINAL_ID="t9")["ABANDONED"],
                         self.task)
        retired = self.hd.control(self.w.run_dir)["retired"]
        self.assertEqual(retired["by"], "t9")
        self.assertFalse((self.w.run_dir / "archived").exists())

    def test_main_is_checked_from_helper_parent_without_control_owner(self):
        self.bind()
        self.hd.write_json(self.w.run_dir / "control.json", {"state": "running"})
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="done")
        self.alter(owner=dict(self.data()["owner"], terminal="t9"))
        self.assertEqual(self.abandon(code=3, HC_TERMINAL_ID="t9")["FAILURE"], "MAIN_LIVE")
        self.assertEqual(self.abandon()["ABANDONED"], self.task)

    def test_whitespace_reason_refuses_without_changes(self):
        self.bind()
        before = self.snapshot(self.folder)
        run_before = self.snapshot(self.w.run_dir)
        for reason in ("", " \t\r\n ", "\u3000"):
            with self.subTest(reason=reason):
                self.assertEqual(self.abandon(reason, "--force", code=3)["FAILURE"], "REASON_REQUIRED")
                self.assertEqual(self.snapshot(self.folder), before)
                self.assertEqual(self.snapshot(self.w.run_dir), run_before)

    def test_draft_task_refuses_even_with_force(self):
        before = self.snapshot(self.folder)
        self.assertEqual(self.abandon("User requested", "--force", code=3)["FAILURE"], "TASK_NOT_BOUND")
        self.assertEqual(self.snapshot(self.folder), before)

    def test_normally_finished_task_refuses_even_if_run_disappeared(self):
        self.bind()
        self.command("finish", "--run", self.w.run_dir, "--line", "Completed normally")
        shutil.rmtree(self.w.run_dir)
        before = self.snapshot(self.folder)
        self.assertEqual(self.abandon("User requested", "--force", code=3)["FAILURE"], "TASK_DONE")
        self.assertEqual(self.snapshot(self.folder), before)

    def test_existing_completion_sources_refuse_even_with_force(self):
        self.bind()
        for source in ("task", "state", "stopped", "retired"):
            with self.subTest(source=source):
                data = self.data()
                data["tasks"][self.task]["finished_at"] = 0 if source == "task" else None
                self.hd.save_topic(self.w.repo, self.topic, data)
                state = {"topic": self.topic, "task": self.task}
                if source == "state":
                    state["finished"] = 0
                self.hd.write_json(self.w.run_dir / "state.json", state)
                self.hd.set_control(self.w.run_dir, state="stopped" if source == "stopped" else "running",
                                    **({"retired": {"at": 0}} if source == "retired" else {}))
                before = self.snapshot(self.folder)
                run_before = self.snapshot(self.w.run_dir)
                self.assertEqual(self.abandon("User requested", "--force", code=3)["FAILURE"], "TASK_DONE")
                self.assertEqual(self.snapshot(self.folder), before)
                self.assertEqual(self.snapshot(self.w.run_dir), run_before)

    def test_missing_run_repeat_preserves_original_reason_timestamp_and_summary(self):
        self.bind()
        shutil.rmtree(self.w.run_dir)
        reason = "\u7528\u6237\u660e\u786e\u653e\u5f03\n\u4fdd\u7559\u8bb0\u5f55"
        self.abandon(reason)
        before = self.snapshot(self.folder)
        self.assertEqual(self.abandon("A different reason", "--force"),
                         {"ABANDONED": self.task, "RUN": "-", "CLOSED": "-"})
        self.assertEqual(self.snapshot(self.folder), before)
        self.assertEqual(self.data()["tasks"][self.task]["abandon_reason"], reason)

    def test_deleting_topic_refuses_without_changes(self):
        self.bind()
        self.alter(deleting=0)
        before = self.snapshot(self.folder)
        run_before = self.snapshot(self.w.run_dir)
        self.assertEqual(self.abandon("User requested", "--force", code=3)["FAILURE"], "TOPIC_DELETING")
        self.assertEqual(self.snapshot(self.folder), before)
        self.assertEqual(self.snapshot(self.w.run_dir), run_before)

    def test_paused_and_stopping_topics_allow_abandon_without_resuming_the_topic(self):
        self.bind()
        for field in ("paused_at", "stopping_at"):
            with self.subTest(field=field):
                if field == "stopping_at":
                    self.task = self.add_task()
                    self.w.run_dir = self.w.run_dir.parent / "dev-stopping-topic"
                    self.w.run_dir.mkdir()
                    self.bind()
                self.alter(**{field: 0})
                self.hd.set_control(self.w.run_dir, state="paused", held=[])
                self.assertEqual(self.abandon()["ABANDONED"], self.task)
                self.assertEqual(self.data()[field], 0)
                control = self.hd.control(self.w.run_dir)
                self.assertEqual(control["state"], "running")
                self.assertEqual(control["retired"]["from"], "paused")
                self.assertFalse((self.w.run_dir / "archived").exists())
                self.alter(**{field: None})

    def test_handoff_retirement_preserves_package_and_does_not_require_previous_main(self):
        self.bind()
        self.hd.set_control(self.w.run_dir, state="handoff", owner="t1",
                            package=str(self.w.run_dir / "handoff" / "1"),
                            prev={"state": "paused", "held": ["a"]})
        self.assertEqual(self.abandon(HC_TERMINAL_ID="")["ABANDONED"], self.task)
        control = self.hd.control(self.w.run_dir)
        self.assertEqual(control["state"], "running")
        self.assertEqual(control["retired"]["from"], "handoff")
        self.assertEqual(control["retired"]["package"], str(self.w.run_dir / "handoff" / "1"))

    def test_abandoned_tasks_do_not_block_archive_on_their_unanswered_items(self):
        self.bind()
        self.hd.write_json(self.w.run_dir / "asks.json", {"choice": {"title": "Choose", "asked": 10}})
        state = self.hd.read_json(self.w.run_dir / "state.json", {})
        state.update(tasks={"card": {"status": "parked", "note": "user"}},
                     pending_decisions={"other": "Choose"})
        self.hd.write_json(self.w.run_dir / "state.json", state)
        self.abandon()
        self.assertEqual(self.command("archive", "--topic", self.topic)["ARCHIVED"], self.topic)
        self.assertTrue(self.w.run_dir.is_dir())
        self.assertTrue((self.w.run_dir / "asks.json").exists())
        self.assertEqual(self.command("delete", "--topic", self.topic)["DELETED"], self.topic)
        self.assertFalse(self.w.run_dir.exists())

    def test_missing_topic_and_task_report_existing_failure_codes(self):
        self.assertEqual(self.command("abandon", "--topic", "missing", "--task", self.task,
                                      "--reason", "User requested", code=3)["FAILURE"], "TOPIC_NOT_FOUND")
        self.assertEqual(self.command("abandon", "--topic", self.topic, "--task", "k999",
                                      "--reason", "User requested", code=3)["FAILURE"], "TASK_NOT_FOUND")

    def test_abandoned_at_zero_is_done_even_without_a_run(self):
        self.assertTrue(self.hd.topic_task_done({"abandoned_at": 0}, self.w.run_dir / "missing"))


if __name__ == "__main__":
    unittest.main()
