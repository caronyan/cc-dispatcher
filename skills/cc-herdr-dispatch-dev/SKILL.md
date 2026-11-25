---
name: cc-herdr-dispatch-dev
description: "herdr 内的重型协作编码：Claude 定契约、拆任务卡、验收、合并，Codex 子 agent 在独立 worktree 中并行实现。只在 herdr 终端里（HC_TERMINAL_ID 有值），且用户点名用 cc-herdr-dispatch-dev，或 cc-herdr-dispatch-review 收尾时用户确认交给它时调用。普通需求、小改动和 bug 修复不要调用"
user-invocable: true
argument-hint: "[方案文件路径或需求描述] [--topic <id> --task <tid> [--request <rid>]] [--parent .cc-dispatch/<run>] [--checkpoints on|off]"
---

## 角色

你是**架构师**兼**验收人**，Codex 子 agent 是**实现者**。你负责契约、任务卡、验收、修复路由和合并；摸底、写代码、修 bug、跑测试都交给子 agent，你只做 shared/herdr.md 里的小活。回报是线索不是结论：每个"通过"都要基于你自己跑过的验收命令和看过的 diff 关键部分。

`$SKILL_DIR` 指本文件所在目录。**开始前先读 [shared/herdr.md](shared/herdr.md)**：前提（在 herdr 里）、分工与小活、skill 之间怎么调用、怎么派发和收回报（`$HD`、`$RD`）、调用失败的通用处理和通用守则都在那里，本文只写本 skill 特有的部分。

## 运行状态

每次运行有一个 `RUN`（如 `20261030-1430-auth-refactor`），运行目录 `$RD=$REPO/.cc-dispatch/$RUN/`：

```
state.json        运行状态：base 分支与 sha、集成分支、checkpoints、codex（available/unavailable）、
                  tasks（以卡片编号为键，如 "T1": {...}）：每个任务的 title/status/owner/worktree/
                  branch/NAME/返工轮数/degraded/depends_on（依赖的卡片编号）/note（一句话现状）。
                  status 只用 pending（未开始）/ running（子 agent 在做）/ accepting（验收或返工中）/
                  merged（已合入集成分支）/ parked（搁置）。parked 的卡必须写 parked_why：user（交给用户
                  决定，还没答复）/ superseded（被另一张卡取代，by 写那张卡的编号）/ dropped（用户决定不做），
                  note 写原因。tasks 只放要合入的任务卡：复核（T<n>-check-r<k>）和摸底（survey）不是卡，
                  不进 tasks，复核结论记在被复核卡的 checks（如 {"r1": "LGTM"}）和 log.md；
                  children（调用过的 test 运行目录，子运行继承同一 Topic）
plan.md           采用的方案（输入方案的副本或你写的简版）
survey.md         代码摸底结论（要改的位置、可参照的实现、测试命令、约定），任务卡的线索来源
contracts.md      模块边界与接口契约
tasks/T<n>.md     任务卡
agents/           hd_dispatch.py 的调用记录：调用名即卡片编号（T1、T2…），复核用 T<n>-check-r<k>，摸底用 survey
log.md            每个任务的验收结论与修复记录
```

`state.json` 是断点续跑的依据：每次状态变化后立即更新它。上下文被压缩后，先读它再继续。

Worktree 放在仓库**外面**，避免被主仓库的测试和构建扫到：`$WT_ROOT=$(dirname $REPO)/.cc-dispatch-wt/$(basename $REPO)/$RUN`。

## 流程

### 0. 准备

