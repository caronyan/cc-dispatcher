# Codex 不可用时：降级、暂停、续跑

cc-herdr-dispatch-research 的 SKILL.md"Codex 不可用时"一节的 FAILURE 表指向这里。只在需要降级、暂停或续跑时读。

**代替 Codex**：用 Agent 工具启动 general-purpose 子 agent，接替 Codex 在当前阶段的角色。子 agent 有全新的上下文，不知道你的判断和 `criteria.md`，这是它能部分保留独立性的原因，所以只给它 Codex 本来会收到的输入：
- **调研线程**：给它 [investigator.md](investigator.md) 中的线程提示（含 brief 和子问题），要求按 [findings.schema.json](findings.schema.json) 的字段输出。spike 线程让它在 spike worktree 里做实验。多个线程可以并行启动多个子 agent。
- **备选方案**：给它"备选方案提示"，按 [options.schema.json](options.schema.json) 的字段输出。在它运行期间，你照常背对背列自己的方案。

核实、综合、出方案的做法都不变。把降级的阶段记入 `state.json.degraded_stages`。

**暂停**：把 `state.json` 写完整，告诉用户之后执行 `/cc-herdr-dispatch-research .cc-dispatch/research-$RUN` 续跑。

**续跑与恢复**：参数指向一个已有的 `research-*` 目录时，先读 `state.json` 和已有的 `brief.md`、`research.md`，从中断的阶段继续。先运行 `hd_dispatch.py probe`：返回 `none` 时把 `codex` 改回 `available`。如果有降级过的阶段，问用户是否用 Codex 把这些阶段重跑一遍，补回不同模型的视角。
