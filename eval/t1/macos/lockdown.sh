#!/bin/bash
# Takes the disposable VM's administrator account away from anything the
# subject could reach, per clone and at run start (#225), as root over SSH.
# The golden image and the base VM are untouched, so the founder can still log
# in to the base VM with the password it was created with.
#
# The admin account the VM was built with has passwordless sudo and a password a
# person chose, which the subject could guess (`dscl . -authonly`, `su`) and
# then reach root. Its password cannot be changed from here: the account holds
# the VM's only Secure Token, so `dscl . -passwd` asks for the old password even
# of root and `sysadminctl -deleteUser` refuses the last Secure Token account.
# So:
#
#   create <orig> <new>      a fresh administrator <new>: a random password that is never stored
#                            or printed, the same SSH key as <orig>, passwordless sudo, SSH key-only
#                            for the whole machine and for <new> alone
#   demote <orig> <new>      <orig> loses sudo and the admin group, cannot authenticate (pwpolicy
#                            -disableuser), has no shell and no SSH keys; its home is closed
#   verify <orig> <new> <subject>   JSON: what the run requires and the outcomes that prove it
#
# The harness runs `create` as <orig>, reconnects as <new>, runs `demote`, then `verify`.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
cmd=${1:-}
orig=${2:-}
new=${3:-}
valid() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }
valid "$orig" && valid "$new" && [ "$orig" != "$new" ] || { echo "bad account names" >&2; exit 2; }
DROPIN=/etc/ssh/sshd_config.d/000-t1-harness.conf

case "$cmd" in
create)
  # The password exists in this process and on sysadminctl's command line for an instant, before the subject has any process; it is not kept.
  pw=$(openssl rand -hex 24)
  sysadminctl -addUser "$new" -fullName "T1 Run" -password "$pw" -home "/Users/$new" -shell /bin/zsh -admin >/dev/null 2>&1
  unset pw
  id "$new" >/dev/null
  createhomedir -c -u "$new" >/dev/null 2>&1 || true
  chmod -N "/Users/$new" 2>/dev/null || true
  chmod 700 "/Users/$new"
  install -d -o "$new" -g staff -m 700 "/Users/$new/.ssh"
  install -o "$new" -g staff -m 600 "/Users/$orig/.ssh/authorized_keys" "/Users/$new/.ssh/authorized_keys"
  printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$new" >"/etc/sudoers.d/t1run-harness"
  chmod 440 /etc/sudoers.d/t1run-harness
  chown root:wheel /etc/sudoers.d/t1run-harness
  visudo -cf /etc/sudoers.d/t1run-harness >/dev/null
  # Key-only SSH for the whole machine, for this one account. sshd reads its configuration per connection.
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nChallengeResponseAuthentication no\nPermitRootLogin no\nAllowUsers %s\n' "$new" >"$DROPIN"
  chmod 644 "$DROPIN"
  echo created
  ;;
demote)
  rm -f "/etc/sudoers.d/$orig"
  dseditgroup -o edit -d "$orig" -t user admin >/dev/null 2>&1 || true
  pwpolicy -u "$orig" -disableuser >/dev/null 2>&1
  dscl . -create "/Users/$orig" UserShell /usr/bin/false
  rm -rf "/Users/$orig/.ssh"
  chmod -N "/Users/$orig" 2>/dev/null || true
  chmod 700 "/Users/$orig"
  pkill -u "$orig" 2>/dev/null || true
  echo demoted
  ;;
verify)
  subject=${4:-}
  valid "$subject" || { echo "bad subject name" >&2; exit 2; }
  json_list() { paste -sd' ' - | sed 's/"/\\"/g'; }
  admin=$(dscl . -read /Groups/admin GroupMembership | sed 's/^GroupMembership: *//' | tr ' ' '\n' | sort | paste -sd' ' -)
  uids=$(dscl . -list /Users UniqueID | awk '$2>=500{print $1}' | sort | paste -sd' ' -)
  # A few candidates for each account, no more: repeated failures lock an account for a while.
  weak=""
  for u in "$orig" "$new" "$subject"; do
    for p in "$u" lume admin; do
      dscl . -authonly "$u" "$p" >/dev/null 2>&1 && weak="$weak $u:$p"
    done
  done
  orig_auth=$(pwpolicy -u "$orig" authentication-allowed 2>&1 | grep -c "not allowed to authenticate" || true)
  orig_sudo=$(sudo -l -U "$orig" 2>&1 | grep -c "may run" || true)
  subject_sudo=$(sudo -l -U "$subject" 2>&1 | grep -c "may run" || true)
  orig_admin=$(dscl . -read /Groups/admin GroupMembership | tr ' ' '\n' | grep -cx "$orig" || true)
  shell=$(dscl . -read "/Users/$orig" UserShell | awk '{print $2}')
  sshd=$(/usr/sbin/sshd -T -C "user=$new,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '{k=tolower($1)} k=="passwordauthentication"||k=="kbdinteractiveauthentication"||k=="permitrootlogin"||k=="allowusers"{printf "%s=%s ", k, tolower($2)}')
  mode() { stat -f '%Lp' "$1" 2>/dev/null || echo missing; }
  printf '{"adminGroup":"%s","uidsFrom500":"%s","defaultPasswordsAccepted":"%s","origAuthenticationDisabled":%s,"origSudo":%s,"origInAdminGroup":%s,"origShell":"%s","subjectSudo":%s,"sshd":"%s","homeModes":{"%s":"%s","%s":"%s","%s":"%s"}}\n' \
    "$admin" "$uids" "${weak# }" "$([ "$orig_auth" -ge 1 ] && echo true || echo false)" "$([ "$orig_sudo" -ge 1 ] && echo true || echo false)" "$([ "$orig_admin" -ge 1 ] && echo true || echo false)" "$shell" \
    "$([ "$subject_sudo" -ge 1 ] && echo true || echo false)" "${sshd% }" "$orig" "$(mode "/Users/$orig")" "$new" "$(mode "/Users/$new")" "$subject" "$(mode "/Users/$subject")"
  ;;
*)
  echo "usage: lockdown.sh create|demote|verify <orig> <new> [<subject>]" >&2
  exit 2
  ;;
esac
