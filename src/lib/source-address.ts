import { BlockList, isIP } from "node:net";

/**
 * The network policy for retrieving a source a user linked to. CreatorBrio
 * runs on the same machine as its own loopback API and other local services,
 * so a server-side fetch of a user-supplied link may reach only public
 * unicast addresses, on the scheme's default port, with no credentials.
 */

export type SourceUrlRefusal =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "non_default_port";

/**
 * Address ranges that are never public unicast destinations, one list per
 * family: a BlockList also checks an IPv4 address against IPv6 rules in its
 * IPv4-mapped form, so a single list with `::ffff:0:0/96` would refuse all
 * of IPv4.
 */
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network", including the unspecified address
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  NON_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64, which embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo, which embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, "ipv6");
}

/** IPv6 global unicast; anything outside it is never public. */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");

/** True only for a public unicast IPv4 or IPv6 address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) {
    return GLOBAL_UNICAST_V6.check(address, "ipv6") && !NON_PUBLIC_V6.check(address, "ipv6");
  }
  return false;
}

/** The host to resolve or connect to, without the brackets of an IPv6 literal. */
export function bareHost(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Parses a URL a source may be retrieved from, or says why it may not. The
 * WHATWG parser normalizes numeric hosts such as `2130706433` or `0x7f.1`
 * to dotted form, so address checks see the real address.
 */
export function parseSourceUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: SourceUrlRefusal } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "unsupported_scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  // The parser drops a port equal to the scheme's default, so any port left is another one.
  if (url.port !== "") return { ok: false, reason: "non_default_port" };
  if (!url.hostname) return { ok: false, reason: "invalid_url" };
  url.hash = "";
  return { ok: true, url };
}
