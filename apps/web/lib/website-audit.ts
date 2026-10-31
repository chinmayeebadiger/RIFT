export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "Functionality" | "Accessibility" | "SEO" | "Security" | "Performance";

export interface AuditIssue {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  category: Category;
  location: string;
  evidence: string;
  recommendation: string;
  before: string;
  after: string;
  impact: string;
}

export interface WebsiteAudit {
  id: string;
  url: string;
  title: string;
  scannedAt: string;
  durationMs: number;
  checks: number;
  sample: boolean;
  issues: AuditIssue[];
  scope: string;
}

export const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const severityLabels: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const sampleAudit: WebsiteAudit = {
  id: "rift-shop-sample",
  url: "https://rift-shop.example",
  title: "Rift Shop",
  scannedAt: "",
  durationMs: 0,
  checks: 12,
  sample: true,
  scope: "Illustrative sample report. Try the storefront controls to reproduce a bug, then compare the fix. Public URL scans check returned HTML; they do not run application workflows.",
  issues: [
    {
      id: "cart-quantity", title: "Cart quantity can go below zero", severity: "critical", category: "Functionality",
      description: "Removing the last item leaves a negative quantity in the cart. The total becomes negative too, allowing an invalid order to continue.",
      location: "Cart / Quantity control", evidence: "Quantity: −1 · Cart total: −$68.00",
      recommendation: "Clamp quantities at zero and remove empty items before calculating the total.",
      before: "quantity: item.quantity + delta", after: "quantity: Math.max(0, item.quantity + delta)",
      impact: "Customers can no longer create a negative cart total.",
    },
    {
      id: "double-discount", title: "Discount is applied twice", severity: "high", category: "Functionality",
      description: "The cart shows a different price from checkout because the discount is subtracted twice. A $68 item with a 20% coupon displays $40.80 instead of $54.40.",
      location: "Cart / Order summary", evidence: "$68.00 − $13.60 − $13.60 = $40.80",
      recommendation: "Subtract the discount once and share that calculation with checkout.",
      before: "return subtotalCents - discountCents * 2;", after: "return subtotalCents - discountCents;",
      impact: "The cart and checkout display the same $54.40 total.",
    },
    {
      id: "expired-coupon", title: "Expired coupon is still accepted", severity: "high", category: "Functionality",
      description: "WELCOME10 expired on January 1, 2024, but the sample cart still accepts it. Expiration needs to be checked before a discount is calculated.",
      location: "Checkout / Coupon validation", evidence: "WELCOME10 · Expired Jan 1, 2024 · Accepted",
      recommendation: "Compare the coupon expiration with the current time and return a clear validation message.",
      before: "return { valid: true, coupon };", after: "if (new Date(coupon.expiresAt) <= now) {\n  return { valid: false, message: 'Coupon expired' };\n}\nreturn { valid: true, coupon };",
      impact: "Expired coupons show a useful message and leave the price unchanged.",
    },
    {
      id: "search-case", title: "Search misses matching products", severity: "medium", category: "Functionality",
      description: "Searching for “hoodie” returns no results even though Rift Hoodie is in the catalog. The product name and query use different capitalization.",
      location: "Storefront / Product search", evidence: "Search: hoodie · Results: 0 · Expected: Rift Hoodie",
      recommendation: "Normalize both the search query and product name before matching.",
      before: "product.name.includes(query)", after: "product.name.toLowerCase()\n  .includes(query.trim().toLowerCase())",
      impact: "Customers find the hoodie regardless of capitalization.",
    },
    {
      id: "image-alt", title: "Product image has no description", severity: "medium", category: "Accessibility",
      description: "The example product image has no alternative text. Screen reader users cannot identify the product from its image.",
      location: "Storefront / Product image", evidence: '<img src="/hoodie.webp">',
      recommendation: "Describe the product in concise alternative text. Keep empty alt text for decorative images only.",
      before: '<img src="/hoodie.webp">', after: '<img src="/hoodie.webp"\n  alt="Rift Hoodie in washed blue, front view">',
      impact: "Assistive technology can announce what the image shows.",
    },
    {
      id: "page-description", title: "Page description is missing", severity: "low", category: "SEO",
      description: "The example page has no meta description. Search engines have no explicit summary to use when presenting this storefront.",
      location: "Page / Document head", evidence: 'No <meta name="description"> element',
      recommendation: "Add a concise summary that accurately describes the store.",
      before: "<head>\n  <title>Rift Shop</title>\n</head>", after: '<head>\n  <title>Rift Shop</title>\n  <meta name="description"\n    content="Thoughtful everyday essentials from Rift Shop.">\n</head>',
      impact: "The page provides a meaningful summary for search engines.",
    },
  ],
};

export function auditFilename(audit: WebsiteAudit) {
  return `rift-${new URL(audit.url).hostname.replace(/[^a-z0-9.-]/gi, "-")}`;
}
