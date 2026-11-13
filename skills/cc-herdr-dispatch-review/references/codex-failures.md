# Codex 不可用时：降级、暂停、续跑

cc-herdr-dispatch-review 的 SKILL.md"Codex 不可用时"一节的 FAILURE 表指向这里。只在需要降级、暂停或续跑时读。

**代替 Codex**：用 Agent 工具启动 general-purpose 子 agent，接替 Codex 在当前阶段的角色。子 agent 有全新的上下文，不知道你的审查结论，这是它能部分保留独立性的原因，所以只给它 Codex 本来会收到的输入：
- **交叉审查**：给它 reviewer-prompt 和 `target.md`，要求它按 [review.schema.json](review.schema.json) 的字段输出。在它运行期间，你照常背对背写 `claude-review.md`。
- **反例测试**：给它 [counterexample.md](counterexample.md) 中的首轮提示，按 [counterexample.schema.json](counterexample.schema.json) 的字段输出。代码模式下，让它在快照 worktree 里写复现测试并运行。
- **复查**：每轮都启动新的子 agent，把之前各轮的反例与处理结果作为上下文给它。

分诊、补强、终止条件都不变。把降级的阶段记入 `state.json.degraded_stages`。

**暂停**：把 `state.json` 写完整，告诉用户之后执行 `/cc-herdr-dispatch-review .cc-dispatch/review-$RUN` 续跑。

**续跑与恢复**：参数指向一个已有的 `review-*` 目录时，先读 `state.json`，从中断的阶段继续。先运行 `hd_dispatch.py probe`：返回 `none` 时把 `codex` 改回 `available`。如果有降级过的阶段，问用户是否用 Codex 把这些阶段重跑一遍，补回不同模型的视角。
