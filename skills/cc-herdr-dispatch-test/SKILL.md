---
name: cc-herdr-dispatch-test
description: "herdr 内：派 Codex 子 agent 跑测试并分诊失败，主 agent 只抽查和兜底。只在 herdr 终端里（HC_TERMINAL_ID 有值）用于：cc-herdr-dispatch-dev/-fix/-review 流程里的回归、用户点名用 cc-herdr-dispatch-test 跑测试或补测试"
user-invocable: true
argument-hint: "[full | 改动范围 | 测试命令] [--path 目录或 worktree] [--parent .cc-dispatch/<run>]"
---

## 角色

你是**测试负责人**：定范围、准备环境、拆分片、派发、核对结论、整理失败交给调用方。Codex 子 agent 是**测试员**：在快照 worktree 里跑测试，复现并分诊失败，需要时补写测试。测试输出留在子 agent 那边，你只读它的结构化回报，只在有疑点或要确认失败时亲自跑命令；子 agent 做不了的分片由你代劳。

`$SKILL_DIR` 指本文件所在目录。**开始前先读 [shared/herdr.md](shared/herdr.md)**：前提（在 herdr 里）、分工与小活、怎么派发和收回报（`$HD`、`$RD`）、调用失败的通用处理和通用守则都在那里，本文只写本 skill 特有的部分。

本 skill 只测试、不修产品代码：失败连同疑似位置和复现命令交还给调用方（cc-herdr-dispatch-dev、-fix、-review 按各自的修复路由处理），或者交给用户。补测模式下写出的测试经你审过后放进目标工作区，不提交。

## 输入

- **范围**：`full`（全量）、一段改动范围（`<base>..<ref>`、文件或目录列表）、或者直接给出的测试命令。没给时默认测目标工作区相对 HEAD 的改动；没有改动时测全量。
- **目标**：`--path` 指定的目录或 worktree（例如 cc-herdr-dispatch-dev 的集成 worktree），默认当前目录。
- **父运行**：`--parent` 指向调用方的运行目录。有它时，从里面读改动背景：`plan.md`、`survey.md` 的测试命令、任务卡的验收命令、`log.md` 里已知的问题。

## 运行状态

`$TARGET` 是被测的目录，`$ROOT` 是它所属仓库的主工作区：`ROOT=$(dirname "$(git -C "$TARGET" rev-parse --path-format=absolute --git-common-dir)")`。这样从集成 worktree 调用时，记录也和调用方的放在一起。运行目录 `$RD=$ROOT/.cc-dispatch/test-$RUN/`：

```
state.json     target（路径、快照 sha、base）、scope、parent、shards（以分片 id 为键：title/mode/commands/
               worktree/NAME/status）、codex（available/unavailable）、takeover（由你代劳的分片）
plan.md        测试计划：范围、分片、每片的命令与通过标准、环境准备、未覆盖项
result.md      测试结论
agents/        hd_dispatch.py 的调用记录，调用名即分片 id（unit、integration、e2e、write…）
```

分片的 worktree 放在 `$WT_ROOT=$(dirname $ROOT)/.cc-dispatch-wt/$(basename $ROOT)/test-$RUN`。

## 流程

### 0. 准备

1. 按 shared/herdr.md 运行 `probe`。不可用时直接进入"Codex 不可用时"，由你代劳。
2. 冻结快照：`SNAP=$(git -C "$TARGET" stash create); SNAP=${SNAP:-$(git -C "$TARGET" rev-parse HEAD)}`（不改动工作区）。`git -C "$TARGET" status --porcelain` 里有未跟踪的新文件时，记下来，第 2 步建好 worktree 后拷进去。
3. 建运行目录，把 `.cc-dispatch/` 写进 `$ROOT/.git/info/exclude`。

完成标准：`state.json` 已写入 target、`SNAP` 和 scope。

### 1. 定计划

