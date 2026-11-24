---
name: cc-herdr-dispatch-review
description: "herdr 内的方案/代码审查：Claude 与 Codex 子 agent（旁路加一个 Gemini 4 Neon）交叉审查，再由子 agent 找反例并用测试复现，Claude 分诊补强"
user-invocable: true
disable-model-invocation: true
argument-hint: "<方案文件路径 | diff/分支/PR | 审查主题> [--no-fix]"
---

## 角色

你是**防守方**兼**裁判**，按 shared/herdr.md 的分工，你的精力放在全局判断和分诊上，补强的实现在小活之外交给子 agent。审查分两段：**交叉审查**中你、Codex 子 agent 和旁路的 Gemini 子 agent 是平级的审查者，背对背各审一遍，由你搜集、整合、裁决；**反例测试**阶段子 agent 是验证工程师，专找对象在什么条件下不满足需求、能复现的写成复现测试，你负责分诊反例、补强对象，再交给子 agent 复查。你的立场是让对象经得起反例，不是捍卫原有写法：反例是否成立看证据，不看措辞，也不看最后谁让步。

发给子 agent 的一切都按 [references/counterexample.md](references/counterexample.md) 的"措辞"写：攻击性说法会被 OpenAI 的内容过滤拦下。

`$SKILL_DIR` 指本文件所在目录。**开始前先读 [shared/herdr.md](shared/herdr.md)**：前提（在 herdr 里）、分工与小活、skill 之间怎么调用、怎么派发和收回报（`$HD`、`$RD`）、调用失败的通用处理和通用守则都在那里，本文只写本 skill 特有的部分。

## 运行状态

`$ROOT` 取 git 仓库根目录，不在仓库内时取当前目录。运行目录 `$RD=$ROOT/.cc-dispatch/review-$RUN/`（在仓库内时把 `.cc-dispatch/` 加进 `.git/info/exclude`）：

```
state.json         模式、fix（on/off）、对象、快照 sha、各调用的 NAME、当前轮次、
                   codex（available/unavailable）、degraded_stages、children（调用过的 fix/test/dev 运行目录）
target.md          审查对象的描述（方案路径，或 diff 范围 + 文件列表）
claude-review.md   你的独立审查
cross.md           交叉审查合并结果（Codex、Gemini 旁路审查和你三方）
rounds/r<k>.md     第 k 轮反例的分诊表与补强记录
followup.md        需要重新设计、列为后续任务的问题（交给 cc-herdr-dispatch-dev 时作为输入）
agents/            hd_dispatch.py 的调用记录（reviewer、reviewer-gemini、stress-r1、checks-r1、stress-r2…）
```

## 流程

### 0. 确定对象与模式

先按 shared/herdr.md 运行 `probe`，确认 Codex 可用。

如果 $ARGUMENTS 指向一个已有的 `.cc-dispatch/review-*` 目录，或用户要你续上、接手之前没做完或中断的运行（"接着上次的""续上""接手"，没给路径也算），这是续跑：先按 shared/herdr.md 的"接手运行"找到运行（没给路径时 `runs` 列出来问用户）并 `takeover`，向用户复述现状、等确认；再按 [references/codex-failures.md](references/codex-failures.md) 的"续跑与恢复"处理。

- **方案模式**：参数是文档路径，或对话中刚产出的方案（`~/.claude/plans/` 下最近的文件也算）。补强 = 原地修改方案文件。
- **代码模式**：参数是 diff、分支、commit 范围或 PR 号，没有参数时默认审工作区相对 HEAD 的改动。冻结快照：`SNAP=$(git stash create); SNAP=${SNAP:-$(git rev-parse HEAD)}`（`git stash create` 不会改动工作区），后续子 agent 都审这个快照。补强 = 修复代码。

**修复开关**：$ARGUMENTS 带 `--no-fix`，或用户说"只审不修""只出报告"时，`state.json.fix` 设为 `off`：只审查、找反例和分诊，不改方案文件和代码，见第 4 步。默认 `on`。

完成标准：`target.md` 写清楚审什么、范围在哪、背景是什么（需求、约束、相关模块）。范围写到具体文件和行范围（代码模式附 `git diff --stat`），相关模块写到文件路径：范围越准，子 agent 探索得越少、越快。敏感文件不写进 target，也不发给子 agent。

### 1. 交叉审查（背对背）

