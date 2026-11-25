"""Topic activation and ownership changes against temporary repos and fake_hc.py."""
import json
import shutil
import unittest

from test_hd_dispatch import Env, module


class TopicActivation(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        self.hd = module()
        result = self.command("topic", "start", "--run", self.w.run_dir, "--title", "Activation")
        self.topic, self.task = result["TOPIC"], result["TASK"]
        self.prompt = self.w.root / "again.md"
        self.prompt.write_text("Continue the task.")

    def command(self, *args, code=0, **env):
        result = self.w.hd(*map(str, args), **env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return self.w.kv(result)

    def topic_data(self, topic=None):
        return self.hd.load_topic(self.w.repo, topic or self.topic)

    def alter_topic(self, **changes):
        with self.hd.topic_lock(self.w.repo, self.topic):
            data = self.topic_data()
            data.update(changes)
            self.hd.save_topic(self.w.repo, self.topic, data)

    def state(self):
        return json.loads((self.w.run_dir / "state.json").read_text())

    def snapshot(self):
        return {str(path.relative_to(self.w.root)): path.read_bytes()
                for root in (self.w.repo / ".cc-dispatch", self.w.home)
                for path in root.rglob("*") if path.is_file()}

    def invoke(self, action, code=0):
        args = [action, "--run", self.w.run_dir]
        if action == "run":
            args += ["--call", "new", "--mode", "write", "--dir", self.w.repo,
                     "--prompt", self.prompt, "--schema", self.w.schema]
        elif action == "send":
            args += ["--call", "a", "--prompt", self.prompt]
        elif action == "handover":
            args += ["--call", "a", "--ask", "0"]
        return self.command(*args, code=code)

    def finish_and_archive(self):
        self.command("topic", "finish", "--run", self.w.run_dir, "--line", "Task completed",
                     "--artifact", "result.md")
        self.alter_topic(archived=123)
        (self.w.run_dir / "archived").write_text("123\n")
        self.assertIsNotNone(self.topic_data()["tasks"][self.task]["finished_at"])
        self.assertIn("finished", self.state())

    def assert_active(self):
        data = self.topic_data()
        task = data["tasks"][self.task]
        self.assertIsNone(data["archived"])
        self.assertIsNone(task["finished_at"])
        self.assertFalse((self.w.run_dir / "archived").exists())
        self.assertNotIn("finished", self.state())
        self.assertEqual((task["summary_line"], task["artifact"]), ("Task completed", "result.md"))
        self.assertEqual((self.state()["topic"], self.state()["task"]), (self.topic, self.task))

    def assert_refused_without_changes(self, action, failure):
        before, hc_before = self.snapshot(), self.w.hc_state()
        self.assertEqual(self.invoke(action, code=3)["FAILURE"], failure)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.w.hc_state(), hc_before)

    def test_all_entries_reject_paused_stopping_deleting_or_taken_topics_without_side_effects(self):
        meta = self.w.dispatch()
        self.command("pause", "--run", self.w.run_dir)
        self.finish_and_archive()
        report = self.w.root / "partial.json"
        report.write_text('{"status": "partial"}')
        shutil.copyfile(report, meta["report"])
        for blocked, failure in (("paused_at", "TOPIC_PAUSED"), ("stopping_at", "TOPIC_STOPPING"),
                                 ("deleting", "TOPIC_DELETING"), ("run", "TASK_TAKEN")):
            with self.hd.topic_lock(self.w.repo, self.topic):
                data = self.topic_data()
                data.update(paused_at=None, stopping_at=None, deleting=None)
                data["tasks"][self.task]["run"] = self.w.run_dir.name
                if blocked == "run":
                    data["tasks"][self.task]["run"] = "dev-other"
                else:
                    data[blocked] = 0
                self.hd.save_topic(self.w.repo, self.topic, data)
            for action in ("run", "send", "handover", "resume"):
                with self.subTest(blocked=blocked, action=action):
                    self.assert_refused_without_changes(action, failure)
        self.assertFalse((self.w.run_dir / "agents" / "new").exists())
        self.assertFalse((self.w.run_dir / "agents" / "a" / "handoff").exists())

    def test_rejected_run_creates_neither_home_nor_call_directory(self):
        self.alter_topic(paused_at=1)
        self.assert_refused_without_changes("run", "TOPIC_PAUSED")
        self.assertFalse(self.w.home.exists())
        self.assertFalse((self.w.run_dir / "agents").exists())

    def test_missing_or_unbound_task_is_taken(self):
        for run in (None, "dev-other"):
            with self.subTest(run=run):
                with self.hd.topic_lock(self.w.repo, self.topic):
                    data = self.topic_data()
                    data["tasks"][self.task]["run"] = run
                    self.hd.save_topic(self.w.repo, self.topic, data)
                self.assert_refused_without_changes("resume", "TASK_TAKEN")
        with self.hd.topic_lock(self.w.repo, self.topic):
            data = self.topic_data()
            del data["tasks"][self.task]
            self.hd.save_topic(self.w.repo, self.topic, data)
        self.assert_refused_without_changes("resume", "TASK_TAKEN")

    def test_deleting_then_paused_take_precedence_over_binding_conflicts(self):
        with self.hd.topic_lock(self.w.repo, self.topic):
            data = self.topic_data()
            data.update(deleting=0, paused_at=0)
            data["tasks"][self.task]["run"] = "dev-other"
            self.hd.save_topic(self.w.repo, self.topic, data)
        self.assert_refused_without_changes("resume", "TOPIC_DELETING")
        self.alter_topic(deleting=None)
        self.assert_refused_without_changes("resume", "TOPIC_PAUSED")

    def test_run_inherits_topic_and_task_and_reopens_finished_task(self):
        self.finish_and_archive()
        self.invoke("run")
        self.assert_active()
        meta = self.w.meta("new")
        self.assertEqual((meta["topic"], meta["task"]), (self.topic, self.task))

    def test_send_reopens_finished_task_in_archived_topic(self):
        self.w.dispatch()
        self.finish_and_archive()
        self.assertEqual(self.invoke("send")["SENT"], "yes")
        self.assert_active()
        self.assertEqual(self.w.meta()["round"], 2)

    def test_handover_reopens_finished_task_in_archived_topic(self):
        self.w.dispatch()
        self.finish_and_archive()
        result = self.invoke("handover")
        self.assertEqual((result["ROUND"], result["FIRST_MESSAGE"]), ("2", "sent"))
        self.assert_active()

    def test_resume_reopens_finished_task_and_resumes_held_helper(self):
        self.w.dispatch()
        self.command("pause", "--run", self.w.run_dir)
        self.finish_and_archive()
        self.assertEqual(self.invoke("resume")["RESUMED"], "a")
        self.assert_active()

    def test_topic_pause_does_not_remove_independent_run_pause(self):
        self.w.dispatch()
        self.command("pause", "--run", self.w.run_dir)
        before = self.hd.control(self.w.run_dir)
        self.alter_topic(paused_at=1)
        self.assert_refused_without_changes("resume", "TOPIC_PAUSED")
        self.alter_topic(paused_at=None)
        self.assertEqual(self.hd.control(self.w.run_dir), before)
        self.assertEqual(before["state"], "paused")
        self.assertEqual(self.invoke("resume")["RESUMED"], "a")

    def test_resume_keeps_handoff_cancellation_and_stopping_refusal(self):
        self.w.dispatch()
        self.command("pause", "--run", self.w.run_dir)
        self.command("handoff", "--run", self.w.run_dir, "--no-notes")
        self.alter_topic(paused_at=1)
        self.assert_refused_without_changes("resume", "TOPIC_PAUSED")
        self.alter_topic(paused_at=None)
        result = self.invoke("resume")
        self.assertEqual((result["HANDOFF"], result["RUN_CONTROL"]), ("cancelled", "paused"))
        self.hd.set_control(self.w.run_dir, state="stopping")
        self.assertEqual(self.invoke("resume", code=3)["RUN_CONTROL"], "stopping")
        self.assertEqual(self.hd.control(self.w.run_dir)["state"], "stopping")

    def test_topic_activation_also_removes_retired_mark(self):
        self.w.dispatch()
        self.finish_and_archive()
        self.hd.set_control(self.w.run_dir, state="running", retired={"at": self.state()["finished"]})
        self.invoke("send")
        self.assert_active()
        self.assertNotIn("retired", self.hd.control(self.w.run_dir))

    def test_legacy_run_has_no_topic_meta_and_keeps_ordinary_finished_state(self):
        (self.w.run_dir / "state.json").write_text('{"finished": 42, "phase": "done"}')
        meta = self.w.dispatch()
        self.assertIsNone(meta.get("topic"))
        self.assertIsNone(meta.get("task"))
        (self.w.run_dir / "archived").write_text("1\n")
        self.invoke("send")
        self.assertFalse((self.w.run_dir / "archived").exists())
        self.assertEqual(self.state(), {"finished": 42, "phase": "done"})

    def test_legacy_send_undoes_retirement_even_when_terminal_is_closed(self):
        (self.w.run_dir / "state.json").write_text('{"phase": "done"}')
        self.w.dispatch()
        self.command("retire", "--run", self.w.run_dir, "--force")
        self.assertTrue((self.w.run_dir / "archived").exists())
        self.invoke("send", code=2)
        self.assertFalse((self.w.run_dir / "archived").exists())
        self.assertNotIn("retired", self.hd.control(self.w.run_dir))
        self.assertEqual(self.state(), {"phase": "done"})

    def check_owner_transfer(self, action, gone=False, owned=True):
        self.w.dispatch()
        unrelated = self.command("topic", "init", "--repo", self.w.repo, "--title", "Unrelated")["TOPIC"]
        unrelated_before = self.topic_data(unrelated)
        if not owned:
            owner = dict(self.topic_data()["owner"], terminal="t9")
            self.alter_topic(owner=owner)
        before = self.topic_data()
        self.w.set_terminals({"next": {"address": "t2", "status": "working", "argv": ["codex"],
                                       "cwd": "/next main", "labels": {"herdr.space": "s2"}}})
        args = [action, "--run", self.w.run_dir]
        if action == "adopt":
            package = self.command("handoff", "--run", self.w.run_dir, "--no-notes")["HANDOFF"]
            args += ["--from", package]
        elif not gone:
            args += ["--force"]
        if gone:
            hc_state = self.w.hc_state()
            del hc_state["terminals"]["parent"]
            self.w.state.write_text(json.dumps(hc_state))
        self.command(*args, HC_TERMINAL_ID="t2", CODEX_THREAD_ID="next-session")
        after = self.topic_data()
        expected = {"terminal": "t2", "agent": "codex", "session": "next-session",
                    "space": "s2", "cwd": "/next main"}
        self.assertEqual(after["owner"], expected if owned else before["owner"])
        self.assertEqual({**after, "owner": before["owner"]}, before)
        self.assertEqual(self.topic_data(unrelated), unrelated_before)
        self.assertEqual(self.hd.control(self.w.run_dir)["owner"], "t2")
        self.assertEqual(self.w.meta()["parent"], "t2")

    def test_adopt_transfers_topic_owner_while_predecessor_is_live(self):
        self.check_owner_transfer("adopt")

    def test_takeover_transfers_topic_owner_after_predecessor_disappears(self):
        self.check_owner_transfer("takeover", gone=True)

    def test_forced_takeover_transfers_topic_owner_while_predecessor_is_live(self):
        self.check_owner_transfer("takeover")

    def test_adopt_preserves_topic_owned_by_another_terminal(self):
        self.check_owner_transfer("adopt", owned=False)

    def test_takeover_preserves_topic_owned_by_another_terminal(self):
        self.check_owner_transfer("takeover", gone=True, owned=False)


if __name__ == "__main__":
    unittest.main()