**找测试命令**，按可信度从高到低：调用方给出的命令 → 父运行的 `survey.md`、任务卡验收命令 → CI 配置（`.github/workflows/`、`.gitlab-ci.yml` 等，最接近团队真实跑法）→ 项目脚本（`package.json` scripts、`Makefile`、`pyproject.toml`、`justfile`）。只读这些文件的相关片段。

**定范围**：
- **全量**：CI 里的测试任务，按套件分开。
- **局部**：把改动文件（`git -C "$TARGET" diff --stat <base>..$SNAP`）映射到测试：同模块的测试、引用了改动模块的测试、测试框架自带的关联模式（`vitest related`、`jest --findRelatedTests`、`pytest <目录>`、`go test ./<包>/...`），再加上父运行各卡的验收命令。
- 改动的行为没有测试覆盖、而调用方要求补测（或缺口明显）时，加一个 **write 分片**（补测模式）。

**拆分片**（1–3 个，并行）：按套件或包切，每片的命令能独立运行。e2e、需要外部服务的单独成片。两片会争用同一资源（同一个测试库、固定端口、全局缓存目录）时合成一片或串行。范围小（一两条命令、几分钟内跑完）就只用一片，用 `--effort medium`。

**环境准备**由你来做：依赖（`node_modules`、`.venv` 等）在分片 worktree 里装好或从 `$TARGET` 软链过去；数据库、容器、浏览器这类外部服务先启动好，并在计划里写明地址。沙箱内连不上的服务，那一片标为由你代劳。

写 `plan.md`。完成标准：每个改动模块都至少被一条分片命令覆盖，否则列进"未覆盖"并写明原因；每片都有命令、通过标准和环境说明。

### 2. 派发

每片一个 worktree（并行的分片互不干扰，`$TARGET` 也不会被测试产物弄脏）：

```bash
git -C "$ROOT" worktree add --detach "$WT_ROOT/<分片>" $SNAP
python3 $HD run --run $RD --call <分片> --mode write --effort high \
  --dir "$WT_ROOT/<分片>" --schema "$SKILL_DIR/references/test-report.schema.json" --prompt $RD/<分片>-prompt.md
```

提示按 [references/tester.md](references/tester.md) 构造（运行模式或补测模式）。只有分片需要安装新依赖时才用 `--mode net`，理由写进 `plan.md`。全部派出后按 shared/herdr.md 启动 `wait`，把每片的 `NAME` 写进 `state.json.shards`。子 agent 运行期间你不读测试输出，也不自己跑同样的命令。

### 3. 核对

每片交回报（`REPORT_OK`）后读回报文件：

1. **覆盖**：`suites` 是否包含了计划里这一片的每条命令，退出码、通过/失败/跳过数是否齐全。缺了就 `send` 让它补跑一次。
2. **没动过测试**：运行模式下，`git -C "$WT_ROOT/<分片>" status --porcelain` 应当只有测试产物（缓存、报告、快照输出）。源码或测试文件被改了，这一片的结论作废，撤销改动后 `send` 让它重跑，并提醒它规则。
3. **通过的分片**：回报自洽（每条命令退出码为 0、`failed` 为 0、`verdict` 为 PASS、跳过数与该套件平时相当）就采信，不重跑。有任何一处对不上，亲自跑那一条命令（`2>&1 | tail -n 40`）。
4. **失败**，按 `category` 处理：

| category | 你做什么 |
|---|---|
| `product`（产品代码的问题） | 亲自跑它的 `reproduce` 命令确认（只跑这一个用例，`tail -n 40`），再打开 `location` 那一段看疑似原因是否站得住。确认后记为**已复现** |
| `test`（测试本身写错或过时） | 读那段测试和对应的产品代码（只读回报指出的那几行），确认确实是测试的问题；要读的超出小活范围时，`send` 让这一片补证据。交还时写明该改测试还是改代码 |
| `env`（环境、依赖、服务） | 能修就修好环境，`send` 让这一片重跑一次；仍然不行，这一片由你代劳 |
| `flaky`（不稳定） | 回报里要有重跑证据（同一用例至少 3 次，有过有不过）。记下来，不算失败，但写进结论 |

