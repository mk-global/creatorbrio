#!/bin/bash
# Provisions the disposable macOS VM that becomes the T1 golden image (#225).
# Run as root by the harness over SSH (`sudo bash provision.sh <app.tar> <harness.tar> <commit>`),
# before any confinement, so it may use the VM's internet access. Idempotent:
# each step checks what is already there and skips or redoes only that step.
#
#   - Node 22 from the official tarball, pinned by version and SHA-256
#   - the Claude CLI pinned to one version in a root-owned prefix the subject
#     cannot write, so it cannot update itself (the app's environment also
#     sets DISABLE_AUTOUPDATER=1), recorded with the hash of its binary
#   - a non-admin subject user `designer` with no sudo and a home
#   - the app from a `git archive` of the harness commit (no host data,
#     uploads or .env.local), installed and built as `designer` with the
#     repository's normal `npm ci`, which downloads Chromium for export
#   - the harness itself in a root-owned folder, and Spotlight off, so no
#     indexer opens a canary
set -euo pipefail

APP_TAR=$1
HARNESS_TAR=$2
COMMIT=$3

NODE_VERSION=22.23.5
NODE_SHA256=e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d
CLAUDE_VERSION=2.1.328
T1=/usr/local/t1
SUBJECT=designer
HOME_DIR=/Users/$SUBJECT
APP=/Users/Shared/creatorbrio

