---
name: cc-herdr-dispatch-research
description: "herdr 内的调研与出方案：Claude 立题、核实、综合，子 agent（默认 Antigravity / Gemini 4 Neon，不可用时自动换 Codex）并行调研代码、资料和可行性，并独立给出备选方案"
user-invocable: true
disable-model-invocation: true
argument-hint: "[调研问题 | 要出方案的需求 | 相关文件路径] [--topic <id> --task <tid> [--request <rid>]] [--parent .cc-dispatch/<run>]"
---

## 角色

你是**主编**兼**核查人**：定问题、拆线程、核实证据、写结论、选推荐方案。子 agent 是**调研员**（默认 Antigravity 的 Gemini 4 Neon，见第 2 步）：按线程读代码、查资料、跑最小实验，方案模式下另开一个调用独立给出备选方案。读代码、查资料、跑实验都交给子 agent，你只做 shared/herdr.md 里的小活。子 agent 的发现是线索不是结论：报告里每个关键结论（会左右回答或推荐的那些）都要经你亲手核实证据，但核实只看证据本身，不重新调研。

`$SKILL_DIR` 指本文件所在目录。**开始前先读 [shared/herdr.md](shared/herdr.md)**：前提（在 herdr 里）、分工与小活、skill 之间怎么调用、怎么派发和收回报（`$HD`、`$RD`）、调用失败的通用处理和通用守则都在那里，本文只写本 skill 特有的部分。

## 两种模式

- **调研模式**：要一个答案。"X 是怎么工作的""为什么会出现 Y""A 和 B 选哪个""这个库能不能满足 Z"。交付 `research.md`。
- **方案模式**：要一份能拿去实现的方案。"怎么做 X""设计一下 Y""出个方案"。交付 `research.md` + `plan.md`，`plan.md` 可以直接作为 cc-herdr-dispatch-dev 的输入。

带 `--task` 时从准备阶段得到的 `DETAIL` 判断，否则从 $ARGUMENTS 和对话判断；判断不了就默认调研模式，在结尾问用户要不要继续出方案。

## 运行状态

`$ROOT` 取 git 仓库根目录，不在仓库内时取当前目录。运行目录 `$RD=$ROOT/.cc-dispatch/research-$RUN/`（在仓库内时把 `.cc-dispatch/` 加进 `.git/info/exclude`）：

```
state.json         模式、问题、各线程（threads：以线程 id 为键，含 title/kind/NAME/status）、codex（available/unavailable）、degraded_stages
brief.md           立题：问题、背景与约束、范围、交付物
criteria.md        评估维度（选型或方案模式），在看到子 agent 结果之前写好
research.md        调研结论
plan.md            方案（方案模式）
agents/            hd_dispatch.py 的调用记录，调用名即线程 id（code、web、spike、options）
```

## 流程

### 0. 准备

按 shared/herdr.md 运行 `probe`，确认 Codex 可用。

如果 $ARGUMENTS 指向一个已有的 `.cc-dispatch/research-*` 目录，或用户要你续上、接手之前没做完或中断的运行（"接着上次的""续上""接手"，没给路径也算），这是续跑：先按 shared/herdr.md 的"接手运行"找到运行（没给路径时 `runs` 列出来问用户）并 `takeover`，向用户复述现状、等确认；再按 [references/codex-failures.md](references/codex-failures.md) 的"续跑与恢复"处理。

建好 `$RD` 并按上文排除 `.cc-dispatch/` 后，运行 `python3 $HD topic start --run "$RD"`，把收到的 `--topic`、`--task`、`--request`、`--parent` 及其值原样追加；`--topic`、`--task`、`--parent` 都没收到时，先按 shared/herdr.md「归到哪个 Topic」选 Topic；没有 `--task` 时加 `--title "<本次问题>"`。遇到 `REQUEST_STALE`、`TOPIC_PAUSED`、`TASK_TAKEN` 或 `KIND_MISMATCH` 就停下告诉用户，不继续启动；其余拒绝按 shared/herdr.md"Topic 与面板请求"处理。带 `--task` 时将输出的 `DETAIL` 按 JSON 解码作为立题输入，原有范围核对和用户确认照常进行。

### 1. 立题

写 `brief.md`：

- **问题**：一句话写清要回答什么、或要做什么决定。问题之下拆成几个子问题，每个都能单独回答。
- **背景与约束**：从对话和仓库里收集：技术栈与版本（看依赖清单）、必须兼容的东西、明确不做的事、时间或成本限制、用户已经排除的选项。
- **范围**：相关目录和文件（写到路径，能写到行范围更好）；外部对象写到名称和版本。
- **交付物**：调研模式或方案模式，以及"什么样的回答能让用户做决定"。

