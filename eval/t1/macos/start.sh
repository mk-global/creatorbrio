#!/bin/bash
# The T1 run's root-side control inside the disposable macOS VM (#225), run
# by the harness over SSH with sudo. Everything it changes is undone by
# `down`, and the whole VM is a clone that is deleted after the run anyway.
#
#   start.sh discover        the facts the host needs to write the run's configuration (JSON)
#   start.sh es-start <event>...   start eslogger for those event types, writing to a FIFO the observer reads; run from an ssh session of its own
#   start.sh egress-user     make the egress proxy's own service account (idempotent) and its folder; prints its uid (JSON)
#   start.sh install-config  read the run's configuration (one JSON document) on standard input into /var/t1
#   start.sh config-file <name>   read one file on standard input into the records' config folder
#   start.sh watchdog <epoch>      a root job, independent of the host, that at that time kills the subject's processes (the app, the CLI and the token in their environment)
#   start.sh up              plant canaries, start the harness services as launchd daemons,
#                            confine the subject with pf, point the system resolver at the
#                            logging one, start the observer, and wait until all are ready
#   start.sh token           read one line (the model token, or nothing) on standard input
#                            and hand it to the app's launcher
#   start.sh channels        the VM's host file-sharing devices: VirtioFS devices, their mounts, and what the device exposes
#   start.sh scan <address>  open TCP ports on an address (root, unconfined)
#   start.sh records         the records folder as a gzip tar on standard output
#   start.sh down            stop and remove everything `up` started
set -euo pipefail
T1=/usr/local/t1
H=$T1/harness
STATE=/var/t1
RUN=/var/run/t1
ANCHOR=com.apple/250.T1Confinement
# The egress proxy is not among these: it runs as its own service account, the only user pf lets reach the network, with its own folder outside /var/t1.
SERVICES="dns-logger web canary-services"
EGRESS_USER=_t1egress
EGRESS_DIR=/var/t1-egress
SUBJECT=designer
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
cmd=${1:-}
shift || true

node_json() { "$T1/node/bin/node" -e "$1"; }

virtiofs_mounts() { mount | awk '/\((AppleVirtIOFS|virtiofs)/ { sub(/^[^ ]+ on /, ""); sub(/ \([^(]*$/, ""); print }'; }

# The devices behind the network services (the uplink), which must carry no IPv6 address during a run.
uplink_devices() { networksetup -listallhardwareports | awk -F': ' '/^Device:/{print $2}'; }
uplink_inet6() {
  for dev in $(uplink_devices); do ifconfig "$dev" 2>/dev/null | grep -q 'inet6 ' && printf '%s\n' "$dev"; done | paste -sd, -
}
cfg_value() { node_json "const c=JSON.parse(require('fs').readFileSync('/var/t1/config.json','utf8')); const v=($1); process.stdout.write(v==null?'':String(v))"; }

# Layer one for IPv6 link-local, tested before IPv6 goes off and before the app runs: with the anchor loaded, the subject's
# attempts to the gateway's link-local address on each port must fail and each must appear in pf's log.
link_local_selftest() {
  local gw6 ports p pids=() tp
  gw6=$(cfg_value 'c.ipv6 && c.ipv6.gateway')
  ports=$(cfg_value 'c.ipv6 && c.ipv6.ports.join(" ")')
  if [ -z "$gw6" ]; then printf '{"gateway":false,"probes":[]}'; return; fi
  rm -f "$STATE/ll-selftest.pcap" "$STATE/ll-selftest.rc"
  tcpdump -n -U -i pflog0 -w "$STATE/ll-selftest.pcap" >/dev/null 2>&1 &
  tp=$!
  sleep 1
  for p in $ports; do
    ( cd / && sudo -u "$SUBJECT" /usr/bin/nc -z -G 2 -w 2 "$gw6" "$p" >/dev/null 2>&1; echo "$p $?" >>"$STATE/ll-selftest.rc" ) &
    pids+=($!)
  done
  wait "${pids[@]}"
  sleep 1
  kill -INT "$tp" 2>/dev/null; wait "$tp" 2>/dev/null || true
  printf '{"gateway":true,"probes":['
  local first=1 rc logged
  while read -r p rc; do
    logged=$(tcpdump -n -e -r "$STATE/ll-selftest.pcap" "ip6 and tcp dst port $p" 2>/dev/null | grep -c 'block out' || true)
    [ $first = 1 ] || printf ','
    first=0
    printf '{"port":%s,"rc":%s,"pflogged":%s}' "$p" "$rc" "$logged"
  done < <(sort -n "$STATE/ll-selftest.rc")
  printf ']}'
}

