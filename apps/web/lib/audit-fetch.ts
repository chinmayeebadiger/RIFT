import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";

export class AuditFetchError extends Error {}

export function validateWebsiteUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new AuditFetchError("Enter a website address, such as https://example.com.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) && !/^https?:\/\//i.test(value.trim())) throw new AuditFetchError("Use a public HTTP or HTTPS website address.");
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); }
  catch { throw new AuditFetchError("That address is not valid. Enter a full website URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new AuditFetchError("Use a public HTTP or HTTPS website with no credentials or custom port.");
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address.replace(/^\[|\]$/g, "")).range() === "unicast"; }
  catch { return false; }
}

/** Pin the validated DNS answer to the connection; revalidate every redirect. */
export async function fetchWebsite(value: unknown): Promise<{ html: string; url: string; durationMs: number }> {
  let url = validateWebsiteUrl(value);
  const started = Date.now();
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects < 4; redirects++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new AuditFetchError("This address points to a private or reserved network. Enter a public website URL.");
    const result = await new Promise<{ html?: string; redirect?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        signal,
        headers: { "User-Agent": "Rift-Website-Audit/1.0", Accept: "text/html", "Accept-Encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.destroy(); resolve({ redirect: response.headers.location }); return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy(); reject(new AuditFetchError(`The website returned HTTP ${response.statusCode ?? "error"}. Check the address and try again.`)); return;
        }
        if (!response.headers["content-type"]?.includes("text/html")) {
          response.destroy(); reject(new AuditFetchError("This address did not return an HTML page. Enter a website page rather than an image or API URL.")); return;
        }
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
          response.destroy(); reject(new AuditFetchError("The website returned an unsupported compressed response. Try another page.")); return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) { response.destroy(); reject(new AuditFetchError("This page is larger than the 2 MB scan limit. Try a smaller page.")); }
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });
    if (result.redirect) { url = validateWebsiteUrl(new URL(result.redirect, url).href); continue; }
    return { html: result.html ?? "", url: url.href, durationMs: Date.now() - started };
  }
  throw new AuditFetchError("This website redirects too many times. Enter its final page address.");
}
