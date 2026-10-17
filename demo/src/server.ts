import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  checkoutCart,
  createCart,
  searchProducts,
  summarizeCart,
  type CartItem,
} from "./domain/shop.js";
import { SHOP_CSS, SHOP_HTML, SHOP_JS } from "./site.js";

const DEFAULT_PORT = 4173;

function send(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  send(response, statusCode, "application/json; charset=utf-8", JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function parseCart(payload: unknown): { items: CartItem[]; coupon?: string } {
  if (!payload || typeof payload !== "object") {
    return { items: [] };
  }

  const body = payload as { items?: unknown; coupon?: unknown };
  const items = Array.isArray(body.items)
    ? body.items.flatMap((item): CartItem[] => {
        if (!item || typeof item !== "object") return [];
        const candidate = item as { productId?: unknown; quantity?: unknown };
        if (typeof candidate.productId !== "string" || typeof candidate.quantity !== "number") {
          return [];
        }
        return [{ productId: candidate.productId, quantity: candidate.quantity }];
      })
    : [];

  return {
    items,
    ...(typeof body.coupon === "string" && body.coupon ? { coupon: body.coupon } : {}),
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8", SHOP_HTML);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/styles.css") {
    send(response, 200, "text/css; charset=utf-8", SHOP_CSS);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/app.js") {
    send(response, 200, "text/javascript; charset=utf-8", SHOP_JS);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { service: "rift-shop-demo", status: "ok" });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/products") {
    sendJson(response, 200, searchProducts(requestUrl.searchParams.get("search") ?? ""));
    return;
  }

  if (request.method === "POST" && (requestUrl.pathname === "/api/cart/summary" || requestUrl.pathname === "/api/checkout")) {
    try {
      const parsed = parseCart(await readJson(request));
      const cart = createCart(parsed.items);
      if (requestUrl.pathname === "/api/checkout") {
        sendJson(response, 200, checkoutCart(cart, parsed.coupon));
      } else {
        sendJson(response, 200, summarizeCart(cart, parsed.coupon));
      }
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
}

export function createShopServer(): Server {
  return createServer((request, response) => {
    void handleRequest(request, response);
  });
}

function getPort(): number {
  const configuredPort = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PORT;
}

export function startServer(): Server {
  const server = createShopServer();
  server.listen(getPort(), () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : getPort();
    console.log(`Rift Shop listening on port ${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
