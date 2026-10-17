import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShopServer } from "./server.js";

describe("Rift Shop demo website", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createShopServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves the storefront and exposes the product catalogue", async () => {
    const pageResponse = await fetch(`${baseUrl}/`);
    const page = await pageResponse.text();
    const productsResponse = await fetch(`${baseUrl}/api/products`);
    const productList = await productsResponse.json();

    expect(pageResponse.status).toBe(200);
    expect(page).toContain("Rift Shop");
    expect(productsResponse.status).toBe(200);
    expect(productList).toHaveLength(4);
  });

  it("reproduces the browser-visible search bug at the HTTP boundary", async () => {
    const response = await fetch(`${baseUrl}/api/products?search=hoodie`);
    const products = await response.json();

    expect(response.status).toBe(200);
    expect(products).toEqual([]);
  });

  it("keeps checkout and cart summary available for a repair loop", async () => {
    const payload = JSON.stringify({
      items: [{ productId: "rift-hoodie", quantity: 1 }],
      coupon: "WELCOME10",
    });
    const summaryResponse = await fetch(`${baseUrl}/api/cart/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const summary = await summaryResponse.json();
    const checkoutResponse = await fetch(`${baseUrl}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const checkout = await checkoutResponse.json();

    expect(summaryResponse.status).toBe(200);
    expect(summary).toMatchObject({ subtotalCents: 6800, discountCents: 680 });
    expect(summary.displayedTotalCents).toBe(5440);
    expect(checkoutResponse.status).toBe(200);
    expect(checkout.accepted).toBe(true);
  });
});
