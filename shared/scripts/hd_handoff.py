"""Handoff packages for hd_dispatch.py: what one agent leaves so another can carry on its work.

A package is a folder (a helper's: <run>/agents/<call>/handoff/r<k>/; a dispatcher's: <run>/handoff/<seq>/):
  handoff.json   for scripts: format, level, who handed off and why, where the work is, the snapshot
  handoff.md     for the receiving agent: the task, the progress note, the worktree, the session's last
                 commands and messages, the screen, what to do first
  prompt.md      the receiver's first message (a helper's goes into its next task file)
  changes.diff   the worktree's uncommitted changes against HEAD, in full (write/net helpers)
  progress.md    the helper's own note, when it wrote one before it was stopped
  notes.md       the dispatcher's own note (<run>/handoff-notes.md), copied as it was
  state.json     the dispatcher's run state (state.json), copied as it was
Everything is built from disk (task files, git, the session logs), so a package can be made for a helper
whose terminal is long gone. Any agent that can run the cc-herdr-dispatch skills can read it.
"""
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

FORMAT = "cc-dispatch-handoff/1"
DIFF_LINES = 400        # of the diff shown in handoff.md; changes.diff has all of it
COMMANDS = 15
MESSAGES = 4


def git(d, *args, env=None):
    r = subprocess.run(["git", "-C", str(d), *args], capture_output=True, text=True,
                       env=dict(os.environ, **(env or {})))
    return r.stdout if r.returncode == 0 else None


def is_repo(d) -> bool:
    return bool(d) and Path(d).is_dir() and git(d, "rev-parse", "--git-dir") is not None


def snapshot(d, ref: str, message: str):
    """Commit the worktree as it is (tracked and untracked files, .gitignore respected) to `ref` without
    touching HEAD, the index or any branch. Returns the commit, or None when `d` is not a git worktree."""
    if not is_repo(d) or not git(d, "rev-parse", "--verify", "HEAD"):
        return None
    fd, idx = tempfile.mkstemp(prefix="cc-freeze-idx-")
    os.close(fd)
    os.unlink(idx)  # git wants to create the index itself
    env = {"GIT_INDEX_FILE": idx, "GIT_AUTHOR_NAME": "cc-dispatch", "GIT_AUTHOR_EMAIL": "cc-dispatch@localhost",
           "GIT_COMMITTER_NAME": "cc-dispatch", "GIT_COMMITTER_EMAIL": "cc-dispatch@localhost"}
    try:
        if git(d, "read-tree", "HEAD", env=env) is None or git(d, "add", "-A", env=env) is None:
            return None
        # the dispatcher's own records are not the helper's work
        git(d, "rm", "-r", "-q", "--cached", "--ignore-unmatch", ".cc-dispatch", env=env)
        tree = (git(d, "write-tree", env=env) or "").strip()
        commit = (git(d, "commit-tree", tree, "-p", "HEAD", "-m", message, env=env) or "").strip()
        if not commit or git(d, "update-ref", ref, commit) is None:
            return None
        return commit
    finally:
        try:
            os.unlink(idx)
        except OSError:
            pass


def worktree(d, base=None, snap=None) -> dict:
    """Branch, status, commits since `base`, diff stat against base (or HEAD) and the uncommitted diff.
    With `snap` (a snapshot commit) the diffs are taken against it, so new untracked files show too."""
    if not is_repo(d):
        return {}
    head = (git(d, "rev-parse", "HEAD") or "").strip()
    since = base if base and base != head else None
    to = [snap] if snap else []
    return {
        "branch": (git(d, "rev-parse", "--abbrev-ref", "HEAD") or "").strip(),
        "head": head,
        "base": base,
        "status": (git(d, "status", "--short") or "").rstrip(),
        "log": (git(d, "log", "--oneline", f"{since}..HEAD") or "").rstrip() if since else "",
        "stat": (git(d, "diff", "--stat", base or "HEAD", *to) or "").rstrip(),
        "diff": git(d, "diff", "HEAD", *to) or "",
    }