# Layer two: IPv6 off on every network service, verified on their devices.
ipv6_off() {
  install -d -o root -g wheel -m 700 "$STATE/v6-saved"
  : >"$STATE/v6-saved/services"
  networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*' | while IFS= read -r svc; do
    printf '%s\t%s\n' "$svc" "$(networksetup -getinfo "$svc" | awk -F': ' '/^IPv6:/{print $2}')" >>"$STATE/v6-saved/services"
    networksetup -setv6off "$svc"
  done
  for _ in $(seq 1 20); do [ -z "$(uplink_inet6)" ] && break; sleep 0.5; done
  [ -z "$(uplink_inet6)" ] || { echo "IPv6 is still on $(uplink_inet6)" >&2; exit 1; }
}

ipv6_restore() {
  [ -f "$STATE/v6-saved/services" ] || return 0
  while IFS=$'\t' read -r svc mode; do
    case "$mode" in
    Automatic) networksetup -setv6automatic "$svc" ;;
    "Link-local only" | LinkLocal) networksetup -setv6LinkLocal "$svc" ;;
    esac
  done <"$STATE/v6-saved/services"
}

unmount_virtiofs() {
  virtiofs_mounts | while IFS= read -r mp; do diskutil unmount force "$mp" >/dev/null 2>&1 || umount -f "$mp"; done
  [ -z "$(virtiofs_mounts)" ] || { echo "a VirtioFS mount remains" >&2; exit 1; }
}

plist() { # label, log, program arguments...  (the service user and its folder from PLIST_USER, PLIST_CONFIG and PLIST_RECORDS; root and /var/t1 by default)
  local label=$1 log=$2
  shift 2
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    printf '<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array>\n' "$label"
    for a in "$@"; do printf '<string>%s</string>\n' "$a"; done
    printf '</array>\n<key>EnvironmentVariables</key><dict><key>T1_CONFIG_FILE</key><string>%s</string><key>T1_RECORDS</key><string>%s</string></dict>\n' "${PLIST_CONFIG:-$STATE/config.json}" "${PLIST_RECORDS:-$STATE/records}"
    printf '<key>UserName</key><string>%s</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/>\n' "${PLIST_USER:-root}"
    printf '<key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string>\n</dict></plist>\n' "$log" "$log"
  } >"/Library/LaunchDaemons/$label.plist"
  chmod 644 "/Library/LaunchDaemons/$label.plist"
  chown root:wheel "/Library/LaunchDaemons/$label.plist"
  launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
}

wait_ready() { # records file, label [folder holding raw/ (default: the run's records)]
  local dir=${3:-$STATE/records}
  for _ in $(seq 1 120); do
    grep -q '"type":"ready"' "$dir/raw/$1" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "$2 did not become ready" >&2
  launchctl list 2>/dev/null | grep t1.harness >&2 || true
  tail -n 8 "$STATE/logs/"* "$EGRESS_DIR/egress-proxy.log" >&2 2>&1 || true
  exit 1
}

case "$cmd" in
discover)
  gw4=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
  gw6=$(route -n get -inet6 default 2>/dev/null | awk '/gateway:/{print $2}')
  en=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  addr4=$(ipconfig getifaddr "$en" 2>/dev/null || true)
  mask=$(ipconfig getoption "$en" subnet_mask 2>/dev/null || true)
  dns=$(scutil --dns | awk '/nameserver\[[0-9]+\] : [0-9.]+$/{print $3}' | sort -u | paste -sd, -)
  printf '{"gateway4":"%s","gateway6":"%s","interface":"%s","address4":"%s","mask4":"%s","upstreamDns":"%s","subjectUid":%s,"names":["%s","%s","%s"],"provenance":%s}\n' \
    "$gw4" "$gw6" "$en" "$addr4" "$mask" "$dns" "$(id -u "$SUBJECT")" "$(scutil --get ComputerName 2>/dev/null | tr -d '"\\')" "$(scutil --get LocalHostName 2>/dev/null | tr -d '"\\')" "$(hostname -s | tr -d '"\\')" "$(cat "$T1/provenance.json")"
  ;;
