# cc-dispatch for Herdr

A Herdr panel for the cc-herdr-dispatch skills. Herdr's Agents list already shows which helpers are
live and their state; this panel shows the dispatch layer on top: runs, each helper's round, report
verdict and failure, history after the terminals are gone, and a hand-off to the dispatching Claude.

## Install

`./install.sh` at the repository root copies `mods/cc-dispatch/` to `~/.config/herdr-app/mods/` and
links `layouts/herdr-cc-dispatch.json`. Then switch to it: `ctrl-shift-l`, or
`herdr-app do layout.switch '{"name":"herdr-cc-dispatch"}'`.

To put it in your own layout instead, add:

- to the tab bar row: `{ "id": "cc-dispatch-toggle", "type": "block", "content": { "mod": "cc-dispatch", "props": { "role": "toggle" } }, "size": { "px": 112 } }`
- beside the work area: `{ "id": "cc-dispatch-panel", "type": "column", "children": [{ "id": "cc-dispatch", "type": "block", "content": { "mod": "cc-dispatch" } }], "size": { "px": 411 }, "min": 300, "max": 720 }`

After editing the mod, rerun `./install.sh` (the installed copy is not a link: Herdr does not load a
mod's icons through one).

## Data

- `<repo>/.cc-dispatch/<kind>-<run>/agents/<call>/meta.json`, written by `shared/scripts/hd_dispatch.py`,
  including `report_check` and `failure` after `collect`.
- hc labels on each helper terminal: `cc.run cc.call cc.kind cc.dir cc.mode cc.round cc.report cc.failure`.
- `.cc-dispatch/topics/*/topic.json` supplies Task bindings, `depends_on` and `follows`.
- `.cc-dispatch/messages/*.summary.json` supplies message counts. The list script reads these summaries
  after the run state sections, never message bodies. Missing summaries count as zero. Each Topic's
  unconfirmed answers and open outgoing questions are summed from every summary's `by_sender[topic]`,
  including summaries for deleted Topics; `by_sender.user` is excluded.

## Messages And Dependencies

Topic 标题的信封显示未确认来信与答案的总数；只有外发问题待回答时，信封不带数字。
有未确认来信的已结束 Topic 始终留在可见列表，不收进“更早的”。
Topic 摘要常驻“消息”入口，显示最近 5 条往来，以及可添加、解除的“关注 Topic”列表；
已删除的关注项仍可解除。

点击信封或“消息”后，面板通过 `topic inbox --topic T --as-user --all` 按需读取
`MESSAGE_DATA`，按对方 Topic 分组，显示排队、已送达、已确认、待回答、已回答、已撤销、
已作废。用户可给本 Topic 负责人留言或提问、撤销自己或本 Topic 发出的 open 问题、
确认来信和答案。操作分别使用 `topic msg`、`topic msg-withdraw`、`topic msg-ack`，
关注使用 `topic follow`；均带 `--as-user` 和仓库路径，自由文本以 `--text=…` 传入。
操作后在对话框内重读消息，失败时保留输入并显示原因；归档 Topic 仍可查阅和确认历史消息。

Task 依赖可写 `k2` 或 `<topic>:k2`，面板按同仓库快照计算结果：完成即放行，等待、
已终止、成环时禁用派发和重发，已放弃或已删除时显示提示并放行。成环会显示完整路径，
折叠 Task 也保留依赖提示。每轮 refresh 都调用一次 `topic deliver`，收到非空
`DELIVERED` 或 `MESSAGE_DELIVERED` 后重载列表；远端空间的读取和操作沿用同一个 `on`。

## Tests

`node --test herdr/tests/*.test.mjs` covers `model.js` and `loader.js` (on a real shell and git).
Check `main.js` with `herdr-app check ~/.config/herdr-app/mods/cc-dispatch`. `RECIPE.md` describes the build in full.