WHY = {"manual": "负责人决定移交", "context_limit": "它的会话上下文满了", "quota": "它所用 agent 的额度用完了",
       "usage": "负责人自己的用量快到上限", "lost": "它的终端意外断了",
       "recover": "它的终端意外断了（herdr 重启、崩溃或终端被关），这次运行由 recover 恢复",
       "takeover": "它的会话已经不在了（终端被关、程序退出或 herdr 重启），没来得及交接",
       "forced": "用户让你接手（它还开着，但之后再操作这次运行会被拒绝）"}


def why_words(why: str) -> str:
    return WHY.get(why, why)


# ---- what the session did --------------------------------------------------------------------------

def _exit_code(text):
    for line in (text or "").splitlines()[:6]:
        for head in ("Process exited with code ", "Exit code: "):
            if line.startswith(head):
                try:
                    return int(line[len(head):].split()[0])
                except ValueError:
                    return None
    return None


def _out_tail(text, n=2):
    body = (text or "").split("\nOutput:\n", 1)[-1]
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    return " | ".join(lines[-n:])[:200]


def _noise(text):
    t = text.lstrip()
    return t.startswith(("<environment_context", "<user_instructions", "<skills_instructions", "# AGENTS.md",
                         "<permissions", "<collaboration_mode"))


def codex_digest(paths) -> dict:
    """The last plan, commands (with exit codes), patched files and messages of Codex session logs."""
    d = {"plan": None, "commands": [], "files": [], "messages": [], "asked": []}
    pending = {}
    for path in paths or []:
        try:
            f = open(path, "rb")
        except OSError:
            continue
        with f:
            for raw in f:
                if not any(k in raw for k in (b'"function_call', b'"custom_tool_call"', b'"message"')):
                    continue
                try:
                    p = json.loads(raw).get("payload") or {}
                except ValueError:
                    continue
                kind, name = p.get("type"), p.get("name")
                if kind == "function_call":
                    try:
                        args = json.loads(p.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    if name in ("exec_command", "shell", "container.exec"):
                        cmd = args.get("cmd") or args.get("command")
                        if isinstance(cmd, list):
                            cmd = " ".join(cmd[2:] if cmd[:2] in (["bash", "-lc"], ["/bin/zsh", "-lc"], ["zsh", "-lc"]) else cmd)
                        c = {"cmd": str(cmd or "")[:300], "exit": None}
                        d["commands"].append(c)
                        pending[p.get("call_id")] = c
                    elif name == "update_plan":
                        d["plan"] = args.get("plan") or d["plan"]
                elif kind == "function_call_output" and p.get("call_id") in pending:
                    c = pending.pop(p["call_id"])
                    out = p.get("output")
                    out = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
                    c["exit"] = _exit_code(out)
                    if c["exit"]:
                        c["tail"] = _out_tail(out)
                elif kind == "custom_tool_call" and name == "apply_patch":
                    for line in (p.get("input") or "").splitlines():
                        for head in ("*** Add File: ", "*** Update File: ", "*** Delete File: "):
                            if line.startswith(head):
                                f_ = line[len(head):].strip()
                                if f_ in d["files"]:
                                    d["files"].remove(f_)
                                d["files"].append(f_)
                elif kind == "message" and p.get("role") in ("assistant", "user"):
                    text = "\n".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict)).strip()
                    if not text or _noise(text):
                        continue
                    (d["messages"] if p["role"] == "assistant" else d["asked"]).append(text[:1500])
    d["commands"] = d["commands"][-COMMANDS:]
    d["files"] = d["files"][-30:]
    d["messages"] = d["messages"][-MESSAGES:]
    d["asked"] = d["asked"][-3:]
    return d