es-start)
  # eslogger mutes the events of its own audit session (the ssh session it is started in) while still counting them in its sequence numbers. So it is started here,
  # in an ssh session nothing else uses (after `up`, which started the observer, and before the app), and the observer, the harness's services and the subject all
  # run in other sessions: their events reach it, and a skipped sequence number means the system really dropped an event. It needs the Full Disk Access Remote Login
  # grants, which it takes at start and keeps.
  for ev in "$@"; do [[ "$ev" =~ ^[a-z_]+$ ]] || { echo "bad event type" >&2; exit 2; }; done
  [ -p "$STATE/observer/es.fifo" ] || { echo "the observer's FIFO does not exist; run up first" >&2; exit 1; }
  # Opened for reading and writing so it never blocks; the job's own end is the only writer once this shell exits, so the observer sees the stream end if eslogger dies.
  exec 3<>"$STATE/observer/es.fifo"
  nohup eslogger "$@" >&3 2>"$STATE/logs/eslogger.log" </dev/null 3>&- &
  echo $! >"$STATE/eslogger.pid"
  exec 3>&-
  echo started
  ;;
egress-user)
  # The one account pf lets reach the network (for the model API and its resolvers). A service account below uid 500, not root and not the subject:
  # root cannot be the match, because pf attributes a setuid tool's packets (traceroute) to root, and the account has no shell, no home and no password.
  if ! id "$EGRESS_USER" >/dev/null 2>&1; then
    egress_id=""
    for u in $(seq 370 394); do
      dscl . -list /Users UniqueID | awk -v u="$u" '$2==u{f=1} END{exit !f}' && continue
      dscl . -list /Groups PrimaryGroupID | awk -v u="$u" '$2==u{f=1} END{exit !f}' && continue
      egress_id=$u
      break
    done
    [ -n "$egress_id" ] || { echo "no free service uid" >&2; exit 1; }
    dscl . -create "/Groups/$EGRESS_USER" PrimaryGroupID "$egress_id"
    dscl . -create "/Users/$EGRESS_USER"
    dscl . -create "/Users/$EGRESS_USER" UniqueID "$egress_id"
    dscl . -create "/Users/$EGRESS_USER" PrimaryGroupID "$egress_id"
    dscl . -create "/Users/$EGRESS_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$EGRESS_USER" NFSHomeDirectory /var/empty
    dscl . -create "/Users/$EGRESS_USER" RealName "T1 egress proxy"
    dscl . -create "/Users/$EGRESS_USER" IsHidden 1
  fi
  # No password at all (the field is the one that matches no input), whether the account was just made or was already there.
  dscl . -create "/Users/$EGRESS_USER" Password '*'
  install -d -o "$EGRESS_USER" -g "$(id -g "$EGRESS_USER")" -m 700 "$EGRESS_DIR" "$EGRESS_DIR/raw"
  # By outcome, as lockdown.sh does for the others: no password is accepted for this account, and the Password field is the star.
  weak=""
  for p in "$EGRESS_USER" "${EGRESS_USER#_}" lume admin; do dscl . -authonly "$EGRESS_USER" "$p" >/dev/null 2>&1 && weak="$weak $p"; done
  field=$(dscl . -read "/Users/$EGRESS_USER" Password | awk '{print $2}')
  printf '{"egressUid":%s,"egressDir":"%s","passwordField":"%s","passwordsAccepted":"%s"}\n' "$(id -u "$EGRESS_USER")" "$EGRESS_DIR" "$field" "${weak# }"
  ;;
watchdog)
  # The run's last line of defence, independent of the host's process: if the host dies or hangs, the clone keeps running, and at the deadline this job kills the subject's
  # processes and then halts the whole machine, so nothing the subject started (a launchd job, a daemonized process, anything the kill missed) can go on holding the token.
  deadline=${1:-}
  [[ "$deadline" =~ ^[0-9]{10}$ ]] || { echo "bad deadline" >&2; exit 2; }
  rm -f "$STATE/watchdog-fired"
  cat >/Library/LaunchDaemons/t1.harness.watchdog.plist <<WD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>t1.harness.watchdog</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>while [ "\$(date +%s)" -lt $deadline ]; do sleep 5; done; /usr/bin/pkill -9 -u $SUBJECT; rm -f $STATE/token.fifo; date +%s &gt;$STATE/watchdog-fired; /bin/sync; /sbin/shutdown -h now</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
