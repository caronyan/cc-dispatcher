# Codex 不可用时：降级、暂停、续跑

cc-herdr-dispatch-dev 的 SKILL.md"Codex 不可用时"一节的 FAILURE 表指向这里。只在需要降级、暂停或续跑时读。

**降级决策**：
- `checkpoints=on`：用 AskUserQuestion 让用户选择：**Claude 接管剩余任务 / 暂停，等额度恢复后续跑 / 中止**。如果能用 magpie-quota skill 查到 Codex 额度的重置时间，把时间写进问题里，帮用户判断要不要等。
- `checkpoints=off`：直接由 Claude 接管，在报告里注明。

**Claude 接管**：
1. 受影响的每张卡在 `state.json` 中标记 `degraded: true`，负责人改为 `claude`。
2. 如果 worktree 里已经有 Codex 写了一半的改动，先读 diff，判断能否沿用：能沿用就在其基础上写完，不能就 `git checkout . && git clean -fd` 后重写。
3. 你按任务卡实现，并亲自跑验收命令。
4. **验收交给独立的审查者**，避免写代码的人自己验收：用 Agent 工具启动一个 general-purpose 子 agent，只给它任务卡、`contracts.md`、worktree 路径和 [acceptance.md](acceptance.md)，让它按验收步骤给出结论和问题清单。你按它的清单修改，修完后让它再验一次。之后按 4.6 照常合并。

**暂停**：把 `state.json` 写完整（每张卡的状态、调用名、已完成的轮次），然后告诉用户如何续跑：重新执行 `/cc-herdr-dispatch-dev .cc-dispatch/$RUN`（或在新会话里说"用 cc-herdr-dispatch-dev 接着之前的运行"）。

**续跑与恢复**：参数指向一个已有的运行目录、或用户要你接着之前的运行时，先按 shared/herdr.md"接手运行"做完 `takeover`（你本来就是它的主 agent 时输出 `TAKEOVER=self`，照样往下）。然后读 `state.json`，跳过已合入的卡。如果 `codex` 是 `unavailable`，先运行 `hd_dispatch.py probe`：返回 `none` 就把它改回 `available`，尚未开始的卡和被暂停的卡交还给 Codex；已经由 Claude 接管、正在进行的卡由 Claude 继续完成。
