---
name: cc-herdr-dispatch-fix
description: "herdr 内：派 Codex 子 agent 修复已确认、修法明确的问题并补回归测试，经 cc-herdr-dispatch-test 回归后应用到工作区，不提交。只在 herdr 终端里（HC_TERMINAL_ID 有值）用于：cc-herdr-dispatch-review/-test 报出的待修问题、用户点名用 cc-herdr-dispatch-fix 修某个 bug。需要重新设计的交给 cc-herdr-dispatch-dev，一个文件约 20 行以内且修法已定的直接改"
user-invocable: true
argument-hint: "<问题清单文件 | 问题描述> [--path 目标工作区] [--parent .cc-dispatch/<run>] [--repro 复现测试目录] [--no-regress]"
---

## 角色

你是**修复负责人**：整理问题、派发、验收、交还。Codex 子 agent 是**修复者**：在快照 worktree 里复现问题、修复、写回归测试。回归测试交给 cc-herdr-dispatch-test，测试输出不进你的上下文。回报是线索不是结论：每个"已修复"都要有你亲自跑过的测试结果和看过的关键 diff。

`$SKILL_DIR` 指本文件所在目录。**开始前先读 [shared/herdr.md](shared/herdr.md)**：前提（在 herdr 里）、分工与小活、skill 之间怎么调用、怎么派发和收回报（`$HD`、`$RD`）、调用失败的通用处理和通用守则都在那里，本文只写本 skill 特有的部分。

本 skill 只处理**修法明确或能定位**的问题，修复落在用户的工作区，不提交，提交由用户决定。需要改接口契约、数据结构或跨多个模块重新设计的问题，不修，交还时标为"需要重新设计"。

## 输入

- **问题**：$ARGUMENTS 里的问题清单文件（cc-herdr-dispatch-review 的 `rounds/r<k>.md` 加编号、cc-herdr-dispatch-test 的 `result.md`），或者自然语言描述的 bug。每个问题尽量带上：位置、触发条件、期望行为、复现方式、修法方向。
- **目标**：`--path` 指定的工作区，默认当前目录。修复最终应用到这里。
- **父运行**：`--parent` 指向调用方的运行目录，从里面读背景（`target.md`、`survey.md`、`plan.md`、测试命令）。
- **复现**：`--repro` 指向调用方已有的复现测试目录（例如 cc-herdr-dispatch-review 反例测试 worktree 里的 `cc-repro/`）。
- **`--no-regress`**：调用方自己负责回归，本 skill 跳过第 4 步。

## 运行状态

`$TARGET` 是目标工作区，`$ROOT` 是它所属仓库的主工作区：`ROOT=$(dirname "$(git -C "$TARGET" rev-parse --path-format=absolute --git-common-dir)")`。运行目录 `$RD=$ROOT/.cc-dispatch/fix-$RUN/`：

```
state.json     target（路径、快照 sha）、parent、issues（以编号为键：title/status）、calls（调用名 → NAME）、
               轮次、codex（available/unavailable）、takeover、children（调用过的 cc-herdr-dispatch-test 运行目录）
issues.md      整理后的问题清单（第 1 步）
survey.md      定位结论（需要时，见 shared/survey.md）
result.md      修复结论
agents/        hd_dispatch.py 的调用记录（fix、survey）
```

修复 worktree：`$FIX_WT=$(dirname $ROOT)/.cc-dispatch-wt/$(basename $ROOT)/fix-$RUN`。

## 流程

### 0. 准备

1. 按 shared/herdr.md 运行 `probe`。不可用时直接按"Codex 不可用时"处理。
2. 冻结快照：`SNAP=$(git -C "$TARGET" stash create); SNAP=${SNAP:-$(git -C "$TARGET" rev-parse HEAD)}`（不改动工作区）。`git -C "$TARGET" status --porcelain` 里有未跟踪的新文件时记下来，建好 worktree 后拷进去。
3. 建运行目录，把 `.cc-dispatch/` 写进 `$ROOT/.git/info/exclude`。

### 1. 整理问题

写 `issues.md`，每个问题一行：编号（沿用来源的编号，如 C3、F1；用户描述的从 I1 开始）、位置、问题（什么输入导致什么后果）、复现、期望行为、修法方向。按 [references/fixer.md](references/fixer.md) 的"措辞"改写来源里的说法。

逐个分档：

| 档 | 判定 | 处理 |
|---|---|---|
| 小活 | 一个文件、约 20 行以内、修法已定 | 你在修复 worktree 里直接改，回归测试也由你写 |
| 派发 | 修法明确或能定位，只动少数文件，不改接口契约 | 合成一次修复调用交给子 agent |
| 需要重新设计 | 要改接口签名、跨模块契约、数据结构，或几个问题要一起重构 | 不修，交还时标出，建议 cc-herdr-dispatch-dev |

问题没有位置、也说不准落在哪里时，先按 [shared/survey.md](shared/survey.md) 摸底定位（`<用途>` 写"定位并修复下列问题"），再分档。

完成标准：每个问题都有档位；派发档的每个问题都有位置或复现方式之一。