</dict></plist>
WD
  chmod 644 /Library/LaunchDaemons/t1.harness.watchdog.plist
  chown root:wheel /Library/LaunchDaemons/t1.harness.watchdog.plist
  launchctl bootstrap system /Library/LaunchDaemons/t1.harness.watchdog.plist
  echo watching
  ;;
install-config)
  # One JSON document on standard input: the configuration, canaries, the app's environment and the pf anchor.
  install -d -o root -g wheel -m 700 "$STATE" "$STATE/records" "$STATE/records/config" "$STATE/logs"
  umask 077
  cat >"$STATE/config.json"
  node_json 'const c=JSON.parse(require("fs").readFileSync("/var/t1/config.json","utf8")); require("fs").writeFileSync("/var/t1/pf.conf", c.pf, {mode: 0o600});'
  chown root:wheel "$STATE/config.json" "$STATE/pf.conf"
  # The egress proxy's own copy: its configuration and the canary values it matches, nothing else (not the app's environment, not the pf anchor).
  node_json 'const c=JSON.parse(require("fs").readFileSync("/var/t1/config.json","utf8")); require("fs").writeFileSync("/var/t1-egress/config.json", JSON.stringify({config: c.config, canaries: c.canaries}), {mode: 0o600});'
  chown "$EGRESS_USER:$(id -g "$EGRESS_USER")" "$EGRESS_DIR/config.json"
  ;;
