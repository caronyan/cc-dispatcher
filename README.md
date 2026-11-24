# cc-dispatcher

仓库：<https://github.com/caronyan/cc-dispatcher>

在 [herdr](https://herdr.dev/) 里，让 Claude Code 把调研、审查、实现、修复、测试派给子 agent（默认 Codex，调研默认 Antigravity 的 Gemini 4 Neon）执行、收回报并验收的一组 Claude Code skill。

子 agent 由 herdr-core（`hc`）托管：它们以 Claude Code 的子终端出现在 herdr 侧栏，状态（干活 / 完成 / 出错 / 等人）由 herdr 跟踪，出错和等人时 herdr 把通知送进 Claude 的对话。Claude 只负责拆分、派发、看状态、验收，不做用量计量。

## skill

| skill | 触发 | 作用 |
|---|---|---|
| `cc-herdr-dispatch-research` | 手动或面板请求 | 立题、拆线程并行调研代码/资料/可行性，核实证据，出调研结论或方案 |
| `cc-herdr-dispatch-review` | 手动或面板请求 | 方案或代码的交叉审查 + 反例测试，分诊并补强 |
| `cc-herdr-dispatch-dev` | 手动、面板请求，或 review 收尾时经用户确认 | 定契约、拆任务卡，子 agent 在各自 worktree 并行实现，验收后合并 |
| `cc-herdr-dispatch-fix` | 手动、面板请求，或由上面几个调用 | 修复已确认的问题并补回归测试，应用到工作区，不提交 |
| `cc-herdr-dispatch-test` | 手动、面板请求，或由上面几个调用 | 分片跑测试、分诊失败，可补测试 |
| `cc-herdr-dispatch-retro` | 手动或面板请求 | 复盘已结束的运行和用户的纠正，经确认后对 skill 文件或项目文档做最小改动，记进 `retro-log.md` |

这组 skill 之间只互相调用；缺了哪个，就由 Claude 自己做那部分，不会转去调用其他同类 skill。

## 结构

```
shared/herdr.md              共用约定：分工、派发与回报、失败处理、守则
shared/survey.md             代码摸底的做法
shared/scripts/hd_dispatch.py  派发脚本：topic（目标、Task、面板请求）/ probe / run / send / wait / collect / status / diagnose / cleanup，以及 pause / resume / stop / handoff / adopt / recover / takeover / runs / ask（待决项）
shared/scripts/hd_check.py   按 schema 检查回报 JSON
shared/scripts/hd_handoff.py 交接包：子 agent 移交（handover）和主 agent 交接（handoff / adopt）用的材料
shared/scripts/hd_usage.py   主 agent 的账号额度：优先从 magpie 读，面板运行卡片上显示，超过阈值时提示主 agent 先问你要不要交接
shared/scripts/hd_retro.py   复盘材料：digest（运行记录 + 用户原话）/ mark（记为已复盘）
shared/templates/cc-hd-*.md  herdr-core 模板：{read,write,net} × {medium,high}
herdr/cc-dispatch/           Herdr 面板（mod + layout）：Topic → Task、待细化条目、派发请求、运行明细与历史，见其 README / RECIPE
herdr/tests/                 面板逻辑的 node 测试：node --test herdr/tests/*.test.mjs
skills/cc-herdr-dispatch-*/  各 skill 的 SKILL.md 与 references（提示模板、回报 schema）
```

运行中的文件：

- 每次运行的记录在目标仓库的 `.cc-dispatch/<kind>-<run>/`（自动加进 `.git/info/exclude`）。
- Topic 的记录在 `.cc-dispatch/topics/<id>/`：`topic.json` 保存目标、负责人、Task 与派发请求，`backlog.json` 保存待细化条目，`summary.md` 汇总各 Task 的结论。运行的 `state.json.topic/task` 指向它所属的 Topic 和 Task。
- worktree 在仓库旁的 `.cc-dispatch-wt/<repo>/` 下。
- 子 agent 的回报文件在 `/tmp/cc-dispatch/`（可用 `CC_HD_HOME` 改）。
- 每个调用有一份只追加的事件流 `agents/<call>/events.jsonl`：派发、返工、自动重试、每次交回的状态与回报检查、卡住、清理，以及交回时 Codex 会话的累计 token / 命令 / 改动文件数。面板的用量和 Timeline、`hd_retro.py` 的复盘材料都读它；Codex 清掉自己的日志后历史仍在。格式见 `hd_dispatch.py --help`。
- 用户在面板上暂停、继续或终止一次运行时，状态写在 `.cc-dispatch/<kind>-<run>/control.json`（`running|paused|stopping|stopped|handoff`、被挂起的调用；主 agent 交接时另记交接包和交接前的状态，新主 agent `adopt` 后记 `owner`）；终止后另有 `stop.md`（各调用状态、回报路径、未交合格回报者的屏幕末尾）和 `stop.log`。
- skill 在准备时用 `topic start` 绑定 Task，收尾用 `topic finish` 写回结论与产物，同时标记 Task 和运行完成；子 agent 由主 agent `cleanup` 关掉终端。运行文件夹保留，供接手和复盘读取。
- 归档和删除按 Topic 操作。所有已绑定 Task 都完成或其运行已终止，且没有未回答的待决项时才可归档；草稿不挡归档。归档会撤销未确认请求，并同步下属运行的 `archived` 标记，列表底部可显示和取消归档。删除只接受已归档的 Topic，会先整体检查下属运行已归档、没有工作中的子 agent、没有暂停或终止中或交接中的运行，全部通过才逐个删除运行及 Topic 记录。运行删除仍清理其终端、回报、进度笔记、快照、面板缓存和复盘台账；worktree、`cc/<run>/*` 分支和各 agent 自己的会话日志保留。删除不能撤销。
- 每个子 agent 终端带 hc 标签：`cc.run cc.call cc.kind cc.dir cc.mode cc.round`（派发时），`cc.report=ok|bad|missing`、`cc.failure`（collect / wait 时更新），`cc.retry`（服务端繁忙或限流、正在自动重试时）。同样的验收结果也写进 `meta.json` 的 `report_check`、`failure`，终端没了也能看。`meta.json` 还记下派发它的主 agent：`parent`（终端）、`space`（herdr space）、`dispatcher_agent`、`session`（Claude Code 会话或 Codex 线程，面板据此读它的后台任务；没记下时按运行目录去找）、`claude_cwd`。面板对每种主 agent 程序各有一个读会话日志的适配器（目前 Claude Code、Codex），后台任务按同一种样子显示。

## Herdr 面板

Herdr 原生 Agents 栏负责"谁活着、什么状态、谁是谁的子 agent"；`herdr/cc-dispatch` 面板按 **Topic → Task** 组织工作。一个 Topic 对应一个问题或目标；每个 Task 有标题、职责（research / review / dev / fix / test / retro）、说明和依赖，启动后绑定一次 skill 运行。dev 运行里的 T1、T2 等任务卡在 Task 的运行明细内展示。

Topic 下的 Task 按 **等你 / 进行中 / 待分发 / 已完成** 分组，展开可读说明、结论与产物，再看运行中的任务卡、子 agent 轮次、回报检查、失败原因和历史。行内可跳转终端、读回报与任务文件、看 worktree 改动，或经确认请主 agent 收回报、诊断和清理终端。Topic 的汇总统计合并下属运行，后台任务按会话与任务编号去重。

**草稿与待细化条目**：可以新建 Topic、增加或编辑未启动的 Task，也可以先记下 backlog 条目，请主 agent 细化成一批草稿 Task。细化提交后等待你派发；主 agent 收尾也可提议下一步草稿。已绑定运行的 Task 不再编辑；修改草稿职责、说明或待细化条目会撤销相应旧请求。

**派发请求**：选择由主 agent 接手，或在新标签页启动。交给主 agent 的请求先排队，只在它在线、空闲且没有进行中的 Task 时投递；细化只要求空闲。Claude Code 收到 `/cc-herdr-dispatch-<kind> --topic <id> --task <tid> --request <rid>`，其他 agent 收到同义文字。面板显示请求排队或已送达，可撤销、重发或改派。skill 通过 `topic start` 核对仍有效的请求，读取 Task 说明并绑定运行；原有确认点照常保留。

Topic 标题行提供暂停、继续、终止，确认后作用于下属运行：

- **暂停**：暂停还在运行的工作并记下这次挂起的运行，阻止新请求投递、Task 启动和运行激活。
- **继续**：只恢复这次 Topic 暂停时挂起的运行；之前单独暂停的运行保持暂停，排队请求恢复投递。
- **终止**：撤销未确认请求，草稿保留；逐个终止尚未结束的运行，让子 agent 写下已完成部分、关终端并保留 worktree，再请主 agent 汇总。各运行的 `stop.md` 可在明细中打开。

Topic 的暂停状态与子 agent 自身状态分别显示，Task 运行内仍可查看暂停、终止、交接和接手信息。历史运行自动显示成只有一个 Task 的隐式 Topic，原有记录可继续查看和操作。`./install.sh` 会一并安装面板（装了 Herdr app 时），然后切到 `herdr-cc-dispatch` layout。

**待决项**：主 agent 需要你拍板或只有你知道答案的事，显示在所属 Topic → Task 的运行明细里。分两种：**decision** 是在 2–4 个具体做法里选一个，每个选项写明代价，主 agent 标出推荐（★）和理由；**question** 是要你提供的信息，可能附几个猜测的答案。点开后能看到上下文（含子 agent 回报里的 open questions）、选项和要发给主 agent 的消息，选一个、写补充，点“发送”后答案记进运行目录的 `answers.jsonl` 并发给主 agent；主 agent 不在时只保存，接手的主 agent 会读到。主 agent 处理完用 `hd_dispatch.py ask --resolve` 关掉这一项。搁置等你决定的卡没有写待决项时，面板给它补一个"继续做 / 不做了"。

断网时，子 agent 在面板上标为“等网络”；因断网停下的不占自动重试次数，网络恢复后自动接着做，主 agent 不用处理。

## 主 agent 交接

主 agent 自己的会话快到上限时，可以把整个运行交给另一个能加载这套 skill 的 agent（Claude Code、Codex 等）接着做，子 agent 不受影响：

- **触发**：你在对话里说"准备交接"；或主 agent 所用账号的某个额度窗口（5 小时、7 天等）超过 90%（`CC_HD_HANDOFF_AT` 可改）时，它会先问你要不要交接，你同意才开始。不论主 agent 是 Claude Code 还是 Codex 都会提示：`hd_dispatch.py wait`/`collect` 每次都检查，Claude Code 另有 hook 在工具调用后检查。每个窗口重置前只问一次。
- **额度从哪来**：先问本机 magpie（网关 `127.0.0.1:3425`，不通时后台跑 `magpie quota --json`），按该服务最近一次实际使用的账号算；没有 magpie 时，Codex 用它会话日志里的 `rate_limits`；都没有就不显示、不检查。面板上每个运行中或暂停的运行卡片头下面有一行「main agent · Claude Code · pro　5h 50%　7d 20%」，按主 agent 终端当前实际跑的程序选订阅（Codex 就显示 Codex 的），≥70% 黄、≥90% 红，悬停看重置时间和来源，约 30 秒刷新一次。`python3 shared/scripts/hd_usage.py quota codex` 可以看当前读到的值。
- 主 agent 停止开始新工作，写交接说明，运行 `hd_dispatch.py handoff`，把给新 agent 的提示词贴在对话里（面板上该运行的“复制提示”也能复制）。
- 你在 herdr 里新开终端启动 Claude Code 或 Codex，发这段提示词。新 agent 读交接包、运行 `adopt` 接手、向你复述现状，经你确认后继续。原来的主 agent 之后再操作这个运行会被拒绝。
- 不交接了：让原主 agent 运行 `hd_dispatch.py resume`。

细节见 `shared/herdr.md` 的"主 agent 交接"。

## 意外中断后恢复

herdr 或机器重启、终端被误关时，没正常结束的子 agent 在面板上标为"已中断"（`lost`），面板只提示，不自动处理。经你同意后主 agent 运行 `hd_dispatch.py recover`：子 agent 能续上原会话就续上，续不上就开新会话读原任务卡接着做；恢复后运行先处于暂停，主 agent 收一遍现状、你确认后再 `resume`。主 agent 自己也没了时，`recover` 会给出续上原主 agent 会话的命令，以及交给新主 agent 的交接包和提示词。

## 新会话接手没做完的运行

主 agent 的会话不在了（终端被关、程序退出、herdr 重启），运行还没做完时，开一个新会话接着做，不用记命令：

- **面板**：这样的运行卡片头下有一行「主 agent（…） 已经不在了」和 **复制接手提示** 按钮。在 herdr 里新开终端，启动 Claude Code、Codex 或 Antigravity（Codex 用 `codex --sandbox danger-full-access`，Antigravity 用 `agy --dangerously-skip-permissions`），粘贴复制的提示词。
- **直接说**：在新会话里说"用 cc-herdr-dispatch-dev 接着之前的运行"（research、review 同理）。skill 运行 `hd_dispatch.py runs` 列出本仓库没做完的运行，问你接哪个。
- 新主 agent 运行 `hd_dispatch.py takeover --run <dir>`：一步完成恢复中断的子 agent 和接手（`recover` + `adopt`），运行先处于暂停；再向你复述现状，你确认后才继续派发。原主 agent 还开着时会拒绝，除非你明确让它接手（`--force`）。
- 新旧主 agent 是什么程序都可以（Claude Code、Codex、Antigravity 等）。主 agent 程序登记在 `hd_dispatch.py` 的 `MAIN_AGENTS` 里（会话变量、续上原会话的命令）；没登记的程序照样能接手，只是不给续上原会话的命令。
- 主 agent 给出最终结论时用 `topic finish` 同步 Task 结论、产物与 `state.json.finished`，这样的运行不再出现在 `runs` 和面板的接手提示里。接手一个 Task 时，若 Topic 的负责人仍是前任，也会同步改为接手者。

## 子 agent 默认是谁

按 skill 场景选默认子 agent（`hd_dispatch.py run --agent auto`，按运行目录类型；SKILL.md 里不用写）：

- **research**：Antigravity（`agy`），模型 `gemini-4-neon-<effort>`（`--model` 或 `CC_HD_AGY_MODEL` 可改）。派出前检查 agy 是否装了、`agy models` 里有没有该模型（缓存 1 小时）、magpie 读到的 Gemini 额度窗口是否用完；不行就直接派 Codex（全局默认模型），输出 `FALLBACK=agy→codex why=…`。运行中途因额度、登录、模型不可用停下或退出、又没交合格回报的 agy 子 agent，`wait`/`collect` 自动移交给 Codex 接着做（同一任务和回报，下一轮）。
- **review**：Codex 审查者照旧，另派一个 Gemini 4 Neon 旁路审查者（`--agent agy --fallback none`，不可用就跳过、不换人），主 agent 合并三方意见、裁决分歧，需要确认的问用户。
- **dev、fix、test、retro** 等：Codex，不变。

agy 子 agent 没有 Codex 的沙箱（弱隔离），只读调用只靠任务文件的规则约束。

## 子 agent 的权限

Codex 子 agent 的三种模式都用它的 `workspace-write` 沙箱，靠工作目录区分能写哪里（agy、Claude Code 子 agent 只靠任务文件的规则）：

- **read**：在 `/tmp/cc-dispatch/<run>/<call>/` 里运行，仓库或 worktree 只能读不能写。
- **write**：在指定 worktree 里运行，改动只落在那里；终端不联网。
- **net**：同 write，但终端能联网，只给确实要装依赖或访问外部接口的任务用。

所有模式都能用网页搜索。回报统一写到 `/tmp/cc-dispatch/` 下，这是沙箱在工作目录之外唯一能写的地方。子 agent 不能运行 `hc`，所以完成与否由 Claude 一侧的 `hd_dispatch.py wait` 根据 herdr 的状态判断。

`/tmp/cc-dispatch` 是一个 git 仓库，Codex 的"信任此目录"只需在这里确认一次；仓库首次派发时的信任确认由脚本自动完成。

## 安装

前提：

- [herdr](https://herdr.dev/)，带 herdr-core（`hc` 在 PATH 上）；要面板的话还需要 Herdr app
- Codex CLI，已 `codex login`
- 可选：Antigravity CLI（`agy`，已登录），research 默认派它、review 用它做旁路审查；没有时这两处自动用 Codex / 跳过旁路
- Python 3、git
- 可选：[magpie](https://usemagpie.ai)，面板上的主 agent 额度和额度交接提醒靠它（没有时 Codex 退回读会话日志，Claude Code 不显示）

步骤：

```sh
# 1. 克隆。skill 链接指向这个目录，装好后别移动或删除它
git clone git@github.com:caronyan/cc-dispatcher.git ~/cc-dispatcher   # 或 https://github.com/caronyan/cc-dispatcher.git
cd ~/cc-dispatcher

# 2. 安装（可重复运行）
./install.sh

# 3. 在 ~/.zshrc 里加一行（见下文），然后开新终端
echo 'source ~/cc-dispatcher/shared/herdr-shell.zsh' >> ~/.zshrc
```

4. 新开一个 Claude Code 会话，检查：`hc templates` 应列出 6 个 `cc-hd-*` 模板；装了 Herdr app 时打开 `herdr-cc-dispatch` layout，右侧有 cc-dispatch 面板。

更新：`git pull && ./install.sh`。skill 和模板是软链接，pull 后即生效；面板 mod 是复制的，要重跑 `install.sh` 才会刷新。

`install.sh` 做的事：

它建两类软链接：

- `~/.claude/skills/cc-herdr-dispatch-*` → `skills/` 下对应目录
- `~/.codex/skills/cc-herdr-dispatch-*`（以及 `~/.codex-api/skills/`，存在时）→ 同上，让 Codex 也能作主 agent 加载这组 skill。Codex 作主 agent 要能运行 `hc`、建 worktree、写 `/tmp/cc-dispatch`，需用 `codex --sandbox danger-full-access` 启动；工具上的差异见 `shared/herdr.md` 的"不是 Claude Code 时"
- `~/.gemini/config/skills/cc-herdr-dispatch-*`（存在 `~/.gemini` 或装了 `agy` 时；`AGY_SKILLS_DIR` 可改）→ 同上，让 Antigravity（`agy`）作主 agent。子 agent 也可移交给 agy（`handover --to agy`，弱隔离，任务和规则从命令行 `-i` 传入；`CC_HD_AGY_MODEL` 改默认模型）
- `~/.config/herdr-core/templates/cc-hd-*.md` → `shared/templates/` 下对应文件

装了 Herdr app（`~/.config/herdr-app`）时，还会复制 `herdr/cc-dispatch/mods/cc-dispatch` 到 `mods/`（Herdr 不跟随软链接加载 mod 图标；复制品带 `.cc-dispatcher` 标记，重跑会刷新），并链接 `herdr-cc-dispatch` layout。

还会在 `~/.claude/settings.json` 里加上用量检查（先备份为 `settings.json.bak-cc-dispatch-<时间>`）：一个 PostToolUse hook，Claude Code 作主 agent 时额度过阈值就让它先问你要不要交接（只针对某个模型的窗口，如 `7d Fable`，只在用那个模型时算）。不再加状态栏；早先版本加过的会被拿掉，原来的状态栏命令（及 `refreshInterval`）原样恢复。上下文占用不显示，也不触发交接。不想要时安装前设 `CC_HD_NO_USAGE_HOOK=1`，或之后运行 `python3 shared/scripts/hd_usage.py settings --remove`。

已存在的同名普通文件不覆盖。新开一个 Claude Code 会话后生效；`hc templates` 应列出 6 个 `cc-hd-*` 模板。

子 agent 状态由 herdr 管理，herdr 里不需要 Claude Code 的进度类 mod。在 `~/.zshrc` 里加一行：

```sh
source ~/cc-dispatcher/shared/herdr-shell.zsh   # 换成你克隆的路径
```

之后在 herdr 终端里（`HC_TERMINAL_ID` 有值）启动 `claude` 时，会清空 `CLAUDE_CODE_PLUGIN_DIRS`，不加载其中的 mod；herdr 之外不受影响。

在 herdr 终端里启动 Claude Code，然后：

```
/cc-herdr-dispatch-research <问题>
/cc-herdr-dispatch-review <方案文件 | diff>
/cc-herdr-dispatch-fix <问题描述>
/cc-herdr-dispatch-retro [仓库路径]
```

卸载：`python3 shared/scripts/hd_usage.py settings --remove`，删除上面两类软链接，以及 `~/.config/herdr-app/mods/cc-dispatch`、`layouts/herdr-cc-dispatch.*`。
