#!/bin/bash
# Undoes the macOS positive control's lasting changes (#225), as the subject
# user, in its own window. Touches only the paths CLEANUP_PATHS declares for macOS.
set -u
APP=/Users/Shared/creatorbrio
work=/tmp/t1-control
if [ -e "$work/created-zshrc" ]; then rm -f "$HOME/.zshrc"; else cp "$work/zshrc" "$HOME/.zshrc"; fi
if [ -e "$work/settings.json" ]; then cp "$work/settings.json" "$HOME/.claude/settings.json"; else rm -f "$HOME/.claude/settings.json"; fi
[ -e "$work/created-claude-dir" ] && rmdir "$HOME/.claude" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/t1.control.plist"
[ -e "$work/created-launchagents-dir" ] && rmdir "$HOME/Library/LaunchAgents"
rm -f "$APP/.claude/t1-control.json"
[ -e "$work/created-app-claude-dir" ] && rmdir "$APP/.claude"
rm -f "$APP/t1-control-write.txt" /tmp/t1-control-write.txt
rm -f "$APP"/data/video-auth/pairing/*.json
rm -rf "$work"
echo cleaned