def claude_digest(path) -> dict:
    """The same from a Claude Code transcript (a helper that ran as Claude Code)."""
    d = {"plan": None, "commands": [], "files": [], "messages": [], "asked": []}
    pending = {}
    try:
        f = open(path, encoding="utf-8")
    except (OSError, TypeError):
        return d
    with f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            content = (e.get("message") or {}).get("content")
            if e.get("type") == "user" and isinstance(content, str):
                if not content.lstrip().startswith("<"):
                    d["asked"].append(content[:1500])
                continue
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    if b.get("name") == "Bash":
                        c = {"cmd": str(inp.get("command", ""))[:300], "exit": None}
                        d["commands"].append(c)
                        pending[b.get("id")] = c
                    elif b.get("name") in ("Edit", "Write", "MultiEdit", "NotebookEdit") and inp.get("file_path"):
                        fp = inp["file_path"]
                        if fp in d["files"]:
                            d["files"].remove(fp)
                        d["files"].append(fp)
                    elif b.get("name") == "TodoWrite":
                        d["plan"] = [{"step": t.get("content"), "status": t.get("status")} for t in inp.get("todos") or []]
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    c = pending.pop(b["tool_use_id"])
                    c["exit"] = 1 if b.get("is_error") else 0
                    if b.get("is_error"):
                        t = b.get("content")
                        t = t if isinstance(t, str) else json.dumps(t, ensure_ascii=False)
                        c["tail"] = _out_tail(t)
                elif b.get("type") == "text" and e.get("type") == "assistant" and b.get("text", "").strip():
                    d["messages"].append(b["text"].strip()[:1500])
    d["commands"] = d["commands"][-COMMANDS:]
    d["files"] = d["files"][-30:]
    d["messages"] = d["messages"][-MESSAGES:]
    d["asked"] = d["asked"][-3:]
    return d


def claude_transcript(session, cwd=None):
    """A Claude Code session's transcript path, or None."""
    if not session:
        return None
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    if cwd:
        p = root / "".join(c if c.isalnum() else "-" for c in str(cwd)) / f"{session}.jsonl"
        if p.exists():
            return str(p)
    found = sorted(root.glob(f"*/{session}.jsonl"))
    return str(found[0]) if found else None


# ---- writing it out --------------------------------------------------------------------------------

def _fence(text, lang=""):
    fence = "~~~~" if "```" in text else "```"
    return f"{fence}{lang}\n{text.rstrip()}\n{fence}"


def digest_md(dg: dict) -> list:
    out = []
    if dg.get("plan"):
        out += ["### 最后的计划", ""]
        out += [f"- [{'x' if s.get('status') == 'completed' else '~' if s.get('status') == 'in_progress' else ' '}] "
                f"{s.get('step')}" for s in dg["plan"]] + [""]
    if dg.get("commands"):
        out += [f"### 最后 {len(dg['commands'])} 条命令", ""]
        for c in dg["commands"]:
            mark = "?" if c.get("exit") is None else c["exit"]
            out.append(f"- `[{mark}]` `{c['cmd'].replace('`', 'ˋ').splitlines()[0][:200]}`"
                       + (f" → {c['tail']}" if c.get("tail") else ""))
        out.append("")
    if dg.get("files"):
        out += ["### 改过的文件（按最后修改先后）", ""] + [f"- `{f}`" for f in dg["files"]] + [""]
    if dg.get("asked"):
        out += ["### 负责人最近发给它的消息", ""]
        for m in dg["asked"]:
            out += [_fence(m), ""]
    if dg.get("messages"):
        out += ["### 它最后说的话", ""]
        for m in dg["messages"]:
            out += [_fence(m), ""]
    return out


def worktree_md(wt: dict) -> list:
    if not wt:
        return []
    out = [f"分支 `{wt.get('branch')}`，HEAD `{(wt.get('head') or '')[:12]}`"
           + (f"，开工时 `{wt['base'][:12]}`" if wt.get("base") else ""), ""]
    if wt.get("log"):
        out += ["开工以来的提交：", "", _fence(wt["log"]), ""]
    out += ["`git status --short`：", "", _fence(wt.get("status") or "(干净)"), ""]
    if wt.get("stat"):
        out += [f"相对 {'开工时' if wt.get('base') else 'HEAD'} 的改动：", "", _fence(wt["stat"]), ""]
    diff = wt.get("diff") or ""
    if diff:
        lines = diff.splitlines()
        cut = len(lines) > DIFF_LINES
        out += [f"未提交的 diff{f'（前 {DIFF_LINES} 行，共 {len(lines)} 行，全文见 changes.diff）' if cut else ''}：", "",
                _fence("\n".join(lines[:DIFF_LINES]), "diff"), ""]
    return out


