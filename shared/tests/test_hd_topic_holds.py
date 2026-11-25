"""A paused or stopping Topic starts and wakes no helper; a died stop can be finished; slow steps do not hold the Topic lock."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest import mock


TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
from test_hd_dispatch import Env, HD, module


class TopicHolds(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        self.env = mock.patch.dict(os.environ, self.w.env())
        self.env.start()
        self.addCleanup(self.env.stop)
        self.hd = module()
        bound = self.command("topic", "start", "--run", self.w.run_dir, "--title", "Holds")
        self.topic, self.task = bound["TOPIC"], bound["TASK"]

    def command(self, *args, code=0):
        result = self.w.hd(*map(str, args))
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return self.w.kv(result)

    def direct(self, action, **args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            getattr(self.hd, "cmd_" + action)(argparse.Namespace(**args))
        return output.getvalue()

    def topic_data(self):
        return self.hd.load_topic(self.w.repo, self.topic)

    def test_due_network_retry_sends_nothing_while_the_topic_is_stopping(self):
        other = self.w.run_dir.parent / "dev-other"
        other.mkdir()
        self.command("topic", "start", "--run", other, "--parent", self.w.run_dir)
        self.w.run_dir = other
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="error", screen="network unreachable")
        meta["retry"] = {
            "round": 1, "n": 0, "kind": "network", "key": "error:1", "at": 0,
        }
        self.hd.save(other, meta)
        before = len(self.w.hc_state()["calls"])
        reached = []
        real_stop = self.hd.cmd_stop

        def reproduce_between_runs(args):
            self.assertIsNotNone(self.topic_data().get("stopping_at"))
            if not reached:
                self.assertEqual(self.hd.control(other)["state"], "running")
                self.hd.pending(other)
                sent = [call for call in self.w.hc_state()["calls"][before:] if call[0] == "send"]
                self.assertFalse(any(call[1] == meta["name"] for call in sent), sent)
            reached.append(args.run)
            real_stop(args)

        with mock.patch.object(self.hd, "cmd_stop", side_effect=reproduce_between_runs), \
                mock.patch.object(self.hd, "helper_usage", return_value=None):
            self.direct("topic_stop", repo=str(self.w.repo), topic=self.topic, wait=0)
        self.assertEqual(len(reached), 2)
        self.assertEqual(self.hd.control(other)["state"], "stopped")

    def test_recover_starts_no_helper_in_a_paused_topic(self):
        meta = self.w.dispatch()
        self.w.patch(meta["name"], state="gone", status="idle")
        self.command("topic", "pause", "--repo", self.w.repo, "--topic", self.topic)
        before = len(self.w.hc_state()["calls"])
        result = self.command("recover", "--run", self.w.run_dir, "--fresh", code=3)
        self.assertEqual(result["FAILURE"], "TOPIC_PAUSED")
        launches = [call for call in self.w.hc_state()["calls"][before:] if call[0] == "run"]
        self.assertEqual(launches, [])
        with contextlib.redirect_stdout(io.StringIO()):  # the path takeover takes
            back, fresh, failed = self.hd.reopen_lost(self.w.run_dir, fresh=True)
        self.assertEqual((back, fresh, failed), ([], [], ["a"]))
        self.assertEqual([c for c in self.w.hc_state()["calls"][before:] if c[0] == "run"], [])

    def test_a_run_whose_state_lost_its_topic_still_obeys_the_topic(self):
        meta = self.w.dispatch()
        self.w.patch(meta["name"], state="gone", status="idle")
        (self.w.run_dir / "state.json").write_text(json.dumps({"mode": "dev"}))  # a main agent rewrote it
        self.command("topic", "pause", "--repo", self.w.repo, "--topic", self.topic)
        result = self.command("recover", "--run", self.w.run_dir, "--fresh", code=3)
        self.assertEqual(result["FAILURE"], "TOPIC_PAUSED", "Topic 归属以 topic.json 为准，state.json 丢了也要守住暂停")
        state = json.loads((self.w.run_dir / "state.json").read_text())
        self.assertEqual((state["topic"], state["task"], state["mode"]), (self.topic, self.task, "dev"))

    def test_stopping_again_finishes_a_run_left_stopping_by_a_dead_process(self):
        meta = self.w.dispatch()
        code = """
import argparse
import os
import sys
from unittest import mock
sys.path.insert(0, sys.argv[1])
from test_hd_dispatch import module
hd = module()
real = hd.set_control
def die_midway(run, **state):
    real(run, **state)
    if state.get("state") == "stopping":
        os._exit(79)
with mock.patch.object(hd, "set_control", side_effect=die_midway):
    hd.cmd_topic_stop(argparse.Namespace(repo=sys.argv[2], topic=sys.argv[3], wait=0))
"""
        crashed = subprocess.run(
            [sys.executable, "-c", code, str(TESTS), str(self.w.repo), self.topic],
            capture_output=True, text=True, env=self.w.env(),
        )
        self.assertEqual(crashed.returncode, 79, crashed.stdout + crashed.stderr)
        self.assertFalse(self.hd.pid_alive(self.topic_data()["stopping_pid"]))
        self.assertEqual(self.hd.control(self.w.run_dir)["state"], "stopping")
        before = len(self.w.hc_state()["calls"])
        output = self.direct("topic_stop", repo=str(self.w.repo), topic=self.topic, wait=0)
        self.assertIn("STOPPED=dev-x", output)
        self.assertIsNone(self.topic_data().get("stopping_at"))
        self.assertEqual(self.hd.control(self.w.run_dir)["state"], "stopped")
        self.assertTrue(any(call[0] == "kill" for call in self.w.hc_state()["calls"][before:]))

    def test_topic_pause_and_delivery_do_not_wait_for_a_handover_progress_note(self):
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="idle", on_send={"status": "working"})
        hd_path = HD
        children = []

        def launch(*args):
            proc = subprocess.Popen(
                [sys.executable, str(hd_path), *map(str, args)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.w.env(),
            )
            children.append(proc)
            return proc

        try:
            handover = launch("handover", "--run", self.w.run_dir, "--call", "a")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    history = self.w.hc_state()["calls"]
                except json.JSONDecodeError:
                    history = []
                if any(call[0] == "send" and call[1] == meta["address"] for call in history):
                    break
                self.assertIsNone(handover.poll())
                time.sleep(0.02)
            else:
                self.fail("handover did not enter the helper progress wait")
            pause = launch("topic", "pause", "--repo", self.w.repo, "--topic", self.topic)
            delivery = launch("topic", "deliver", "--repo", self.w.repo)
            for proc in (pause, delivery):
                stdout, stderr = proc.communicate(timeout=10)
                self.assertEqual(proc.returncode, 0, stdout + stderr)
            self.assertIsNone(handover.poll(), "the handover is still waiting for the progress note")
            self.assertIsNotNone(self.topic_data()["paused_at"])
        finally:
            for proc in children:
                if proc.poll() is None:
                    proc.terminate()
                proc.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
