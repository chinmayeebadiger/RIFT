export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
}

export interface Coupon {
  code: string;
  percentOff: number;
  expiresAt: string;
}

export interface CouponValidation {
  valid: boolean;
  coupon?: Coupon;
  message: string;
}

export interface CartSummary {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  displayedTotalCents: number;
  coupon?: Coupon;
}

export interface CheckoutResult {
  accepted: boolean;
  message: string;
  totalCents: number;
  coupon?: Coupon;
}

export const products: readonly Product[] = [
  {
    id: "rift-hoodie",
    name: "Rift Hoodie",
    description: "Heavyweight cotton with a soft, nebula-blue finish.",
    priceCents: 6800,
  },
  {
    id: "signal-mug",
    name: "Signal Mug",
    description: "A ceramic mug for long debugging sessions.",
    priceCents: 1800,
  },
  {
    id: "patch-notes",
    name: "Patch Notes Notebook",
    description: "A pocket notebook for hypotheses, fixes, and follow-ups.",
    priceCents: 1200,
  },
  {
    id: "incident-pin",
    name: "Incident Pin",
    description: "A small enamel pin for your incident response kit.",
    priceCents: 900,
  },
];

export const coupons: readonly Coupon[] = [
  {
    code: "WELCOME10",
    percentOff: 10,
    expiresAt: "2024-01-01T00:00:00.000Z",
  },
  {
    code: "RIFT20",
    percentOff: 20,
    expiresAt: "2099-12-31T23:59:59.000Z",
  },
];

export function createCart(items: CartItem[] = []): Cart {
  return { items: items.map((item) => ({ ...item })) };
}

export function findProduct(productId: string): Product | undefined {
  return products.find((product) => product.id === productId);
}

export function searchProducts(query: string): readonly Product[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return products;
  }

  const normalizedQuery = trimmedQuery.toLowerCase();
  return products.filter(
    (product) =>
      product.name.toLowerCase().includes(normalizedQuery) ||
      product.description.toLowerCase().includes(normalizedQuery),
  );
}

export function addToCart(cart: Cart, productId: string): Cart {
  if (!findProduct(productId)) {
    return createCart(cart.items);
  }

  const existing = cart.items.find((item) => item.productId === productId);
  if (existing) {
    return adjustCartItem(cart, productId, 1);
  }

  return createCart([...cart.items, { productId, quantity: 1 }]);
}

export function adjustCartItem(cart: Cart, productId: string, delta: number): Cart {
  const existing = cart.items.find((item) => item.productId === productId);
  if (!existing) {
    return createCart(cart.items);
  }

  return createCart(
    cart.items
      .map((item) => item.productId === productId ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item)
      .filter((item) => item.quantity > 0),
  );
}

export function calculateSubtotal(cart: Cart): number {
  return cart.items.reduce((subtotal, item) => {
    const product = findProduct(item.productId);
    return subtotal + (product?.priceCents ?? 0) * item.quantity;
  }, 0);
}

export function findCoupon(code: string | undefined): Coupon | undefined {
  if (!code) {
    return undefined;
  }

  return coupons.find((coupon) => coupon.code === code.trim().toUpperCase());
}

export function validateCoupon(code: string | undefined, now = new Date()): CouponValidation {
  if (!code?.trim()) {
    return { valid: true, message: "No coupon applied" };
  }

  const coupon = findCoupon(code);
  if (!coupon) {
    return { valid: false, message: "Coupon not found" };
  }

  if (new Date(coupon.expiresAt).getTime() <= now.getTime()) {
    return { valid: false, message: "Coupon expired" };
  }

  return { valid: true, coupon, message: "Coupon applied" };
}

export function calculateDiscount(subtotalCents: number, coupon?: Coupon): number {
  if (!coupon) {
    return 0;
  }

  return Math.round(subtotalCents * (coupon.percentOff / 100));
}

export function calculateDisplayedCartTotal(subtotalCents: number, discountCents: number): number {
  return subtotalCents - discountCents;
}

export function summarizeCart(cart: Cart, couponCode?: string, now = new Date()): CartSummary {
  const subtotalCents = calculateSubtotal(cart);
  const couponValidation = validateCoupon(couponCode, now);
  const coupon = couponValidation.valid ? couponValidation.coupon : undefined;
  const discountCents = calculateDiscount(subtotalCents, coupon);

  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    displayedTotalCents: calculateDisplayedCartTotal(subtotalCents, discountCents),
    ...(coupon ? { coupon } : {}),
  };
}

export function checkoutCart(cart: Cart, couponCode?: string, now = new Date()): CheckoutResult {
  const couponValidation = validateCoupon(couponCode, now);
  if (!couponValidation.valid) {
    return {
      accepted: false,
      message: couponValidation.message,
      totalCents: calculateSubtotal(cart),
    };
  }

  const summary = summarizeCart(cart, couponValidation.coupon?.code, now);
  return {
    accepted: true,
    message: "Order accepted",
    totalCents: summary.totalCents,
    ...(summary.coupon ? { coupon: summary.coupon } : {}),
  };
}
