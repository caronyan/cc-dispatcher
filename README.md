# cc-dispatcher

在 [herdr](https://herdr.dev/) 里，让 Claude Code 把调研、审查、实现、修复、测试派给 Codex 子 agent 执行、收回报并验收的一组 Claude Code skill。

子 agent 由 herdr-core（`hc`）托管：它们以 Claude Code 的子终端出现在 herdr 侧栏，状态（干活 / 完成 / 出错 / 等人）由 herdr 跟踪，出错和等人时 herdr 把通知送进 Claude 的对话。Claude 只负责拆分、派发、看状态、验收，不做用量计量。

## skill

| skill | 触发 | 作用 |
|---|---|---|
| `cc-herdr-dispatch-research` | 手动 | 立题、拆线程并行调研代码/资料/可行性，核实证据，出调研结论或方案 |
| `cc-herdr-dispatch-review` | 手动 | 方案或代码的交叉审查 + 反例测试，分诊并补强 |
| `cc-herdr-dispatch-dev` | 手动，或 review 收尾时经用户确认 | 定契约、拆任务卡，子 agent 在各自 worktree 并行实现，验收后合并 |
| `cc-herdr-dispatch-fix` | 手动，或由上面几个调用 | 修复已确认的问题并补回归测试，应用到工作区，不提交 |
| `cc-herdr-dispatch-test` | 手动，或由上面几个调用 | 分片跑测试、分诊失败，可补测试 |
| `cc-herdr-dispatch-retro` | 手动 | 复盘已结束的运行和用户的纠正，经确认后对 skill 文件或项目文档做最小改动，记进 `retro-log.md` |

这组 skill 之间只互相调用；缺了哪个，就由 Claude 自己做那部分，不会转去调用其他同类 skill。

## 结构

```
shared/herdr.md              共用约定：分工、派发与回报、失败处理、守则
shared/survey.md             代码摸底的做法
shared/scripts/hd_dispatch.py  派发脚本：probe / run / send / wait / collect / status / diagnose / cleanup
shared/scripts/hd_check.py   按 schema 检查回报 JSON
shared/scripts/hd_handoff.py 交接包：子 agent 移交（handover）和主 agent 交接（handoff / adopt）用的材料
shared/scripts/hd_usage.py   主 agent 的账号额度：优先从 magpie 读，面板运行卡片上显示，超过阈值时提示主 agent 先问你要不要交接
shared/scripts/hd_retro.py   复盘材料：digest（运行记录 + 用户原话）/ mark（记为已复盘）
shared/templates/cc-hd-*.md  herdr-core 模板：{read,write,net} × {medium,high}
herdr/cc-dispatch/           Herdr 面板（mod + layout）：派发运行、轮次、回报验收、历史，见其 README / RECIPE
herdr/tests/                 面板逻辑的 node 测试：node --test herdr/tests/*.test.mjs
skills/cc-herdr-dispatch-*/  各 skill 的 SKILL.md 与 references（提示模板、回报 schema）
```

运行中的文件：

- 每次运行的记录在目标仓库的 `.cc-dispatch/<kind>-<run>/`（自动加进 `.git/info/exclude`）。
- worktree 在仓库旁的 `.cc-dispatch-wt/<repo>/` 下。
- 子 agent 的回报文件在 `/tmp/cc-dispatch/`（可用 `CC_HD_HOME` 改）。
- 每个调用有一份只追加的事件流 `agents/<call>/events.jsonl`：派发、返工、自动重试、每次交回的状态与回报检查、卡住、清理，以及交回时 Codex 会话的累计 token / 命令 / 改动文件数。面板的用量和 Timeline、`hd_retro.py` 的复盘材料都读它；Codex 清掉自己的日志后历史仍在。格式见 `hd_dispatch.py --help`。
- 用户在面板上暂停、继续或终止一次运行时，状态写在 `.cc-dispatch/<kind>-<run>/control.json`（`running|paused|stopping|stopped|handoff`、被挂起的调用；主 agent 交接时另记交接包和交接前的状态，新主 agent `adopt` 后记 `owner`）；终止后另有 `stop.md`（各调用状态、回报路径、未交合格回报者的屏幕末尾）和 `stop.log`。
- 每个子 agent 终端带 hc 标签：`cc.run cc.call cc.kind cc.dir cc.mode cc.round`（派发时），`cc.report=ok|bad|missing`、`cc.failure`（collect / wait 时更新），`cc.retry`（服务端繁忙或限流、正在自动重试时）。同样的验收结果也写进 `meta.json` 的 `report_check`、`failure`，终端没了也能看。`meta.json` 还记下派发它的 Claude：`parent`（终端）、`space`（herdr space）、`session`（Claude Code 会话，面板据此读它的后台任务）、`claude_cwd`。

## Herdr 面板

Herdr 原生 Agents 栏负责"谁活着、什么状态、谁是谁的子 agent"；`herdr/cc-dispatch` 面板只放 skill 才知道的：每次派发运行、各子 agent 的轮次、回报是否过 schema、失败原因、已结束运行的历史。行内可跳转、Peek、看回报 / 任务文件 / worktree 改动，或经确认把"请收回报 / 请诊断"发给派发它的 Claude、清理终端。

运行卡片标题行末尾有三个运行级图标按钮（悬停显示名称），点了都要再确认一次：

- **Pause**：给工作中的子 agent 按停止键，Codex 会话保留，已交回的不动；派发方暂停期间 `run`/`send` 被拒，`wait` 不报任何调用。
- **Resume**：让被挂起的子 agent 接着做任务，不重做已完成的部分。
- **Stop**：优雅终止：让还没交合格回报的子 agent 停手，把已完成部分写进回报（最多等 3 分钟），收回报、关终端（worktree 保留），写 `stop.md`，再请派发方汇总给你并等你决定下一步。

暂停是运行这一层的状态，和子 agent 自己的状态分开显示：运行圆点换成暂停标记，卡片边框变黄，标题下有一行"Paused · 多久前 · 挂起几个"；被挂起的子 agent 的圆点从转圈换成暂停标记，归入 `paused` 组。终止中和已终止也各有一行，已终止的可直接打开 `stop.md`。`./install.sh` 会一并安装（装了 Herdr app 时），然后切到 `herdr-cc-dispatch` layout。

断网时，子 agent 在面板上标为 waiting for network；因断网停下的不占自动重试次数，网络恢复后自动接着做，主 agent 不用处理。

## 主 agent 交接

主 agent 自己的会话快到上限时，可以把整个运行交给另一个能加载这套 skill 的 agent（Claude Code、Codex 等）接着做，子 agent 不受影响：

- **触发**：你在对话里说"准备交接"；或主 agent 所用账号的某个额度窗口（5 小时、7 天等）超过 90%（`CC_HD_HANDOFF_AT` 可改）时，它会先问你要不要交接，你同意才开始。不论主 agent 是 Claude Code 还是 Codex 都会提示：`hd_dispatch.py wait`/`collect` 每次都检查，Claude Code 另有 hook 在工具调用后检查。每个窗口重置前只问一次。
- **额度从哪来**：先问本机 magpie（网关 `127.0.0.1:3425`，不通时后台跑 `magpie quota --json`），按该服务最近一次实际使用的账号算；没有 magpie 时，Codex 用它会话日志里的 `rate_limits`；都没有就不显示、不检查。面板上每个运行中或暂停的运行卡片头下面有一行「main agent · Claude Code · pro　5h 50%　7d 20%」，按主 agent 终端当前实际跑的程序选订阅（Codex 就显示 Codex 的），≥70% 黄、≥90% 红，悬停看重置时间和来源，约 30 秒刷新一次。`python3 shared/scripts/hd_usage.py quota codex` 可以看当前读到的值。
- 主 agent 停止开始新工作，写交接说明，运行 `hd_dispatch.py handoff`，把给新 agent 的提示词贴在对话里（面板上该运行的 Copy prompt 也能复制）。
- 你在 herdr 里新开终端启动 Claude Code 或 Codex，发这段提示词。新 agent 读交接包、运行 `adopt` 接手、向你复述现状，经你确认后继续。原来的主 agent 之后再操作这个运行会被拒绝。
- 不交接了：让原主 agent 运行 `hd_dispatch.py resume`。

细节见 `shared/herdr.md` 的"主 agent 交接"。

## 意外中断后恢复

herdr 或机器重启、终端被误关时，没正常结束的子 agent 在面板上标为"已中断"（`lost`），面板只提示，不自动处理。经你同意后主 agent 运行 `hd_dispatch.py recover`：子 agent 能续上原会话就续上，续不上就开新会话读原任务卡接着做；恢复后运行先处于暂停，主 agent 收一遍现状、你确认后再 `resume`。主 agent 自己也没了时，`recover` 会给出续上原主 agent 会话的命令，以及交给新主 agent 的交接包和提示词。

## 子 agent 的权限

三种模式都用 Codex 的 `workspace-write` 沙箱，靠工作目录区分能写哪里：

- **read**：在 `/tmp/cc-dispatch/<run>/<call>/` 里运行，仓库或 worktree 只能读不能写。
- **write**：在指定 worktree 里运行，改动只落在那里；终端不联网。
- **net**：同 write，但终端能联网，只给确实要装依赖或访问外部接口的任务用。

所有模式都能用网页搜索。回报统一写到 `/tmp/cc-dispatch/` 下，这是沙箱在工作目录之外唯一能写的地方。子 agent 不能运行 `hc`，所以完成与否由 Claude 一侧的 `hd_dispatch.py wait` 根据 herdr 的状态判断。

`/tmp/cc-dispatch` 是一个 git 仓库，Codex 的"信任此目录"只需在这里确认一次；仓库首次派发时的信任确认由脚本自动完成。

## 安装

前提：herdr（带 herdr-core `hc`）、Codex CLI（已 `codex login`）、Python 3。

```sh
./install.sh
```

它建两类软链接：

- `~/.claude/skills/cc-herdr-dispatch-*` → `skills/` 下对应目录
- `~/.codex/skills/cc-herdr-dispatch-*`（以及 `~/.codex-api/skills/`，存在时）→ 同上，让 Codex 也能作主 agent 加载这组 skill。Codex 作主 agent 要能运行 `hc`、建 worktree、写 `/tmp/cc-dispatch`，需用 `codex --sandbox danger-full-access` 启动；工具上的差异见 `shared/herdr.md` 的"不是 Claude Code 时"
- `~/.config/herdr-core/templates/cc-hd-*.md` → `shared/templates/` 下对应文件

装了 Herdr app（`~/.config/herdr-app`）时，还会复制 `herdr/cc-dispatch/mods/cc-dispatch` 到 `mods/`（Herdr 不跟随软链接加载 mod 图标；复制品带 `.cc-dispatcher` 标记，重跑会刷新），并链接 `herdr-cc-dispatch` layout。

还会在 `~/.claude/settings.json` 里加上用量检查（先备份为 `settings.json.bak-cc-dispatch-<时间>`）：一个 PostToolUse hook，Claude Code 作主 agent 时额度过阈值就让它先问你要不要交接（只针对某个模型的窗口，如 `7d Fable`，只在用那个模型时算）。不再加状态栏；早先版本加过的会被拿掉，原来的状态栏命令（及 `refreshInterval`）原样恢复。上下文占用不显示，也不触发交接。不想要时安装前设 `CC_HD_NO_USAGE_HOOK=1`，或之后运行 `python3 shared/scripts/hd_usage.py settings --remove`。

已存在的同名普通文件不覆盖。新开一个 Claude Code 会话后生效；`hc templates` 应列出 6 个 `cc-hd-*` 模板。

子 agent 状态由 herdr 管理，herdr 里不需要 Claude Code 的进度类 mod。在 `~/.zshrc` 里加一行：

```sh
source /path/to/cc-dispatcher/shared/herdr-shell.zsh
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
