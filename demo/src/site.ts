export const SHOP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rift Shop</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">RIFT <span>SHOP</span></a>
      <p>Goods for people who fix things.</p>
    </header>
    <main class="layout">
      <section class="catalog" aria-labelledby="catalog-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">FIELD SUPPLY / 001</p>
            <h1 id="catalog-title">Useful things for the next incident.</h1>
          </div>
          <label class="search-label" for="search">Search <input id="search" type="search" placeholder="Try “hoodie”" /></label>
        </div>
        <div id="products" class="product-grid" aria-live="polite"></div>
      </section>
      <aside class="cart-panel" aria-labelledby="cart-title">
        <div class="cart-heading"><p class="eyebrow">YOUR KIT</p><h2 id="cart-title">Cart</h2></div>
        <div id="cart-items" class="cart-items"></div>
        <div class="coupon-row"><label for="coupon">Coupon</label><input id="coupon" type="text" placeholder="WELCOME10" /><button id="apply-coupon" class="text-button">Apply</button></div>
        <div class="totals">
          <div><span>Subtotal</span><strong id="subtotal">$0.00</strong></div>
          <div><span>Discount</span><strong id="discount">-$0.00</strong></div>
          <div class="total-line"><span>Total</span><strong id="total">$0.00</strong></div>
        </div>
        <button id="checkout" class="checkout-button">Checkout</button>
        <p id="status" class="status" role="status"></p>
      </aside>
    </main>
    <footer><span>Rift Shop</span><span>offline demo / repair target</span></footer>
    <script src="/app.js"></script>
  </body>
