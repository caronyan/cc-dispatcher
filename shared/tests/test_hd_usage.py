import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

USAGE = Path(__file__).resolve().parent.parent / "scripts" / "hd_usage.py"


class Usage(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hd-usage-")).resolve()
        self.home = self.root / "hd"
        self.repo = self.root / "repo"
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.run_dir = self.repo / ".cc-dispatch" / "dev-x"
        (self.run_dir / "agents" / "a").mkdir(parents=True)
        (self.run_dir / "agents" / "a" / "meta.json").write_text(json.dumps({"call": "a", "parent": "t1", "session": "s1"}))

    def sh(self, *args, stdin="", **env):
        e = dict(os.environ, CC_HD_HOME=str(self.home), HC_TERMINAL_ID="t1", MAGPIE_PORT="1",
                 CC_HD_QUOTA_JSON=str(self.root / "quota.json"))
        e.update(env)
        return subprocess.run([sys.executable, str(USAGE), *args], input=stdin, capture_output=True, text=True, env=e)

    def magpie(self, five, seven=20, fable=None):
        wins = [{"name": "5 hours", "used": five, "resetsAt": "2099-01-01T00:00:00Z"},
                {"name": "7 days", "used": seven, "resetsAt": "2099-01-08T00:00:00Z"}]
        if fable is not None:
            wins.append({"name": "7 days · Fable", "used": fable})
        (self.root / "quota.json").write_text(json.dumps([
            {"provider": "codex", "kind": "subscription", "windows": [{"name": "7 days", "used": 3}]},
            {"provider": "claude", "kind": "subscription", "user": "a", "last": True, "windows": wins}]))
        for f in (self.home / "usage").glob("quota-*.json"):
            f.unlink()  # past the 60 s cache

    def hook(self, sid="s1", model=None, **env):
        d = {"session_id": sid, "cwd": str(self.repo), "hook_event_name": "PostToolUse"}
        if model:
            t = self.root / "transcript.jsonl"
            t.write_text(json.dumps({"type": "assistant", "message": {"model": model}}) + "\n")
            d["transcript_path"] = str(t)
        r = self.sh("hook", stdin=json.dumps(d), **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else None

    def test_quota_is_magpies_last_served_account_and_cached(self):
        self.magpie(42.4, 31, fable=88)
        q = json.loads(self.sh("quota", "claude").stdout)
        self.assertEqual((q["source"], q["account"], [w["used"] for w in q["windows"]]), ("magpie", "a", [42.4, 31, 88]))
        self.assertEqual(json.loads(self.sh("quota", "codex").stdout)["windows"][0]["used"], 3)
        (self.root / "quota.json").unlink()  # magpie stops answering within the minute
        self.assertEqual(json.loads(self.sh("quota", "claude").stdout)["windows"][0]["used"], 42.4)
        for f in (self.home / "usage").glob("quota-*.json"):
            f.unlink()
        self.assertIsNone(json.loads(self.sh("quota", "claude").stdout))  # nothing known

    def test_agy_reads_the_antigravity_subscription_with_its_window_names_turned_round(self):
        (self.root / "quota.json").write_text(json.dumps([
            {"provider": "antigravity-bridge", "kind": "subscription", "windows": [
                {"name": "Gemini · 5 hours", "used": 12}, {"name": "Claude & GPT · 7 days", "used": 40}]}]))
        q = json.loads(self.sh("quota", "agy").stdout)
        self.assertEqual([(w["name"], w["used"]) for w in q["windows"]],
                         [("5 hours · Gemini", 12), ("7 days · Claude & GPT", 40)])

    def test_a_window_for_another_model_does_not_prompt(self):
        self.magpie(50, 20, fable=95)
        self.assertIsNone(self.hook(model="claude-opus-5-5"))
        self.assertIn("USAGE=claude:7d_Fable:95", self.hook(model="claude-fable-5-2"))

    def test_hook_asks_once_per_window_for_a_main_agent(self):
        self.magpie(50)
        self.assertIsNone(self.hook())
        self.magpie(91)
        note = self.hook()
        self.assertIn("CC_HANDOFF=usage USAGE=claude:5h:91", note)
        self.assertIn(str(self.run_dir), note)
        self.assertIn("AskUserQuestion", note)
        self.assertIsNone(self.hook())  # once
        self.magpie(95, 93)
        self.assertIn("USAGE=claude:7d:93", self.hook())  # another window
        self.assertIsNone(self.hook())

    def test_hook_stays_quiet_when_not_the_main_agent(self):
        self.magpie(95)
        self.assertIsNone(self.hook(sid="other", HC_TERMINAL_ID="t9"))  # dispatches nothing here
        self.assertIsNone(self.hook(HC_TERMINAL_ID=""))  # not in herdr
        (self.run_dir / "control.json").write_text(json.dumps({"state": "handoff"}))
        self.assertIsNone(self.hook())  # already handing off
        (self.run_dir / "control.json").write_text(json.dumps({"state": "running", "owner": "t5"}))
        self.assertIsNone(self.hook())  # adopted by another main agent
        (self.run_dir / "control.json").write_text(json.dumps({"state": "running"}))
        (self.root / "quota.json").unlink()
        self.assertIsNone(self.hook())  # nothing known

    def test_settings_add_the_hook_and_take_out_the_old_status_line(self):
        f = self.root / "settings.json"
        me = "python3 /x/hd_usage.py"
        f.write_text(json.dumps({"model": "x", "statusLine": {"type": "command", "padding": 1, "refreshInterval": 30,
                                 "command": f"{me} statusline --refresh-added --inner 'echo hi'"}}))
        r = self.sh("settings", "--file", str(f))
        self.assertIn("BACKUP=", r.stdout)
        s = json.loads(f.read_text())
        self.assertEqual(s["statusLine"], {"type": "command", "padding": 1, "command": "echo hi"})
        self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)
        self.assertIn("SETTINGS=unchanged", self.sh("settings", "--file", str(f)).stdout)
        self.sh("settings", "--file", str(f), "--remove")
        self.assertEqual(json.loads(f.read_text()), {"model": "x", "statusLine": {"type": "command", "padding": 1, "command": "echo hi"}})
        g = self.root / "old.json"
        g.write_text(json.dumps({"statusLine": {"type": "command", "command": f"{me} statusline", "refreshInterval": 30}}))
        self.sh("settings", "--file", str(g))
        self.assertEqual(set(json.loads(g.read_text())), {"hooks"})
        self.sh("settings", "--file", str(g), "--remove")
        self.assertEqual(json.loads(g.read_text()), {})


if __name__ == "__main__":
    unittest.main()