1. **先派 Codex 审查者**（只读）：
   ```bash
   python3 $HD run --run $RD --call reviewer --mode read --effort high \
     --dir "$ROOT" --schema "$SKILL_DIR/references/review.schema.json" --prompt $RD/reviewer-prompt.md
   ```
   reviewer-prompt：严格的技术审查者，从正确性、可行性、完整性、边界条件、安全、性能、架构、可维护性、过度设计这些角度审查 `<target>`；每条意见要有位置、证据和建议。代码模式下告诉它审查 `git diff <base>..$SNAP`。告诉它先读 target 列出的文件，只为核实具体问题才扩大阅读范围，不遍历仓库，不跑全量测试。
   改动不到约 300 行（或方案不到约 3 页）时用 `--effort medium`。
   **同时派 Gemini 旁路审查者**：同一份 reviewer-prompt、同一个 schema、同样的 effort，交给 Antigravity 的 Gemini 4 Neon，与 Codex 审查者背对背：
   ```bash
   python3 $HD run --run $RD --call reviewer-gemini --agent agy --fallback none --mode read --effort high \
     --dir "$ROOT" --schema "$SKILL_DIR/references/review.schema.json" --prompt $RD/reviewer-prompt.md \
     --title "Gemini 复核"
   ```
   它是旁路，不顶替 Codex：`--fallback none` 让它在 agy 不可用（输出 `AGENT_UNAVAILABLE`，原因在同一行）时不派，运行中途失败时也不换成 Codex。不可用或失败时不重试、不改派，在 `state.json.gemini` 记 `unavailable` 和原因，继续只用 Codex 和你的两方结论，报告里注明。两个都派出后启动 `wait`，它们的 `NAME` 都写进 `state.json`。
2. **在子 agent 运行期间，你独立完成审查**，写入 `claude-review.md`，使用同样的字段（位置/问题/证据/建议/严重度）。写完之前不读两个审查者的回报（`wait` 报回了也先放着），这是背对背的意义所在。你审的是全局：需求是否达成、架构与模块边界、契约和跨模块影响、方案层面的遗漏；逐行细节由审查者覆盖。代码模式下先看 `git diff --stat`，改动超过约 300 行时只细读核心路径上的文件。
3. **合并**：你、Codex 审查者、Gemini 旁路审查者（有回报时）的结论逐条对齐、去重（同一位置同一问题算一条，记下哪几方提出），写入 `cross.md`，每条标来源（Claude / Codex / Gemini）。你只审了全局，审查者的逐行意见没有你的对应项是正常的，按"单方提出"核实：
   - **共识**（两方或三方都提出）：高置信，直接进入待修复清单。
   - **单方提出**：回到代码或方案中核实（只读那一段），结论只能是"成立"或"不成立"（附理由）；一条要读的超出小活范围时，`send` 给提出它的审查者让它补证据，不自己通读；核实不了的标为"存疑"。
   - **审查者之间矛盾**（例如 Codex 认为有问题、Gemini 认为没问题，或严重度、修法相反）：看证据裁决，写明采信哪一方和理由；证据不足以裁决时标为"存疑"。
   - **向用户确认**：存疑项、以及成立与否取决于只有用户知道的信息（需求意图、业务取舍、部署环境、可接受的风险）的条目，合并完一次性用 AskUserQuestion 问用户（每题说清是哪条意见、各方怎么说、你倾向哪边），同时按 shared/herdr.md「待决项」写成 `question` 或 `decision`。用户答复前，这些条目不进入修复清单。
4. **修复交叉审查发现的问题**，按第 4 步"补强"的分工和回归做（代码模式：小活自己改，其余交给 cc-herdr-dispatch-fix，改完调 cc-herdr-dispatch-test 回归并重新冻结 `$SNAP`），然后进入反例测试。高严重度问题必须修，低严重度问题可以记录下来留待以后。`fix=off` 时跳过这一步。

完成标准：`cross.md` 中每条意见都有明确结论（存疑项已问过用户并记下答复）；`fix=on` 时所有成立的 high 级问题都已修复。审查者用完后 `cleanup --call reviewer` 和 `cleanup --call reviewer-gemini`。

### 2. 反例测试

按 [references/counterexample.md](references/counterexample.md) 构造首轮提示，把 `cross.md` 中已确认的问题放进 `<known-issues>`，避免重复报告。

- **方案模式**：`--mode read --dir "$ROOT" --effort high`，子 agent 可以读代码，验证方案与现状是否相符。
- **代码模式**：为快照建一次性 worktree，让子 agent 在里面写复现测试并运行：
  ```bash
  git -C "$ROOT" worktree add --detach "$(dirname $ROOT)/.cc-dispatch-wt/$(basename $ROOT)/review-$RUN-r<k>" $SNAP
  ```
  使用 `--mode write --effort high`，`--dir` 指向该 worktree：复现测试只在本地运行，终端不联网。测试需要的依赖由你提前装好或软链过去。