1. 按 shared/herdr.md 运行 `probe`，确认 Codex 可用。
2. 确认在 git 仓库内（`git rev-parse --show-toplevel` → `$REPO`）。如果工作区不干净，告诉用户未提交的改动不会进入 worktree，问他们是先提交/stash 还是照常继续。
3. 建运行目录，并把 `.cc-dispatch/` 写进 `$REPO/.git/info/exclude`（不改用户的 `.gitignore`）。随后运行 `python3 $HD topic start --run "$RD"`，把收到的 `--topic`、`--task`、`--request`、`--parent` 及其值原样追加；`--topic`、`--task`、`--parent` 都没收到时，先按 shared/herdr.md「归到哪个 Topic」选 Topic；没有 `--task` 时加 `--title "<本次问题>"`。遇到 `REQUEST_STALE`、`TOPIC_PAUSED`、`TASK_TAKEN` 或 `KIND_MISMATCH` 就停下告诉用户，不继续启动；其余拒绝按 shared/herdr.md"Topic 与面板请求"处理。带 `--task` 时将输出的 `DETAIL` 按 JSON 解码作为本次需求。
4. 记下 `base_branch`、`base_sha`，建集成分支并检出到它自己的 worktree，所有合并和全量测试都在这里做：
   ```bash
   git -C "$REPO" worktree add -b cc/$RUN/integration "$WT_ROOT/integration" $base_sha
   ```

完成标准：`state.json` 已写入，集成 worktree 已存在。

### 1. 读方案与代码摸底

如果 $ARGUMENTS 指向一个已有的 `.cc-dispatch/<run>/` 目录，或用户要你续上、接手之前没做完或中断的运行（"接着上次的""续上""接手"，没给路径也算），这是续跑：先按 shared/herdr.md 的"接手运行"找到运行（没给路径时 `runs` 列出来问用户）并 `takeover`，向用户复述现状、等确认；再按 [references/codex-failures.md](references/codex-failures.md) 的"续跑与恢复"处理。

**找输入**：带 `--task` 时用第 0 步得到的 `DETAIL`，其中指定的文件按需读取；否则按 $ARGUMENTS 指定的文件 → 对话中刚产出的方案（例如 cc-herdr-dispatch-research 的 `plan.md`、cc-herdr-dispatch-review 的结果）→ 都没有时，摸底之后根据需求和代码现状写一份简版方案。方案存为 `plan.md`。如果需求含糊到会影响拆分，先问用户。

**摸底**：拆分要的是代码现状，按 [shared/survey.md](shared/survey.md) 做（要不要派发、提示、核对），`<用途>` 写"拆分实现任务"。整理出的 `survey.md` 是任务卡"现有代码线索"的来源。

完成标准：`plan.md` 已写入；每个方案目标都对应到要改的文件（写到行范围）和验收命令的来源；会写进契约的位置都由你亲眼核对过。

### 2. 拆分

1. **先定契约**，写入 `contracts.md`：模块边界、对外函数签名、数据结构、错误约定、共享文件的归属。并行任务只依赖契约，不依赖彼此的实现。
2. **写任务卡**：每张卡按 [references/task-card.md](references/task-card.md) 的模板，存为 `tasks/T<n>.md`。
3. **排波次**：根据卡片之间的依赖排成若干波次，同一波次的卡片可以并行。

拆分标准：
- 每张卡是子 agent 一轮能完成的量，通常只动少数几个文件，并能用一条测试命令验收。
- 同一波次的两张卡**不改同一个文件**。共享文件（路由表、注册表、依赖清单）的改动交给一张专门的卡，或者留给你在合并时完成。
- 在小活范围内的胶水代码（一个文件、约 20 行以内）标记为 `owner: claude`，由你自己写。超出这个量的都派发，哪怕要多开一张卡；共享文件的改动也一样，超过小活就单独成卡。

完成标准：每个方案目标都至少落在一张卡上，每张卡都有允许改动的范围和验收命令。

### 3. 确认检查点模式

向用户展示拆分概要（契约要点、波次表：卡片 / 标题 / 负责人 / 依赖），然后用 AskUserQuestion 询问**是否需要中途确认**：

