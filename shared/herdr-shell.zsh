# Source from ~/.zshrc. In herdr terminals ($HC_TERMINAL_ID set), Claude Code starts without the
# mods listed in CLAUDE_CODE_PLUGIN_DIRS: herdr tracks agent state itself. Elsewhere nothing changes.
claude() {
  if [ -n "$HC_TERMINAL_ID" ]; then
    command claude --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}}' "$@"
  else
    command claude "$@"
  fi
}