### 2. 派发

```bash
git -C "$ROOT" worktree add --detach "$FIX_WT" $SNAP
cp -R "<--repro 目录>" "$FIX_WT/cc-repro"   # 有复现时
python3 $HD run --run $RD --call fix --mode write --effort high \
  --dir "$FIX_WT" --schema "$SKILL_DIR/references/fix.schema.json" --prompt $RD/fix-prompt.md \
  --title "<问题的英文简写>"
```

提示按 [references/fixer.md](references/fixer.md) 构造。依赖由你在 worktree 里装好或从 `$TARGET` 软链过去。问题少、范围只在一两个文件时用 `--effort medium`。派出后按 shared/herdr.md 启动 `wait`。小活档的问题等子 agent 交回报后你再改，避免同时写同一个 worktree。

### 3. 验收

1. **看回报**：`REPORT_OK` 后读回报文件：`status`、每个问题是否在 `addressed` 里、`open_questions`。没修到的问题 `send` 追一次（返工提示见 fixer.md）。
2. **范围**：`git -C "$FIX_WT" status --porcelain` 应当只有这些问题相关的文件和新测试；越界的改动撤销。
3. **测试**：跑回报里的测试命令，只看结果（shared/herdr.md"核对用最便宜的信号"）。
4. **diff**：先看 `git -C "$FIX_WT" diff --stat`，再细看每个问题对应的那几段修复，确认修的是根因、回归测试断言的是行为、没有弱化已有测试。
5. 回报说某个问题需要改契约（`open_questions` 里提到、`status` 为 `partial`），这个问题改标为"需要重新设计"。

每个问题最多返工 2 轮，仍然没修好就标为"未解决"，写明卡在哪里。

### 4. 回归

带 `--no-regress` 时跳过。

用 Skill 工具调用 cc-herdr-dispatch-test，参数写 `<修复改动的文件列表> --path "$FIX_WT" --parent .cc-dispatch/fix-$RUN`，把它的运行目录记进 `state.json.children`。技能列表里没有 cc-herdr-dispatch-test 时，你在 `$FIX_WT` 里跑改动模块的测试（安静模式，`2>&1 | tail -n 60`）。

- **PASS**：进入第 5 步。
- **FAIL**：修复引入的 `product` 失败，`send` 给修复者返工（计入第 3 步的返工轮数），修完再用 cc-herdr-dispatch-test 只复测失败的用例；与本次修复无关、快照上本来就失败的，记进结论，不在这里修。
- **BLOCKED**：环境问题由你补齐后重测；补不齐就在结论里写明，修复照常应用，但结论标为未经回归。

### 5. 应用与交还

把修复应用到目标工作区，然后结束子 agent、删除修复 worktree：

```bash
git -C "$FIX_WT" add -A && git -C "$FIX_WT" diff --cached --binary $SNAP | git -C "$TARGET" apply
python3 $HD cleanup --run $RD
git -C "$ROOT" worktree remove --force "$FIX_WT"
```

apply 冲突说明用户在修复期间改过这些文件：停下来告诉用户冲突的文件，问怎么处理。

写 `result.md`，并输出给调用方（被其他 skill 调用时，这就是交还的内容；之后控制回到调用方）：

```
## cc-herdr-dispatch-fix：<问题来源>
结论：FIXED | PARTIAL | BLOCKED —— 已修复 N / 未解决 M / 需要重新设计 K；回归：PASS | 未跑（--no-regress）| 未经回归（原因）

| 编号 | 问题 | 结论 | 修复位置 | 回归测试 |
|---|---|---|---|---|

### 未解决
- <编号>：<卡在哪里，需要什么>
### 需要重新设计
- <编号>：<为什么超出修复范围，建议方向>

改动已应用到 <TARGET>，未提交。
记录目录：.cc-dispatch/fix-$RUN/
```

单独使用（没有调用方）时，有"需要重新设计"的问题，问用户要不要交给 cc-herdr-dispatch-dev。

## Codex 不可用时

通用处理见 shared/herdr.md 的"调用失败"。本 skill 特有的规则：**由你接管**，不启动其他子 agent：修复对错由复现测试和回归测试判定，不依赖另一个模型的视角。以下情况都算：

- `quota`，或探测时就不可用；
- 修复调用连续两次 `other`；
- `refused`：按 fixer.md 的"措辞"改写后开新调用重跑一次，仍被拦。

接管的做法：在 `$FIX_WT` 里按第 1 步的问题清单逐个先复现、再修、再写回归测试，验收和回归照常走第 3、4 步。修复量超出约 300 行时，先停下来问用户：继续由你修、暂停等额度恢复，还是交给 cc-herdr-dispatch-dev。把接管记进 `state.json.takeover`，并在结论里注明。

## 守则

通用守则（只有你派发、输出控制、敏感文件、提交记录只写改动本身等）见 shared/herdr.md。另外：

- 只修清单里的问题，不顺手重构；修复中发现的新问题写进结论交还。
- 用户要求提交时，按通用守则"提交记录只写改动本身"写说明，一个提交对应一组相关的修复。
