import { describe, expect, it } from "vitest";
import { auditHtml } from "./audit-html";
import { isPublicAddress, validateWebsiteUrl } from "./audit-fetch";

const healthyPage = `<!doctype html><html lang="en"><head>
<title>Rift Shop</title><meta name="description" content="Everyday essentials">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script defer src="/shop.js"></script></head><body><main><h1>Shop essentials</h1>
<img src="/hoodie.webp" alt="Blue hoodie" width="800" height="600">
<label for="query">Find a product</label><input id="query">
<button aria-label="Open cart"><svg></svg></button></main></body></html>`;

describe("website HTML findings", () => {
  it("does not invent findings or runtime verification for healthy returned markup", () => {
    const report = auditHtml(healthyPage, "https://example.com", 123);
    expect(report.issues).toEqual([]);
    expect(report).toMatchObject({ sample: false, checks: 12, durationMs: 123, title: "Rift Shop" });
    expect(report.scope).toContain("workflows are not tested");
  });

  it("reports exact observed evidence and puts severe findings first", () => {
    const report = auditHtml('<img src="/photo.jpg"><button></button><input name="email">', "https://example.com", 20);
    expect(report.issues.find((issue) => issue.title.includes("alternative text"))?.evidence).toBe('<img src="/photo.jpg">');
    expect(report.issues.find((issue) => issue.title.includes("form field"))?.evidence).toBe('<input name="email">');
    const firstMedium = report.issues.findIndex((issue) => issue.severity === "medium");
    const lastHigh = report.issues.findLastIndex((issue) => issue.severity === "high");
    expect(firstMedium).toBeGreaterThan(lastHigh);
  });

  it("accepts empty decorative alt and multiple valid field labelling patterns", () => {
    const html = healthyPage.replace("</main>", `<img src="/decoration.svg" alt="" width="10" height="10">
      <label>First name <input></label><span id="name-label">Last name</span>
      <input aria-labelledby="name-label"><input aria-label="Search"><input type="hidden"></main>`);
    expect(auditHtml(html, "https://example.com", 0).issues).toEqual([]);
  });

  it("does not accept broken aria-labelledby references as valid labels", () => {
    const report = auditHtml(healthyPage.replace("</main>", '<input aria-labelledby="nonexistent"></main>'), "https://example.com", 0);
    expect(report.issues.some((issue) => issue.title.includes("form field"))).toBe(true);
  });

  it("detects mixed resources only for an HTTPS page and keeps source escaped as data", () => {
    const html = healthyPage.replace("/hoodie.webp", "http://example.com/photo.jpg");
    expect(auditHtml(html, "https://example.com", 0).issues.some((issue) => issue.category === "Security")).toBe(true);
    expect(auditHtml(html, "http://example.com", 0).issues.some((issue) => issue.category === "Security")).toBe(false);
  });

  it("distinguishes blocking scripts from async, deferred and module scripts", () => {
    const html = healthyPage.replace("<script defer", "<script");
    expect(auditHtml(html, "https://example.com", 0).issues.some((issue) => issue.title.includes("delay page"))).toBe(true);
    for (const attribute of ["async", 'type="module"']) {
      expect(auditHtml(healthyPage.replace("<script defer", `<script ${attribute}`), "https://example.com", 0).issues).toEqual([]);
    }
  });
});

describe("public website boundary", () => {
  it("normalizes a plain domain and strips its fragment", () => {
    expect(validateWebsiteUrl(" example.com/shop#cart ").href).toBe("https://example.com/shop");
  });
  it.each(["", "https://user:secret@example.com", "https://example.com:4000", "file:///etc/passwd", "javascript:alert(1)", "not a url", "ftp://example.com"])("rejects unsupported input: %s", (url) => {
    expect(() => validateWebsiteUrl(url)).toThrow();
  });
  it.each(["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"])("blocks private and reserved destinations: %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("accepts public destinations: %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
