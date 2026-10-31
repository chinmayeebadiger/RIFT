"use client";

import { useState } from "react";
import { Check, Minus, Plus, Search, ShoppingBag } from "lucide-react";

export function HoodieIllustration({ accessible = false }: { accessible?: boolean }) {
  return <svg viewBox="0 0 240 230" className="hoodie-art" role="img" aria-label={accessible ? "Rift Hoodie in washed blue, front view" : "Sample product illustration"}>
    <defs>
      <linearGradient id="hoodie-shade" x1="0" x2="1" y2="1"><stop stopColor="#b9cfe1" /><stop offset="1" stopColor="#88a8c5" /></linearGradient>
    </defs>
    <ellipse cx="120" cy="209" rx="74" ry="9" fill="#b8c9d4" opacity=".24" />
    <path d="M89 51c1-29 13-40 31-40s30 11 31 40l-12 24h-38Z" fill="#829fb9" />
    <path d="M93 49c3-20 12-29 27-29s24 9 27 29l-12 13h-30Z" fill="#597a97" />
    <path d="m87 48-29 13-35 78 26 13 29-43-6 93q47 13 96 0l-6-93 29 43 26-13-35-78-29-13-16 20h-34Z" fill="url(#hoodie-shade)" stroke="#829fb9" strokeWidth="1.2" />
    <path d="m87 48 16 20 17 10 17-10 16-20M77 108 88 69m75 39-11-39M74 195q46 13 92 0" fill="none" stroke="#7395b1" opacity=".65" />
    <path d="m101 143-12 29q31 11 62 0l-12-29Z" fill="#9fb9cf" stroke="#829fb9" />
    <path d="m109 72-2 40m24-40 2 40" stroke="#e6edf2" strokeWidth="2" />
    <path d="M104 111h6m20 0h6" stroke="#607f99" strokeWidth="2" />
    <text x="120" y="115" textAnchor="middle" fill="#eef2f6" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="9" letterSpacing="2">rift.</text>
    <path d="m24 138 24 12m144 0 24-12" stroke="#7395b1" strokeWidth="6" />
  </svg>;
}

export function SampleStorefront({ issueId, fixed = false, compact = false }: { issueId: string; fixed?: boolean; compact?: boolean }) {
  const [quantity, setQuantity] = useState(issueId === "cart-quantity" ? -1 : 1);
  const [query, setQuery] = useState(issueId === "search-case" ? "hoodie" : "");
  const [coupon, setCoupon] = useState(issueId === "expired-coupon" ? "WELCOME10" : "RIFT20");
  const [applied, setApplied] = useState(issueId === "expired-coupon" || issueId === "double-discount");
  const searchBroken = issueId === "search-case" && !fixed && !"Rift Hoodie".includes(query) && !!query;
  const searchEmpty = fixed && !!query && !"rift hoodie".includes(query.trim().toLowerCase());
  const qty = fixed ? Math.max(0, quantity) : quantity;
  const expired = coupon.trim().toUpperCase() === "WELCOME10";
  const validCoupon = ["WELCOME10", "RIFT20"].includes(coupon.trim().toUpperCase());
  const discount = applied && validCoupon && !(fixed && expired) ? (expired ? 0.1 : 0.2) : 0;
  const multiplier = issueId === "double-discount" && !fixed ? 2 : 1;
  const total = Math.max(fixed ? 0 : -Infinity, qty * 68 * (1 - discount * multiplier));
  const showSearch = issueId === "search-case";
  const highlightCart = issueId === "cart-quantity" || issueId === "double-discount" || issueId === "expired-coupon";
  return <div className={`sample-store ${compact ? "sample-compact" : ""} ${fixed ? "sample-fixed" : ""}`}>
    <div className="store-header"><span className="store-brand">rift<span>shop</span></span><span className="store-nav">Everyday, considered.</span><ShoppingBag size={14} /></div>
    {showSearch && <label className="store-search"><Search size={12} /><input aria-label={fixed ? "Search fixed sample store" : "Search original sample store"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search products" /></label>}
    {searchBroken || searchEmpty ? <div className="store-empty"><Search size={24} /><strong>No products found</strong><span>Try another search.</span></div> : <div className="store-product">
      <div className={`store-image ${issueId === "image-alt" ? "store-highlight" : ""}`}><HoodieIllustration accessible={fixed} />{issueId === "image-alt" && <span className="store-annotation">{fixed ? "Image description added" : "Missing image description"}</span>}</div>
      <div className="store-product-info"><span className="store-collection">The everyday collection</span><h3>Rift Hoodie</h3><p>Heavyweight comfort. Made for the everyday.</p><strong className="store-price">$68.00</strong><div className="store-color"><span /> Washed blue</div>
        <div className={`store-cart ${highlightCart ? "store-highlight" : ""}`}>
          <div className="store-cart-line"><span>Quantity</span><div className="store-quantity"><button type="button" aria-label={fixed ? "Decrease fixed quantity" : "Decrease original quantity"} onClick={() => setQuantity((n) => fixed ? Math.max(0, n - 1) : n - 1)}><Minus size={10} /></button><output>{qty}</output><button type="button" aria-label={fixed ? "Increase fixed quantity" : "Increase original quantity"} onClick={() => setQuantity((n) => n + 1)}><Plus size={10} /></button></div></div>
          {(issueId === "expired-coupon" || issueId === "double-discount") && <><div className="store-coupon"><input aria-label={fixed ? "Fixed sample coupon" : "Original sample coupon"} value={coupon} onChange={(event) => { setCoupon(event.target.value); setApplied(false); }} /><button type="button" onClick={() => setApplied(true)}>Apply</button></div><p className={`store-coupon-message ${fixed && expired ? "coupon-invalid" : ""}`}>{applied ? !validCoupon ? "Coupon not found" : fixed && expired ? "This coupon has expired." : `${Math.round(discount * 100)}% discount applied` : "Apply your coupon"}</p></>}
          <div className="store-total"><span>Total</span><strong>{total < 0 ? "−" : ""}${Math.abs(total).toFixed(2)}</strong></div>
          {issueId === "cart-quantity" && <span className="store-annotation">{fixed ? <><Check size={10} /> Quantity stays at zero</> : "Try the − button"}</span>}
          {issueId === "double-discount" && <span className="store-annotation">{fixed ? "One discount. Correct total." : "Discount deducted twice"}</span>}
        </div>
      </div>
    </div>}
    {issueId === "page-description" && <div className={`store-search-result ${fixed ? "search-result-fixed" : ""}`}><span>Search result preview</span><strong>Rift Shop</strong><p>{fixed ? "Thoughtful everyday essentials from Rift Shop." : "No page description provided."}</p></div>}
    <div className="store-footer">Thoughtful essentials. Nothing extra.</div>
  </div>;
}