- **需要**：在"拆分完成后"和"合并进 base 分支前"两处停下来等确认。此时就处在第一个确认点，再问一次"按这个拆分开始执行吗"；用户提出修改就修改后再确认。
- **不需要**：全程自主执行到合并完成，只在出现搁置（4.5 节）或 Codex 需要重新登录时才找用户。

把结果写进 `state.json.checkpoints`（`on`/`off`）。面板派发的 Task 也保留本步骤，派卡前按原规则确认。

### 4. 按波次执行

对每个波次：

**4.1 建 worktree**：从集成分支的最新提交拉出，每张卡一个：
```bash
git -C "$REPO" worktree add -b cc/$RUN/T<n> "$WT_ROOT/T<n>" cc/$RUN/integration
```

**4.2 准备环境**：子 agent 可以用网页搜索查资料，但终端命令默认不能联网。卡片已有的依赖（`node_modules`、`.venv` 等）由你在 worktree 里装好，或者从主仓库软链过去。卡片标了 `network: true` 时，派发用 `--mode net`。

**4.3 派发**：把任务卡按 [references/task-card.md](references/task-card.md) 里的派发提示包好，同一波次的卡并行派出（最多 3 个）：
```bash
python3 $HD run --run $RD --call T<n> --mode write --effort high \
  --dir "$WT_ROOT/T<n>" --schema "$SKILL_DIR/references/report.schema.json" --prompt $RD/tasks/T<n>-prompt.md \
  --title "<卡片的中文短标题>"
```
小卡（一两个文件、几十行改动、验收命令现成）用 `--effort medium`。把 `NAME` 写入 `state.json` 中这张卡，状态改为 `running`。因为依赖未完成而暂不派发的卡保持 `pending`，`depends_on` 写全，面板在所属 Topic → Task 的运行明细中列出这些待派发卡片，并显示还在等哪些卡。全部派出后，按 shared/herdr.md 启动 `wait`。派发前先看 `state.json.codex`：如果是 `unavailable`，不要派发，按"Codex 不可用时"处理。

`wait` 每报回一张卡，按它的输出处理：`REPORT_OK` 先把卡改为 `accepting` 再验收（停在 running 的卡在面板上显示为"待验收"，用户会来催）；其他情况按 shared/herdr.md 处理，属于 `FAILURE=` 的再按"Codex 不可用时"处理。

**4.4 验收**：每个任务交回报后，按 [references/acceptance.md](references/acceptance.md) 验收，给出四种结论之一：**通过 / 小修 / 返工 / 搁置**，结论和理由记入 `log.md`。

**4.5 修复路由**：
- **小修**：只限小活（一个文件、约 20 行以内、修法已确定）。你直接在 worktree 里改，然后重新跑验收命令。
- **返工**：在同一个 worktree 里 `send` 给这张卡的子 agent，提示格式见 acceptance.md，然后启动 `wait`。每张卡最多返工 3 轮。
- **搁置**：3 轮后仍不通过、回报 `blocked`、或者问题出在契约本身。这时停止这张卡，写 `status: parked`、`parked_why: user`、`note`（原因），再按 shared/herdr.md「待决项」写一条 `decision`（`card` 填这张卡，`blocks` 填依赖它的卡）：选项是具体的去路（如放宽验收、改契约后返工、换做法、不做了），每个写清代价，并给出推荐和理由；同时在对话里问用户。契约有错会影响其他卡，要先改 `contracts.md` 再处理受影响的卡。被另一张卡取代的写 `parked_why: superseded`、`by`，不用问用户。