</html>`;

export const SHOP_CSS = `:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #111318; color: #f4f3ef; }
* { box-sizing: border-box; }
body { max-width: 1180px; min-height: 100vh; margin: 0 auto; padding: 0 28px; background: #111318; }
.site-header { display: flex; align-items: baseline; justify-content: space-between; padding: 28px 0; border-bottom: 1px solid #343741; }
.brand { color: #f4f3ef; font-size: 1.1rem; font-weight: 800; letter-spacing: .14em; text-decoration: none; }
.brand span { color: #a3a6ff; font-weight: 400; }
.site-header p, footer { color: #9da0ad; font-size: .78rem; letter-spacing: .05em; }
.layout { display: grid; grid-template-columns: 1fr 340px; gap: 58px; padding: 64px 0 80px; }
.section-heading { display: flex; justify-content: space-between; gap: 28px; align-items: end; margin-bottom: 34px; }
.eyebrow { color: #a3a6ff; font-size: .68rem; font-weight: 700; letter-spacing: .16em; margin: 0 0 10px; }
h1, h2 { margin: 0; letter-spacing: -.04em; }
h1 { max-width: 450px; font-size: clamp(2rem, 5vw, 4rem); line-height: .98; }
h2 { font-size: 1.8rem; }
.search-label { color: #9da0ad; font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; }
input { width: 100%; border: 1px solid #3b3e48; border-radius: 4px; background: #1a1c23; color: #fff; padding: 11px 12px; font: inherit; }
.search-label input { display: block; width: 160px; margin-top: 8px; }
.product-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.product-card { min-height: 225px; display: flex; flex-direction: column; justify-content: space-between; padding: 21px; border: 1px solid #343741; background: #191b21; }
.product-art { display: grid; place-items: center; height: 75px; margin-bottom: 20px; color: #a3a6ff; background: #242633; font-size: 1.7rem; }
.product-card h3 { margin: 0 0 7px; font-size: 1.03rem; }
.product-card p { min-height: 40px; margin: 0; color: #9da0ad; font-size: .8rem; line-height: 1.45; }
.product-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 18px; }
.price { font-weight: 700; }
button { cursor: pointer; border: 0; font: inherit; }
.add-button, .checkout-button { padding: 11px 15px; border-radius: 3px; background: #a3a6ff; color: #15151b; font-weight: 700; }
.add-button:hover, .checkout-button:hover { background: #c0c2ff; }
.cart-panel { align-self: start; padding: 25px; border: 1px solid #343741; background: #191b21; }
.cart-heading { margin-bottom: 25px; }
.cart-item { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 14px 0; border-top: 1px solid #343741; }
.cart-item-name { font-size: .86rem; }
.cart-item-price { color: #9da0ad; font-size: .78rem; margin-top: 4px; }
.quantity { display: flex; align-items: center; gap: 8px; }
.quantity button { width: 23px; height: 23px; border-radius: 50%; background: #30333e; color: #fff; }
.quantity button:hover { background: #454958; }
.coupon-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 23px 0; border-top: 1px solid #343741; }
.coupon-row label { grid-column: 1 / -1; color: #9da0ad; font-size: .73rem; }
.coupon-row input { min-width: 0; }
.text-button { background: transparent; color: #a3a6ff; font-size: .78rem; }
.totals { border-top: 1px solid #343741; padding-top: 18px; }
.totals div { display: flex; justify-content: space-between; margin: 9px 0; color: #9da0ad; font-size: .8rem; }
.totals strong { color: #f4f3ef; font-weight: 500; }
.totals .total-line { margin-top: 17px; color: #f4f3ef; font-size: 1rem; }
.totals .total-line strong { font-size: 1.2rem; font-weight: 800; }
.checkout-button { width: 100%; margin-top: 20px; }
.status { min-height: 20px; margin: 13px 0 0; color: #a3a6ff; font-size: .76rem; line-height: 1.4; }
footer { display: flex; justify-content: space-between; padding: 20px 0 30px; border-top: 1px solid #343741; }
@media (max-width: 760px) { body { padding: 0 18px; } .layout { grid-template-columns: 1fr; gap: 40px; padding-top: 40px; } .section-heading { display: block; } .search-label { display: block; margin-top: 25px; } .search-label input { width: 100%; } }
`;

export const SHOP_JS = `const state = { cart: [], coupon: "" };
const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const productsEl = document.querySelector("#products");
const cartItemsEl = document.querySelector("#cart-items");
const statusEl = document.querySelector("#status");

async function loadProducts(query = "") {
  const response = await fetch("/api/products?search=" + encodeURIComponent(query));
  const products = await response.json();
  window.__products = products;
  productsEl.innerHTML = products.length ? products.map((product) =>
    '<article class="product-card"><div><div class="product-art">✦</div><h3>' + product.name + '</h3><p>' + product.description + '</p></div><div class="product-footer"><span class="price">' + money(product.priceCents) + '</span><button class="add-button" data-add="' + product.id + '">Add</button></div></article>'
  ).join("") : '<p>No supplies match that search.</p>';
}

function renderCart() {
  cartItemsEl.innerHTML = state.cart.length ? state.cart.map((item) =>
    '<div class="cart-item"><div><div class="cart-item-name">' + item.name + '</div><div class="cart-item-price">' + money(item.priceCents * item.quantity) + '</div></div><div class="quantity"><button data-adjust="' + item.productId + '" data-delta="-1" aria-label="Decrease ' + item.name + '">−</button><span>' + item.quantity + '</span><button data-adjust="' + item.productId + '" data-delta="1" aria-label="Increase ' + item.name + '">+</button></div></div>'
  ).join("") : '<p class="status">Your kit is empty.</p>';
  refreshSummary();
}

async function refreshSummary() {
  const response = await fetch("/api/cart/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: state.cart.map((item) => ({ productId: item.productId, quantity: item.quantity })), coupon: state.coupon }) });
  const summary = await response.json();
  document.querySelector("#subtotal").textContent = money(summary.subtotalCents);
  document.querySelector("#discount").textContent = "-" + money(summary.discountCents);
  // The server deliberately supplies the buggy display total for this repair exercise.
  document.querySelector("#total").textContent = money(summary.displayedTotalCents);
}

productsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-add]");
  if (!button) return;
  const productId = button.dataset.add;
  const product = window.__products.find((candidate) => candidate.id === productId);
  const existing = state.cart.find((item) => item.productId === productId);
  if (existing) existing.quantity += 1;
  else state.cart.push({ productId, name: product.name, priceCents: product.priceCents, quantity: 1 });
  renderCart();
});

cartItemsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-adjust]");
  if (!button) return;
  const item = state.cart.find((candidate) => candidate.productId === button.dataset.adjust);
  if (item) item.quantity += Number(button.dataset.delta);
  renderCart();
});

document.querySelector("#search").addEventListener("input", (event) => loadProducts(event.target.value));
document.querySelector("#apply-coupon").addEventListener("click", () => { state.coupon = document.querySelector("#coupon").value; statusEl.textContent = state.coupon ? "Coupon ready for checkout." : ""; refreshSummary(); });
document.querySelector("#checkout").addEventListener("click", async () => {
  const response = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: state.cart.map((item) => ({ productId: item.productId, quantity: item.quantity })), coupon: state.coupon }) });
  const result = await response.json();
  statusEl.textContent = result.message + (result.accepted ? " Total: " + money(result.totalCents) : "");
});

window.__products = [];
loadProducts();
`;