config-file)
  name=$1
  case "$name" in */* | .*) echo "bad name" >&2; exit 1 ;; esac
  # Through a temporary file and a rename: the web server reads the page on every request and must never see half of one.
  tmp=$(mktemp "$STATE/records/config/.w.XXXXXX")
  cat >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE/records/config/$name"
  ;;
up)
  # lume attaches a VirtioFS device (its live share) to every VM; nothing of the host stays mounted while the subject runs.
  unmount_virtiofs
  # Canaries first, while nothing watches and the subject runs nothing.
  "$H/macos/t1.sh" macos/plant.ts
  install -d -o root -g wheel -m 755 "$RUN"
  web=$(node_json 'const c=JSON.parse(require("fs").readFileSync("/var/t1/config.json","utf8")).config; process.stdout.write(c.addresses.web)')
  ifconfig lo0 alias "$web/32"
  ifconfig pflog0 create 2>/dev/null || true
  ifconfig pflog0 up
  for s in $SERVICES; do
    plist "t1.harness.$s" "$STATE/logs/$s.log" "$T1/node/bin/node" --no-warnings --import "$H/register.mjs" "$H/services/$s.ts"
  done
  # The egress proxy as its own service account, with its own folder: it can read only its configuration and write only its own log.
  PLIST_USER=$EGRESS_USER PLIST_CONFIG=$EGRESS_DIR/config.json PLIST_RECORDS=$EGRESS_DIR \
    plist "t1.harness.egress-proxy" "$EGRESS_DIR/egress-proxy.log" "$T1/node/bin/node" --no-warnings --import "$H/register.mjs" "$H/services/egress-proxy.ts"
  wait_ready dns.jsonl "the resolver"
  wait_ready web.jsonl "the web server"
  wait_ready proxy.jsonl "the egress proxy" "$EGRESS_DIR"
  wait_ready sockets.jsonl "the canary listeners"
  # The subject's confinement, logged with its uid on pflog0.
  pfctl -a "$ANCHOR" -f "$STATE/pf.conf" 2>/dev/null
  pfctl -E 2>&1 | awk '/^Token/{print $3}' >"$STATE/pf.token"
  pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -q "user = $(id -u "$SUBJECT")" || { echo "the pf anchor did not load" >&2; exit 1; }
  pfctl -a "$ANCHOR" -s rules 2>/dev/null | grep -q "fe80::/10" || { echo "the pf anchor has no link-local rule" >&2; exit 1; }
  # IPv6 link-local, both layers, before the observer or the app: the all-users pf rule proven by a self-test, then IPv6 off.
  selftest=$(link_local_selftest)
  ipv6_off
  # The observer, started from this SSH session. It reads eslogger's output from a FIFO; eslogger itself is started afterwards from a session of its own (es-start).
  install -d -o root -g wheel -m 700 "$STATE/observer"
  rm -f "$STATE/observer/es.fifo"
  mkfifo -m 600 "$STATE/observer/es.fifo"
  nohup "$H/macos/t1.sh" services/observer.ts serve </dev/null >"$STATE/logs/observer.log" 2>&1 &
  echo $! >"$STATE/observer.pid"
  wait_ready observer.jsonl "the observer"
  # The system resolver becomes the logging one, after the observer starts so mDNSResponder's log attributes the queries the switch sets off; the proxy asks the old upstream itself.
  install -d -o root -g wheel -m 700 "$STATE/dns-saved"
  networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*' | while IFS= read -r svc; do
    networksetup -getdnsservers "$svc" >"$STATE/dns-saved/$(printf '%s' "$svc" | shasum | cut -c1-12)"
    printf '%s\n' "$svc" >>"$STATE/dns-saved/services"
    networksetup -setdnsservers "$svc" 127.0.0.1
  done
  dscacheutil -flushcache
  killall -HUP mDNSResponder 2>/dev/null || true
  # The app's launcher waits for the token line before it starts the app.
  plist t1.harness.app "$STATE/app.log" /bin/bash "$H/macos/launch-app.sh"
  for _ in $(seq 1 40); do [ -p "$STATE/token.fifo" ] && break; sleep 0.25; done
  [ -p "$STATE/token.fifo" ] || { echo "the app launcher did not start" >&2; exit 1; }
  printf '{"up":true,"resolvers":"%s","pfRules":%s,"linkLocalSelfTest":%s,"uplinkInet6":"%s"}\n' "$(scutil --dns | awk '/nameserver\[/{print $3}' | sort -u | paste -sd, -)" "$(pfctl -a "$ANCHOR" -s rules 2>/dev/null | wc -l | tr -d ' ')" "$selftest" "$(uplink_inet6)"
  ;;
token)
  [ -p "$STATE/token.fifo" ] || { echo "no launcher is waiting" >&2; exit 1; }
  IFS= read -r line || true
  printf '%s\n' "$line" >"$STATE/token.fifo"
  unset line
  # Ready when the app listens: checked from the socket table, so no connection reaches the app before the driver's first request.
  port=$(cfg_value 'c.config.appPort')
  for _ in $(seq 1 360); do lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 0.5; done
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || { echo "the app did not start listening" >&2; tail -20 "$STATE/app.log" >&2; exit 1; }
  ;;
channels)
  # lume's live-share device: what it exposes and whether root can write to it, proven through a mount and recorded.
  devices=$(ioreg -rc AppleVirtIOFSNub -d1 2>/dev/null | grep -c AppleVirtIOFSNub || true)
  mounts=$(virtiofs_mounts | wc -l | tr -d ' ')
  listing="" files=0 create_root=none create_share=none remove_share=none
  if [ "$devices" -gt 0 ]; then
    mp=$(virtiofs_mounts | head -1)
    probe=""
    if [ -z "$mp" ]; then
      probe=$(mktemp -d /var/t1/virtiofs.XXXXXX)
      if mount_virtiofs com.apple.virtio-fs.automount "$probe" 2>/dev/null; then mp=$probe; else listing="(not mountable)"; fi
    fi
    if [ -n "$mp" ]; then
      listing=$(cd "$mp" && find . -mindepth 1 -maxdepth 4 2>/dev/null | head -20 | tr -d '"\\' | paste -sd'|' -)
      files=$(cd "$mp" && find . -mindepth 1 ! -type d 2>/dev/null | wc -l | tr -d ' ')
      f="$mp/.t1-write-probe-$$"
      if touch "$f" 2>/dev/null; then create_root=succeeded; rm -f "$f"; else create_root=refused; fi
      if [ -d "$mp/.lume-live-share" ]; then
        f="$mp/.lume-live-share/.t1-write-probe-$$"
        if touch "$f" 2>/dev/null; then create_share=succeeded; rm -f "$f"; else create_share=refused; fi
        if rmdir "$mp/.lume-live-share" 2>/dev/null; then remove_share=succeeded; else remove_share=refused; fi
      fi
    fi
    if [ -n "$probe" ]; then
      [ "$mp" = "$probe" ] && { umount -f "$probe" 2>/dev/null || diskutil unmount force "$probe" >/dev/null 2>&1 || true; }
      rmdir "$probe" 2>/dev/null || true
    fi
  fi
  printf '{"virtiofsDevices":%s,"virtiofsMounts":%s,"deviceListing":"%s","files":%s,"writes":{"createRoot":"%s","createLiveShare":"%s","removeLiveShare":"%s"}}\n' "$devices" "$mounts" "$listing" "$files" "$create_root" "$create_share" "$remove_share"
  ;;
scan)
  "$H/macos/t1.sh" macos/scan-ports.ts "$1"
  ;;
records)
  # The egress proxy's log lives in its own folder; copy it in as a regular file (never through a link), then archive as plain ustar, no extended headers or mac metadata:
  # the host parses this archive itself and refuses anything but regular files and folders.
  if [ -f "$EGRESS_DIR/raw/proxy.jsonl" ] && [ ! -L "$EGRESS_DIR/raw/proxy.jsonl" ]; then cat "$EGRESS_DIR/raw/proxy.jsonl" >"$STATE/records/raw/proxy.jsonl"; fi
  COPYFILE_DISABLE=1 tar --format ustar --no-xattrs --no-mac-metadata -C "$STATE/records" -czf - raw config
  ;;
status)
  printf '{"watchdogFired":%s,"uplinkInet6":"%s","virtiofsMounts":%s,"pfRules":%s,"pfEnabled":%s,"resolvers":"%s"}\n' "$([ -f "$STATE/watchdog-fired" ] && echo true || echo false)" "$(uplink_inet6)" "$(virtiofs_mounts | wc -l | tr -d ' ')" "$(pfctl -a "$ANCHOR" -s rules 2>/dev/null | wc -l | tr -d ' ')" "$(pfctl -s info 2>/dev/null | grep -c 'Status: Enabled')" "$(scutil --dns | awk '/nameserver\[/{print $3}' | sort -u | paste -sd, -)"
  ;;
down)
  for s in app egress-proxy watchdog $SERVICES; do
    launchctl bootout "system/t1.harness.$s" 2>/dev/null || true
    rm -f "/Library/LaunchDaemons/t1.harness.$s.plist"
  done
  pkill -u "$SUBJECT" 2>/dev/null || true
  [ -f "$STATE/observer.pid" ] && kill "$(cat "$STATE/observer.pid")" 2>/dev/null || true
  pkill -f "$H/services/observer.ts" 2>/dev/null || true
  [ -f "$STATE/eslogger.pid" ] && kill "$(cat "$STATE/eslogger.pid")" 2>/dev/null || true
  pkill -x eslogger 2>/dev/null || true
  pfctl -a "$ANCHOR" -F all 2>/dev/null || true
  [ -s "$STATE/pf.token" ] && pfctl -X "$(cat "$STATE/pf.token")" 2>/dev/null || true
  if [ -f "$STATE/dns-saved/services" ]; then
    while IFS= read -r svc; do
      saved=$(cat "$STATE/dns-saved/$(printf '%s' "$svc" | shasum | cut -c1-12)")
      if printf '%s' "$saved" | grep -q "aren't any"; then networksetup -setdnsservers "$svc" Empty; else networksetup -setdnsservers "$svc" $saved; fi
    done <"$STATE/dns-saved/services"
  fi
  web=$(node_json 'try{const c=JSON.parse(require("fs").readFileSync("/var/t1/config.json","utf8")).config; process.stdout.write(c.addresses.web)}catch{}' || true)
  [ -n "$web" ] && ifconfig lo0 -alias "$web" 2>/dev/null || true
  ifconfig pflog0 destroy 2>/dev/null || true
  ipv6_restore
  echo down
  ;;
*)
  echo "usage: start.sh discover|es-start|egress-user|install-config|config-file|up|token|channels|scan|records|status|down" >&2
  exit 2
  ;;
esac