**搁置之后**：用户的决定可能在对话里给，也可能来自面板（消息以 `[cc-dispatch 面板]` 开头；`wait` 返回 `WAIT=answer`，输出带 `ANSWER <id>:`）。按选中的选项落实，然后 `ask --resolve <id> --decision "…"` 关掉这一项（没写待决项、用的是面板补的默认项时 id 是 `card:<卡片>`）：
- 继续做：卡改回 `pending`，`parked_why` 删掉、`note` 记下用户的决定；按你的判断在原 worktree 里返工（子 agent 还在用 `send`，已结束用 `run` 开新调用），或者需要改契约时先改 `contracts.md`、拿不准就先问用户。返工轮数重新计。
- 不做了：写 `parked_why: dropped`、`note`，它的 worktree 和分支先问用户是否保留。依赖它的卡要么改依赖，要么一起搁置并说明。

**4.6 入集成分支**：卡片通过后，`python3 $HD cleanup --run $RD --call T<n>` 结束它的子 agent，由你提交（子 agent 不提交），以一个提交压进集成分支，不产生合并提交。提交说明按通用守则"提交记录只写改动本身"来写，描述这张卡带来的行为变化，不写卡片编号：
```bash
git -C "$WT_ROOT/T<n>" add -A && git -C "$WT_ROOT/T<n>" commit -m "<临时说明>"
git -C "$WT_ROOT/integration" merge --squash cc/$RUN/T<n>
git -C "$WT_ROOT/integration" commit -m "<type>(<scope>): <行为变化>"
git -C "$REPO" worktree remove --force "$WT_ROOT/T<n>"
```
卡片分支上的临时提交不会进入集成分支，随分支在第 6 步删除。合并冲突在小活范围内的就自己解决；冲突多、或涉及逻辑取舍的按"返工"处理（子 agent 已结束时用 `run` 开新调用），让它在卡片 worktree 里 rebase 到最新的集成分支后解决。

一个波次全部合入后跑回归测试，交给 cc-herdr-dispatch-test，测试输出就不会进入你的上下文：用 Skill 工具调用它，参数写 `<范围> --path "$WT_ROOT/integration" --parent .cc-dispatch/$RUN`，把子运行目录记进 `state.json.children`，子运行继承同一 Topic。范围：中间波次写本波次的改动（`<上一波次合入点>..HEAD`），最后一个波次写 `full`。技能列表里没有 cc-herdr-dispatch-test 时，你自己在集成 worktree 里跑全量测试。

交还的结论：
- **PASS**：开始下一个波次，下一波次从新的集成分支拉 worktree。
- **FAIL**：按失败的疑似位置找到负责的卡，走 4.5 的修复路由（`product` 失败当作这张卡的返工或小修；`test` 失败按建议改测试或改代码），修复合入后再用 cc-herdr-dispatch-test 复测失败的部分（参数写失败用例的复现命令）。
- **BLOCKED**：环境问题由你补齐后重测；补不齐就告诉用户缺什么。

全绿后才开始下一个波次。

完成标准：所有卡片都已合入或已搁置；集成分支上全量测试通过。

### 5. 合并进 base 分支

1. 如果 `checkpoints=on`：展示 `git diff --stat $base_sha..cc/$RUN/integration`、测试结果、搁置项，等用户确认后再合并。
2. 如果 base 分支在运行期间有了新提交，先在集成 worktree 里 `git rebase $base_branch`，再用 cc-herdr-dispatch-test 跑一次 `full`（没有它时自己跑全量测试）。
3. 在主仓库快进合并，不产生合并提交：`git -C "$REPO" checkout $base_branch && git -C "$REPO" merge --ff-only cc/$RUN/integration`。用户要求整个方案只留一个提交时，改用 `git merge --squash cc/$RUN/integration` 再按通用守则提交。
4. 不 push，推送由用户决定。

### 6. 清理与报告

`python3 $HD cleanup --run $RD` 结束剩余的子 agent；删除剩余的 worktree（集成 worktree、搁置卡片的 worktree 先问用户是否保留）和已合并的 `cc/$RUN/*` 分支（卡片分支是 squash 合入的，用 `git branch -D` 删除；搁置卡片的分支随 worktree 一起问用户），保留 `.cc-dispatch/$RUN/` 作为记录。把最终结论写进 `log.md`，运行 `python3 $HD topic finish --run "$RD" --done "<已完成的内容，几行>" --open "<遗留和待决的事，没有就不传>" --line "<实现、合并与测试的一句结论>" --artifact "$RD/log.md"`；有下一步建议时可按 shared/herdr.md 用 `topic task-add` 提议草稿，不自动派发。然后输出：

