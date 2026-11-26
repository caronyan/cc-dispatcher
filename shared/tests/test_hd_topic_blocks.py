"""Reverse Task dependencies use temporary repositories and fake hc terminals."""
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


class TopicBlocks(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        self.w.set_terminals({
            "other": {"address": "t2", "status": "working", "app": "codex", "argv": ["codex"]},
            "refiner": {"address": "t3", "status": "working", "app": "codex", "argv": ["codex"]},
        })
        for topic, terminal, count in (("A", "t1", 3), ("B", "t2", 2)):
            data = self.hd.new_topic_data(topic, topic, {"terminal": terminal, "agent": "codex"})
            for index in range(count):
                self.hd.add_topic_task(data, str(index), "dev")
            self.hd.save_topic(self.w.repo, topic, data)
            self.hd.save_backlog(self.w.repo, topic, {"next_item": 1, "items": []})

    def invoke(self, name, *args, terminal="", code=0):
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.w.env(HC_TERMINAL_ID=terminal)), mock.patch.object(
                sys, "argv", [str(HD), "topic", name, "--repo", str(self.w.repo), *map(str, args)]):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    self.hd.main()
                    actual = 0
                except SystemExit as error:
                    actual = error.code
        text = output.getvalue()
        self.assertEqual(actual, code, text)
        return dict(line.split("=", 1) for line in text.splitlines()
                    if "=" in line and line.split("=", 1)[0].isupper())

    def path(self, topic="A", name="topic.json"):
        return self.hd.topic_dir(self.w.repo, topic) / name

    def data(self, topic="A"):
        return self.hd.read_json_strict(self.path(topic), {})

    def change(self, topic="A", task=None, **changes):
        data = self.data(topic)
        (data["tasks"][task] if task else data).update(changes)
        self.hd.save_topic(self.w.repo, topic, data)

    def snapshot(self):
        return {str(path.relative_to(self.w.repo)): path.read_bytes()
                for path in (self.w.repo / ".cc-dispatch").rglob("*.json")}

    def edit(self, *args, **kwargs):
        return self.invoke("task-edit", "--topic", "A", "--task", "k1", *args, **kwargs)

    def refine_request(self, target="owner"):
        item = self.invoke("backlog-add", "--topic", "A", "--text", "Plan")["ITEM"]
        return self.invoke("request", "--topic", "A", "--items", item, "--target", target)["REQUEST"]

    def refine(self, rid, drafts, **kwargs):
        return self.invoke("refined", "--topic", "A", "--ack", rid, "--drafts", json.dumps(drafts),
                           **kwargs)

    def test_user_adds_local_and_cross_topic_blocks_without_new_task_fields(self):
        self.change("B", "k1", depends_on=["k2"])
        result = self.invoke("task-add", "--topic", "A", "--title", "Producer", "--kind", "dev",
                             "--blocks", "k2,B:k1")
        self.assertEqual(result, {"TASK": "k4"})
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], ["k4"])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["k2", "A:k4"])
        self.assertTrue(all("blocks" not in task for topic in ("A", "B")
                            for task in self.data(topic)["tasks"].values()))

    def test_edit_blocks_replaces_the_full_set_and_preserves_other_dependencies(self):
        self.change(task="k2", depends_on=["k3", "A:k1"])
        self.change("B", "k1", depends_on=["A:k1", "k2"])
        self.edit("--blocks", "k3,A:k3,B:k1,B:k1")
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], ["k3"])
        self.assertEqual(self.data()["tasks"]["k3"]["depends_on"], ["k1"])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["A:k1", "k2"])
        self.edit("--title", "Renamed")
        self.assertEqual(self.data()["tasks"]["k3"]["depends_on"], ["k1"])
        self.edit("--blocks", "")
        self.assertEqual(self.data()["tasks"]["k3"]["depends_on"], [])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["k2"])

    def test_invalid_missing_and_self_blocks_do_not_write(self):
        before = self.snapshot()
        for ref, failure in (("bad", "DEPENDS_INVALID"), ("B:k0", "DEPENDS_INVALID"),
                             ("k99", "DEPENDS_MISSING"), ("missing:k1", "DEPENDS_MISSING"),
                             ("B:k99", "DEPENDS_MISSING"), ("k1", "DEPENDS_SELF"),
                             ("A:k1", "DEPENDS_SELF")):
            with self.subTest(ref=ref):
                result = self.edit("--depends", "k3", "--blocks", f"k2,{ref}", code=3)
                self.assertEqual(result["FAILURE"], failure)
                self.assertEqual(self.snapshot(), before)

    def test_bound_targets_reject_additions_and_removals_atomically(self):
        for topic, target, ref in (("A", "k2", "k2"), ("B", "k1", "B:k1")):
            with self.subTest(topic=topic):
                self.change(topic, target, run="dev-bound", depends_on=[])
                before = self.snapshot()
                result = self.edit("--depends", "k3", "--blocks", ref, terminal="t1", code=3)
                self.assertEqual(result["FAILURE"], "TASK_BOUND")
                self.assertEqual(self.snapshot(), before)
                self.change(topic, target, depends_on=["k1" if topic == "A" else "A:k1"])
                before = self.snapshot()
                self.assertEqual(self.edit("--depends", "k3", "--blocks", "", code=3)["FAILURE"],
                                 "TASK_BOUND")
                self.assertEqual(self.snapshot(), before)
                self.change(topic, target, run=None, depends_on=[])

    def test_bound_target_rejects_task_add_without_consuming_an_id(self):
        self.change("B", "k1", run="dev-bound")
        before = self.snapshot()
        result = self.invoke("task-add", "--topic", "A", "--title", "Producer", "--kind", "dev",
                             "--depends", "k3", "--blocks", "k2,B:k1", terminal="t1", code=3)
        self.assertEqual(result["FAILURE"], "TASK_BOUND")
        self.assertEqual(self.snapshot(), before)

    def test_retained_bound_and_closed_edges_are_noops_for_users_and_terminals(self):
        self.change(task="k2", run="dev-local", depends_on=["A:k1"])
        self.change("B", "k1", run="dev-remote", depends_on=["A:k1"])
        for field in ("archived", "deleting", "stopping_at"):
            self.change("B", **{field: 1})
            for terminal in ("", "t1"):
                with self.subTest(field=field, terminal=terminal):
                    before = self.path("B").read_bytes()
                    result = self.edit("--depends", "k3", "--blocks", "k2,B:k1", terminal=terminal)
                    self.assertEqual(result, {"TASK": "k1"})
                    self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["k3"])
                    self.assertEqual(self.path("B").read_bytes(), before)
                    snapshot = self.snapshot()
                    result = self.edit("--blocks", "k2", terminal=terminal, code=3)
                    self.assertEqual(result["FAILURE"], "TASK_BOUND")
                    self.assertEqual(self.snapshot(), snapshot)
            self.change("B", **{field: None})

    def test_changed_edges_require_writable_target_topics(self):
        for field, failure in (("archived", "TOPIC_ARCHIVED"), ("deleting", "TOPIC_DELETING"),
                               ("stopping_at", "TOPIC_STOPPING")):
            self.change("B", **{field: 1})
            before = self.snapshot()
            self.assertEqual(self.edit("--blocks", "k2,B:k1", code=3)["FAILURE"], failure)
            self.assertEqual(self.snapshot(), before)
            self.change("B", **{field: None})

    def test_depends_and_blocks_are_checked_as_one_graph(self):
        before = self.snapshot()
        result = self.edit("--depends", "k2", "--blocks", "k2", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertEqual(result["CYCLE"].split("\u2192"), ["A:k1", "A:k2", "A:k1"])
        self.assertEqual(self.snapshot(), before)
        self.change(task="k2", depends_on=["k1"])
        self.edit("--depends", "k2", "--blocks", "")
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["k2"])
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], [])

    def test_cross_topic_cycle_rejects_local_changes_and_approvals(self):
        before = self.snapshot()
        result = self.edit("--depends", "B:k1", "--blocks", "k2,B:k1", terminal="t1", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertIn("B:k1", result["CYCLE"])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.path("B", "approvals.json").exists())

    def test_pending_remote_removal_cannot_make_local_depends_commit_a_cycle(self):
        self.change("B", "k1", depends_on=["A:k1"])
        before = self.snapshot()
        result = self.edit("--depends", "B:k1", "--blocks", "", terminal="t1", code=3)
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertEqual(self.snapshot(), before)
        self.edit("--depends", "B:k1", "--blocks", "")
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["B:k1"])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], [])

    def test_terminal_requests_remote_edge_and_approval_preserves_later_edits(self):
        self.change("B", "k1", depends_on=["k2"])
        before = self.path("B").read_bytes()
        result = self.edit("--blocks", "k2,B:k1", terminal="t1")
        self.assertEqual(result, {"TASK": "k1", "APPROVAL": "B:a1"})
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], ["k1"])
        self.assertEqual(self.path("B").read_bytes(), before)
        approval = self.hd.load_approvals(self.w.repo, "B")["items"][0]
        self.assertEqual(approval["op"], "task-edit")
        self.assertEqual(approval["args"], {"task": "k1", "add_depends": "A:k1"})
        self.assertEqual(approval["from"]["topic"], "A")
        self.assertEqual(approval["from"]["terminal"], "t1")
        self.change("B", "k1", depends_on=["A:k3"])
        self.invoke("task-edit", "--topic", "A", "--task", "k2", "--blocks", "B:k1", terminal="t1")
        self.invoke("approval-decide", "--topic", "B", "--id", "a2", "--decision", "approve")
        result = self.invoke("approval-decide", "--topic", "B", "--id", "a1", "--decision", "approve")
        self.assertEqual(result["STATE"], "approved")
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["A:k3", "A:k2", "A:k1"])
        self.hd.flush_outbox(self.w.repo)
        self.assertEqual(self.hd.load_messages(self.w.repo, "A")["items"][0]["kind"], "notice")

    def test_replacing_blocks_withdraws_only_superseded_edge_requests(self):
        self.edit("--blocks", "B:k1,B:k2", terminal="t1")
        self.invoke("task-edit", "--topic", "A", "--task", "k2", "--blocks", "B:k1", terminal="t1")
        self.assertEqual(self.edit("--blocks", "B:k2", terminal="t1")["APPROVAL"], "B:a2")
        self.edit("--blocks", "", terminal="t1")
        items = self.hd.load_approvals(self.w.repo, "B")["items"]
        self.assertEqual([item["state"] for item in items], ["withdrawn", "withdrawn", "open"])
        self.assertEqual(self.invoke("approval-decide", "--topic", "B", "--id", "a1",
                                    "--decision", "approve", code=3)["FAILURE"], "APPROVAL_CLOSED")
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], [])

    def test_user_keeps_pending_block_until_explicitly_deselected(self):
        self.edit("--blocks", "B:k1", terminal="t1")
        approvals = self.path("B", "approvals.json").read_bytes()
        target = self.path("B").read_bytes()
        self.edit("--blocks", "B:k1,k2")
        self.assertEqual(self.path("B", "approvals.json").read_bytes(), approvals)
        self.assertEqual(self.path("B").read_bytes(), target)
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], ["k1"])
        self.edit("--blocks", "k2")
        self.assertEqual(self.hd.load_approvals(self.w.repo, "B")["items"][0]["state"], "withdrawn")
        self.assertEqual(self.path("B").read_bytes(), target)

    def test_replacement_metadata_failure_leaves_topics_approvals_and_outbox_intact(self):
        self.edit("--blocks", "B:k1", terminal="t1")
        before = self.snapshot()
        with mock.patch.object(self.hd, "hc_json", side_effect=FileNotFoundError("hc")):
            with self.assertRaises(FileNotFoundError):
                self.edit("--blocks", "k2,B:k2", terminal="t1")
        self.assertEqual(self.snapshot(), before)

    def test_pending_removal_is_withdrawn_when_source_retains_that_edge(self):
        self.change("B", "k1", depends_on=["A:k1"])
        self.edit("--blocks", "", terminal="t1")
        self.edit("--blocks", "B:k1", terminal="t1")
        self.assertEqual(self.hd.load_approvals(self.w.repo, "B")["items"][0]["state"], "withdrawn")

    def test_legacy_automatic_snapshot_requires_resubmission_as_an_edge(self):
        self.invoke("approval-request", "--from-topic", "A", "--topic", "B", "--op", "task-edit",
                    "--args", '{"task":"k1","depends":"A:k1"}',
                    "--reason", "调整阻挡关系，使 B:k1 的依赖与 Topic A 的草稿安排一致。", terminal="t1")
        self.change("B", "k1", depends_on=["k2"])
        result = self.invoke("approval-decide", "--topic", "B", "--id", "a1", "--decision", "approve")
        self.assertEqual(result.get("FAILURE"), "APPROVAL_INVALID")
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["k2"])

    def test_approval_rechecks_cycle_after_new_edges(self):
        self.edit("--blocks", "B:k1", terminal="t1")
        self.edit("--depends", "B:k1")
        result = self.invoke("approval-decide", "--topic", "B", "--id", "a1", "--decision", "approve")
        self.assertEqual(result["FAILURE"], "DEPENDS_CYCLE")
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], [])

    def test_incremental_dependencies_match_local_aliases_and_validate_ref_format(self):
        self.edit("--depends", "A:k2")
        self.edit("--add-depends", "k2")
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["A:k2"])
        self.edit("--remove-depends", "k2")
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], [])
        for flag in ("--add-depends", "--remove-depends"):
            with self.subTest(flag=flag):
                self.assertEqual(self.edit(flag, "bad", code=3)["FAILURE"], "DEPENDS_INVALID")
                self.edit(flag, "k2", "--depends", "", code=2)

    def test_task_add_automatically_requests_remote_blocks(self):
        before = self.path("B").read_bytes()
        result = self.invoke("task-add", "--topic", "A", "--title", "Producer", "--kind", "dev",
                             "--blocks", "k2,B:k1", terminal="t1")
        self.assertEqual(result, {"TASK": "k4", "APPROVAL": "B:a1"})
        self.assertEqual(self.data()["tasks"]["k2"]["depends_on"], ["k4"])
        self.assertEqual(self.path("B").read_bytes(), before)
        self.assertEqual(self.hd.load_approvals(self.w.repo, "B")["items"][0]["args"],
                         {"task": "k1", "add_depends": "A:k4"})

    def test_remote_removal_is_requested_and_duplicate_requests_reuse_the_id(self):
        self.change("B", "k1", depends_on=["A:k1", "k2"])
        before = self.path("B").read_bytes()
        for _ in range(2):
            self.assertEqual(self.edit("--blocks", "", terminal="t1")["APPROVAL"], "B:a1")
        approvals = self.hd.load_approvals(self.w.repo, "B")
        self.assertEqual(len(approvals["items"]), 1)
        self.assertEqual(approvals["items"][0]["args"], {"task": "k1", "remove_depends": "A:k1"})
        self.assertEqual(self.path("B").read_bytes(), before)

    def test_multiple_remote_tasks_return_comma_separated_approval_refs(self):
        result = self.edit("--blocks", "B:k1,B:k2", terminal="t1")
        self.assertEqual(result["APPROVAL"], "B:a1,B:a2")
        approvals = self.hd.load_approvals(self.w.repo, "B")["items"]
        self.assertEqual([item["args"] for item in approvals], [
            {"task": "k1", "add_depends": "A:k1"}, {"task": "k2", "add_depends": "A:k1"}])

    def test_nonowner_cannot_use_blocks_to_change_a_source_topic(self):
        before = self.snapshot()
        result = self.edit("--blocks", "B:k1", terminal="t2", code=3)
        self.assertEqual(result["FAILURE"], "NOT_OWNER")
        self.assertEqual(self.snapshot(), before)

    def test_refined_user_blocks_support_local_cross_topic_and_later_drafts(self):
        rid = self.refine_request()
        result = self.refine(rid, [
            {"title": "Producer", "kind": "dev", "blocks": ["k1", "k5", "B:k1"]},
            {"title": "Consumer", "kind": "dev"}])
        self.assertEqual(result, {"TASKS": "k4,k5"})
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["k4"])
        self.assertEqual(self.data()["tasks"]["k5"]["depends_on"], ["k4"])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["A:k4"])

    def test_new_drafts_combine_blocks_and_explicit_dependencies(self):
        rid = self.refine_request()
        self.refine(rid, [{"title": "Producer", "kind": "dev", "blocks": ["B:k1"]},
                          {"title": "Consumer", "kind": "dev", "depends_on": ["k4"]}])
        self.assertEqual(self.data()["tasks"]["k5"]["depends_on"], ["k4"])
        self.assertEqual(self.data("B")["tasks"]["k1"]["depends_on"], ["A:k4"])

    def test_refined_new_terminal_requests_each_remote_edge_once(self):
        rid = self.refine_request(target="new_tab")
        drafts = [
            {"title": "One", "kind": "dev", "blocks": ["k1", "B:k1"]},
            {"title": "Two", "kind": "dev", "blocks": ["B:k1"]}]
        before = self.path("B").read_bytes()
        result = self.refine(rid, drafts, terminal="t3")
        self.assertEqual(result, {"TASKS": "k4,k5", "APPROVAL": "B:a1,B:a2"})
        self.assertEqual(self.data()["tasks"]["k1"]["depends_on"], ["k4"])
        self.assertEqual(self.path("B").read_bytes(), before)
        approvals = self.hd.load_approvals(self.w.repo, "B")["items"]
        self.assertEqual([a["args"] for a in approvals], [
            {"task": "k1", "add_depends": "A:k4"}, {"task": "k1", "add_depends": "A:k5"}])
        self.assertTrue(all(a["from"]["terminal"] == "t3" for a in approvals))
        snapshot = self.snapshot()
        self.assertEqual(self.refine(rid, drafts, terminal="t3"), result)
        self.assertEqual(self.snapshot(), snapshot)

    def test_refined_rejects_invalid_blocks_shapes_before_writing(self):
        rid = self.refine_request()
        before = self.snapshot()
        for refs in ("k1", None, [1], [{}]):
            with self.subTest(refs=refs):
                self.refine(rid, [{"title": "Producer", "kind": "dev", "blocks": refs}], code=2)
                self.assertEqual(self.snapshot(), before)

    def test_refined_without_blocks_does_not_read_unrelated_topics(self):
        rid = self.refine_request()
        self.path("B").write_text("damaged")
        result = self.refine(rid, [{"title": "Local", "kind": "dev", "depends_on": ["k1"]}])
        self.assertEqual(result, {"TASKS": "k4"})
        self.assertEqual(self.path("B").read_text(), "damaged")

    def test_refined_invalid_graph_preserves_tasks_backlog_and_receipts(self):
        rid = self.refine_request()
        before = self.snapshot()
        for drafts, failure in (
                ([{"title": "Self", "kind": "dev", "blocks": ["k4"]}], "DEPENDS_SELF"),
                ([{"title": "Bad", "kind": "dev", "blocks": ["bad"]}], "DEPENDS_INVALID"),
                ([{"title": "Missing", "kind": "dev", "blocks": ["B:k99"]}], "DEPENDS_MISSING"),
                ([{"title": "Cycle", "kind": "dev", "depends_on": ["B:k1"],
                   "blocks": ["k1", "B:k1"]}], "DEPENDS_CYCLE"),
                ([{"title": "One", "kind": "dev", "blocks": ["k5"]},
                  {"title": "Two", "kind": "dev", "blocks": ["k4"]}], "DEPENDS_CYCLE")):
            with self.subTest(failure=failure):
                self.assertEqual(self.refine(rid, drafts, terminal="t1", code=3)["FAILURE"], failure)
                self.assertEqual(self.snapshot(), before)
        self.change("B", "k1", run="dev-bound")
        before = self.snapshot()
        result = self.refine(rid, [{"title": "Bound", "kind": "dev", "blocks": ["k1", "B:k1"]}],
                             terminal="t1", code=3)
        self.assertEqual(result["FAILURE"], "TASK_BOUND")
        self.assertEqual(self.snapshot(), before)

    def test_damaged_topic_and_approval_files_never_cause_partial_edits(self):
        self.path("B").write_text("damaged")
        before = self.snapshot()
        self.assertEqual(self.edit("--blocks", "k2,B:k1", code=3)["FAILURE"], "FILE_DAMAGED")
        self.assertEqual(self.snapshot(), before)
        self.hd.save_topic(self.w.repo, "B", self.hd.new_topic_data("B", "B", {}))
        data = self.data("B")
        self.hd.add_topic_task(data, "Target", "dev")
        self.hd.save_topic(self.w.repo, "B", data)
        self.path("B", "approvals.json").write_text("damaged")
        before = self.snapshot()
        self.assertEqual(self.edit("--blocks", "k2,B:k1", terminal="t1", code=3)["FAILURE"],
                         "FILE_DAMAGED")
        self.assertEqual(self.snapshot(), before)

    def test_reverse_edits_lock_dependencies_before_topics_in_sorted_order(self):
        self.hd.save_topic(self.w.repo, "C", self.hd.new_topic_data("C", "Unrelated", {}))
        original_depends, original_topic = self.hd.depends_lock, self.hd.topic_lock
        held, acquired = [], []
        dependency_held = False

        @contextlib.contextmanager
        def dependency_lock(repo):
            nonlocal dependency_held
            with original_depends(repo):
                dependency_held = True
                try:
                    yield
                finally:
                    dependency_held = False

        @contextlib.contextmanager
        def topic_lock(repo, topic):
            self.assertTrue(dependency_held)
            if topic not in held:
                self.assertTrue(not held or topic > max(held), (held, topic))
                acquired.append(topic)
            with original_topic(repo, topic):
                held.append(topic)
                try:
                    yield
                finally:
                    held.pop()

        with mock.patch.object(self.hd, "depends_lock", side_effect=dependency_lock), \
                mock.patch.object(self.hd, "topic_lock", side_effect=topic_lock):
            self.edit("--depends", "k3", "--blocks", "k2,B:k1", terminal="t1")
        self.assertEqual(acquired, ["A", "B"])
        self.assertEqual(held, [])

    def test_concurrent_blocks_and_depends_in_two_processes_cannot_commit_a_cycle(self):
        self.change(task="k1", depends_on=["B:k2"])
        script = (
            "import sys,time\n"
            "sys.path.insert(0,sys.argv[1])\n"
            "import hd_dispatch as hd\n"
            "validate=hd.validate_task_depends\n"
            "def slow(*args):\n"
            " validate(*args)\n"
            " time.sleep(0.2)\n"
            "hd.validate_task_depends=slow\n"
            "sys.argv=['hd_dispatch.py','topic','task-edit','--repo',sys.argv[2],*sys.argv[3:]]\n"
            "hd.main()\n"
        )
        commands = [
            ("--topic", "A", "--task", "k1", "--blocks", "B:k1"),
            ("--topic", "B", "--task", "k2", "--depends", "k1")]
        processes = [subprocess.Popen(
            [sys.executable, "-c", script, str(HD.parent), str(self.w.repo), *args],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=self.w.env(HC_TERMINAL_ID="")) for args in commands]
        results = []
        for process in processes:
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                self.fail("dependency edits deadlocked")
            results.append((process.returncode, stdout + stderr))
        self.assertEqual(sorted(code for code, _ in results), [0, 3], results)
        rejected = next(output for code, output in results if code == 3)
        self.assertIn("FAILURE=DEPENDS_CYCLE", rejected)
        self.assertIn("CYCLE=", rejected)
        self.assertEqual(self.hd.dependency_cycle(self.w.repo, "A", "k1", {}, []), [])


if __name__ == "__main__":
    unittest.main()