log() { printf 't1-provision: %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "arm64 only" >&2; exit 1; }

install -d -o root -g wheel -m 755 "$T1"
install -d -o root -g wheel -m 700 /var/t1

# Generic machine names: the image's records must not carry anyone's name.
scutil --set ComputerName "t1-subject"
scutil --set LocalHostName "t1-subject"
scutil --set HostName "t1-subject"

# Spotlight would open every file in the subject's home, canaries included.
mdutil -a -i off >/dev/null 2>&1 || true

# Node, verified against the pinned hash before it is unpacked.
if [ "$("$T1/node/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  log "installing Node $NODE_VERSION"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  echo "$NODE_SHA256  $tmp/node.tar.gz" | shasum -a 256 -c - >/dev/null
  rm -rf "$T1/node"
  mkdir -p "$T1/node"
  tar -xzf "$tmp/node.tar.gz" -C "$T1/node" --strip-components 1
  chown -R root:wheel "$T1/node"
  rm -rf "$tmp"
fi
export PATH="$T1/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# The subject: a standard (non-admin) user with no sudo, hidden from the login window.
if ! id "$SUBJECT" >/dev/null 2>&1; then
  log "creating user $SUBJECT"
  # A random password nobody keeps: the subject never logs in.
  sysadminctl -addUser "$SUBJECT" -fullName "T1 Designer" -password "$(openssl rand -hex 24)" -home "$HOME_DIR" -shell /bin/zsh >/dev/null 2>&1
  createhomedir -c -u "$SUBJECT" >/dev/null 2>&1 || true
  dscl . -create "/Users/$SUBJECT" IsHidden 1
fi
for g in admin _developer wheel staff_admin; do
  dseditgroup -o checkmember -m "$SUBJECT" "$g" >/dev/null 2>&1 && dseditgroup -o edit -d "$SUBJECT" -t user "$g" || true
done
if sudo -l -U "$SUBJECT" 2>/dev/null | grep -q "may run"; then echo "$SUBJECT can use sudo" >&2; exit 1; fi
[ -d "$HOME_DIR" ] || { install -d -o "$SUBJECT" -g staff -m 750 "$HOME_DIR"; }
chown "$SUBJECT:staff" "$HOME_DIR"
chmod 750 "$HOME_DIR"

# The Claude CLI in a root-owned prefix: the subject can run it but never replace it.
if [ "$("$T1/claude/bin/claude" --version 2>/dev/null | awk '{print $1}')" != "$CLAUDE_VERSION" ]; then
  log "installing the Claude CLI $CLAUDE_VERSION"
  rm -rf "$T1/claude"
  npm install --global --prefix "$T1/claude" --no-fund --no-audit "@anthropic-ai/claude-code@$CLAUDE_VERSION" >/dev/null
  chown -R root:wheel "$T1/claude"
  chmod -R go-w "$T1/claude"
fi
claude_real=$(realpath "$T1/claude/bin/claude")
[ "$("$T1/claude/bin/claude" --version | awk '{print $1}')" = "$CLAUDE_VERSION" ] || { echo "Claude CLI version mismatch" >&2; exit 1; }

# The harness, root-owned and read-only to everyone else.
log "installing the harness"
rm -rf "$T1/harness.new"
mkdir -p "$T1/harness.new"
tar -xf "$HARNESS_TAR" -C "$T1/harness.new"
chown -R root:wheel "$T1/harness.new"
chmod -R go-w "$T1/harness.new"
rm -rf "$T1/harness"
mv "$T1/harness.new" "$T1/harness"

# The app, from the archive of one commit, installed and built as the subject.
if [ "$(cat "$APP/.t1-commit" 2>/dev/null || true)" != "$COMMIT" ]; then
  log "installing the app at $COMMIT"
  rm -rf "$APP"
  install -d -o "$SUBJECT" -g staff -m 755 "$APP"
  tar -xf "$APP_TAR" -C "$APP"
  chown -R "$SUBJECT:staff" "$APP"
  sudo -u "$SUBJECT" -H env -i HOME="$HOME_DIR" PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 TMPDIR=/private/tmp \
    /bin/bash -c "cd '$APP' && npm ci --no-fund --no-audit && npm run build" >/var/t1/provision-build.log 2>&1 || {
    tail -40 /var/t1/provision-build.log >&2
    exit 1
  }
  printf '%s\n' "$COMMIT" >"$APP/.t1-commit"
  chown "$SUBJECT:staff" "$APP/.t1-commit"
fi
# The checkout's parent chain, closed to the subject (round 7): the CLI reads instruction files, settings and MCP definitions in every folder above its working directory, and Node reads every ancestor's
# node_modules. /Users/Shared ships world-writable (drwxrwxrwt), so a file the subject made there would load in every later session. It is made root-owned, mode 755, with no ACL; /Users and / are root's already.
# The checkout itself stays the subject's: the subject owns /Users/Shared/creatorbrio and everything in it, and can write nothing above it. The preflight proves this again from root's facts on every run.
chown root:wheel /Users/Shared
chmod 0755 /Users/Shared
chmod -N /Users/Shared 2>/dev/null || true
[ "$(stat -f '%Su:%Sg %Lp' /Users/Shared)" = "root:wheel 755" ] || { echo "/Users/Shared is not root:wheel 755" >&2; exit 1; }
[ "$(stat -f '%Su' "$APP")" = "$SUBJECT" ] || { echo "$APP is not the subject's" >&2; exit 1; }
chrome=$(sudo -u "$SUBJECT" -H env -i HOME="$HOME_DIR" PATH="$PATH" /bin/bash -c "cd '$APP' && npx --no-install puppeteer browsers list 2>/dev/null" | head -1 || true)

# What a record needs to name this image.
{
  printf '{"macos":"%s","build":"%s",' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)"
  printf '"node":{"version":"%s","tarballSha256":"%s"},' "$NODE_VERSION" "$NODE_SHA256"
  printf '"claude":{"version":"%s","binarySha256":"%s","install":"npm, root-owned prefix"},' "$CLAUDE_VERSION" "$(shasum -a 256 "$claude_real" | awk '{print $1}')"
  printf '"commit":"%s","chrome":"%s",' "$COMMIT" "$(printf '%s' "$chrome" | tr -d '"\\' | cut -c1-120)"
  printf '"subjectUid":%s}\n' "$(id -u "$SUBJECT")"
} >"$T1/provenance.json"
chmod 644 "$T1/provenance.json"
log "done: $(cat "$T1/provenance.json")"