只有在歧义会改变调研方向时才用 AskUserQuestion 问用户，一次问完。

再**拆线程**（1–3 个，并行）：

| 线程 | 什么时候开 | 派发方式 |
|---|---|---|
| `code` 代码摸底 | 问题涉及现有代码：现状怎么工作、入口在哪、改动会波及哪里 | `--mode read --dir "$ROOT"` |
| `web` 外部调研 | 涉及库、服务、标准、业界做法、版本差异、已知坑 | `--mode read --dir "$ROOT"`（网页搜索默认开启；给它仓库是为了让它看到依赖版本） |
| `spike` 可行性验证 | 有一个能用最小实验回答的关键疑问（API 行为、性能量级、兼容性） | 一次性 worktree，`--mode write` |

spike 的 worktree：`git -C "$ROOT" worktree add --detach "$(dirname $ROOT)/.cc-dispatch-wt/$(basename $ROOT)/research-$RUN-spike" HEAD`，实验需要的依赖由你提前装好或软链过去。

完成标准：每个子问题都至少落在一个线程上；每个线程的范围写到具体路径或具体对象。范围越准，子 agent 探索得越少、越快。

### 2. 派发

按 [references/investigator.md](references/investigator.md) 构造每个线程的提示，同时派出：

```bash
python3 $HD run --run $RD --call <线程> --mode read --effort high \
  --dir "$ROOT" --schema "$SKILL_DIR/references/findings.schema.json" --prompt $RD/<线程>-prompt.md \
  --title "<子问题的中文短标题>"
```

不写 `--agent`：research 运行的子 agent 默认是 Antigravity（`agy`），模型 `gemini-4-neon-<effort>`；agy 没装、模型不可用或 Gemini 额度用完时脚本自动改派 Codex（全局默认模型），输出 `FALLBACK=agy→codex why=…`，运行中途因额度等原因停下的也会自动移交给 Codex 接着做（见 shared/herdr.md"派发"）。把输出的 `AGENT=` 记进 `state.json.threads.<线程>.agent`，报告里不必区分。用户点名要某个 agent 或模型时才加 `--agent`/`--model`。

子问题窄、范围在几个文件内的线程用 `--effort medium`。全部派出后按 shared/herdr.md 启动 `wait`，把每个线程的 `NAME` 写进 `state.json.threads`。

**子 agent 运行期间，你写 `criteria.md`**（选型问题和方案模式必写，纯事实类调研可跳过）：评估维度、各自的权重或底线（例如"必须支持 PG 16""运维成本优先于性能"），每条都要能追溯到 `brief.md` 的约束。在看到子 agent 的结果之前定下标准，避免被先看到的答案锚定：`criteria.md` 写完之前，`wait` 报回的回报先不读。

### 3. 核实与综合

逐条处理回报的 findings，给每条一个状态：

| 状态 | 判定 |
|---|---|
| **已核实** | 你亲自看过证据：打开引用的 `文件:行`（只读那一段）、用 WebFetch 打开关键来源、或在 spike worktree 里重跑实验命令（只看结果，见 shared/herdr.md"核对用最便宜的信号"） |
| **未核实** | 不左右结论的次要事实，照录并标注来源 |
| **不成立** | 证据与结论不符、来源过时或与代码现状矛盾；写明理由 |

左右回答或推荐的结论必须是"已核实"。线程之间互相矛盾、或某个子问题没有答案时，`send` 给该线程追问一次，问题写具体；每个线程最多追问一次，仍然没有答案就在报告里标为未解决。只有用户能回答的（内部约定、业务取舍、可用的账号或环境），按 shared/herdr.md「待决项」写成 `question`，报告里照样列出。一个线程的结论都处理完后 `cleanup` 它。

写 `research.md`：

```
# <问题>
## 结论
<直接回答，3–5 句；选型问题给出推荐与一句理由>
## 子问题
### <子问题 1>
<回答> —— 证据：<文件:行 | 链接 | 实验命令与结果>（已核实 | 未核实）
## 不成立或已排除
- <被推翻的说法及理由>
## 未解决
- <问题>：需要 <什么信息/谁来确认> 才能回答
```

完成标准：`brief.md` 的每个子问题要么有回答，要么列在"未解决"里并写明需要什么；结论一节的每句话都能指到一条已核实的证据。

调研模式到这里进入第 5 步。

### 4. 出方案（方案模式）