def write(pkg: Path, data: dict, md: list, prompt: str, diff: str = "", progress: str = None, extra: dict = None) -> Path:
    pkg.mkdir(parents=True, exist_ok=True)
    data = {"format": FORMAT, "created": int(time.time()), **data}
    files = ["handoff.json", "handoff.md", "prompt.md"]
    for name, text in (extra or {}).items():
        (pkg / name).write_text(text)
        files.append(name)
    if diff:
        (pkg / "changes.diff").write_text(diff)
        files.append("changes.diff")
    if progress:
        (pkg / "progress.md").write_text(progress)
        files.append("progress.md")
    data["files"] = files
    (pkg / "handoff.md").write_text("\n".join(md).rstrip() + "\n")
    (pkg / "prompt.md").write_text(prompt.rstrip() + "\n")
    (pkg / "handoff.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return pkg


def read(pkg) -> dict:
    """A package's handoff.json, checked: raises ValueError with the reason when it is not one."""
    p = Path(pkg)
    if p.name == "handoff.json":
        p = p.parent
    try:
        data = json.loads((p / "handoff.json").read_text())
    except (OSError, ValueError) as e:
        raise ValueError(f"no readable handoff.json in {p}: {e}")
    if data.get("format") != FORMAT:
        raise ValueError(f"{p}: format {data.get('format')!r}, expected {FORMAT}")
    missing = [f for f in data.get("files") or [] if not (p / f).exists()]
    if missing:
        raise ValueError(f"{p}: missing {', '.join(missing)}")
    data["_dir"] = str(p)
    return data


# ---- a helper's package ----------------------------------------------------------------------------

def helper_package(meta: dict, run: Path, why: str, digest: dict, screen: str = "", progress: str = None) -> Path:
    """Write the package a frozen helper leaves: <agent_dir>/handoff/r<round>/."""
    k = meta["round"]
    fz = meta.get("frozen") or {}
    agent_dir = Path(meta["agent_dir"])
    pkg = agent_dir / "handoff" / f"r{k}"
    wt = worktree(meta["dir"], meta.get("base"), fz.get("snapshot")) if meta["mode"] != "read" else {}
    task = agent_dir / f"task-{k}.md"
    task_text = task.read_text() if task.exists() else "(任务文件不见了)"
    earlier = [str(agent_dir / f"task-{i}.md") for i in range(1, k) if (agent_dir / f"task-{i}.md").exists()]
    report = Path(meta["report"])
    kept = agent_dir / f"report-r{k}.json"
    agent = meta.get("agent") or "codex"
    data = {
        "level": "helper", "why": why,
        "from": {"agent": agent, "name": meta.get("name"), "address": meta.get("address"),
                 "session": meta.get("agent_session"), "rollouts": meta.get("rollouts") or []},
        "run": str(run), "kind": run.name.split("-", 1)[0], "call": meta["call"], "round": k,
        "mode": meta["mode"], "dir": meta["dir"], "report": meta["report"], "schema": meta["schema"],
        "task": str(task), "earlier_tasks": earlier,
        "snapshot": {"ref": fz.get("snapshot_ref"), "commit": fz.get("snapshot"), "base": meta.get("base")},
    }
    md = [
        f"# 交接：{meta['call']}（第 {k} 轮）",
        "",
        f"上一位子 agent（{agent}，终端 `{meta.get('name')}`）因为**{why_words(why)}**停下，它的工作交给你接着做。"
        "下面是它停下时留下的全部线索。原任务的要求不变：照原任务文件做完、按 schema 写回报。",
        "",
        "## 原任务",
        "",
        f"任务文件 `{task}`" + (f"（更早的几轮：{', '.join(f'`{e}`' for e in earlier)}）" if earlier else "") + "：",
        "",
        _fence(task_text, "markdown"),
        "",
        "## 它自己写的进度说明",
        "",
        progress.strip() if progress and progress.strip() else "（没有：它停下前没能写。以下面的工作区和会话记录为准。）",
        "",
    ]
    if meta["mode"] != "read":
        md += ["## 工作区", "", f"`{meta['dir']}`"
               + (f"；停下时的完整状态另存为 `{fz.get('snapshot_ref')}`（`{(fz.get('snapshot') or '')[:12]}`）" if fz.get("snapshot") else ""),
               ""] + worktree_md(wt)
    md += ["## 它的会话", ""] + (digest_md(digest) or ["（找不到会话记录。）", ""])
    if screen.strip():
        tail = "\n".join(screen.rstrip().splitlines()[-40:])
        md += ["## 停下时的屏幕（最后 40 行）", "", _fence(tail), ""]
    md += [
        "## 回报",
        "",
        f"写到 `{report}`（覆盖），schema `{meta['schema']}`。"
        + (f" 它这一轮写过的回报留在 `{kept}`，可以参考，但以你核实后的结果为准。" if kept.exists() else ""),
        "",
        "## 先做这几件事",
        "",
        "1. 读完原任务和上面的进度说明。",
        "2. 核实工作区：改动是否和说明一致、验收命令现在是什么结果。" if meta["mode"] != "read" else
        "2. 核实它已有的结论，没有依据的重新查。",
        "3. 从没做完的地方接着做，已经做完并核实过的不要重做；走不通的路不要再走一遍。",
        "4. 按原任务的要求写回报，最后一句只写\"回报已写入 <路径>\"。",
    ]
    prompt = (f"你接手的是另一个子 agent 没做完的工作（任务 {meta['call']}，原因：{why_words(why)}）。"
              f"先读交接说明 {pkg / 'handoff.md'}，它包含原任务、进度、工作区现状和上一位最后做的事；"
              f"然后按其中\"先做这几件事\"接着完成原任务。工作目录、回报文件和 schema 不变。")
    return write(pkg, data, md, prompt, diff=wt.get("diff", ""), progress=progress)


# ---- a dispatcher's package ------------------------------------------------------------------------

STATE_LINES = 200


def _cell(v):
    return str(v if v not in (None, "") else "—").replace("|", "\\|").replace("\n", " ")


def dispatcher_package(run: Path, pkg: Path, why: str, frm: dict, calls: list, notes, hd: str,
                       control: dict, children=None) -> Path:
    """Write the package a dispatcher (the main agent) leaves for the next one: <run>/handoff/<seq>/.
    `calls`: one dict per call (call name agent round mode state status report failure frozen task
    report_path open); `frm`: {terminal, agent, session, space}; `control`: the run's state before the handoff."""
    kind = run.name.split("-", 1)[0]
    skill = f"cc-herdr-dispatch-{kind if kind in ('research', 'review', 'fix', 'test', 'retro') else 'dev'}"
    root = run.parent.parent
    state_path = run / "state.json"
    state = state_path.read_text() if state_path.exists() else None
    wt = worktree(root) if is_repo(root) else {}
    live = [c for c in calls if c.get("state") == "live"]
    data = {
        "level": "dispatcher", "why": why, "from": frm, "run": str(run), "kind": kind, "skill": skill,
        "root": str(root), "hd": hd, "control": control, "children": children or [],
        "calls": calls, "state": str(state_path) if state is not None else None,
    }
    md = [
        f"# 交接：主 agent（运行 `{run.name}`）",
        "",
        f"上一位主 agent（{frm.get('agent') or '未知'}，终端 `{frm.get('terminal') or '?'}`）因为**{why_words(why)}**，"
        f"把 {skill} 这次运行的主 agent 工作交给你。" + (
            "中断的子 agent 已由 recover 在原会话（找不到时是新会话）里重开，运行处于暂停：它们停着，等你和用户确认后再继续。"
            if why == "recover" else "上一位没来得及交接就离开了：下面若有交接说明，可能是更早写的，以 state.json、log 和各调用的回报为准。还在干活的子 agent 没有停，你接手后照常收它们的回报。"
            if why == "takeover" else "子 agent 没有停：在干活的继续干，你接手后照常收它们的回报。"),
        "",
        "## 接手步骤",
        "",
        f"1. 加载 skill `{skill}`（读它的 SKILL.md 和其中引用的 herdr.md），按它的规则做主 agent。`$HD` 是 `{hd}`，`$RD` 是 `{run}`。",
        f"2. 读完下面上一位写的交接说明、子 agent 表和 state.json。",
        f"3. 运行 `python3 {hd} adopt --run {run} --from {pkg}`：把子 agent 记到你的终端名下。"
        "已经用 `takeover` 接手的（输出 `TAKEOVER=adopted`）跳过这步。",
        "4. 用几句话向用户复述：在做什么、做到哪、哪些子 agent 还在跑、你打算的下一步；用户确认之前不派发、不 `send`、不合并、不清理。",
        (f"5. 用户确认后，先运行一次 `collect`，再运行 `python3 {hd} resume --run {run}` 让暂停的子 agent 接着做，然后照常 `wait`。"
         if why == "recover" else "5. 用户确认后，先运行一次 `collect`，再照常 `wait`。"),
        "",
        "## 上一位主 agent 写的交接说明",
        "",
        notes.strip() if notes and notes.strip() else "（没有写。以下面的子 agent 表、state.json 和各调用的回报为准，并先问用户这次运行要做成什么。）",
        "",
        "## 这次运行",
        "",
        f"- skill：`{skill}`；运行目录 `{run}`；仓库 `{root}`",
        f"- 交接前的运行状态：`{(control or {}).get('state', 'running')}`"
        + (f"（暂停时打断的调用：{', '.join(control.get('held') or []) or '无'}）" if (control or {}).get("state") == "paused" else ""),
    ]
    if children:
        md.append(f"- 它调用的下层运行：{', '.join(f'`{c}`' for c in children)}")
    md += ["", "## 子 agent", ""]
    if calls:
        md += ["| 调用 | agent | 轮次 | 模式 | 终端 | 状态 | 回报 | 失败 |", "|---|---|---|---|---|---|---|---|"]
        for c in calls:
            md.append("| " + " | ".join(_cell(x) for x in (
                f"`{c['call']}`", c.get("agent"), c.get("round"), c.get("mode"),
                f"`{c.get('name')}` " + ("在" if c.get("state") == "live" else "已关"),
                c.get("status"), c.get("report"), c.get("failure"))) + " |")
        md.append("")
        for c in calls:
            bits = [f"任务 `{c.get('task')}`", f"回报 `{c.get('report_path')}`"]
            if c.get("frozen"):
                bits.append(f"已冻结，交接包 `{c['frozen']}`")
            md.append(f"- `{c['call']}`：" + "；".join(bits))
        md.append("")
        md.append(f"还开着的终端：{', '.join('`' + str(c.get('name')) + '`' for c in live) or '无'}。")
        md.append("")
    else:
        md += ["（还没有派发过子 agent。）", ""]
    md += ["## state.json", ""]
    if state is None:
        md += ["（没有 state.json。）", ""]
    else:
        lines = state.splitlines()
        md += [f"`{state_path}`" + (f"（前 {STATE_LINES} 行，全文见包里的 state.json）" if len(lines) > STATE_LINES else "") + "：", "",
               _fence("\n".join(lines[:STATE_LINES]), "json"), ""]
    if wt:
        md += ["## 仓库", "", f"`{root}`", ""] + worktree_md({k: v for k, v in wt.items() if k != "diff"})
    prompt = (f"你将接手 herdr 里 {skill} 一次运行的主 agent 工作（运行目录 {run}，原因：{why_words(why)}）。"
              f"先读交接说明 {pkg / 'handoff.md'}，按其中\"接手步骤\"做：加载 {skill}、运行 adopt、向我复述现状。"
              "我确认之前，不要派发、发送、合并或清理。")
    extra = {}
    if notes and notes.strip():
        extra["notes.md"] = notes
    if state is not None:
        extra["state.json"] = state
    return write(pkg, data, md, prompt, extra=extra)
