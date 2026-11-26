"""Topic writes and approvals use temporary repositories and fake hc terminals."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

from test_hd_dispatch import Env, HD, module


WRITES = {
    "task-add": ("--title", "New", "--kind", "dev"),
    "task-edit": ("--task", "k1", "--title", "Changed"),
    "task-rm": ("--task", "k1"),
    "backlog-add": ("--text", "New"),
    "backlog-edit": ("--item", "b1", "--text", "Changed"),
    "backlog-rm": ("--item", "b1"),
    "request": ("--task", "k1"),
    "abandon": ("--task", "k2", "--reason", "Removed"),
    "pause": (), "resume": (), "stop": (), "archive": (), "unarchive": (), "delete": (),
}


class TopicApprovals(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        self.w.set_terminals({
            "owner": {"address": "t2", "status": "working", "app": "codex", "argv": ["codex"]},
            "controller": {"address": "t3", "status": "working", "app": "codex", "argv": ["codex"]},
            "helper": {"address": "t4", "status": "working", "app": "codex", "argv": ["codex"]},
        })
        self.source, self.target = "source", "target"
        for topic, terminal in ((self.source, "t1"), (self.target, "t2")):
            data = self.hd.new_topic_data(topic, topic, {"terminal": terminal, "agent": "codex"})
            self.hd.add_topic_task(data, "Draft", "dev")
            self.hd.save_topic(self.w.repo, topic, data)
            self.hd.save_backlog(self.w.repo, topic, {
                "next_item": 2, "items": [{"id": "b1", "text": "Backlog", "status": "open",
                                         "request": None, "task_ids": []}]})
        data = self.data()
        self.hd.add_topic_task(data, "Running", "dev")
        data["tasks"]["k2"]["run"] = self.w.run_dir.name
        self.hd.save_topic(self.w.repo, self.target, data)
        self.hd.write_json(self.w.run_dir / "control.json", {"state": "running", "owner": "t3"})

    def invoke(self, name, *args, terminal="t1", code=0):
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.w.env(HC_TERMINAL_ID=terminal)), mock.patch.object(
                sys, "argv", [str(HD), "topic", name, "--repo", str(self.w.repo), *map(str, args)]):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    self.hd.main()
                    actual = 0
                except SystemExit as e:
                    actual = e.code
        self.assertEqual(actual, code, output.getvalue())
        text = output.getvalue()
        return dict(line.split("=", 1) for line in text.splitlines()
                    if "=" in line and line.split("=", 1)[0].isupper()), text

    def data(self):
        return self.hd.read_json(self.hd.topic_dir(self.w.repo, self.target) / "topic.json", {})

    def snapshot(self):
        folder = self.hd.topic_dir(self.w.repo, self.target)
        return {str(path.relative_to(folder)): path.read_bytes()
                for path in folder.rglob("*") if path.is_file()}

    def approvals(self):
        return self.hd.load_approvals(self.w.repo, self.target)

    def request(self, op="task-add", args=None, terminal="t1", source=None, code=0, run=None):
        if args is None:
            args = {"title": "Requested", "kind": "dev"}
        identity = ("--run", run) if run else ("--from-topic", source or self.source)
        return self.invoke("approval-request", "--topic", self.target, *identity,
                           "--op", op, "--args", json.dumps(args), "--reason", "需要更新",
                           terminal=terminal, code=code)[0]

    def decide(self, aid="a1", decision="approve", note=None, terminal="", code=0):
        return self.invoke("approval-decide", "--topic", self.target, "--id", aid,
                           "--decision", decision, *(("--note", note) if note is not None else ()),
                           terminal=terminal, code=code)

    def notices(self):
        return self.hd.load_messages(self.w.repo, self.source)["items"]

    def terminal_request(self, op="resume", args=None, terminal="t4", code=0):
        return self.invoke("approval-request", "--topic", self.target, "--op", op,
                           "--args", json.dumps(args or {}), "--reason", "终端申请",
                           terminal=terminal, code=code)[0]

    def test_terminal_requests_deduplicate_by_terminal_without_a_source_topic(self):
        first = self.terminal_request()
        self.assertEqual(first["APPROVAL"], "target:a1")
        self.assertEqual(self.approvals()["items"][0]["from"],
                         {"topic": None, "task": None, "run": None, "terminal": "t4", "agent": "codex"})
        with mock.patch.object(self.hd, "hc_json", return_value=None):
            self.assertEqual(self.terminal_request(), {**first, "APPROVAL_EXISTS": "1"})
        self.assertEqual(self.terminal_request(terminal="t3")["APPROVAL"], "target:a2")
        source = self.hd.read_json(self.hd.topic_dir(self.w.repo, self.source) / "topic.json", {})
        source["owner"]["terminal"] = "t4"
        self.hd.save_topic(self.w.repo, self.source, source)
        self.assertEqual(self.request("resume", {}, terminal="t4")["APPROVAL"], "target:a3")
        self.assertEqual(self.invoke("deliver")[0]["APPROVALS_OPEN"], "3")
        self.assertEqual(sorted(path.parent.name for path in
                                (self.w.repo / ".cc-dispatch/topics").glob("*/topic.json")),
                         ["source", "target"])

    def test_approval_arguments_with_nul_are_rejected_on_request(self):
        before = self.snapshot()
        result = self.terminal_request("backlog-edit", {"item": "b1\0", "text": "Changed"}, code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_INVALID")
        self.assertEqual(self.snapshot(), before)

    def test_overlong_approval_results_are_truncated_before_terminal_delivery(self):
        self.terminal_request("backlog-edit", {"item": "b" + "9" * 20000, "text": "Changed"})
        self.decide()
        events = self.hd.read_json(self.hd.MSG_DIR(self.w.repo) / f"{self.target}.outbox.json",
                                   {"events": []})["events"]
        text = events[0]["text"]
        self.assertLess(len(text), self.hd.APPROVAL_NOTICE_LIMIT + 100)
        self.assertIn("内容过长已截断", text)

    def queue_terminal_notice(self, terminal, aid, text="结果"):
        event = {"id": f"e-approval-target-{aid}", "at": 1, "op": "notice", "to": None,
                 "from": {"topic": "target"}, "text": text, "refs": [], "reason": "approval",
                 "user_seen": True, "terminal": terminal, "agent": "codex", "delivered_at": None}
        with self.hd.topic_lock(self.w.repo, "target"):
            self.hd.outbox_add(self.w.repo, "target", [event])
        return self.hd.MSG_DIR(self.w.repo) / "target.outbox.json"

    def deliver_terminal_round(self):
        with mock.patch.dict(os.environ, self.w.env(HC_TERMINAL_ID="")):
            return self.hd.deliver_topics(self.w.repo, report=False)[1]

    def test_a_damaged_outbox_holds_back_only_its_own_terminal_notices(self):
        self.w.patch("helper", status="idle")
        good = self.queue_terminal_notice("t4", "a1")
        (self.hd.MSG_DIR(self.w.repo) / "aaa.outbox.json").write_bytes(b'{"events":[{"text":"\xf0\x9f"}]}')
        self.assertEqual(self.deliver_terminal_round(), ["terminal:t4"])
        self.assertIsNotNone(json.loads(good.read_text())["events"][0]["delivered_at"])

    def test_a_notice_that_cannot_be_sent_does_not_block_later_notices(self):
        self.w.patch("helper", status="idle")
        self.w.patch("controller", status="idle")
        path = self.queue_terminal_notice("t4", "a1", "无法发送")
        self.queue_terminal_notice("t3", "a2", "正常结果")
        real = self.hd.send_terminal_text

        def send(terminal, info, text):
            if text == "无法发送":
                raise OSError(7, "Argument list too long")
            return real(terminal, info, text)
        with mock.patch.object(self.hd, "send_terminal_text", side_effect=send):
            self.assertEqual(self.deliver_terminal_round(), ["terminal:t3"])
        events = json.loads(path.read_text())["events"]
        self.assertIsNone(events[0]["delivered_at"])
        self.assertIsNotNone(events[1]["delivered_at"])

    def test_approval_arguments_must_be_encodable_text(self):
        before = self.snapshot()
        result = self.terminal_request("backlog-edit", {"item": "b1\ud800", "text": "Changed"}, code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_INVALID")
        self.assertEqual(self.snapshot(), before)
        with mock.patch.object(self.hd.subprocess, "run") as run:
            self.hd.hc("send", "t4", "旧结果\ud800")
        self.assertEqual(run.call_args.args[0], ["hc", "send", "t4", "旧结果?"])

    def test_terminal_commands_never_pass_nul_to_a_process(self):
        with mock.patch.object(self.hd.subprocess, "run") as run:
            self.hd.hc("send", "t4", "结果\0文本")
        self.assertEqual(run.call_args.args[0], ["hc", "send", "t4", "结果文本"])

    def test_users_still_need_a_source_for_approval_requests_and_withdrawal(self):
        before = self.snapshot()
        self.assertEqual(self.terminal_request(terminal="", code=3)["FAILURE"], "NO_TOPIC")
        result, _ = self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                terminal="", code=3)
        self.assertEqual(result["FAILURE"], "NO_TOPIC")
        self.assertEqual(self.snapshot(), before)

    def test_terminal_withdrawal_requires_the_same_terminal_and_identity_mode(self):
        self.terminal_request()
        before = self.snapshot()
        for terminal, flags in (("t3", ()), ("t1", ("--from-topic", self.source))):
            with self.subTest(terminal=terminal):
                result, _ = self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                        *flags, terminal=terminal, code=3)
                self.assertEqual(result["FAILURE"], "NOT_OWNER")
                self.assertEqual(self.snapshot(), before)
        source = self.hd.read_json(self.hd.topic_dir(self.w.repo, self.source) / "topic.json", {})
        source["owner"]["terminal"] = "t4"
        self.hd.save_topic(self.w.repo, self.source, source)
        result, _ = self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                "--from-topic", self.source, terminal="t4", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        self.assertEqual(self.snapshot(), before)
        self.w.patch("helper", status="idle")
        self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1", terminal="t4")
        self.assertEqual(self.approvals()["items"][0]["state"], "withdrawn")
        self.assertIn("已撤回", self.w.hc_state()["terminals"]["helper"]["sent"][0])
        self.assertEqual(list(self.hd.message_files(self.w.repo)), [])
        self.assertEqual(self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                     terminal="t4", code=3)[0]["FAILURE"], "APPROVAL_CLOSED")

    def test_terminal_decisions_deliver_complete_results_without_topic_mailboxes(self):
        self.w.patch("helper", status="idle")
        for index, (decision, op, args, expected) in enumerate((
                ("approve", "resume", {}, "approved"),
                ("approve", "task-edit", {"task": "k999", "title": "No"}, "failed"),
                ("reject", "pause", {}, "rejected"),
                ("answer", "resume", {}, "answered")), 1):
            with self.subTest(state=expected):
                self.terminal_request(op, args)
                self.assertEqual(self.decide(f"a{index}", decision, note="附言")[0]["STATE"], expected)
                self.invoke("deliver")
                sent = self.w.hc_state()["terminals"]["helper"]["sent"]
                self.assertEqual(len(sent), index)
                self.assertIn(f"target:a{index}", sent[-1])
                self.assertIn("终端申请", sent[-1])
                self.assertIn("附言", sent[-1])
                if expected == "failed":
                    self.assertIn("FAILURE=TASK_NOT_FOUND", sent[-1])
                self.assertEqual(list(self.hd.message_files(self.w.repo)), [])
        calls = [call for call in self.w.hc_state()["calls"] if call[0] == "send"]
        self.assertTrue(all(call[-3:] == ["--if", "idle", "--json"] for call in calls))

    def test_terminal_results_wait_for_matching_idle_agent_and_retry_failed_sends(self):
        self.terminal_request()
        self.decide(decision="reject")
        for changes in ({"status": "working"}, {"status": "idle", "state": "finished"},
                        {"status": "idle", "state": "live", "app": "claude-code", "argv": ["claude"]},
                        {"status": "idle", "app": "codex", "argv": ["codex"], "refuse": True}):
            with self.subTest(changes=changes):
                self.w.patch("helper", **changes)
                self.assertEqual(self.invoke("deliver")[0]["MESSAGE_DELIVERED"], "")
                self.assertFalse(self.w.hc_state()["terminals"]["helper"].get("sent"))
        self.w.patch("helper", status="done", refuse=False)
        self.assertTrue(self.invoke("deliver")[0]["MESSAGE_DELIVERED"])
        self.assertEqual(len(self.w.hc_state()["terminals"]["helper"]["sent"]), 1)
        self.assertNotIn("--if", self.w.hc_state()["calls"][-1])
        self.assertEqual(self.invoke("deliver")[0]["MESSAGE_DELIVERED"], "")

    def test_terminal_results_respect_claude_drafts(self):
        self.terminal_request(terminal="t1")
        self.decide(decision="reject")
        self.w.patch("parent", status="idle", screen="❯ unfinished")
        self.assertEqual(self.invoke("deliver")[0]["MESSAGE_DELIVERED"], "")
        self.w.patch("parent", screen="❯ ")
        self.assertTrue(self.invoke("deliver")[0]["MESSAGE_DELIVERED"])
        self.assertIn("已驳回", self.w.hc_state()["terminals"]["parent"]["sent"][0])

    def test_terminal_result_receipts_prevent_replay_after_decision_recovery(self):
        self.terminal_request()
        real = self.hd.outbox_add

        def interrupt(*args):
            real(*args)
            raise KeyboardInterrupt()

        with mock.patch.object(self.hd, "outbox_add", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide()
        self.w.patch("helper", status="idle")
        self.invoke("deliver")
        # Replaying the same durable receipt must not send a second terminal result.
        path = self.hd.approval_journal_path(self.w.repo, self.target)
        journal = self.hd.read_json(path, {})
        journal["a1"]["pending"] = True
        self.hd.write_json(path, journal)
        self.invoke("deliver")
        self.assertEqual(len(self.w.hc_state()["terminals"]["helper"]["sent"]), 1)
        self.assertEqual(list(self.hd.message_files(self.w.repo)), [])

    def test_terminal_results_survive_deletion_of_the_target_topic(self):
        self.terminal_request()
        self.make_archivable()
        self.invoke("archive", "--topic", self.target, terminal="")
        self.invoke("delete", "--topic", self.target, terminal="")
        self.invoke("archive", "--topic", self.source, terminal="")
        self.invoke("delete", "--topic", self.source, terminal="")
        self.w.patch("helper", status="idle")
        self.assertTrue(self.invoke("deliver")[0]["MESSAGE_DELIVERED"])
        self.assertIn("已撤回", self.w.hc_state()["terminals"]["helper"]["sent"][0])
        self.assertEqual(list(self.hd.message_files(self.w.repo)), [])

    def test_terminal_results_can_deliver_after_request_metadata_recovers(self):
        with mock.patch.object(self.hd, "hc_json", return_value=None):
            self.terminal_request()
        self.assertIsNone(self.approvals()["items"][0]["from"]["agent"])
        self.decide(decision="reject")
        self.w.patch("helper", status="idle")
        self.assertTrue(self.invoke("deliver")[0]["MESSAGE_DELIVERED"])
        self.assertIn("已驳回", self.w.hc_state()["terminals"]["helper"]["sent"][0])

    def test_approval_results_are_user_seen_but_remain_unacked_for_the_agent(self):
        for index, (decision, op, args) in enumerate((
                ("approve", "task-add", {"title": "New", "kind": "dev"}),
                ("approve", "task-edit", {"task": "k999", "title": "No"}),
                ("reject", "pause", {}), ("answer", "resume", {}), ("withdraw", "resume", {})), 1):
            with self.subTest(decision=decision):
                self.request(op, args)
                if decision == "withdraw":
                    self.invoke("approval-withdraw", "--topic", self.target, "--id", f"a{index}",
                                "--from-topic", self.source)
                else:
                    self.decide(f"a{index}", decision, note="附言")
                notice = self.notices()[-1]
                self.assertIs(notice.get("user_seen"), True)
                self.assertIsNone(notice["acked_at"])
        summary = self.hd.read_json(self.hd.MSG_DIR(self.w.repo) / f"{self.source}.summary.json", {})
        self.assertEqual(summary["unacked"], 0)
        result, _ = self.invoke("inbox", "--topic", self.source)
        self.assertEqual(result["INBOX"], "5")
        source = self.hd.read_json(self.hd.topic_dir(self.w.repo, self.source) / "topic.json", {})
        source["owner"]["agent"] = "claude"
        self.hd.save_topic(self.w.repo, self.source, source)
        self.w.patch("parent", status="idle", screen="❯ ")
        self.invoke("deliver")
        self.assertTrue(all(item["delivered"]["terminal"] == "t1" for item in self.notices()))
        source["tasks"]["k1"]["run"] = self.w.run_dir.name
        self.hd.save_topic(self.w.repo, self.source, source)
        target = self.data()
        target["tasks"]["k2"]["run"] = None
        self.hd.save_topic(self.w.repo, self.target, target)
        self.hd.write_json(self.w.run_dir / "control.json", {"state": "running", "owner": "t1"})
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.w.env()), contextlib.redirect_stdout(output):
            self.hd.messages_check(self.w.run_dir)
        ids = [item["id"] for item in self.notices()]
        self.assertIn("MESSAGES_UNACKED=" + ",".join(ids), output.getvalue())
        self.assertEqual(self.invoke("msg-ack", "--topic", self.source, "--ids", ",".join(ids))[0]["ACKED"],
                         ",".join(ids))
        self.assertEqual(self.invoke("inbox", "--topic", self.source)[0]["INBOX"], "0")

    def test_panel_unread_summary_uses_the_user_seen_field_not_an_event_prefix(self):
        ordinary = self.hd.new_message(self.source, {"topic": self.target}, "notice", "Ordinary", [],
                                       event="e-approval-looks-special")
        known = self.hd.new_message(self.source, {"topic": self.target}, "notice", "Known", [])
        known["user_seen"] = True
        self.hd.save_messages(self.w.repo, self.source, {"version": 0, "items": [ordinary, known]})
        summary = self.hd.read_json(self.hd.MSG_DIR(self.w.repo) / f"{self.source}.summary.json", {})
        self.assertEqual(summary["unacked"], 1)
        self.assertEqual(self.invoke("inbox", "--topic", self.source)[0]["INBOX"], "2")

    def test_every_writer_command_rejects_other_topics_and_helpers_without_changes(self):
        before = self.snapshot()
        for terminal in ("t1", "t4"):
            for name, args in WRITES.items():
                with self.subTest(terminal=terminal, command=name):
                    result, output = self.invoke(name, "--topic", self.target, *args,
                                                 terminal=terminal, code=3)
                    self.assertEqual(result["FAILURE"], "NOT_OWNER")
                    self.assertIn("topic approval-request", output)
                    self.assertEqual(self.snapshot(), before)

    def test_every_writer_command_dispatches_for_user_owner_and_active_controller(self):
        for terminal in ("", "t2", "t3"):
            for name, args in WRITES.items():
                with self.subTest(terminal=terminal, command=name):
                    handler = ("task" if name.startswith("task-") else
                               "backlog" if name.startswith("backlog-") else name)
                    with mock.patch.object(self.hd, "cmd_topic_" + handler) as called:
                        self.invoke(name, "--topic", self.target, *args, terminal=terminal)
                        called.assert_called_once()

    def test_every_writer_command_rejects_controller_after_any_completion_source(self):
        data = self.data()
        task = data["tasks"]["k2"]
        for field in ("finished_at", "abandoned_at"):
            task[field] = 0
            self.hd.save_topic(self.w.repo, self.target, data)
            for name, args in WRITES.items():
                with self.subTest(completion=field, command=name):
                    before = self.snapshot()
                    result, _ = self.invoke(name, "--topic", self.target, *args, terminal="t3", code=3)
                    self.assertEqual(result["FAILURE"], "NOT_OWNER")
                    self.assertEqual(self.snapshot(), before)
            task.pop(field)
        self.hd.save_topic(self.w.repo, self.target, data)
        for state in ({"finished": 0}, None):
            if state:
                self.hd.write_json(self.w.run_dir / "state.json", state)
            else:
                (self.w.run_dir / "state.json").unlink()
                self.hd.write_json(self.w.run_dir / "control.json",
                                   {"state": "stopped", "owner": "t3"})
            for name, args in WRITES.items():
                with self.subTest(completion=state, command=name):
                    result, _ = self.invoke(name, "--topic", self.target, *args, terminal="t3", code=3)
                    self.assertEqual(result["FAILURE"], "NOT_OWNER")

    def test_controller_is_also_found_from_helper_parent_without_control_owner(self):
        self.hd.write_json(self.w.run_dir / "control.json", {"state": "running"})
        folder = self.w.run_dir / "agents" / "helper"
        folder.mkdir(parents=True)
        self.hd.write_json(folder / "meta.json", {"parent": "t3", "started_at": 0})
        self.invoke("task-edit", "--topic", self.target, "--task", "k1", "--title", "Allowed",
                    terminal="t3")
        self.assertEqual(self.data()["tasks"]["k1"]["title"], "Allowed")

    def test_every_writer_command_keeps_missing_topic_failure(self):
        for terminal in ("", "t1"):
            for name, args in WRITES.items():
                with self.subTest(terminal=terminal, command=name):
                    result, _ = self.invoke(name, "--topic", "missing", *args,
                                             terminal=terminal, code=3)
                    self.assertEqual(result["FAILURE"], "TOPIC_NOT_FOUND")

    def test_refined_and_requested_start_allow_a_new_terminal(self):
        result, _ = self.invoke("request", "--topic", self.target, "--items", "b1",
                                "--target", "new_tab", terminal="t2")
        result, _ = self.invoke("refined", "--topic", self.target, "--ack", result["REQUEST"],
                                "--drafts", '[{"title":"Refined","kind":"dev","detail":"work"}]',
                                terminal="t4")
        task = result["TASKS"]
        result, _ = self.invoke("request", "--topic", self.target, "--task", task,
                                "--target", "new_tab", "--agent", "codex", terminal="t2")
        run = self.w.run_dir.parent / "dev-new"
        run.mkdir()
        self.invoke("start", "--run", run, "--topic", self.target, "--task", task,
                    "--request", result["REQUEST"], terminal="t4")
        self.invoke("finish", "--run", run, "--line", "Done", terminal="t4")
        self.assertEqual(self.data()["tasks"][task]["summary_line"], "Done")
        self.invoke("init", "--title", "Independent", terminal="t4")
        self.invoke("list", terminal="t4")
        self.invoke("peers", terminal="t4")
        self.invoke("deliver", terminal="t4")

    def test_existing_topic_authorizes_start_before_binding(self):
        run = self.w.run_dir.parent / "dev-new"
        run.mkdir()
        rid = self.invoke("request", "--topic", self.target, "--task", "k1", terminal="t2")[0]["REQUEST"]
        with mock.patch.object(self.hd, "save_topic") as save:
            for flags in ((), ("--task", "k1"), ("--task", "k1", "--request", rid)):
                with self.subTest(flags=flags):
                    result, _ = self.invoke("start", "--run", run, "--topic", self.target,
                                            *flags, terminal="t1", code=3)
                    self.assertEqual(result["FAILURE"], "NOT_OWNER")
                    save.assert_not_called()

    def test_new_tab_controller_can_start_a_child_of_its_dispatched_run(self):
        request, _ = self.invoke("request", "--topic", self.target, "--task", "k1",
                                 "--target", "new_tab", "--agent", "codex", terminal="t2")
        parent = self.w.run_dir.parent / "dev-new"
        parent.mkdir()
        self.invoke("start", "--run", parent, "--topic", self.target, "--task", "k1",
                    "--request", request["REQUEST"], terminal="t4")
        child = self.w.run_dir.parent / "test-child"
        child.mkdir()
        before = self.snapshot()
        for terminal in ("t1", "t3"):
            with self.subTest(terminal=terminal):
                result, _ = self.invoke("start", "--run", child, "--parent", parent,
                                        terminal=terminal, code=3)
                self.assertEqual(result["FAILURE"], "NOT_OWNER")
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(list(child.iterdir()), [])
        result, _ = self.invoke("start", "--run", child, "--parent", parent, terminal="t4")
        self.assertEqual(result["TOPIC"], self.target)
        task = self.data()["tasks"][result["TASK"]]
        self.assertEqual((task["parent_task"], task["run"]), ("k1", child.name))
        self.assertEqual(self.hd.run_message_controller(child), "t4")
        self.assertEqual(self.data()["owner"]["terminal"], "t2")

    def test_bound_controller_can_repair_state_without_a_request(self):
        run = self.w.run_dir
        before = self.snapshot()
        result, _ = self.invoke("start", "--run", run, terminal="t4", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        self.assertFalse((run / "state.json").exists())
        self.assertEqual(self.snapshot(), before)
        result, _ = self.invoke("start", "--run", run, terminal="t3")
        self.assertEqual((result["TOPIC"], result["TASK"]), (self.target, "k2"))
        self.assertEqual(self.hd.read_json(run / "state.json", {}), {"topic": self.target, "task": "k2"})
        self.assertEqual(self.snapshot(), before)

    def test_binding_lookups_require_the_canonical_run_location(self):
        run = self.w.run_dir
        for lookup in (self.hd.topic_binding, self.hd.topic_binding_snapshot):
            with self.subTest(lookup=lookup.__name__):
                self.assertEqual(lookup(self.w.repo, run), (self.target, "k2"))
                self.assertIsNone(lookup(self.w.repo, self.w.repo / "unrelated" / run.name))

    def test_finish_requires_the_bound_runs_controller_even_for_topic_owner(self):
        for terminal in ("t1", "t2"):
            with self.subTest(terminal=terminal), mock.patch.object(self.hd, "save_topic") as save:
                result, _ = self.invoke("finish", "--run", self.w.run_dir, "--line", "Done",
                                        terminal=terminal, code=3)
                self.assertEqual(result["FAILURE"], "NOT_OWNER")
                save.assert_not_called()
        self.invoke("finish", "--run", self.w.run_dir, "--line", "Done", terminal="t3")

    def test_refinement_message_describes_both_dependency_directions(self):
        result, _ = self.invoke("request", "--topic", self.target, "--items", "b1", terminal="t2")
        for field in ("depends_on", "blocks"):
            self.assertIn(field, json.loads(result["MESSAGE"]))

    def test_owner_refinement_checks_the_recipient_before_validating_drafts(self):
        rid = self.invoke("request", "--topic", self.target, "--items", "b1", terminal="t2")[0]["REQUEST"]
        before = self.snapshot()
        result, _ = self.invoke("refined", "--topic", self.target, "--ack", rid,
                                "--drafts", "[]oops", terminal="t4", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        self.assertEqual(self.snapshot(), before)

    def completed_refinement(self, target="owner", terminal="t2"):
        rid = self.invoke("request", "--topic", self.target, "--items", "b1",
                           "--target", target, terminal="t2")[0]["REQUEST"]
        result = self.invoke("refined", "--topic", self.target, "--ack", rid,
                             "--drafts", '[{"title":"Refined","kind":"dev"}]', terminal=terminal)[0]
        return rid, result

    def test_owner_refinement_retries_require_the_current_owner_or_user(self):
        rid, original = self.completed_refinement()
        path = self.hd.topic_dir(self.w.repo, self.target) / "refinements.json"
        self.assertEqual(self.hd.read_json(path, {})[rid].get("target"), "owner")
        data = self.data()
        data["owner"]["terminal"] = "t3"
        self.hd.save_topic(self.w.repo, self.target, data)
        before = self.snapshot()
        for terminal in ("t2", "t4"):
            result, _ = self.invoke("refined", "--topic", self.target, "--ack", rid,
                                    "--drafts", "[]oops", terminal=terminal, code=3)
            self.assertEqual(result["FAILURE"], "NOT_OWNER")
            self.assertEqual(self.snapshot(), before)
        for terminal in ("t3", ""):
            self.assertEqual(self.invoke("refined", "--topic", self.target, "--ack", rid,
                                         "--drafts", "[]oops", terminal=terminal)[0], original)

    def test_legacy_refinement_receipts_default_to_owner_on_retry(self):
        rid, original = self.completed_refinement()
        path = self.hd.topic_dir(self.w.repo, self.target) / "refinements.json"
        journal = self.hd.read_json(path, {})
        journal[rid].pop("target", None)
        self.hd.write_json(path, journal)
        result, _ = self.invoke("refined", "--topic", self.target, "--ack", rid,
                                "--drafts", "[]", terminal="t4", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        for terminal in ("t2", ""):
            self.assertEqual(self.invoke("refined", "--topic", self.target, "--ack", rid,
                                         "--drafts", "[]", terminal=terminal)[0], original)

    def test_new_tab_refinement_receipts_preserve_unrestricted_retries(self):
        rid, original = self.completed_refinement("new_tab", terminal="t4")
        path = self.hd.topic_dir(self.w.repo, self.target) / "refinements.json"
        self.assertEqual(self.hd.read_json(path, {})[rid].get("target"), "new_tab")
        self.assertEqual(self.invoke("refined", "--topic", self.target, "--ack", rid,
                                     "--drafts", "[]oops", terminal="t1")[0], original)

    def test_approval_parser_excludes_reverse_edits_and_new_tab_requests(self):
        for op, args, hint in (
                ("task-add", {"title": "Draft", "kind": "dev", "blocks": ""}, "blocks"),
                ("task-edit", {"task": "k1", "blocks": ""}, "blocks"),
                ("request", {"items": "b1", "target": "new_tab"}, "owner")):
            with self.subTest(op=op), mock.patch.object(self.hd, "topic_approval_request",
                                                       return_value=("a1", False)) as store:
                result, output = self.invoke("approval-request", "--topic", self.target,
                    "--from-topic", self.source, "--op", op, "--args", json.dumps(args),
                    "--reason", "reason", code=3)
                self.assertEqual(result["FAILURE"], "APPROVAL_INVALID")
                self.assertIn(hint, output)
                store.assert_not_called()

    def test_request_schema_duplicate_detection_and_repository_count(self):
        first = self.request()
        second = self.request()
        self.assertEqual(first["APPROVAL"], self.target + ":a1")
        self.assertEqual(second, {"APPROVAL": self.target + ":a1", "APPROVAL_EXISTS": "1"})
        approvals = self.approvals()
        self.assertEqual(approvals["next"], 2)
        item = approvals["items"][0]
        self.assertEqual(set(item), {"id", "from", "op", "args", "summary", "reason", "created",
                                     "state", "decided_at", "note", "result"})
        self.assertEqual(item["from"], {"topic": self.source, "task": None, "terminal": "t1",
                                        "agent": "claude", "run": None})
        self.assertEqual((item["state"], item["result"], item["note"]), ("open", None, None))
        self.assertEqual(self.invoke("deliver")[0]["APPROVALS_OPEN"], "1")
        self.assertEqual(self.data()["next_task"], 3)

    def test_open_run_request_is_reused_after_agent_metadata_changes(self):
        with mock.patch.object(self.hd, "hc_json", return_value=None):
            first = self.request(run=self.w.run_dir, terminal="t3")
        before = self.snapshot()
        with mock.patch.object(self.hd, "hc_json", return_value={"state": "live", "status": {"app": "claude-code"}}):
            retry = self.request(run=self.w.run_dir, terminal="t3")
        self.assertEqual(retry, {**first, "APPROVAL_EXISTS": "1"})
        self.assertEqual(self.snapshot(), before)

    def test_malformed_task_and_dependency_refs_are_rejected_on_request(self):
        before = self.snapshot()
        for args in ({"task": "k01"}, {"task": "target:k1"}, {"task": "k1", "depends": "k3,b1"},
                     {"task": "k1", "add-depends": "source:k0"},
                     {"task": "k1", "remove_depends": "source::k3"}):
            with self.subTest(args=args):
                self.assertEqual(self.request("task-edit", args, code=3)["FAILURE"], "APPROVAL_INVALID")
                self.assertEqual(self.snapshot(), before)

    def test_all_allowed_operations_validate_their_real_arguments(self):
        for op, args in (
                ("task-add", {"title": "New", "kind": "dev", "from-backlog": "b1"}),
                ("task-edit", {"task": "k1", "title": "Edited", "depends": ""}),
                ("task-rm", {"task": "k1"}),
                ("backlog-add", {"text": "New"}),
                ("backlog-edit", {"item": "b1", "text": "Edited"}),
                ("backlog-rm", {"item": "b1"}),
                ("request", {"task": "k1", "kind": "dispatch", "cancel": True}),
                ("abandon", {"task": "k2", "reason": "Removed", "force": False}),
                ("pause", {}), ("resume", {})):
            with self.subTest(op=op):
                self.request(op, args)
        self.assertEqual(len(self.approvals()["items"]), 10)

    def test_invalid_operations_and_arguments_create_no_files(self):
        before = self.snapshot()
        for op, args in (
                ("delete", {}), ("stop", {}), ("refined", {}), ("bogus", {}),
                ("pause", {"repo": "/elsewhere"}), ("pause", {"topic": self.source}),
                ("pause", {"run": str(self.w.run_dir)}), ("pause", {"unknown": "x"}),
                ("pause", []), ("pause", None), ("task-add", {"title": "Missing kind"}),
                ("task-add", {"title": "Invalid kind", "kind": "bad"}),
                ("task-add", {"title": ["List"], "kind": "dev"}),
                ("request", {"task": "k1", "items": "b1"}),
                ("request", {"items": "", "type": "refine"}),
                ("request", {"task": "k1", "type": "refine"}),
                ("request", {"task": "k1", "cancel": "true"}),
                ("request", {"task": "k1", "cancel": True, "resend": True}),
                ("request", {"task": "k1", "type": "dispatch", "kind": "dispatch"})):
            with self.subTest(op=op, args=args):
                result, _ = self.invoke("approval-request", "--topic", self.target,
                                        "--from-topic", self.source, "--op", op,
                                        "--args", json.dumps(args), "--reason", "reason", code=3)
                self.assertEqual(result["FAILURE"], "APPROVAL_INVALID")
                self.assertEqual(self.snapshot(), before)
        result, _ = self.invoke("approval-request", "--topic", self.target,
                                "--from-topic", self.source, "--op", "pause",
                                "--args", "{", "--reason", "reason", code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_INVALID")
        self.assertEqual(self.snapshot(), before)

    def test_source_identity_is_checked_and_run_uses_authoritative_binding(self):
        self.assertEqual(self.request(terminal="t4", code=3)["FAILURE"], "NOT_OWNER")
        result = self.request(source=self.target, terminal="t3")
        self.assertEqual(result["APPROVAL"], self.target + ":a1")
        self.hd.write_json(self.w.run_dir / "state.json", {"topic": self.source})
        self.request(run=self.w.run_dir, terminal="t3")
        item = self.approvals()["items"][-1]
        self.assertEqual((item["from"]["topic"], item["from"]["task"], item["from"]["run"]),
                         (self.target, "k2", self.w.run_dir.name))
        self.request(terminal="")
        self.assertIsNone(self.approvals()["items"][-1]["from"]["terminal"])

    def test_only_user_can_decide_and_approve_returns_original_output(self):
        self.request(args={"title": "--literal\n$(untouched)", "kind": "dev"})
        before = self.snapshot()
        for terminal in ("t1", "t2", "t3", "t4"):
            with self.subTest(terminal=terminal):
                self.assertEqual(self.decide(terminal=terminal, code=3)[0]["FAILURE"], "NOT_OWNER")
                self.assertEqual(self.snapshot(), before)
        result, output = self.decide(note="同意")
        self.assertEqual(result, {"TASK": "k3", "STATE": "approved"})
        self.assertEqual(output, "TASK=k3\nSTATE=approved\n")
        item = self.approvals()["items"][0]
        self.assertEqual(item["result"], {"ok": True, "failure": None, "output": "TASK=k3"})
        self.assertEqual(item["note"], "同意")
        self.assertEqual(self.data()["tasks"]["k3"]["title"], "--literal\n$(untouched)")
        self.assertEqual(len(self.notices()), 1)
        notice = self.notices()[0]
        self.assertEqual(notice["kind"], "notice")
        for text in ("target:a1", "同意", "TASK=k3", "成功"):
            self.assertIn(text, notice["text"])
        self.assertEqual(self.decide(code=3)[0]["FAILURE"], "APPROVAL_CLOSED")
        self.invoke("deliver")
        self.assertEqual(len(self.notices()), 1)
        self.assertEqual(self.data()["next_task"], 4)

    def test_execution_failure_reject_and_answer_each_notify_once(self):
        for index, (decision, op, args, expected) in enumerate((
                ("approve", "task-edit", {"task": "k999", "title": "No"}, "failed"),
                ("reject", "pause", {}, "rejected"), ("answer", "resume", {}, "answered")), 1):
            with self.subTest(decision=decision):
                self.request(op, args)
                result, _ = self.decide(f"a{index}", decision, note="用户附言")
                self.assertEqual(result["STATE"], expected)
                item = self.approvals()["items"][-1]
                self.assertEqual(item["state"], expected)
                self.assertEqual(item["note"], "用户附言")
                if decision == "approve":
                    self.assertEqual(result["FAILURE"], "TASK_NOT_FOUND")
                    self.assertEqual(item["result"]["failure"], "TASK_NOT_FOUND")
                    self.assertFalse(item["result"]["ok"])
                    self.assertIn("TASK_NOT_FOUND", self.notices()[-1]["text"])
                else:
                    self.assertIsNone(item["result"])
                self.assertEqual(len(self.notices()), index)
                self.assertIn("用户附言", self.notices()[-1]["text"])

    def test_answer_requires_a_nonblank_note_on_open_approval(self):
        self.request()
        for note in (None, "", " \n "):
            with self.subTest(note=note):
                self.assertEqual(self.decide(decision="answer", note=note, code=3)[0]["FAILURE"],
                                 "APPROVAL_INVALID")
                self.assertEqual(self.approvals()["items"][0]["state"], "open")

    def test_decision_result_includes_operation_stderr(self):
        self.request()
        def operation(_):
            print("validation detail", file=sys.stderr)
            self.hd.fail("invalid task", failure="TASK_BOUND", code=3)
        with mock.patch.object(self.hd, "cmd_topic_task", operation):
            self.decide()
        self.assertIn("validation detail", self.approvals()["items"][0]["result"]["output"])

    def test_decision_checks_topic_lifecycle_before_recording_or_executing(self):
        self.request()
        data = self.data()
        for field, failure in (("archived", "TOPIC_ARCHIVED"), ("deleting", "TOPIC_DELETING"),
                               ("messages_pending", "TOPIC_MESSAGES_PENDING")):
            self.hd.save_topic(self.w.repo, self.target, {**data, field: 1})
            with self.subTest(field=field), mock.patch.object(self.hd, "cmd_topic_task") as execute:
                self.assertEqual(self.decide(code=3)[0]["FAILURE"], failure)
                self.assertFalse(self.hd.approval_journal_path(self.w.repo, self.target).exists())
                execute.assert_not_called()

    def test_delivery_isolates_malformed_decision_records(self):
        self.request()
        path = self.hd.approval_journal_path(self.w.repo, self.target)
        for record in ({}, None, {"phase": "executing"}, {"phase": "done", "pending": True}):
            with self.subTest(record=record):
                self.hd.write_json(path, {"a1": record})
                result, output = self.invoke("deliver")
                self.assertIn("approval-decisions.json", output)
                self.assertIn("APPROVALS_OPEN", result)
                self.assertEqual(self.decide(code=3)[0]["FAILURE"], "FILE_DAMAGED")
                self.assertEqual(self.hd.read_json(path, {}), {"a1": record})

    def test_withdraw_only_accepts_its_source_topic_and_open_items(self):
        self.request()
        result, _ = self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                "--from-topic", self.target, terminal="t2", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                    "--from-topic", self.source)
        self.assertEqual(self.approvals()["items"][0]["state"], "withdrawn")
        self.assertEqual(len(self.notices()), 1)
        result, _ = self.invoke("approval-withdraw", "--topic", self.target, "--id", "a1",
                                "--from-topic", self.source, code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_CLOSED")
        self.assertEqual(self.decide(code=3)[0]["FAILURE"], "APPROVAL_CLOSED")

    def make_archivable(self):
        data = self.data()
        data["tasks"]["k2"]["finished_at"] = 0
        self.hd.save_topic(self.w.repo, self.target, data)
        self.hd.write_json(self.w.run_dir / "state.json", {"finished": 0})

    def test_archive_and_delete_withdraw_open_items_and_preserve_one_notice(self):
        self.request()
        self.request("pause", {})
        self.make_archivable()
        self.invoke("archive", "--topic", self.target, terminal="t2")
        self.assertEqual([item["state"] for item in self.approvals()["items"]],
                         ["withdrawn", "withdrawn"])
        self.assertEqual(len(self.notices()), 2)
        self.invoke("delete", "--topic", self.target, terminal="t2")
        self.invoke("deliver")
        self.assertEqual(len(self.notices()), 2)
        self.assertEqual(self.invoke("deliver")[0]["APPROVALS_OPEN"], "0")

    def test_delete_also_withdraws_items_left_in_an_archived_topic(self):
        self.request()
        self.make_archivable()
        data = self.data()
        data["archived"] = 1
        self.hd.save_topic(self.w.repo, self.target, data)
        (self.w.run_dir / "archived").write_text("1")
        self.invoke("delete", "--topic", self.target, terminal="t2")
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("已撤回", self.notices()[0]["text"])

    def test_decisions_preserve_notices_for_archived_and_deleted_applicants(self):
        for delete in (False, True):
            with self.subTest(delete=delete):
                self.request()
                self.invoke("archive", "--topic", self.source)
                if delete:
                    self.invoke("delete", "--topic", self.source)
                self.decide(f"a{2 if delete else 1}")
                self.assertEqual(len(self.notices()), 2 if delete else 1)
                notice = self.notices()[-1]
                self.assertIsNone(notice["dropped"])
                self.assertIn("成功", notice["text"])
                if not delete:
                    self.invoke("unarchive", "--topic", self.source)

    def test_decision_receipt_recovers_after_execution_without_repeating_the_operation(self):
        self.request()
        with mock.patch.object(self.hd, "complete_approval", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide()
        self.assertEqual(self.data()["next_task"], 4)
        self.assertEqual(self.approvals()["items"][0]["state"], "open")
        result, _ = self.decide()
        self.assertEqual(result, {"TASK": "k3", "STATE": "approved"})
        self.assertEqual(self.data()["next_task"], 4)
        self.assertEqual(len(self.notices()), 1)

    def test_recovering_a_receipt_does_not_report_a_new_note_as_sent(self):
        self.request()
        with mock.patch.object(self.hd, "complete_approval", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide(note="原附言")
        result, _ = self.decide(note="新附言", code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_CLOSED")
        self.assertEqual(self.approvals()["items"][0]["note"], "原附言")
        self.assertEqual(len(self.notices()), 1)

    def test_delivery_recovers_a_decision_committed_before_outbox_queue(self):
        self.request()
        with mock.patch.object(self.hd, "queue_approval_notice", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide()
        self.assertEqual(self.approvals()["items"][0]["state"], "approved")
        self.assertEqual(self.notices(), [])
        self.invoke("deliver")
        self.assertEqual(len(self.notices()), 1)
        self.assertEqual(self.data()["next_task"], 4)

    def test_replayed_outbox_commit_does_not_duplicate_notices(self):
        self.request()
        real = self.hd.outbox_add

        def interrupt(*args):
            real(*args)
            raise KeyboardInterrupt

        with mock.patch.object(self.hd, "outbox_add", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide(decision="answer", note="已回复")
        self.hd.flush_outbox(self.w.repo)
        self.assertEqual(len(self.notices()), 1)
        self.invoke("deliver")
        self.assertEqual(len(self.notices()), 1)
        self.assertEqual(self.decide(decision="answer", code=3)[0]["FAILURE"], "APPROVAL_CLOSED")

    def test_interruption_during_the_operation_never_reexecutes_it(self):
        self.request()
        real = self.hd.cmd_topic_task

        def interrupt(args):
            real(args)
            raise KeyboardInterrupt

        with mock.patch.object(self.hd, "cmd_topic_task", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.decide()
        result, _ = self.decide(decision="reject", note="新的选择", code=3)
        self.assertEqual(result["FAILURE"], "APPROVAL_INTERRUPTED")
        self.assertIsNone(self.approvals()["items"][0]["note"])
        self.assertEqual(self.data()["next_task"], 4)
        self.assertEqual(self.approvals()["items"][0]["result"]["failure"], "APPROVAL_INTERRUPTED")
        self.assertIn("APPROVAL_INTERRUPTED", self.notices()[0]["text"])

    def test_interrupted_reject_and_answer_preserve_the_original_decision_and_note(self):
        for index, (decision, state) in enumerate((("reject", "rejected"), ("answer", "answered")), 1):
            self.request()
            aid = f"a{index}"
            with self.hd.topic_lock(self.w.repo, self.target):
                path = self.hd.approval_journal_path(self.w.repo, self.target)
                journal = self.hd.read_json_strict(path, {})
                journal[aid] = {"phase": "executing", "pid": None, "decision": decision,
                                "decided_at": 1, "note": "原附言"}
                self.hd.write_json(path, journal)
            result, _ = self.decide(aid, note="重试附言", code=3)
            self.assertEqual(result["FAILURE"], "APPROVAL_INTERRUPTED")
            item = self.approvals()["items"][-1]
            self.assertEqual(item["state"], state)
            self.assertEqual(item["note"], "原附言")
            self.assertIsNone(item["result"])
            self.assertEqual(len(self.notices()), index)
        self.assertEqual(self.data()["next_task"], 3)

    def test_new_requests_submitted_during_execution_are_preserved(self):
        self.request()
        real = self.hd.cmd_topic_task

        def operation(args):
            real(args)
            with contextlib.redirect_stdout(io.StringIO()):
                self.request("pause", {})

        with mock.patch.object(self.hd, "cmd_topic_task", operation):
            self.decide()
        self.assertEqual([(item["id"], item["state"]) for item in self.approvals()["items"]],
                         [("a1", "approved"), ("a2", "open")])
        self.assertEqual(self.approvals()["next"], 3)

    def test_simultaneous_decisions_execute_and_notify_once(self):
        self.request()
        argv = [sys.executable, str(HD), "topic", "approval-decide", "--repo", str(self.w.repo),
                "--topic", self.target, "--id", "a1", "--decision", "approve"]
        processes = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                      env=self.w.env(HC_TERMINAL_ID="")) for _ in range(2)]
        try:
            results = [process.communicate(timeout=15) for process in processes]
            self.assertEqual(sorted(process.returncode for process in processes), [0, 3], results)
            self.assertEqual(self.data()["next_task"], 4)
            self.assertEqual(len(self.notices()), 1)
            self.assertIn("FAILURE=APPROVAL_CLOSED", "".join(stdout for stdout, _ in results))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)

    def test_archive_cleanup_retries_interrupted_withdrawal(self):
        self.request()
        self.make_archivable()
        with mock.patch.object(self.hd, "queue_approval_notice", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("archive", "--topic", self.target, terminal="t2")
        self.invoke("deliver")
        self.assertEqual(self.approvals()["items"][0]["state"], "withdrawn")
        self.assertEqual(len(self.notices()), 1)
        self.assertNotIn("messages_pending", self.data())

    def test_damaged_approval_files_are_never_overwritten(self):
        self.request()
        path = self.hd.topic_dir(self.w.repo, self.target) / "approvals.json"
        for text in ("{damaged", "{}", '{"items": [{}], "next": 2}'):
            with self.subTest(text=text):
                path.write_text(text)
                before = self.snapshot()
                self.assertEqual(self.request("pause", {}, code=3)["FAILURE"], "FILE_DAMAGED")
                self.assertEqual(self.decide(code=3)[0]["FAILURE"], "FILE_DAMAGED")
                self.assertEqual(self.snapshot(), before)

    def test_unreadable_approval_files_report_read_failed(self):
        self.request()
        path = self.hd.topic_dir(self.w.repo, self.target) / "approvals.json"
        read = self.hd.Path.read_text
        before = self.snapshot()

        def unreadable(current, *args, **kwargs):
            if current == path:
                raise PermissionError("not readable")
            return read(current, *args, **kwargs)

        with mock.patch.object(self.hd.Path, "read_text", unreadable):
            self.assertEqual(self.request("pause", {}, code=3)["FAILURE"], "READ_FAILED")
            self.assertEqual(self.decide(code=3)[0]["FAILURE"], "READ_FAILED")
        self.assertEqual(self.snapshot(), before)

    def test_approval_handlers_do_not_hold_topic_locks_during_operation_dispatch(self):
        self.request("task-edit", {"task": "k1", "depends": ""})
        lock = self.hd.topic_lock
        held = []

        @contextlib.contextmanager
        def tracked(repo, topic):
            with lock(repo, topic):
                held.append(topic)
                try:
                    yield
                finally:
                    held.pop()

        real = self.hd.cmd_topic_task

        def operation(args):
            self.assertEqual(held, [])
            return real(args)

        with mock.patch.object(self.hd, "topic_lock", tracked), mock.patch.object(
                self.hd, "cmd_topic_task", operation):
            self.decide()


if __name__ == "__main__":
    unittest.main()
