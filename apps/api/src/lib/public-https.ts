import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked4 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(ip, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const)
  blocked6.addSubnet(ip, prefix, "ipv6");

/** Node's IP parser handles compressed/mapped forms. Only public unicast is allowed. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !blocked4.check(address, "ipv4");
  return kind === 6 && global6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
}

export async function readPublicJson(raw: string): Promise<unknown> {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
    throw new Error("不允許的 metadata URL");
  const signal = AbortSignal.timeout(5000);
  const addresses = await Promise.race([
    isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("DNS timeout")), { once: true })),
  ]);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new Error("不允許的 metadata 位址");
  const pinned = addresses[0];
  if (!pinned) throw new Error("DNS empty");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // A dedicated connection uses the already checked address. No second DNS resolution, redirects, or proxy env.
    const req = request(url, {
      agent: false, signal, headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      lookup: (_hostname, _options, cb) => cb(null, pinned.address, pinned.family),
    }, (res) => {
      if (res.statusCode !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
        res.destroy(); reject(new Error("metadata response rejected")); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { res.destroy(); reject(new Error("metadata 太大")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
