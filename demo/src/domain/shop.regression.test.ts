import { describe, expect, it } from "vitest";
import {
  calculateDiscount,
  calculateDisplayedCartTotal,
  checkoutCart,
  createCart,
  adjustCartItem,
  searchProducts,
} from "./shop.js";

const NOW = new Date("2025-06-15T12:00:00.000Z");

describe("Rift Shop regression coverage", () => {
  it("clamps decrements at one and removes an item when it reaches zero", () => {
    const twoItemCart = createCart([{ productId: "rift-hoodie", quantity: 2 }]);
    const oneItemCart = adjustCartItem(twoItemCart, "rift-hoodie", -1);

    expect(oneItemCart.items).toEqual([{ productId: "rift-hoodie", quantity: 1 }]);

    const emptyCart = adjustCartItem(oneItemCart, "rift-hoodie", -1);
    expect(emptyCart.items).toEqual([]);
  });

  it("applies a valid coupon discount exactly once to the total", () => {
    const cart = createCart([{ productId: "rift-hoodie", quantity: 2 }]);

    expect(calculateDisplayedCartTotal(1_000, 100)).toBe(900);
    expect(calculateDiscount(2_000, { code: "RIFT20", percentOff: 20, expiresAt: "2099-12-31T23:59:59.000Z" })).toBe(400);
  });

  it("rejects an expired coupon during checkout", () => {
    const result = checkoutCart(createCart([{ productId: "rift-hoodie", quantity: 1 }]), "WELCOME10", NOW);

    expect(result.accepted).toBe(false);
  });

  it("searches product names case-insensitively", () => {
    const matches = searchProducts("hoodie");

    expect(matches.map((product) => product.id)).toEqual(["rift-hoodie"]);
  });
});
