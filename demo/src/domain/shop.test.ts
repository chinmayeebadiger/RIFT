import { describe, expect, it } from "vitest";
import {
  calculateDisplayedCartTotal,
  checkoutCart,
  createCart,
  adjustCartItem,
  searchProducts,
} from "./shop.js";

describe("Rift Shop domain smoke checks", () => {
  it("has a visible catalog and creates an empty cart", () => {
    expect(searchProducts("").length).toBeGreaterThan(0);
    expect(createCart()).toEqual({ items: [] });
    expect(checkoutCart(createCart([{ productId: "signal-mug", quantity: 1 }])).accepted).toBe(true);
  });

  it("keeps the intentional repair-target behavior executable", () => {
    expect(adjustCartItem(createCart([{ productId: "signal-mug", quantity: 0 }]), "signal-mug", -1).items[0].quantity).toBe(-1);
    expect(calculateDisplayedCartTotal(1000, 100)).toBe(800);
    expect(checkoutCart(createCart([{ productId: "signal-mug", quantity: 1 }]), "WELCOME10").accepted).toBe(true);
    expect(searchProducts("hoodie")).toHaveLength(0);
  });
});
