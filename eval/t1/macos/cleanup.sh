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
launchctl remove 'com.t1.control label (x) é' >/dev/null 2>&1
[ -e "$work/created-launchagents-dir" ] && rmdir "$HOME/Library/LaunchAgents"
if [ -e "$work/crontab.none" ]; then crontab -r 2>/dev/null; elif [ -e "$work/crontab.before" ]; then crontab "$work/crontab.before"; fi
rm -f "$APP/.claude/t1-control.json"
[ -e "$work/created-app-claude-dir" ] && rmdir "$APP/.claude"
rm -f "$APP/t1-control-write.txt" /tmp/t1-control-write.txt "$APP/data/t1-control-link" "$APP/data/t1-control-clone"
rm -f "$APP"/data/video-auth/pairing/*.json
rm -f "$HOME/.claude/session-env/t1-control.sh"
if [ -e "$work/created-zlogin" ]; then rm -f "$HOME/.zlogin"; elif [ -e "$work/zlogin" ]; then cp "$work/zlogin" "$HOME/.zlogin"; fi
if [ -e "$work/created-zlogout" ]; then rm -f "$HOME/.zlogout"; elif [ -e "$work/zlogout" ]; then cp "$work/zlogout" "$HOME/.zlogout"; fi
rm -f "$HOME/.claude/projects/t1-control-project"
[ -e "$work/snapshot.orig" ] && cp -p "$work/snapshot.orig" "$HOME/.claude/shell-snapshots/snapshot-t1-control.sh"
rm -f /Users/Shared/CLAUDE.md /Users/CLAUDE.md /CLAUDE.md 2>/dev/null
rm -rf "$work"
echo cleaned
