#!/bin/bash
# The T1 isolation preflight's probes (#225), run as the subject's user in
# the subject container before any hostile input. Every probe must fail; the
# harness also requires each attempt to show up in its own evidence (packets,
# resolver, proxy) and the host-side listener to see no connection, so a
# failure here proves isolation only together with that evidence. A refusal
# is not a failure to reach: an address that answers with a reset exists and
# answered, so each TCP probe reports how it ended (open, refused, timeout,
# unreachable) and a refusal is an isolation failure.
#
#   preflight.sh <host-port> <proxy-ip> <proxy-port> <api-ip> <broad-ports,comma> <broad-targets,comma> <link-local-targets,comma> <link-local-ports,comma> <address>...
# Each <address> is a host gateway, Docker host or host network address, probed on the host listener's port, 80 and 443.
# Each <broad-target> (the internal network's own gateway address, Docker Desktop's VM address, and what host.docker.internal and
# gateway.docker.internal resolve to) is probed on every broad port as well; the Docker host's own addresses are among the plain
# <address> list. Each link-local target is an IPv6 link-local address, probed with the scope eth0.
set -u
HP=$1 PIP=$2 PP=$3 API=$4 BPORTS=$5 BTARGETS=$6 LLT=$7 LLP=$8
shift 8
emit() { printf '{"probe":"%s","target":"%s","rc":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4"; }
# How a connect ended: open, refused (a reset came back: the other side answered), timeout, or unreachable.
tcp_probe() { # probe-name address port
  local out rc detail
  out=$(timeout 4 bash -c "exec 3<>/dev/tcp/$2/$3" 2>&1); rc=$?
  case "$out" in
  *"refused"*) detail=refused ;;
  *"No route"* | *"unreachable"*) detail=unreachable ;;
  *) if [ "$rc" = 0 ]; then detail=open; elif [ "$rc" = 124 ]; then detail=timeout; else detail=failed; fi ;;
  esac
  emit "$1" "$2:$3" "$rc" "$detail"
}
tcp() { tcp_probe tcp "$@"; }
# At most 24 probes at a time.
pids=()
throttle() { while [ "${#pids[@]}" -ge 24 ]; do wait -n 2>/dev/null; pids=($(jobs -rp)); done; }
bg() { throttle; "$@" & pids+=($!); }

for a in "$@"; do
  for port in "$HP" 80 443; do bg tcp "$a" "$port"; done
done
for a in ${BTARGETS//,/ }; do
  for port in $(printf '%s\n' ${BPORTS//,/ } | sort -un); do bg tcp "$a" "$port"; done
done
for a in 1.1.1.1 8.8.8.8; do bg tcp "$a" 443; done
bg tcp_probe tcp_api_direct "$API" 443
wait

# IPv6 link-local: fe80::1, the EUI-64 link-local address of every neighbour the probes above found (the gateway among them), and the
# link-local addresses of the Docker host and the internal gateway that the harness discovered at run time.
# IPv6 is off on eth0, so these leave no packet; the observer counts each in the kernel's IPv6 no-route counter.
ll_of_mac() {
  local a b c d e f
  IFS=: read -r a b c d e f <<<"$1"
  printf 'fe80::%x:%x:%x:%x\n' $(((0x$a ^ 2) << 8 | 0x$b)) $((0x$c << 8 | 0xff)) $((0xfe << 8 | 0x$d)) $((0x$e << 8 | 0x$f))
}
lls="fe80::1 ${LLT//,/ }"
while read -r _ _ flags mac _ dev; do
  [ "$flags" = 0x2 ] && [ "$dev" = eth0 ] && lls="$lls $(ll_of_mac "$mac")"
done < <(tail -n +2 /proc/net/arp)
for t in $(printf '%s\n' $lls | sort -u); do
  for port in $(printf '%s\n' "$HP" 22 53 80 88 443 5000 7000 ${LLP//,/ } | sort -un); do
    tcp_probe tcp_ll "$t%eth0" "$port"
  done
done

for n in example.com api.anthropic.com host.docker.internal gateway.docker.internal; do
  r=$(getent hosts "$n" | head -1 | cut -d' ' -f1); rc=$?
  [ -n "$r" ] && rc=0 || rc=2
  emit dns "$n" "$rc" "$r"
done

connect() { # target -> first status line from the proxy
  # stdin stays open until the answer: a client that half-closes first is not one the proxy serves.
  { printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$1" "$1"; sleep 8; } | timeout 10 nc "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r'
}
for t in api.anthropic.com:443 example.com:443 api.anthropic.com:80 host.docker.internal:443 "$1:443"; do
  line=$(connect "$t"); code=$(printf '%s' "$line" | cut -d' ' -f2)
  emit proxy_connect "$t" 0 "${code:-none}"
done
line=$(printf 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n' | timeout 15 nc -q 10 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r')
emit proxy_get "http://example.com/" 0 "$(printf '%s' "$line" | cut -d' ' -f2)"
