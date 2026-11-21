#!/bin/bash
# The macOS isolation preflight's probes (#225), run as the subject user
# before any hostile input. Every probe must fail; the harness also requires
# each attempt to show up in evidence the subject cannot write (pf's log with
# the subject's uid, or, for tools that run as root or through a root daemon,
# pf's log of the blocked packet whoever sent it; the logging resolver; the
# proxy's log), nothing unexpected to have left the machine on the uplink, and
# the host-side listener to see no connection. A refusal is an answer: a probe
# that ends in "refused" proves a host answered and is an isolation failure.
#
#   preflight.sh <host-port> <proxy-ip> <proxy-port> <api-ip> <gateway-ports,comma> <link-local-targets,comma> <link-local-ports,comma> <gateway-v4> <gateway-v6> <address>...
# Each <address> is the IPv4 gateway or a host network address. Each link-local target is an IPv6 link-local
# address with its scope (the gateway's, the host's); IPv6 is off on the uplink, so those attempts leave no
# packet and the observer counts each in the kernel's IPv6 no-route counter.
set -u
HP=$1 PIP=$2 PP=$3 API=$4 GPORTS=$5 LLT=$6 LLP=$7 GW4=$8 GW6=$9
shift 9
emit() { printf '{"probe":"%s","target":"%s","rc":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4"; }
limit() { perl -e 'alarm shift @ARGV; exec @ARGV' "$@"; }
# How a connect ended: open, refused (a reset came back: the other side answered), timeout, or failed.
tcp_probe() { # probe-name address port
  local out rc detail
  out=$(nc -z -v -G 3 -w 3 "$2" "$3" 2>&1); rc=$?
  case "$out" in
  *refused*) detail=refused ;;
  *"timed out"*) detail=timeout ;;
  *succeeded* | *open*) detail=open ;;
  *) detail=failed ;;
  esac
  emit "$1" "$2:$3" "$rc" "$detail"
}

# At most 8 probes at a time: hundreds of processes started at once overran the system's event queue the file observer reads.
pids=()
throttle() { while [ "${#pids[@]}" -ge 8 ]; do wait -n 2>/dev/null; pids=($(jobs -rp)); done; }
bg() { throttle; "$@" & pids+=($!); }
for a in "$@"; do
  for port in $(printf '%s\n' "$HP" 80 443 ${GPORTS//,/ } | sort -un); do
    bg tcp_probe tcp "$a" "$port"
  done
done
for a in 1.1.1.1 8.8.8.8; do bg tcp_probe tcp "$a" 443; done
bg tcp_probe tcp_api_direct "$API" 443
wait
# One at a time, so each attempt is one rise of the no-route counter.
for t in ${LLT//,/ }; do
  for port in $(printf '%s\n' ${LLP//,/ } | sort -un); do tcp_probe tcp_ll "$t" "$port"; done
done
pids=()
for a in "$1" 8.8.8.8; do
  ( dig +time=2 +tries=1 +short "@$a" example.com >/dev/null 2>&1; r=$?; [ "$r" = 0 ] && r=0 || r=9; emit udp "$a:53" "$r" "" ) &
  pids+=($!)
done
wait "${pids[@]}"

# Tools with the privileges of root, or that ask a root daemon: pf attributes their packets to root or to no one, so a rule scoped to the subject's user never saw them.
# Each must get no reply, and the harness requires pf to have logged it blocked and the uplink to have carried nothing. rc 0 means a reply came back.
replies() { awk '/^ *[0-9]+ +[0-9a-fA-F:.%a-z]+ /{c++} END{print c+0}'; }
for t in "$GW4" 1.1.1.1; do
  n=$(/usr/sbin/traceroute -n -w 1 -q 1 -m 2 "$t" 2>&1 | replies); [ "$n" -gt 0 ] && rc=0 || rc=1
  emit traceroute "$t" "$rc" "$n replies"
  n=$(/usr/sbin/traceroute -P icmp -n -w 1 -q 1 -m 2 "$t" 2>&1 | replies); [ "$n" -gt 0 ] && rc=0 || rc=1
  emit traceroute_icmp "$t" "$rc" "$n replies"
done
n=$(/usr/sbin/traceroute6 -n -w 1 -q 1 -m 2 "$GW6" 2>&1 | replies); [ "$n" -gt 0 ] && rc=0 || rc=1
emit traceroute6 "$GW6" "$rc" "$n replies"
# A .local name goes to mDNSResponder, which asks the network over multicast: no answer may come back, and its multicast must be blocked.
n=$(limit 4 dns-sd -G v4 "t1probe-$RANDOM.local" 2>&1 | grep -c ' Add ' || true); [ "$n" -gt 0 ] && rc=0 || rc=1
emit mdns "224.0.0.251" "$rc" "$n answers"

# The control channel's port: the anchor passes SSH replies from port 22 to the harness peer, which the subject could only use by sending from port 22. launchd holds *:22, so a wildcard bind
# fails (measured: EADDRINUSE under every option); this binds 0.0.0.0:22 with SO_REUSEPORT and SO_REUSEADDR and connects out from it, which must not succeed.
out=$(/usr/bin/perl -MIO::Socket::INET -e 'my $s = IO::Socket::INET->new(Proto => "tcp", LocalAddr => "0.0.0.0", LocalPort => 22, ReuseAddr => 1, ReusePort => 1, PeerAddr => $ARGV[0], PeerPort => $ARGV[1], Timeout => 3); print $s ? "connected" : "failed: $@ $!";' "$GW4" "$HP" 2>&1)
case "$out" in connected*) rc=0 ;; *) rc=1 ;; esac
emit bind22 "0.0.0.0:22>$GW4:$HP" "$rc" "$(printf '%s' "$out" | tr -c 'A-Za-z0-9 :._-' ' ' | cut -c1-80)"

for n in example.com api.anthropic.com; do
  r=$(dscacheutil -q host -a name "$n" | awk '/ip_address/{print $2; exit}')
  if [ -n "$r" ]; then emit dns "$n" 0 "$r"; else emit dns "$n" 2 ""; fi
done

connect() { # target -> first status line from the proxy
  { printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$1" "$1"; sleep 8; } | nc -w 10 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r'
}
for t in api.anthropic.com:443 example.com:443 api.anthropic.com:80 "$1:443"; do
  line=$(connect "$t"); code=$(printf '%s' "$line" | cut -d' ' -f2)
  emit proxy_connect "$t" 0 "${code:-none}"
done
line=$({ printf 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'; sleep 5; } | nc -w 8 "$PIP" "$PP" 2>/dev/null | head -1 | tr -d '\r')
emit proxy_get "http://example.com/" 0 "$(printf '%s' "$line" | cut -d' ' -f2)"
