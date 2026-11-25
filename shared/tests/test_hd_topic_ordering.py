"""Topic pause/stop against helpers being started, and a Topic pause interrupted mid-way."""

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_hd_dispatch import Env, HD, module


class TopicControlOrdering(unittest.TestCase):
    def setUp(self):
        self.world = Env()
        self.addCleanup(shutil.rmtree, self.world.root)
        self.env = mock.patch.dict(os.environ, self.world.env())
        self.env.start()
        self.addCleanup(self.env.stop)
        self.hd = module()
        result = self.invoke("topic", "start", "--run", self.world.run_dir)
        self.topic = result["TOPIC"]

    def invoke(self, *args):
        argv = ["hd_dispatch.py", *map(str, args)]
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.hd.main()
        return dict(
            line.split("=", 1)
            for line in output.getvalue().splitlines()
            if "=" in line and line.split("=", 1)[0].isupper()
        )

    def invoke_control(self, name):
        args = argparse.Namespace(
            repo=str(self.world.repo), topic=self.topic, wait=0
        )
        with contextlib.redirect_stdout(io.StringIO()):
            getattr(self.hd, "cmd_topic_" + name)(args)

    def start_helper_while_topic_control_runs(self, operation):
        prompt = self.world.root / "prompt.md"
        prompt.write_text("Do the work.")
        original_launch = self.hd.launch
        controllers = []

        def control_before_launch(*args):
            # A Topic pause/stop from another process lands between the checks and the launch.
            script = (
                "import argparse,sys\n"
                "sys.path.insert(0,sys.argv[1])\n"
                "import hd_dispatch as hd\n"
                "args=argparse.Namespace(repo=sys.argv[3],topic=sys.argv[4],wait=0)\n"
                "getattr(hd,'cmd_topic_'+sys.argv[2])(args)\n"
            )
            controller = subprocess.Popen(
                [sys.executable, "-c", script, str(HD.parent), operation,
                 str(self.world.repo), self.topic],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            controllers.append(controller)
            try:
                controller.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                # It waits for the Topic lock the start holds; finish it after the launch.
                pass
            return original_launch(*args)

        with mock.patch.object(
            self.hd, "launch", side_effect=control_before_launch
        ):
            self.invoke(
                "run", "--run", self.world.run_dir,
                "--call", "helper", "--mode", "write",
                "--dir", self.world.repo, "--schema", self.world.schema,
                "--prompt", prompt,
            )
        for controller in controllers:
            stdout, stderr = controller.communicate(timeout=15)
            self.assertEqual(controller.returncode, 0, stdout + stderr)
        control = self.hd.control(self.world.run_dir)
        actual = self.world.hc_state()["terminals"]
        working = [
            name for name, term in actual.items()
            if name != "parent"
            and term["state"] == "live"
            and term["status"] == "working"
        ]
        self.assertEqual(
            working, [],
            f"Topic {operation} returned; control={control}; "
            f"new helpers still started: {working}",
        )

    def test_topic_pause_during_helper_start_leaves_no_helper_working(self):
        self.start_helper_while_topic_control_runs("pause")

    def test_topic_stop_during_helper_start_leaves_no_helper_working(self):
        self.start_helper_while_topic_control_runs("stop")

    def test_topic_pause_failing_midway_still_lets_resume_restart_its_run(self):
        meta = self.world.dispatch()
        original_save = self.hd.save_topic

        def fail_paused_runs_write(repo, topic, data):
            if data.get("paused_runs"):
                raise OSError("interrupted before paused_runs commit")
            return original_save(repo, topic, data)

        with mock.patch.object(
            self.hd, "save_topic", side_effect=fail_paused_runs_write
        ):
            with self.assertRaisesRegex(OSError, "paused_runs"):
                self.invoke_control("pause")
        self.invoke_control("pause")
        self.invoke_control("resume")
        topic = self.hd.load_topic(self.world.repo, self.topic)
        self.assertIsNone(topic["paused_at"])
        self.assertEqual(
            self.hd.control(self.world.run_dir)["state"], "running",
            "Retrying Topic pause then resume leaves its helper paused: "
            + json.dumps(self.world.hc_state()["terminals"][meta["name"]]),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
