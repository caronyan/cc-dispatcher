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

## Tests

`node --test herdr/tests/*.test.mjs` covers `model.js` and `loader.js` (on a real shell and git).
Check `main.js` with `herdr-app check ~/.config/herdr-app/mods/cc-dispatch`. `RECIPE.md` describes the build in full.
