# Rift Shop bug catalogue

This storefront is deliberately broken so it can be used as a repair target. Each defect is isolated in a domain function and marked with a `BUG-00x` comment in `src/domain/shop.ts`.

1. **BUG-001 — negative cart quantities:** `adjustCartItem` adds the requested delta without clamping the result at zero. Clicking the minus control enough times creates a negative quantity.
2. **BUG-002 — discount applied twice in the display:** `calculateDisplayedCartTotal` subtracts the discount twice. Checkout's server-side total uses the normal one-discount calculation, making the mismatch visible.
3. **BUG-003 — expired coupon accepted:** `validateCoupon` finds a coupon by code but never compares its expiry date with the current time. The seeded `WELCOME10` coupon is expired and is still accepted.
4. **BUG-004 — case-sensitive search:** `searchProducts` uses the query as entered rather than normalizing the query and product text. Searching for `hoodie` does not find `Rift Hoodie`.

The demo has no external runtime dependencies. Run it from this directory with:

```sh
npm install
npm run typecheck
npm run build
npm start
```
