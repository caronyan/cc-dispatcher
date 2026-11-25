"""Reproduce Topic lifecycle invariants with temporary repositories and fake hc."""
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


sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_hd_dispatch import Env, HD, module


class TopicPauseStopWakeups(unittest.TestCase):
    def setUp(self):
        self.w = Env()
        self.addCleanup(shutil.rmtree, self.w.root)
        with mock.patch.dict(os.environ, self.w.env()):
            self.hd = module()
        result = self.command("topic", "start", "--run", self.w.run_dir)
        self.topic = self.w.kv(result)["TOPIC"]
        self.topic_args = argparse.Namespace(repo=str(self.w.repo), topic=self.topic, wait=0)

    def command(self, *args, code=0):
        result = self.w.hd(*map(str, args))
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def data(self):
        return self.hd.load_topic(self.w.repo, self.topic)

    def direct(self, function, args):
        with mock.patch.dict(os.environ, self.w.env()), contextlib.redirect_stdout(io.StringIO()):
            return function(args)

    def test_helper_start_holds_the_topic_lock_reentrantly(self):
        original_launch = self.hd.launch
        lock_path = self.hd.topic_dir(self.w.repo, self.topic).parent / f".{self.topic}.lock"

        def verify_before_launch(*args):
            script = """
import fcntl
import sys
with open(sys.argv[1], "a") as stream:
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("held")
    else:
        print("unlocked")
"""
            result = subprocess.run(
                [sys.executable, "-c", script, str(lock_path)],
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.stdout.strip(), "held", result.stderr)
            return original_launch(*args)

        prompt = self.w.root / "reproduce.md"
        prompt.write_text("Reproduce the assigned invariant.")
        argv = [str(HD), "run", "--run", str(self.w.run_dir), "--call", "a",
                "--mode", "write", "--dir", str(self.w.repo),
                "--prompt", str(prompt), "--schema", str(self.w.schema)]
        with mock.patch.object(self.hd, "launch", side_effect=verify_before_launch):
            with mock.patch.object(sys, "argv", argv):
                self.direct(lambda _: self.hd.main(), None)

    def test_topic_pause_keeps_its_resume_record_after_a_failure(self):
        self.w.dispatch()
        original_pause = self.hd.cmd_pause

        def interrupted_after_pause(args):
            original_pause(args)
            raise OSError("reproduced interruption after run pause")

        with mock.patch.object(self.hd, "cmd_pause", side_effect=interrupted_after_pause):
            with self.assertRaisesRegex(OSError, "reproduced interruption"):
                self.direct(self.hd.cmd_topic_pause, self.topic_args)
        self.assertIn(self.w.run_dir.name, self.data()["paused_runs"])
        self.command("topic", "pause", "--repo", self.w.repo, "--topic", self.topic)
        self.command("topic", "resume", "--repo", self.w.repo, "--topic", self.topic)
        self.assertEqual(self.hd.control(self.w.run_dir)["state"], "running")
        self.assertEqual(self.data()["paused_runs"], [])

    def test_due_retry_sends_nothing_once_the_topic_is_paused(self):
        meta = self.w.dispatch()
        self.w.patch(meta["name"], status="error", turn=2)
        meta["retry"] = {"round": 1, "n": 1, "kind": "capacity",
                         "key": "error:2", "at": 0}
        self.hd.save(self.w.run_dir, meta)
        original_retry = self.hd.retry_step
        before = len(self.w.hc_state()["terminals"][meta["name"]].get("sent", []))

        def pause_before_retry(run, captured_meta, observation, key):
            # pending() has passed its running check and captured this scheduled retry.
            self.hd.cmd_topic_pause(self.topic_args)
            self.assertEqual(self.hd.control(run)["state"], "paused")
            self.assertIsNotNone(self.data()["paused_at"])
            return original_retry(run, captured_meta, observation, key)

        with mock.patch.object(self.hd, "retry_step", side_effect=pause_before_retry):
            self.direct(self.hd.pending, self.w.run_dir)
        sent = self.w.hc_state()["terminals"][meta["name"]].get("sent", [])[before:]
        self.assertEqual(sent, [], "automatic retry woke a helper after Topic pause returned")

    def test_run_resume_cannot_undo_a_completed_topic_pause(self):
        self.w.dispatch()
        self.command("pause", "--run", self.w.run_dir)
        original_activate = self.hd.activate_run
        controllers = []

        def pause_after_activation(run):
            original_activate(run)
            # A Topic pause from another process lands between resume's checks and its RESUME_MSG.
            script = (
                "import argparse,sys\n"
                "sys.path.insert(0,sys.argv[1])\n"
                "import hd_dispatch as hd\n"
                "hd.cmd_topic_pause(argparse.Namespace(repo=sys.argv[2],topic=sys.argv[3]))\n"
            )
            controller = subprocess.Popen(
                [sys.executable, "-c", script, str(HD.parent), str(self.w.repo), self.topic],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            controllers.append(controller)
            try:
                controller.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                pass  # it waits for the Topic lock resume holds

        with mock.patch.object(self.hd, "activate_run", side_effect=pause_after_activation):
            self.direct(self.hd.cmd_resume, argparse.Namespace(run=str(self.w.run_dir)))
        for controller in controllers:
            out, err = controller.communicate(timeout=15)
            self.assertEqual(controller.returncode, 0, out + err)
        self.assertIsNotNone(self.data()["paused_at"])
        self.assertEqual(self.hd.control(self.w.run_dir)["state"], "paused",
                         "a Topic pause that returned must leave the run paused")

    def test_topic_stop_killed_midway_can_be_stopped_again(self):
        ready = self.w.root / "stop-entered"
        script = """
import argparse
import importlib.util
import pathlib
import sys
import time
spec = importlib.util.spec_from_file_location("hd_repro", sys.argv[1])
hd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hd)
def interrupted_stop(args):
    pathlib.Path(sys.argv[4]).write_text("entered")
    time.sleep(30)
hd.cmd_stop = interrupted_stop
hd.cmd_topic_stop(argparse.Namespace(repo=sys.argv[2], topic=sys.argv[3], wait=0))
"""
        process = subprocess.Popen(
            [sys.executable, "-c", script, str(HD), str(self.w.repo), self.topic, str(ready)],
            env=self.w.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            deadline = time.monotonic() + 8
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "stop did not reach its persisted-marker window")
            process.terminate()
            process.communicate(timeout=5)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
        self.assertIsNotNone(self.data().get("stopping_at"))
        observed = {}
        for operation in ("stop", "pause", "resume"):
            result = self.w.hd("topic", operation, "--repo", str(self.w.repo), "--topic", self.topic)
            observed[operation] = (result.returncode, self.w.kv(result).get("FAILURE"))
        self.assertEqual(
            observed["stop"][0], 0,
            f"dead stop process leaves Topic permanently held; retry/control results: {observed}",
        )


if __name__ == "__main__":
    unittest.main()
