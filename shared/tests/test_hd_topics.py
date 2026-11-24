"""Topic commands use temporary repositories and fake_hc.py; no live terminals are touched."""
import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

from test_hd_dispatch import Env, HD, module


class Topics(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)

    def command(self, name, *args, code=0, **env):
        r = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args), **env)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return self.w.kv(r)

    def init(self, title="Topic", **env):
        return self.command("init", "--title", title, **env)["TOPIC"]

    def task(self, topic, title="Task", kind="dev", **extra):
        args = ["--topic", topic, "--title", title, "--kind", kind]
        for key, value in extra.items():
            args.extend(["--" + key.replace("_", "-"), value])
        return self.command("task-add", *args)["TASK"]

    def item(self, topic, text="Backlog"):
        return self.command("backlog-add", "--topic", topic, "--text", text)["ITEM"]

    def topic_path(self, topic):
        return self.w.repo / ".cc-dispatch" / "topics" / topic

    def data(self, topic, name="topic.json"):
        return json.loads((self.topic_path(topic) / name).read_text())

    def alter(self, topic, **changes):
        hd = module()
        with hd.topic_lock(self.w.repo, topic):
            data = hd.load_topic(self.w.repo, topic)
            data.update(changes)
            hd.save_topic(self.w.repo, topic, data)

    def request(self, topic, task=None, items=None, **extra):
        args = ["--topic", topic, "--task" if task else "--items", task or ",".join(items)]
        for key, value in extra.items():
            args.extend(["--" + key.replace("_", "-"), value])
        return self.command("request", *args)

    def start(self, topic=None, task=None, run=None, request=None, **extra):
        args = ["--run", run or self.w.run_dir]
        if topic:
            args.extend(["--topic", topic, "--task", task])
        if request:
            args.extend(["--request", request])
        for key, value in extra.items():
            args.extend(["--" + key.replace("_", "-"), value])
        return self.command("start", *args)

    def new_run(self, name):
        run = self.w.repo / ".cc-dispatch" / name
        run.mkdir()
        return run

    def snapshot(self, topic):
        return {p.name: p.read_bytes() for p in self.topic_path(topic).iterdir() if p.is_file()}

    def test_init_complete_schema_and_owner_without_herdr(self):
        topic = self.init("中文标题", HC_TERMINAL_ID="")
        self.assertRegex(topic, r"^\d{8}-[0-9a-f]{4}$")
        data = self.data(topic)
        self.assertEqual(set(data), {"id", "title", "created_at", "archived", "paused_at", "paused_runs",
                                     "deleting", "owner", "next_task", "tasks"})
        self.assertEqual(data["owner"], dict.fromkeys(("terminal", "agent", "session", "space", "cwd")))
        self.assertEqual((data["id"], data["title"], data["next_task"], data["tasks"]),
                         (topic, "中文标题", 1, {}))
        self.assertEqual(self.data(topic, "backlog.json"), {"next_item": 1, "items": []})

    def test_init_uses_current_dispatcher_or_explicit_owner(self):
        self.w.patch("parent", cwd=str(self.w.repo))
        current = self.data(self.init(CLAUDE_CODE_SESSION_ID="session-x"))["owner"]
        self.assertEqual(current, {"terminal": "t1", "agent": "claude", "session": "session-x",
                                   "space": "s1", "cwd": str(self.w.repo)})
        self.w.set_terminals({"other": {"address": "t9", "argv": ["codex"], "cwd": "/other cwd",
                                        "labels": {"herdr.space": "s9"}}})
        topic = self.command("init", "--title", "Other", "--owner", "t9", HC_TERMINAL_ID="")["TOPIC"]
        self.assertEqual(self.data(topic)["owner"], {"terminal": "t9", "agent": "codex", "session": None,
                                                    "space": "s9", "cwd": "/other cwd"})
        self.assertIn(["get", "t9", "--json"], self.w.hc_state()["calls"])

    def test_repo_defaults_to_git_top_and_accepts_repo_before_subcommand(self):
        r = subprocess.run([sys.executable, str(HD), "topic", "init", "--title", "Default"],
                           cwd=self.w.run_dir, env=self.w.env(HC_TERMINAL_ID=""),
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(self.topic_path(self.w.kv(r)["TOPIC"]).exists())
        r = self.w.hd("topic", "--repo", str(self.w.repo), "init", "--title", "Explicit",
                      HC_TERMINAL_ID="")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(self.topic_path(self.w.kv(r)["TOPIC"]).exists())

    def test_task_and_backlog_crud_keep_monotonic_ids_and_dependencies(self):
        topic = self.init()
        b1 = self.item(topic)
        k1 = self.task(topic, detail="First", from_backlog=b1)
        k2 = self.task(topic, kind="review", depends=k1)
        self.command("task-edit", "--topic", topic, "--task", k2, "--title", "Second",
                     "--kind", "test", "--detail", "Changed", "--depends", f"{k1},k3")
        tasks = self.data(topic)["tasks"]
        self.assertEqual(tasks[k1]["from_backlog"], b1)
        self.assertEqual((tasks[k2]["title"], tasks[k2]["kind"], tasks[k2]["detail"], tasks[k2]["depends_on"]),
                         ("Second", "test", "Changed", [k1, "k3"]))
        self.assertEqual(set(tasks[k1]), {"title", "kind", "detail", "depends_on", "from_backlog",
                                         "parent_task", "run", "agent", "request", "consumed_request",
                                         "summary_line", "artifact", "created_at", "started_at", "finished_at"})
        self.assertEqual(self.command("task-rm", "--topic", topic, "--task", k2)["REMOVED"], k2)
        self.assertEqual(self.task(topic), "k3")
        self.command("backlog-edit", "--topic", topic, "--item", b1, "--text", "Changed")
        self.assertEqual(self.data(topic, "backlog.json")["items"][0]["text"], "Changed")
        self.assertEqual(self.command("backlog-rm", "--topic", topic, "--item", b1)["REMOVED"], b1)
        self.assertEqual(self.item(topic), "b2")

    def test_missing_objects_have_failure_codes(self):
        self.assertEqual(self.command("task-add", "--topic", "missing", "--title", "T", "--kind", "dev",
                                      code=3)["FAILURE"], "TOPIC_NOT_FOUND")
        topic = self.init()
        self.assertEqual(self.command("task-edit", "--topic", topic, "--task", "k99", "--title", "T",
                                      code=3)["FAILURE"], "TASK_NOT_FOUND")
        self.assertEqual(self.command("backlog-rm", "--topic", topic, "--item", "b99",
                                      code=3)["FAILURE"], "ITEM_NOT_FOUND")

    def test_task_edit_invalidates_only_changed_kind_or_detail(self):
        topic = self.init()
        task = self.task(topic)
        first = self.request(topic, task)["REQUEST"]
        self.command("task-edit", "--topic", topic, "--task", task, "--title", "Renamed",
                     "--kind", "dev", "--detail", "")
        self.assertEqual(self.data(topic)["tasks"][task]["request"]["id"], first)
        for flag, value in (("--kind", "review"), ("--detail", "New detail")):
            self.command("task-edit", "--topic", topic, "--task", task, flag, value)
            self.assertIsNone(self.data(topic)["tasks"][task]["request"])
            self.request(topic, task)

    def test_backlog_edit_invalidates_request_and_returns_to_open(self):
        topic = self.init()
        item = self.item(topic)
        self.request(topic, items=[item])
        self.command("backlog-edit", "--topic", topic, "--item", item, "--text", "New text")
        saved = self.data(topic, "backlog.json")["items"][0]
        self.assertEqual((saved["status"], saved["request"]), ("open", None))

    def test_bound_tasks_reject_edit_remove_and_request(self):
        topic = self.init()
        task = self.task(topic)
        self.start(topic, task)
        before = self.snapshot(topic)
        for command, args in (("task-edit", ["--title", "Changed"]), ("task-rm", []), ("request", [])):
            result = self.command(command, "--topic", topic, "--task", task, *args, code=3)
            self.assertEqual(result["FAILURE"], "TASK_BOUND")
        self.assertEqual(self.snapshot(topic), before)

    def test_dispatch_messages_select_owner_agent_or_explicit_agent(self):
        topic = self.init()
        task = self.task(topic, kind="research")
        first = self.request(topic, task)
        self.assertEqual(json.loads(first["MESSAGE"]),
                         f"/cc-herdr-dispatch-research --topic {topic} --task {task} --request {first['REQUEST']}")
        other = self.request(topic, task, target="new_tab", agent="codex")
        self.assertNotEqual(first["REQUEST"], other["REQUEST"])
        self.assertEqual(json.loads(other["MESSAGE"]),
                         f"按 cc-herdr-dispatch-research skill 执行，参数：--topic {topic} --task {task}"
                         f" --request {other['REQUEST']}")
        saved = self.data(topic)["tasks"][task]["request"]
        self.assertEqual(set(saved), {"id", "type", "target", "agent", "at", "delivered_at"})
        self.assertEqual((saved["type"], saved["target"], saved["agent"]), ("dispatch", "new_tab", "codex"))
        owner = self.data(topic)["owner"]
        owner["agent"] = "agy"
        self.alter(topic, owner=owner)
        self.assertTrue(json.loads(self.request(topic, task)["MESSAGE"]).startswith("按 "))

    def test_request_cancel_and_resend_preserve_request_identity(self):
        topic = self.init()
        task = self.task(topic)
        rid = self.request(topic, task)["REQUEST"]
        hd = module()
        with hd.topic_lock(self.w.repo, topic):
            data = hd.load_topic(self.w.repo, topic)
            data["tasks"][task]["request"]["delivered_at"] = 12
            hd.save_topic(self.w.repo, topic, data)
        self.assertEqual(self.command("request", "--topic", topic, "--task", task, "--resend"), {"REQUEST": rid})
        self.assertIsNone(self.data(topic)["tasks"][task]["request"]["delivered_at"])
        self.assertEqual(self.command("request", "--topic", topic, "--task", task, "--cancel"), {"CANCELLED": rid})
        self.assertIsNone(self.data(topic)["tasks"][task]["request"])
        self.assertEqual(self.command("request", "--topic", topic, "--task", task, "--resend",
                                      code=3)["FAILURE"], "REQUEST_STALE")

    def test_refine_request_message_cancel_and_resend(self):
        topic = self.init()
        items = [self.item(topic), self.item(topic)]
        result = self.request(topic, items=items, type="refine")
        rid = result["REQUEST"]
        message = json.loads(result["MESSAGE"])
        self.assertIn(f"backlog 条目 {','.join(items)}", message)
        self.assertIn(str(self.topic_path(topic) / "backlog.json"), message)
        self.assertIn(f"python3 {HD} topic refined --topic {topic} --ack {rid}", message)
        self.assertTrue(message.endswith("只建草稿，不要派发。"))
        for item in self.data(topic, "backlog.json")["items"]:
            self.assertEqual((item["status"], item["request"]["id"]), ("refining", rid))
        args = ["--topic", topic, "--items", ",".join(items)]
        self.assertEqual(self.command("request", *args, "--resend"), {"REQUEST": rid})
        self.assertEqual(self.command("request", *args, "--cancel"), {"CANCELLED": rid})
        self.assertTrue(all(i["request"] is None and i["status"] == "open"
                            for i in self.data(topic, "backlog.json")["items"]))

    def test_request_and_start_refuse_paused_archived_or_deleting_topics(self):
        topic = self.init()
        task = self.task(topic)
        for field, failure in (("paused_at", "TOPIC_PAUSED"), ("archived", "TOPIC_ARCHIVED"),
                               ("deleting", "TOPIC_DELETING")):
            with self.subTest(field=field):
                self.alter(topic, **{field: 1})
                before = self.snapshot(topic)
                for name, args in (("request", ["--topic", topic, "--task", task]),
                                   ("start", ["--run", self.w.run_dir, "--topic", topic, "--task", task])):
                    result = self.command(name, *args, code=3)
                    self.assertEqual(result["FAILURE"], failure)
                self.assertEqual(self.snapshot(topic), before)
                self.alter(topic, **{field: None})

    def test_additions_refuse_archived_or_deleting_topics(self):
        topic = self.init()
        self.alter(topic, archived=1)
        for name, args in (("task-add", ["--title", "T", "--kind", "dev"]),
                           ("backlog-add", ["--text", "B"])):
            self.assertEqual(self.command(name, "--topic", topic, *args, code=3)["FAILURE"], "TOPIC_ARCHIVED")
        self.alter(topic, archived=None, deleting=1)
        self.assertEqual(self.command("task-add", "--topic", topic, "--title", "T", "--kind", "dev",
                                      code=3)["FAILURE"], "TOPIC_DELETING")

    def test_start_explicit_consumes_request_and_preserves_other_state(self):
        topic = self.init()
        task = self.task(topic, detail="需求\n第二行")
        rid = self.request(topic, task)["REQUEST"]
        (self.w.run_dir / "state.json").write_text(json.dumps({"tasks": {"old": "value"}}))
        result = self.start(topic, task, request=rid)
        self.assertEqual((result["TOPIC"], result["TASK"], json.loads(result["DETAIL"])),
                         (topic, task, "需求\n第二行"))
        saved = self.data(topic)["tasks"][task]
        self.assertEqual((saved["run"], saved["agent"], saved["request"], saved["consumed_request"]),
                         (self.w.run_dir.name, "claude", None, rid))
        self.assertIsNotNone(saved["started_at"])
        self.assertEqual(json.loads((self.w.run_dir / "state.json").read_text()),
                         {"tasks": {"old": "value"}, "topic": topic, "task": task})
        (self.w.run_dir / "state.json").unlink()
        self.assertEqual(self.start(topic, task, request=rid)["TASK"], task)
        self.assertEqual(self.data(topic)["tasks"][task]["started_at"], saved["started_at"])

    def test_start_with_no_arguments_creates_topic_and_retry_finds_it(self):
        result = self.start(title="Fresh")
        topic, task = result["TOPIC"], result["TASK"]
        self.assertEqual(self.data(topic)["title"], "Fresh")
        self.assertEqual(self.data(topic)["tasks"][task]["title"], "Fresh")
        self.assertEqual(self.data(topic, "backlog.json"), {"next_item": 1, "items": []})
        (self.w.run_dir / "state.json").unlink()
        repeated = self.start(title="Ignored on retry")
        self.assertEqual((repeated["TOPIC"], repeated["TASK"]), (topic, task))
        self.assertEqual(len(list(self.topic_path(topic).parent.glob("*/topic.json"))), 1)

    def test_start_default_title_and_kind_come_from_run(self):
        result = self.start()
        task = self.data(result["TOPIC"])["tasks"][result["TASK"]]
        self.assertEqual((task["title"], task["kind"]), (self.w.run_dir.name, "dev"))

    def test_start_without_herdr_recovers_authoritative_binding_despite_stale_state(self):
        result = self.command("start", "--run", self.w.run_dir, HC_TERMINAL_ID="")
        topic, task = result["TOPIC"], result["TASK"]
        self.assertIsNone(self.data(topic)["tasks"][task]["agent"])
        (self.w.run_dir / "state.json").write_text('{"topic":"missing","task":"k999","extra":true}')
        retry = self.command("start", "--run", self.w.run_dir, HC_TERMINAL_ID="")
        self.assertEqual((retry["TOPIC"], retry["TASK"]), (topic, task))
        self.assertEqual(json.loads((self.w.run_dir / "state.json").read_text()),
                         {"topic": topic, "task": task, "extra": True})

    def test_unrelated_broken_topic_does_not_block_start(self):
        broken = self.topic_path("00000000-bad0")
        broken.mkdir(parents=True)
        (broken / "topic.json").write_text("{broken")
        self.assertEqual(self.start()["TASK"], "k1")

    def test_parent_start_inherits_topic_and_parent_task(self):
        original = self.start()
        child = self.new_run("test-child")
        result = self.start(run=child, parent=self.w.run_dir, title="Child")
        self.assertEqual(result["TOPIC"], original["TOPIC"])
        saved = self.data(result["TOPIC"])["tasks"][result["TASK"]]
        self.assertEqual((saved["kind"], saved["parent_task"], saved["run"]),
                         ("test", original["TASK"], child.name))
        self.assertEqual(self.start(run=child, parent=self.w.run_dir)["TASK"], result["TASK"])
        self.assertEqual(len(self.data(result["TOPIC"])["tasks"]), 2)

    def test_start_refuses_stale_taken_or_mismatched_requests(self):
        topic = self.init()
        task = self.task(topic)
        old = self.request(topic, task)["REQUEST"]
        current = self.request(topic, task)["REQUEST"]
        args = ["--run", self.w.run_dir, "--topic", topic, "--task", task]
        before = self.snapshot(topic)
        self.assertEqual(self.command("start", *args, "--request", old, code=3)["FAILURE"], "REQUEST_STALE")
        wrong_run = self.new_run("review-other")
        self.assertEqual(self.command("start", "--run", wrong_run, "--topic", topic, "--task", task,
                                      "--request", current, code=3)["FAILURE"], "KIND_MISMATCH")
        self.assertEqual(self.snapshot(topic), before)
        self.start(topic, task, request=current)
        other_run = self.new_run("dev-second")
        self.assertEqual(self.command("start", "--run", other_run, "--topic", topic, "--task", task,
                                      "--request", current, code=3)["FAILURE"], "TASK_TAKEN")
        self.assertEqual(self.command("start", *args, "--request", old, code=3)["FAILURE"], "REQUEST_STALE")

    def test_start_after_detail_edit_refuses_delivered_request(self):
        topic = self.init()
        task = self.task(topic)
        rid = self.request(topic, task)["REQUEST"]
        self.command("task-edit", "--topic", topic, "--task", task, "--detail", "Changed")
        before = self.snapshot(topic)
        self.assertEqual(self.command("start", "--run", self.w.run_dir, "--topic", topic, "--task", task,
                                      "--request", rid, code=3)["FAILURE"], "REQUEST_STALE")
        self.assertEqual(self.snapshot(topic), before)

    def test_start_repairs_an_interrupted_state_write_for_every_entry(self):
        hd = module()
        for entry in ("explicit", "fresh", "parent"):
            with self.subTest(entry=entry):
                if entry == "explicit":
                    topic = self.init()
                    task = self.task(topic)
                    rid = self.request(topic, task)["REQUEST"]
                    args = ["--topic", topic, "--task", task, "--request", rid]
                    run = self.w.run_dir
                elif entry == "fresh":
                    run = self.new_run("dev-fresh")
                    args = []
                else:
                    run = self.new_run("test-retry")
                    args = ["--parent", str(self.w.run_dir)]
                argv = [str(HD), "topic", "start", "--run", str(run), *args]
                original = hd.write_json
                calls = []

                def interrupted(path, value):
                    calls.append(path.name)
                    if len(calls) == 2:
                        raise OSError("interrupted")
                    original(path, value)

                with mock.patch.dict(os.environ, self.w.env()), mock.patch.object(sys, "argv", argv):
                    with mock.patch.object(hd, "write_json", side_effect=interrupted):
                        with self.assertRaisesRegex(OSError, "interrupted"):
                            hd.main()
                self.assertEqual(calls, ["topic.json", "state.json"])
                self.assertFalse((run / "state.json").exists())
                found = hd.topic_binding(self.w.repo, run)
                result = self.command("start", "--run", run, *args)
                self.assertEqual((result["TOPIC"], result["TASK"]), found)
                self.assertEqual(json.loads((run / "state.json").read_text()),
                                 {"topic": found[0], "task": found[1]})

    def test_finish_records_state_and_summary_without_duplicate_conclusion(self):
        result = self.start()
        topic, task = result["TOPIC"], result["TASK"]
        line = "实现完成\n验证通过"
        args = ["--run", self.w.run_dir, "--line", line, "--artifact", '结果/"a".md']
        self.assertEqual(self.command("finish", *args)["FINISHED"], task)
        summary = self.topic_path(topic) / "summary.md"
        expected = f'## {task} {self.w.run_dir.name}（dev）\n{line}\n产物：结果/"a".md\n\n'
        self.assertEqual(summary.read_text(), expected)
        self.command("finish", *args)
        self.assertEqual(summary.read_text(), expected)
        saved = self.data(topic)["tasks"][task]
        state = json.loads((self.w.run_dir / "state.json").read_text())
        self.assertEqual((saved["summary_line"], saved["artifact"]), (line, '结果/"a".md'))
        self.assertEqual(saved["finished_at"], state["finished"])
        self.command("finish", "--run", self.w.run_dir, "--line", "更新结论")
        self.assertTrue(summary.read_text().endswith("更新结论\n\n"))
        self.assertEqual(summary.read_text().count("产物："), 1)

    def test_finish_unbound_run_refuses_without_writes(self):
        self.assertEqual(self.command("finish", "--run", self.w.run_dir, "--line", "Done",
                                      code=3)["FAILURE"], "NO_TOPIC")
        self.assertFalse((self.w.run_dir / "state.json").exists())

    def test_refined_creates_drafts_once_and_records_all_items(self):
        topic = self.init()
        items = [self.item(topic), self.item(topic)]
        rid = self.request(topic, items=items)["REQUEST"]
        drafts = [{"title": "草稿一", "kind": "research", "detail": "中文\n引号\""},
                  {"title": "草稿二", "kind": "dev", "depends_on": ["k1"]}]
        path = self.w.root / "drafts.json"
        path.write_text(json.dumps(drafts))
        args = ["--topic", topic, "--ack", rid, "--drafts", path]
        self.assertEqual(self.command("refined", *args), {"TASKS": "k1,k2"})
        tasks = self.data(topic)["tasks"]
        self.assertEqual((tasks["k1"]["detail"], tasks["k2"]["detail"], tasks["k2"]["depends_on"]),
                         ("中文\n引号\"", "", ["k1"]))
        self.assertTrue(all(t["from_backlog"] == items[0] and t["run"] is None for t in tasks.values()))
        for item in self.data(topic, "backlog.json")["items"]:
            self.assertEqual((item["status"], item["task_ids"], item["request"]), ("refined", ["k1", "k2"], None))
        before = self.snapshot(topic)
        self.assertEqual(self.command("refined", *args), {"TASKS": "k1,k2"})
        self.assertEqual(self.snapshot(topic), before)

    def test_refined_rejects_whole_request_if_one_member_changes(self):
        for action in ("edit", "remove", "cancel", "replace"):
            with self.subTest(action=action):
                topic = self.init()
                items = [self.item(topic), self.item(topic)]
                rid = self.request(topic, items=items)["REQUEST"]
                if action == "edit":
                    self.command("backlog-edit", "--topic", topic, "--item", items[0], "--text", "Changed")
                elif action == "remove":
                    self.command("backlog-rm", "--topic", topic, "--item", items[0])
                elif action == "cancel":
                    self.command("request", "--topic", topic, "--items", items[0], "--cancel")
                else:
                    self.request(topic, items=[items[0]])
                before = self.snapshot(topic)
                result = self.command("refined", "--topic", topic, "--ack", rid, "--drafts",
                                      '[{"title":"Draft","kind":"dev"}]', code=3)
                self.assertEqual(result["FAILURE"], "REQUEST_STALE")
                self.assertEqual(self.snapshot(topic), before)
                self.assertEqual(self.data(topic)["tasks"], {})

    def test_refined_rejects_bad_drafts_before_writing(self):
        topic = self.init()
        item = self.item(topic)
        rid = self.request(topic, items=[item])["REQUEST"]
        for drafts in ('[{"title":"T","kind":"unknown"}]', '[{"title":"T","kind":"dev","depends_on":[3]}]', "{}"):
            with self.subTest(drafts=drafts):
                before = self.snapshot(topic)
                self.command("refined", "--topic", topic, "--ack", rid, "--drafts", drafts, code=2)
                self.assertEqual(self.snapshot(topic), before)

    def test_refined_empty_drafts_are_idempotent(self):
        topic = self.init()
        rid = self.request(topic, items=[self.item(topic)])["REQUEST"]
        args = ["--topic", topic, "--ack", rid, "--drafts", "[]"]
        self.assertEqual(self.command("refined", *args), {"TASKS": ""})
        before = self.snapshot(topic)
        self.assertEqual(self.command("refined", *args), {"TASKS": ""})
        self.assertEqual(self.snapshot(topic), before)

    def test_concurrent_processes_add_forty_tasks_without_lost_updates(self):
        topic = self.init()
        script = (
            "import contextlib,io,sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import hd_dispatch as hd\n"
            "repo,topic=sys.argv[2:]\n"
            "for n in range(20):\n"
            " sys.argv=['hd_dispatch.py','topic','task-add','--repo',repo,"
            "'--topic',topic,'--title',str(n),'--kind','dev']\n"
            " with contextlib.redirect_stdout(io.StringIO()): hd.main()\n"
        )
        argv = [sys.executable, "-c", script, str(HD.parent), str(self.w.repo), topic]
        processes = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, env=self.w.env(HC_TERMINAL_ID="")) for _ in range(2)]
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, stdout + stderr)
        data = self.data(topic)
        self.assertEqual(data["next_task"], 41)
        self.assertEqual(set(data["tasks"]), {f"k{n}" for n in range(1, 41)})

    def test_lock_is_reentrant_and_remains_outside_topic_directory(self):
        topic = self.init()
        hd = module()
        self.assertEqual(hd.repo_of_run(self.w.run_dir), self.w.repo)
        with hd.topic_lock(self.w.repo, topic):
            with hd.topic_lock(self.w.repo, topic):
                data = hd.load_topic(self.w.repo, topic)
                data["title"] = "Nested"
                hd.save_topic(self.w.repo, topic, data)
                backlog = hd.load_backlog(self.w.repo, topic)
                hd.save_backlog(self.w.repo, topic, backlog)
        lock_path = self.topic_path(topic).parent / f".{topic}.lock"
        self.assertTrue(lock_path.is_file())
        shutil.rmtree(self.topic_path(topic))
        self.assertTrue(lock_path.is_file())

    def test_text_arguments_round_trip_without_shell_interpretation(self):
        marker = self.w.root / "must-not-exist"
        text = f'中文\n"double" \'single\' $(touch {marker}) $HOME `pwd`'
        topic = self.init(text)
        item = self.item(topic, text)
        task = self.task(topic, title=text, detail=text)
        self.assertEqual(self.data(topic)["title"], text)
        self.assertEqual(self.data(topic)["tasks"][task]["title"], text)
        self.assertEqual(self.data(topic)["tasks"][task]["detail"], text)
        self.assertEqual(self.data(topic, "backlog.json")["items"][0]["text"], text)
        self.command("backlog-edit", "--topic", topic, "--item", item, "--text", text + "\n")
        self.assertEqual(self.data(topic, "backlog.json")["items"][0]["text"], text + "\n")
        self.assertEqual(json.loads(self.start(topic, task)["DETAIL"]), text)
        self.assertFalse(marker.exists())

    def test_placeholders_are_registered(self):
        topic = self.init()
        for name in ("deliver", "pause", "resume", "stop", "archive", "unarchive", "delete"):
            args = [] if name == "deliver" else ["--topic", topic]
            r = self.w.hd("topic", name, "--repo", str(self.w.repo), *args)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertEqual(r.stdout, "not implemented\nFAILURE=other\n")

    def test_argument_errors_use_argparse(self):
        topic = self.init()
        task = self.task(topic)
        for name, args in (("request", ["--topic", topic, "--task", task, "--items", "b1"]),
                           ("request", ["--topic", topic, "--task", task, "--type", "refine"]),
                           ("start", ["--run", self.w.run_dir, "--task", task]),
                           ("start", ["--run", self.w.run_dir, "--request", "r123456"]),
                           ("task-add", ["--topic", topic, "--title", "T", "--kind", "probe"])):
            with self.subTest(name=name, args=args):
                r = self.w.hd("topic", name, "--repo", str(self.w.repo), *map(str, args))
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertIn("error:", r.stderr)
                self.assertNotIn("FAILURE=", r.stdout)


if __name__ == "__main__":
    unittest.main()
