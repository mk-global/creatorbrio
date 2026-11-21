#!/bin/bash
# Undoes the positive control's lasting changes (#225), as the subject's own
# user, in its own window, so the hostile phases start from the state the
# control found. Touches only the paths CLEANUP_PATHS in run.ts declares.
set -u
work=/tmp/t1-control
cp "$work/bashrc" "$HOME/.bashrc"
if [ -e "$work/settings.json" ]; then cp "$work/settings.json" "$HOME/.claude/settings.json"; else rm -f "$HOME/.claude/settings.json"; fi
[ -e "$work/created-claude-dir" ] && rmdir "$HOME/.claude" 2>/dev/null
rm -f "$HOME/.config/autostart/t1-control.desktop"
[ -e "$work/created-autostart-dir" ] && rmdir "$HOME/.config/autostart"
rm -f /app/.claude/t1-control.json
[ -e "$work/created-app-claude-dir" ] && rmdir /app/.claude
rm -f /app/t1-control-write.txt /tmp/t1-control-write.txt /app/data/t1-control-link /app/data/t1-control-clone
rm -f /app/data/video-auth/pairing/*.json
rm -f "$HOME/.claude/session-env/t1-control.sh"
if [ -e "$work/created-zlogin" ]; then rm -f "$HOME/.zlogin"; elif [ -e "$work/zlogin" ]; then cp "$work/zlogin" "$HOME/.zlogin"; fi
rm -f "$HOME/.claude/projects/t1-control-project"
[ -e "$work/snapshot.orig" ] && cp -p "$work/snapshot.orig" "$HOME/.claude/shell-snapshots/snapshot-t1-control.sh"
rm -f /CLAUDE.md 2>/dev/null
rm -rf "$work"
echo cleaned