两种模式下，子 agent 都能用网页搜索查依赖版本的已知问题和框架的已知陷阱。

schema 用 `$SKILL_DIR/references/counterexample.schema.json`，调用名 `stress-r<k>`。代码模式下对象涉及请求入口、权限、文件或 URL 处理时，同时派出只读的**校验点盘点**（调用名 `checks-r<k>`，提示见 counterexample.md），访问控制这一维度由它负责，不放进反例测试。派出后启动 `wait`。

### 3. 分诊

每个反例（含校验点盘点的 A 项）给出一个结论，写入 `rounds/r<k>.md`：

| 结论 | 判定依据 |
|---|---|
| **证实** | 你亲自重跑复现测试复现了；或者推理链每一步都能在代码/方案中找到对应 |
| **存疑** | 依赖你无法确认的外部条件（部署环境、流量规模、下游行为） |
| **驳回** | 前提条件不成立、已有防护（指出具体位置）、或者超出对象的职责范围；必须附证据 |

复现测试必须在 worktree 里亲自重跑，不能只看子 agent 写的 `confidence`。A 项没有复现，跟读它指出的那几行代码来判定。重跑时按通用守则控制输出：只看能判定成立与否的那几行。

### 4. 补强

`fix=off` 时整步跳过：证实项连同修复建议写进 `rounds/r1.md`，不改方案文件和代码，不进入第 5 步复查，直接到第 6 步收尾。

- 证实项：critical/high 必须补强；medium 视成本而定；low 记录下来。
- **方案模式**：直接原地修改方案文件，把补强写进对应的章节，而不是附在文末。
- **代码模式**：修复最终落在用户的工作区，默认不提交，提交由用户决定；用户要求提交时，按通用守则"提交记录只写改动本身"写说明，一个提交对应一组相关的修复，不按审查阶段或轮次拆分。每个修复都要把复现测试转成正式的回归测试（测试名描述被保护的行为，不用反例编号）。按量分三档：
  - 在小活范围内（一个文件、约 20 行以内、修法已确定），连同回归测试都很小：你直接在工作区改。
  - 其余修法明确的：本轮这些证实项合成一次交给 **cc-herdr-dispatch-fix**：用 Skill 工具调用，参数写 `<问题清单文件> 中的 <编号列表> --path "$ROOT" --parent .cc-dispatch/review-$RUN --no-regress`：反例阶段清单是 `.cc-dispatch/review-$RUN/rounds/r<k>.md`，再加 `--repro <本轮反例测试 worktree>/cc-repro`；交叉审查阶段清单是 `cross.md`，不带 `--repro`。它的运行目录记进 `state.json.children`。它交还的"未解决"项写进本轮记录，留到残余风险；"需要重新设计"项并入下一档。技能列表里没有 cc-herdr-dispatch-fix 时，这一档由你按同样的要求自己修。
  - 需要重新设计的（改接口契约、跨多个模块）：不在本次审查里修，写进 `followup.md`（问题、证据、约束、建议方向），收尾时问用户要不要交给 cc-herdr-dispatch-dev。

  **回归**：本轮有任何代码改动（含交叉审查阶段的修复）时，用 Skill 工具调用 **cc-herdr-dispatch-test**，参数写 `<本轮改动的文件列表> --parent .cc-dispatch/review-$RUN`（目标默认是当前工作区）。FAIL 中由本轮修复引起的 `product` 失败当作新的证实项，按上面三档再修一次（fix 用新调用）并复测；同一轮最多这样补修 2 次，仍失败就停止补强，写进残余风险。与本次修复无关、快照上本来就失败的，记进报告。技能列表里没有 cc-herdr-dispatch-test 时，你跑改动模块的测试（只看结果）。

  回归通过后重新冻结快照 `$SNAP`。
- 存疑项：写清楚需要什么信息才能下结论，最终报告中交给用户。

每轮向用户输出一个简短摘要：`第 k 轮：反例 N 条 → 证实 a / 存疑 b / 驳回 c；补强：...；回归：PASS | FAIL`。

### 5. 复查