```
## cc-herdr-dispatch-dev 完成：<方案标题>
- 任务：N 张（Codex M / Claude K，其中 D 张因 Codex 不可用由 Claude 接管），返工 X 次，搁置 Y 张
- 合并：<base_branch> ← cc/$RUN/integration（<commit 短 sha>）
- 测试：<命令> → <结果>

| 卡片 | 标题 | 负责人 | 返工轮数 | 结论 |
|---|---|---|---|---|

搁置 / 遗留问题：
- ...
记录目录：.cc-dispatch/$RUN/
```

如果改动涉及安全、并发或数据一致性，建议用户接着用 `/cc-herdr-dispatch-review` 对合并后的 diff 做一轮审查和反例测试。

## 被其他 skill 调用时

参数带 `--parent` 时（目前只有 cc-herdr-dispatch-review 收尾、经用户确认后调用），主流程不变，只有以下几处不同：

- **第 0 步**：调用方的工作区里通常留着它的未提交改动（例如审查后的补强），这些就是本次运行的起点，不问用户要不要先提交。base 取工作区快照，包含未跟踪的新文件，不动用户的暂存区：
  ```bash
  IDX="$(git -C "$REPO" rev-parse --absolute-git-dir)/cc-snap-$RUN.index"   # 临时索引，放在 .git 里，不会被快照收进去
  GIT_INDEX_FILE="$IDX" git -C "$REPO" read-tree HEAD && GIT_INDEX_FILE="$IDX" git -C "$REPO" add -A
  base_sha=$(git -C "$REPO" commit-tree "$(GIT_INDEX_FILE="$IDX" git -C "$REPO" write-tree)" -p HEAD -m "workspace snapshot")
  rm -f "$IDX"
  ```
  `base_branch` 只记录调用方所在的分支，后面不往上合并。
- **第 1 步**：输入是调用方给的问题清单（`followup.md`：问题、证据、约束、建议方向），按"找输入"的第三种情况处理：摸底后写简版方案。
- **第 3 步**：不问检查点，用 `--checkpoints` 的值（调用方已经问过用户），没给时为 `off`。`on` 时仍在拆分完成后、交付前两处停下确认。
- **第 5 步**：不 rebase，不合并进 base 分支，而是把集成分支相对快照的全部改动应用到用户工作区，不提交：
  ```bash
  git -C "$WT_ROOT/integration" diff --binary $base_sha HEAD | git -C "$REPO" apply
  ```
  apply 失败说明用户在运行期间改过这些文件：停下来告诉用户冲突的文件，问怎么处理。
- **第 6 步**：集成 worktree 和全部 `cc/$RUN/*` 分支都删除（改动已经在工作区里）。报告中"合并"一行改为"已应用到工作区（未提交）"，不再建议审查。输出报告后结束，控制回到调用方。

## Codex 不可用时

通用处理见 shared/herdr.md 的"调用失败"。本 skill 特有的规则：

- `quota`：正在运行的其他卡照常收尾，之后不再派发；然后按 [references/codex-failures.md](references/codex-failures.md) 做降级决策（问用户，或直接由 Claude 接管）。
- `other`：同一张卡连续两次 `other`，这张卡按搁置处理。
- `auth`：登录后从失败的卡续跑。

降级（含 Claude 接管）、暂停、续跑与恢复的具体做法见 [references/codex-failures.md](references/codex-failures.md)，用到时再读。

## 守则

通用守则（只有你派发、输出控制、敏感文件、提交记录只写改动本身等）见 shared/herdr.md。
