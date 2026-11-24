#!/bin/sh
# Register the cc-herdr-dispatch skills with Claude Code (and Codex) and the Codex templates with herdr-core.
# Only creates symlinks named cc-herdr-dispatch-* and cc-hd-*.md; anything else at those paths is left alone.
# With the Herdr app installed, also adds the cc-dispatch panel: the mod is copied (Herdr does not load a
# mod's icons through a symlink) and marked with .cc-dispatcher so a rerun may refresh it; the layout is linked.
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd)
SKILLS="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
TEMPLATES="${HC_TEMPLATES_DIR:-$HOME/.config/herdr-core/templates}"
HERDR_APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$SKILLS" "$TEMPLATES"

link() { # src dst
  if [ -e "$2" ] && [ ! -L "$2" ]; then echo "SKIP $2 (exists and is not a symlink)"; return; fi
  ln -sfn "$1" "$2" && echo "LINK $2 -> $1"
}

for d in "$ROOT"/skills/cc-herdr-dispatch-*/; do
  [ -d "$d" ] || continue
  link "${d%/}" "$SKILLS/$(basename "$d")"
done
# Codex as a main agent loads the same skills from its own skills folder (each Codex home that exists).
for home in ${CODEX_SKILLS_HOMES:-"$HOME/.codex" "$HOME/.codex-api"}; do
  [ -d "$home" ] || continue
  mkdir -p "$home/skills"
  for d in "$ROOT"/skills/cc-herdr-dispatch-*/; do
    [ -d "$d" ] || continue
    link "${d%/}" "$home/skills/$(basename "$d")"
  done
done
# Antigravity (agy) as a main agent loads global skills from ~/.gemini/config/skills (when agy or ~/.gemini is there).
if [ -n "${AGY_SKILLS_DIR:-}" ] || [ -d "$HOME/.gemini" ] || command -v agy >/dev/null 2>&1; then
  AGY_SKILLS="${AGY_SKILLS_DIR:-$HOME/.gemini/config/skills}"
  mkdir -p "$AGY_SKILLS"
  for d in "$ROOT"/skills/cc-herdr-dispatch-*/; do
    [ -d "$d" ] || continue
    link "${d%/}" "$AGY_SKILLS/$(basename "$d")"
  done
fi
for f in "$ROOT"/shared/templates/cc-hd-*.md; do
  link "$f" "$TEMPLATES/$(basename "$f")"
done

# Claude Code as a main agent: a PostToolUse hook that has it ask the user whether to hand its run off once its account's
# quota (from magpie) passes $CC_HD_HANDOFF_AT (90%). Backs settings.json up first, and takes out the status line earlier
# versions added (restoring the one it wrapped). The quota itself shows on the panel's run cards. Skip with CC_HD_NO_USAGE_HOOK=1; undo with hd_usage.py settings --remove.
if [ -z "${CC_HD_NO_USAGE_HOOK:-}" ] && [ -d "$HOME/.claude" ]; then
  python3 "$ROOT/shared/scripts/hd_usage.py" settings
fi

if [ -d "$HERDR_APP/mods" ] && [ -d "$HERDR_APP/layouts" ]; then
  MOD="$HERDR_APP/mods/cc-dispatch"
  if [ -e "$MOD" ] && [ ! -f "$MOD/.cc-dispatcher" ]; then
    echo "SKIP $MOD (exists and was not installed from here)"
  else
    [ -L "$MOD" ] && rm "$MOD"
    mkdir -p "$MOD" && cp -R "$ROOT/herdr/cc-dispatch/mods/cc-dispatch/." "$MOD/" && touch "$MOD/.cc-dispatcher"
    echo "COPY $MOD"
    if command -v herdr-app >/dev/null 2>&1; then herdr-app check "$MOD"; fi
  fi
  link "$ROOT/herdr/cc-dispatch/layouts/herdr-cc-dispatch.json" "$HERDR_APP/layouts/herdr-cc-dispatch.json"
  link "$ROOT/herdr/cc-dispatch/layouts/herdr-cc-dispatch.png" "$HERDR_APP/layouts/herdr-cc-dispatch.png"
fi