完成标准：每片都有采信或亲自验证过的结论；每条 `product` 失败都已复现或被推翻。

### 4. 结论与交还

**补测分片**：先审它新增的测试：断言的是行为而不是实现细节，确实覆盖了改动，在快照上能跑通，没有 `skip`/`only`。审过后放进目标工作区，不提交：
```bash
git -C "$WT_ROOT/write" add -A && git -C "$WT_ROOT/write" diff --cached $SNAP -- <新增或改动的测试文件> | git -C "$TARGET" apply
```

写 `result.md`，并输出给调用方（被其他 skill 调用时，这就是交还的内容；之后控制权回到调用方的流程）：

```
## cc-herdr-dispatch-test：<范围>
结论：PASS | FAIL | BLOCKED —— 通过 N / 失败 M / 跳过 K（命令 C 条，分片 S 个）

### 失败（已复现）
- F1 [product] <用例> —— 疑似位置 <文件:行>；复现 `<命令>`；建议 <一句话>
- F2 [test] <用例> —— <测试哪里过时>；建议改测试 | 改代码

### 不稳定 / 环境
- <用例>：<重跑结果或环境问题>

### 新增测试（补测模式）
- <路径>：覆盖 <行为>（已放进 <TARGET>，未提交）

### 未覆盖
- <模块>：<原因>

由 Claude 代劳的分片：<无 | 列表>
记录目录：.cc-dispatch/test-$RUN/
```

结论的判定：所有命令都通过（只允许有已记录的 flaky）为 **PASS**；有已复现的 `product` 或已确认的 `test` 失败为 **FAIL**；环境问题修不好、有分片没跑成为 **BLOCKED**，写明缺什么。

单独使用（没有调用方）时，FAIL 之后用 AskUserQuestion 问用户：**交给 cc-herdr-dispatch-fix**（修法明确或能定位的 `product`/`test` 失败，用 Skill 工具调用，参数写 `.cc-dispatch/test-$RUN/result.md 中的 <编号列表> --path "$TARGET" --parent .cc-dispatch/test-$RUN`）/ **交给 cc-herdr-dispatch-dev**（失败指向需要重新设计的问题，提示用户用 `/cc-herdr-dispatch-dev` 并附上失败清单）/ 自己修 / 先放着。

### 5. 清理

`python3 $HD cleanup --run $RD` 结束各分片的子 agent，删除各分片 worktree（`git -C "$ROOT" worktree remove --force`），保留 `.cc-dispatch/test-$RUN/`。你启动的外部服务，调用方不再需要时停掉。

## Codex 不可用时

通用处理见 shared/herdr.md 的"调用失败"。本 skill 特有的规则：**由你代劳**，不启动其他子 agent，也不问用户（测试结果可以复现，不需要另一个模型的视角）。以下情况都算：

- `quota`，或探测时就不可用；
- 同一片连续两次 `other`；
- 回报 BLOCKED 是因为沙箱的限制（连不上服务、需要容器或浏览器），而你的环境里没有这个限制。

代劳的做法：在该片的 worktree 里按 `plan.md` 的命令亲自跑，用安静模式并加 `2>&1 | tail -n 60`，只对失败的用例重跑看详细输出，分诊标准同第 3 步。把分片 id 记进 `state.json.takeover`。预计要跑 10 分钟以上的套件，开始前用一句话告诉用户。

## 守则

通用守则（只有你派发、输出控制、敏感文件、提交记录只写改动本身等）见 shared/herdr.md。另外：

- 测试员在运行模式下只跑测试、不改文件；补测模式下只新增或修改测试文件。弱化测试（删断言、加 `skip`、放宽阈值）让它通过的，一律作废。
- 你不改产品代码，修复交给调用方或用户。
- 被其他 skill 调用时，交还结论后就结束，不替调用方决定修复方式。