1. **背对背出备选**：开一个新调用（不发给调研线程，避免沿用调研员的倾向），给它 `brief.md`、`research.md`、`criteria.md`，按 [references/investigator.md](references/investigator.md) 的"备选方案提示"要 2–3 个方案：
   ```bash
   python3 $HD run --run $RD --call options --mode read --effort high \
     --dir "$ROOT" --schema "$SKILL_DIR/references/options.schema.json" --prompt $RD/options-prompt.md
   ```
   派出后启动 `wait`。它运行期间，你独立列出自己的 2–3 个方案（写在 `plan.md` 草稿的"方案对比"里），写完之前不读它的回报。
2. **合并与选择**：把双方方案去重合并成一张对比表，按 `criteria.md` 逐项打分；子 agent 提出而你没想到的方案，核实可行性再进表：要看的在小活范围内就自己看，否则 `send` 给 options，让它给出能证明可行的 `文件:行` 或来源，你只核对这些证据。选出推荐方案，理由逐条对应评估维度。
3. **写 `plan.md`**：

```
# <方案名>
## 背景与目标
## 非目标
## 方案对比
| 方案 | 要点 | 优点 | 缺点 | 工作量 | 评分 |
## 推荐方案
### 设计       模块边界、接口签名、数据结构、关键流程；落到具体文件路径
### 实施步骤   按依赖排序；每步写清改哪些文件、如何验证
### 验收标准   可运行的命令或可观察的行为
### 风险与回滚
## 未决问题
```

4. **过度设计检查**：回看推荐方案，有没有为 speculative 风险加入的重型机制、只用一次的抽象、"以后可能用到"的配置项。精简为与已核实需求相称的最小做法。

完成标准：每个目标都有对应的设计和验收标准；推荐理由能对应到 `criteria.md` 的维度；实施步骤细到 cc-herdr-dispatch-dev 能据此拆卡。

### 5. 收尾

1. `python3 $HD cleanup --run $RD` 结束剩余的子 agent，删除 spike worktree（如有），保留 `.cc-dispatch/research-$RUN/` 作为记录。
2. 写好 `research.md`（方案模式同时写好 `plan.md`），运行 `python3 $HD topic finish --run "$RD" --line "<一句调研结论或推荐>" --artifact "$RD/research.md"`；方案模式把 `--artifact` 改为 `"$RD/plan.md"`。有下一步建议时可按 shared/herdr.md 用 `topic task-add` 提议 review 或 dev 草稿，不自动派发。
3. 输出最终报告：

```
## cc-herdr-dispatch-research：<问题>
<一句话结论或推荐>

### 要点
- <子问题>：<回答>（证据：…）

### 方案（方案模式）
推荐 <方案名>：<理由>。备选 <方案名>：<什么情况下改选它>
方案文件：<plan.md 路径>

### 未解决
- <问题>：需要 <什么>

记录目录：.cc-dispatch/research-$RUN/
```

4. 下一步提示：方案模式下，建议先用 `/cc-herdr-dispatch-review <plan.md 路径>` 做对抗审查，再用 `/cc-herdr-dispatch-dev <plan.md 路径>` 实现；调研模式下问用户要不要继续出方案。

如果有阶段因 Codex 不可用而降级，在一句话结论后面加一行：`⚠️ 降级：<阶段> 由 Claude 子 agent 代替 Codex 完成，与主编属同一系列模型，视角可能重合；建议额度恢复后重跑 /cc-herdr-dispatch-research .cc-dispatch/research-$RUN`。

## Codex 不可用时

agy 不可用时自动换 Codex 由脚本处理，不在这一节的范围内；这一节说的是 Codex 也用不了的情况（自动换过去的 Codex 调用报 `quota`/`other`，或 `probe` 不通过）。通用处理见 shared/herdr.md 的"调用失败"。本 skill 特有的规则：

- `quota`：用 AskUserQuestion 让用户选择：**Claude 子 agent 代替 Codex 继续 / 暂停，等额度恢复后续跑 / 到此结束，用已有材料出结论**。查到了额度重置时间就写进问题里。
- `other`：同一线程连续两次 `other`，按 `quota` 的降级处理。

降级、暂停、续跑与恢复的具体做法见 [references/codex-failures.md](references/codex-failures.md)，用到时再读。

## 守则

通用守则（只有你派发、输出控制、敏感文件、提交记录只写改动本身等）见 shared/herdr.md。另外：

- **证据跟着结论走**：报告里的事实性说法都带来源（`文件:行`、链接、实验命令）；推断写成推断，并说明依据。
- **控制读取量**：你只读核实所需的那一段，不通读子 agent 已经摸过的文件。
- 本 skill 只读用户的代码：改动只发生在 spike worktree 里，结论和方案写在 `.cc-dispatch/` 下。用户要求把方案放进仓库（例如 `docs/` 下）时，按仓库已有的文档约定放，正文不出现 skill 名、线程 id、Codex/Claude 分工这类流程信息。