- **方案模式**：把 counterexample.md 中的"复查提示"（含更新后的方案）`send` 给 `stress-r1`，同一个子 agent 接着复查。
- **代码模式**：为新快照建新的 worktree，开**新调用** `stress-r<k+1>`（`--dir` 指向新 worktree），把之前各轮的反例与处理结果作为上下文放进复查提示；派了校验点盘点的，它的 A 项也同样开新调用 `checks-r<k+1>` 复查。上一轮的调用 `cleanup`，worktree 删除。

回到第 3 步。**终止条件**（满足任一即停）：
- 子 agent 给出 `HOLDS`，或者本轮没有新的 critical/high 证实项；
- 已经跑满 3 轮；
- 连续两轮全部反例都被驳回：双方僵持，把争议点交给用户裁决。

### 6. 收尾

1. **过度设计检查**（仅方案模式，`fix=on`）：回看各轮补强，有没有为 speculative 级风险加入的重型机制、只用一次的抽象、"以后可能用到"的配置项。把这类补强精简为与已证实风险相称的最小做法，并说明理由。
2. `python3 $HD cleanup --run $RD` 结束剩余的子 agent，删除 review worktree，保留 `.cc-dispatch/review-$RUN/` 作为记录。
3. 输出最终报告：

```
## cc-herdr-dispatch-review 结论：<对象>
<一句话：现在的状态能不能放心往下走，还剩什么风险>

### 交叉审查
- 共识 N 条 / 仅 Claude a 条 / 仅 Codex b 条 / 仅 Gemini c 条 → 成立 x、不成立 y、存疑 z（Gemini 旁路未参与时写明原因）
- 已修复：<要点>

### 反例测试（共 K 轮，最终 HOLDS | FAILS | 僵持）
| 编号 | 严重度 | 维度 | 反例 | 结论 | 处理 |
|---|---|---|---|---|---|

### 残余风险与待决事项
- <存疑项及所需信息 / 僵持的争议 / 列为后续任务的大改动>

### 过度设计检查（方案模式）
<无 ✅ / 已精简：去掉了 X，因为 Y>

记录目录：.cc-dispatch/review-$RUN/
```

如果有阶段因 Codex 不可用而降级，在报告开头的一句话结论后面加一行：`⚠️ 降级：<阶段> 由 Claude 子 agent 代替 Codex 完成，与防守方属同一系列模型，盲区可能重合；建议额度恢复后重跑 /cc-herdr-dispatch-review .cc-dispatch/review-$RUN`。

收尾后的下一步：

- `followup.md` 不为空（代码模式）：用 AskUserQuestion 问用户怎么处理这些需要重新设计的问题：**交给 cc-herdr-dispatch-dev，中途确认 / 交给 cc-herdr-dispatch-dev，自主执行 / 先放着**。同时按 shared/herdr.md「待决项」写成一条 `decision`（id `followup`），让面板上也能选。选了交给它时，用 Skill 工具调用 cc-herdr-dispatch-dev，参数写 `.cc-dispatch/review-$RUN/followup.md --parent .cc-dispatch/review-$RUN --checkpoints on|off`，运行目录记进 `state.json.children`；它把改动应用到工作区后，在报告末尾补一行它的结论。这部分改动没有经过本次反例测试，提示用户需要时再审一轮。
- `fix=off`：报告末尾提示用户，要修的话可以说"修复 C1、C3"（交给 cc-herdr-dispatch-fix），需要重新设计的交给 cc-herdr-dispatch-dev。
- 方案模式下如果下一步是实现，提示用户可以用 `/cc-herdr-dispatch-dev <方案文件>` 开始实现。

## Codex 不可用时

通用处理见 shared/herdr.md 的"调用失败"。本 skill 特有的规则：

- `quota`：用 AskUserQuestion 让用户选择：**Claude 子 agent 代替 Codex 继续 / 暂停，等额度恢复后续跑 / 到此结束，输出已有结论**。查到了额度重置时间就写进问题里。
- `refused`，或反例测试的调用报 `other` 而屏幕末尾显示请求被拒或对话中止：多半是内容过滤，按 counterexample.md 的"被过滤时"处理。
- `other`：同一阶段连续两次，按 `quota` 的降级处理。

降级（Claude 子 agent 代替 Codex）、暂停、续跑与恢复的具体做法见 [references/codex-failures.md](references/codex-failures.md)，用到时再读。

## 守则

通用守则（只有你派发、输出控制、敏感文件、提交记录只写改动本身等）见 shared/herdr.md。另外：

- 子 agent 在 worktree 里写的复现测试不会自动进入用户的代码；转成回归测试在补强阶段完成（小活你自己写，其余由 cc-herdr-dispatch-fix 写）。
