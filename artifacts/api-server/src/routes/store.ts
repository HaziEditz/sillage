import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { sendStoreMail } from "../lib/mail";
import { clerkClient, getAuth } from "@clerk/express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  min,
  ne,
  not,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  AdjustInventoryBody,
  AdjustInventoryResponse,
  CancelPayPalOrderBody,
  CancelPayPalOrderResponse,
  CapturePayPalOrderBody,
  CapturePayPalOrderResponse,
  CreatePayPalOrderBody,
  CreatePayPalOrderResponse,
  CreateProductBody,
  CreateProductResponse,
  GetAdminDashboardResponse,
  GetAdminOrdersResponse,
  GetAdminProductsResponse,
  GetProductParams,
  GetProductResponse,
  GetProductsQueryParams,
  GetProductsResponse,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
} from "@workspace/api-zod";
import {
  db,
  discountCodesTable,
  inventoryMovementsTable,
  orderItemsTable,
  customerMessagesTable,
  ordersTable,
  productReactionsTable,
  productReviewsTable,
  productVariantsTable,
  productsTable,
  storeSettingsTable,
} from "@workspace/db";
import {
  DISCOUNT_PERCENT,
  DISCOUNT_THRESHOLD_MINOR,
  FREE_SHIPPING_THRESHOLD_MINOR,
  SAMPLE_AVAILABLE_STOCK,
  SAMPLE_PRICE_MINOR,
  SAMPLE_SIZE,
  discountOfferLabel,
  isSampleSku,
  quoteCheckout,
  sampleSku,
} from "../lib/pricing";
import { isAdminUser, requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();
const LOW_STOCK_THRESHOLD = 5;
const NZD = "NZD";

type PayPalMode = "sandbox" | "live";

type ProductRow = typeof productsTable.$inferSelect;
type VariantRow = typeof productVariantsTable.$inferSelect;
type OrderRow = typeof ordersTable.$inferSelect;

function toProduct(row: ProductRow, variants: VariantRow[]) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    description: row.description,
    audience: row.audience,
    concentration: row.concentration,
    scentFamily: row.scentFamily,
    notes: row.notes,
    imageUrl: row.imageUrl,
    imageUrls: (row.imageUrls ?? []).filter((url) => url && url !== row.imageUrl),
    status: row.status,
    featured: row.featured,
    bestseller: row.bestseller,
    variants: variants.map((variant) => ({
      id: variant.id,
      size: variant.size,
      sku: variant.sku,
      priceMinor: variant.priceMinor,
      compareAtPriceMinor: variant.compareAtPriceMinor,
      costMinor: variant.costMinor,
      stock: variant.stock,
    })),
    createdAt: row.createdAt,
  };
}

async function syncSampleVariants() {
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.status, "published"));
  if (products.length === 0) return;
  const variants = await db
    .select()
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.productId, products.map((product) => product.id)));
  for (const product of products) {
    const own = variants.filter((variant) => variant.productId === product.id);
    const bottles = own.filter((variant) => !isSampleSku(variant.sku));
    if (bottles.length === 0) continue;
    const sample = own.find((variant) => variant.sku === sampleSku(product.id));
    const available = bottles.some((variant) => variant.stock > 0);
    const stock = !available
      ? 0
      : sample && sample.stock > 0
        ? sample.stock
        : SAMPLE_AVAILABLE_STOCK;
    if (!sample) {
      await db.insert(productVariantsTable).values({
        productId: product.id,
        size: SAMPLE_SIZE,
        sku: sampleSku(product.id),
        priceMinor: SAMPLE_PRICE_MINOR,
        stock,
      });
      continue;
    }
    if (sample.priceMinor !== SAMPLE_PRICE_MINOR || sample.size !== SAMPLE_SIZE || sample.stock !== stock) {
      await db
        .update(productVariantsTable)
        .set({ priceMinor: SAMPLE_PRICE_MINOR, size: SAMPLE_SIZE, stock })
        .where(eq(productVariantsTable.id, sample.id));
    }
  }
}

async function productResults(rows: ProductRow[]) {
  if (rows.length === 0) return [];
  const variants = await db
    .select()
    .from(productVariantsTable)
    .where(
      inArray(
        productVariantsTable.productId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(productVariantsTable.priceMinor));
  const byProduct = new Map<number, VariantRow[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId) ?? [];
    list.push(variant);
    byProduct.set(variant.productId, list);
  }
  return rows.map((row) => toProduct(row, byProduct.get(row.id) ?? []));
}

function toOrder(row: OrderRow, items: { productName: string; variantSize: string; quantity: number }[] = []) {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    email: row.email.endsWith("@arvessofragrances.local") ? "" : row.email,
    recipientName: row.recipientName,
    paymentMethod: row.paymentMethod,
    fulfillment: row.fulfillment,
    status: row.status,
    discountMinor: row.discountMinor,
    totalMinor: row.totalMinor,
    currency: row.currency,
    paypalOrderId: row.paypalOrderId,
    createdAt: row.createdAt,
    items: items.map((item) => ({ name: item.productName, size: item.variantSize, quantity: item.quantity })),
  };
}

async function ordersForStudio(rows: OrderRow[]) {
  const ids = rows.map((row) => row.id);
  const items = ids.length
    ? await db.select().from(orderItemsTable).where(inArray(orderItemsTable.orderId, ids))
    : [];
  return rows.map((row) => toOrder(row, items.filter((item) => item.orderId === row.id)));
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function money(minor: number) {
  return (minor / 100).toFixed(2);
}

function paypalMode(): PayPalMode {
  const mode = process.env.PAYPAL_MODE ?? "sandbox";
  if (mode !== "sandbox" && mode !== "live") {
    throw new Error('PAYPAL_MODE must be either "sandbox" or "live".');
  }
  return mode;
}

function paypalApi(mode: PayPalMode) {
  return mode === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function paypalCredentials(mode: PayPalMode) {
  const clientId = process.env[
    mode === "live" ? "PAYPAL_LIVE_CLIENT_ID" : "PAYPAL_SANDBOX_CLIENT_ID"
  ];
  const secret = process.env[
    mode === "live" ? "PAYPAL_LIVE_CLIENT_SECRET" : "PAYPAL_SANDBOX_CLIENT_SECRET"
  ];
  if (!clientId || !secret) {
    throw new Error(`PayPal ${mode} credentials are not configured.`);
  }
  return { clientId, secret };
}

async function deliverySettings() {
  const [row] = await db
    .select()
    .from(storeSettingsTable)
    .where(eq(storeSettingsTable.id, 1))
    .limit(1);
  if (row) {
    return {
      shippingFeeMinor: row.shippingFeeMinor,
      freeShippingThresholdMinor: row.freeShippingThresholdMinor,
    };
  }
  return {
    shippingFeeMinor: configuredShippingFeeMinor(paypalMode()),
    freeShippingThresholdMinor: FREE_SHIPPING_THRESHOLD_MINOR,
  };
}

function dollarsToMinor(value: unknown, label: string) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000) {
    throw new Error(`${label} must be between $0 and $1,000.`);
  }
  const minor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - minor) > 0.01) {
    throw new Error(`${label} can only use cents.`);
  }
  return minor;
}

function configuredShippingFeeMinor(mode: PayPalMode) {
  const configuredFee = process.env.SHIPPING_FEE_MINOR;
  if (configuredFee === undefined) {
    if (mode === "live") {
      throw new Error("Set SHIPPING_FEE_MINOR before enabling live checkout.");
    }
    return 0;
  }
  if (!/^\d+$/.test(configuredFee)) {
    throw new Error("SHIPPING_FEE_MINOR must be a non-negative integer in cents.");
  }
  const fee = Number(configuredFee);
  if (!Number.isSafeInteger(fee)) {
    throw new Error("SHIPPING_FEE_MINOR must be a safe integer in cents.");
  }
  return fee;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizePublicHttpsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The store URL must be a valid public HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    LOCAL_HOSTS.has(url.hostname)
  ) {
    throw new Error("The store URL must be a public HTTPS address.");
  }
  return url.origin;
}

function configuredPublicUrl() {
  for (const candidate of [process.env.PUBLIC_APP_URL, process.env.RENDER_EXTERNAL_URL]) {
    if (!candidate) continue;
    try {
      return normalizePublicHttpsUrl(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function requestPublicUrl(req: Request) {
  const host = req.get("host");
  if (!host || req.protocol !== "https") return null;
  const hostname = host.split(":")[0];
  if (!hostname || LOCAL_HOSTS.has(hostname)) return null;
  return `https://${host}`;
}

function liveCheckoutReady(req: Request) {
  if (process.env.PAYPAL_LIVE_CHECKOUT_ENABLED !== "true") return false;
  if (process.env.STORE_POLICIES_FINAL !== "true") return false;
  return Boolean(configuredPublicUrl() ?? requestPublicUrl(req));
}

function paypalModeForOrder(order: OrderRow): PayPalMode {
  if (!order.paypalApprovalUrl) {
    throw new Error("PayPal approval URL is missing for this order.");
  }
  const hostname = new URL(order.paypalApprovalUrl).hostname;
  if (hostname === "www.sandbox.paypal.com") return "sandbox";
  if (hostname === "www.paypal.com" || hostname === "paypal.com") return "live";
  throw new Error("PayPal approval URL host is not recognized.");
}

function cancelTokenFor(requestId: string) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be configured before checkout is enabled.");
  }
  return createHmac("sha256", sessionSecret).update(requestId).digest("hex");
}

async function paypalAccessToken(mode: PayPalMode): Promise<string> {
  const { clientId, secret } = paypalCredentials(mode);
  const response = await fetch(`${paypalApi(mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`PayPal could not authorize the ${mode} request.`);
  }
  const result = (await response.json()) as { access_token?: string };
  if (!result.access_token) throw new Error("PayPal returned no access token.");
  return result.access_token;
}

async function paypalRequest<T>(
  path: string,
  init: RequestInit = {},
  requestId?: string,
  mode: PayPalMode = paypalMode(),
): Promise<T> {
  const token = await paypalAccessToken(mode);
  const response = await fetch(`${paypalApi(mode)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`PayPal request failed (${response.status}): ${details.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

function publicBaseUrl(req: Request, mode: PayPalMode) {
  const publicUrl = configuredPublicUrl() ?? requestPublicUrl(req);
  if (mode === "live") {
    if (!publicUrl) {
      throw new Error("Live checkout needs the public HTTPS address Render assigns to this service.");
    }
    return publicUrl;
  }
  if (publicUrl) return publicUrl;
  const domain = (
    process.env.REPLIT_DOMAINS ??
    process.env.REPLIT_DEV_DOMAIN ??
    ""
  )
    .split(",")[0]
    .trim();
  if (domain) return `https://${domain}`;
  if (process.env.NODE_ENV !== "production") {
    const origin = req.get("origin");
    if (origin) {
      try {
        const url = new URL(origin);
        if (
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ) {
          return url.origin;
        }
      } catch {
        throw new Error("The checkout origin is invalid.");
      }
    }
  }
  if (process.env.NODE_ENV !== "production" && req.get("host")) {
    return `${req.protocol}://${req.get("host")}`;
  }
  throw new Error("A public app domain is required for PayPal return URLs.");
}

async function releaseReservation(orderId: number, finalStatus: "failed" | "cancelled") {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .for("update");
    if (!order || order.status !== "pending") return;
    const items = await tx
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));
    for (const item of items) {
      if (item.variantId === null) continue;
      await tx
        .update(productVariantsTable)
        .set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` })
        .where(eq(productVariantsTable.id, item.variantId));
      await tx.insert(inventoryMovementsTable).values({
        variantId: item.variantId,
        delta: item.quantity,
        reason: `Released checkout reservation (${finalStatus})`,
        orderId,
      });
    }
    if (order.discountCode) {
      await tx
        .update(discountCodesTable)
        .set({
          usedCount: sql`GREATEST(${discountCodesTable.usedCount} - 1, 0)`,
        })
        .where(eq(discountCodesTable.code, order.discountCode));
    }
    await tx
      .update(ordersTable)
      .set({ status: finalStatus })
      .where(eq(ordersTable.id, orderId));
  });
}

function normalizeDiscountCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function discountOfferFromRow(row: typeof discountCodesTable.$inferSelect) {
  const type = row.type;
  if (type !== "percent" && type !== "fixed" && type !== "free_shipping") {
    return null;
  }
  return { type, percent: row.percent, amountMinor: row.amountMinor };
}

function toDiscountCode(row: typeof discountCodesTable.$inferSelect) {
  const offer = discountOfferFromRow(row);
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    type: row.type,
    percent: row.percent,
    amountMinor: row.amountMinor,
    minSubtotalMinor: row.minSubtotalMinor,
    usageLimit: row.usageLimit,
    usedCount: row.usedCount,
    active: row.active,
    summary: offer ? discountOfferLabel(offer) : row.type,
    createdAt: row.createdAt,
  };
}

function parseDiscountInput(body: unknown) {
  if (!body || typeof body !== "object") return { error: "Discount details are required." };
  const input = body as Record<string, unknown>;
  const code = normalizeDiscountCode(input.code);
  if (!/^[A-Z0-9-]{3,32}$/.test(code)) {
    return { error: "Use 3–32 letters, numbers, or hyphens for the code." };
  }
  const type = input.type;
  if (type !== "percent" && type !== "fixed" && type !== "free_shipping") {
    return { error: "Choose a percent discount, a fixed amount, or free delivery." };
  }
  const percent = type === "percent" ? Number(input.percent) : null;
  const amountMinor = type === "fixed" ? Math.round(Number(input.amount) * 100) : null;
  if (type === "percent" && (!Number.isInteger(percent) || percent! < 1 || percent! > 100)) {
    return { error: "Percent discounts must be a whole number from 1 to 100." };
  }
  if (type === "fixed" && (!Number.isInteger(amountMinor) || amountMinor! < 1)) {
    return { error: "Enter a fixed discount greater than zero." };
  }
  const minSubtotalMinor = input.minSubtotal === "" || input.minSubtotal == null
    ? 0
    : Math.round(Number(input.minSubtotal) * 100);
  if (!Number.isInteger(minSubtotalMinor) || minSubtotalMinor < 0) {
    return { error: "Minimum spend must be zero or more." };
  }
  const usageLimit = input.usageLimit === "" || input.usageLimit == null
    ? null
    : Number(input.usageLimit);
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
    return { error: "Usage limit must be a whole number, or left empty for unlimited." };
  }
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 80) : "";
  const active = input.active !== false;
  return { data: { code, type, percent, amountMinor, minSubtotalMinor, usageLimit, label, active } };
}

router.get("/products", async (req, res): Promise<void> => {
  await syncSampleVariants();
  const params = GetProductsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { q, brand, audience, sort, page = 1, pageSize = 12 } = params.data;
  const conditions = [eq(productsTable.status, "published")];
  if (brand) conditions.push(eq(productsTable.brand, brand));
  if (audience) conditions.push(sql`lower(${productsTable.audience}) = ${audience.toLowerCase()}`);
  if (q) {
    const term = `%${q.replace(/[%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(productsTable.name, term),
        ilike(productsTable.brand, term),
        ilike(productsTable.description, term),
        ilike(productsTable.scentFamily, term),
        sql`${productsTable.notes}::text ILIKE ${term}`,
      )!,
    );
  }
  const where = and(...conditions);
  const lowestPrices = db
    .select({
      productId: productVariantsTable.productId,
      lowest: min(productVariantsTable.priceMinor).as("lowest"),
    })
    .from(productVariantsTable)
    .where(not(ilike(productVariantsTable.sku, "SAMPLE-%")))
    .groupBy(productVariantsTable.productId)
    .as("lowest_prices");
  const orderBy =
    sort === "price-asc"
      ? [asc(lowestPrices.lowest), asc(productsTable.id)]
      : sort === "price-desc"
        ? [desc(lowestPrices.lowest), asc(productsTable.id)]
        : sort === "name"
          ? [asc(productsTable.name)]
          : [desc(productsTable.createdAt)];

  const [rows, totals] = await Promise.all([
    db
      .select({ product: productsTable })
      .from(productsTable)
      .leftJoin(lowestPrices, eq(productsTable.id, lowestPrices.productId))
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(productsTable).where(where),
  ]);
  const products = await productResults(rows.map((row) => row.product));
  res.json(
    GetProductsResponse.parse({
      items: products,
      page,
      pageSize,
      total: totals[0]?.total ?? 0,
    }),
  );
});

router.get("/admin/access", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  try {
    res.json({ isAdmin: await isAdminUser(userId) });
  } catch (error) {
    req.log.error({ error, userId }, "Failed to verify admin identity");
    res.status(503).json({ error: "Could not verify admin access." });
  }
});

router.get("/checkout/config", async (req, res): Promise<void> => {
  try {
    const mode = paypalMode();
    const delivery = await deliverySettings();
    const shippingMinor = delivery.shippingFeeMinor;
    const credentialsConfigured = Boolean(
      process.env[
        mode === "live" ? "PAYPAL_LIVE_CLIENT_ID" : "PAYPAL_SANDBOX_CLIENT_ID"
      ] &&
        process.env[
          mode === "live" ? "PAYPAL_LIVE_CLIENT_SECRET" : "PAYPAL_SANDBOX_CLIENT_SECRET"
        ],
    );
    const liveReady = mode === "sandbox" || liveCheckoutReady(req);
    res.json({
      mode,
      shippingMinor,
      freeShippingThresholdMinor: delivery.freeShippingThresholdMinor,
      discountThresholdMinor: DISCOUNT_THRESHOLD_MINOR,
      discountPercent: DISCOUNT_PERCENT,
      checkoutEnabled: credentialsConfigured && liveReady,
    });
  } catch (error) {
    req.log.error({ error }, "PayPal checkout configuration is invalid");
    res.status(503).json({
      error: error instanceof Error ? error.message : "PayPal checkout is not configured.",
    });
  }
});

router.get("/products/brands", async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({ brand: productsTable.brand })
    .from(productsTable)
    .where(eq(productsTable.status, "published"))
    .orderBy(asc(productsTable.brand));
  res.json(rows.map((row) => row.brand).filter(Boolean));
});

router.get("/products/:slug", async (req, res): Promise<void> => {
  await syncSampleVariants();
  const params = GetProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(productsTable)
    .where(
      and(
        eq(productsTable.slug, params.data.slug),
        eq(productsTable.status, "published"),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  const product = (await productResults([row]))[0];
  res.json(GetProductResponse.parse(product));
});

async function publishedProduct(slug: string) {
  const [row] = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.slug, slug), eq(productsTable.status, "published")))
    .limit(1);
  return row ?? null;
}

async function reviewerName(userId: string) {
  const user = await clerkClient.users.getUser(userId);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name.slice(0, 80) || "Customer";
}

router.get("/products/:slug/feedback", async (req, res): Promise<void> => {
  const product = await publishedProduct(String(req.params.slug));
  if (!product) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  const userId = getAuth(req).userId;
  const [reactions, reviews] = await Promise.all([
    db.select().from(productReactionsTable).where(eq(productReactionsTable.productId, product.id)),
    db.select().from(productReviewsTable).where(eq(productReviewsTable.productId, product.id)).orderBy(desc(productReviewsTable.createdAt)).limit(40),
  ]);
  res.json({
    likes: reactions.filter((reaction) => reaction.vote === "like").length,
    dislikes: reactions.filter((reaction) => reaction.vote === "dislike").length,
    mine: reactions.find((reaction) => reaction.clerkUserId === userId)?.vote ?? null,
    reviews: reviews.map((review) => ({
      id: review.id,
      authorName: review.authorName,
      body: review.body,
      createdAt: review.createdAt,
      mine: review.clerkUserId === userId,
    })),
  });
});

router.post("/products/:slug/reaction", async (req, res): Promise<void> => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to like or dislike a fragrance." });
    return;
  }
  const vote = req.body?.vote === "like" || req.body?.vote === "dislike" ? req.body.vote : null;
  if (!vote) {
    res.status(400).json({ error: "Choose like or dislike." });
    return;
  }
  const product = await publishedProduct(String(req.params.slug));
  if (!product) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  const [existing] = await db
    .select()
    .from(productReactionsTable)
    .where(and(eq(productReactionsTable.productId, product.id), eq(productReactionsTable.clerkUserId, userId)))
    .limit(1);
  if (existing?.vote === vote) {
    await db.delete(productReactionsTable).where(eq(productReactionsTable.id, existing.id));
  } else if (existing) {
    await db.update(productReactionsTable).set({ vote }).where(eq(productReactionsTable.id, existing.id));
  } else {
    await db.insert(productReactionsTable).values({ productId: product.id, clerkUserId: userId, vote });
  }
  res.status(204).end();
});

router.post("/products/:slug/reviews", async (req, res): Promise<void> => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to leave a review." });
    return;
  }
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (body.length < 8 || body.length > 600) {
    res.status(400).json({ error: "Write a review between 8 and 600 characters." });
    return;
  }
  const product = await publishedProduct(String(req.params.slug));
  if (!product) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  const authorName = await reviewerName(userId);
  await db
    .insert(productReviewsTable)
    .values({ productId: product.id, clerkUserId: userId, authorName, body })
    .onConflictDoUpdate({
      target: [productReviewsTable.productId, productReviewsTable.clerkUserId],
      set: { body, authorName, updatedAt: new Date() },
    });
  res.status(201).json({ ok: true });
});

const MESSAGE_KINDS = new Set(["suggestion", "idea", "purchase", "report"]);

router.post("/messages", async (req, res): Promise<void> => {
  const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim().slice(0, 80) : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!MESSAGE_KINDS.has(kind)) {
    res.status(400).json({ error: "Choose what this message is about." });
    return;
  }
  if (name.length < 2 || name.length > 80) {
    res.status(400).json({ error: "Enter your name." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    res.status(400).json({ error: "Enter an email address we can reply to." });
    return;
  }
  if (body.length < 8 || body.length > 1000) {
    res.status(400).json({ error: "Write between 8 and 1000 characters." });
    return;
  }
  const [created] = await db.insert(customerMessagesTable).values({
    kind,
    name,
    email,
    topic: topic || null,
    body,
  }).returning({ id: customerMessagesTable.id });
  res.status(201).json({ id: created.id });
});

router.get("/admin/messages", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(customerMessagesTable).orderBy(desc(customerMessagesTable.createdAt)).limit(80);
  res.json(rows);
});

router.delete("/admin/reviews/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose a review to remove." });
    return;
  }
  const [row] = await db.delete(productReviewsTable).where(eq(productReviewsTable.id, id)).returning({ id: productReviewsTable.id });
  if (!row) {
    res.status(404).json({ error: "Review not found." });
    return;
  }
  res.status(204).end();
});

router.get("/admin/dashboard", requireAdmin, async (req, res): Promise<void> => {
  const [productCount, lowStockRows, pendingRows, salesRows, recent, paidTodayRows, toSendRows, collectedRows] =
    await Promise.all([
      db.select({ total: count() }).from(productsTable),
      db
        .select({ total: count() })
        .from(productVariantsTable)
        .where(sql`${productVariantsTable.stock} <= ${LOW_STOCK_THRESHOLD}`),
      db
        .select({ total: count() })
        .from(ordersTable)
        .where(eq(ordersTable.status, "pending")),
      db
        .select({ total: sum(ordersTable.totalMinor) })
        .from(ordersTable)
        .where(eq(ordersTable.status, "paid")),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(8),
      db.select({ total: sum(ordersTable.totalMinor) }).from(ordersTable).where(and(
        eq(ordersTable.status, "paid"),
        sql`(COALESCE(${ordersTable.paidAt}, ${ordersTable.createdAt}) AT TIME ZONE 'Pacific/Auckland')::date = (now() AT TIME ZONE 'Pacific/Auckland')::date`,
      )),
      db.select({ total: count() }).from(ordersTable).where(and(
        eq(ordersTable.status, "paid"),
        ne(ordersTable.paymentMethod, "cash"),
        eq(ordersTable.fulfillment, "to_send"),
      )),
      db.select({ total: count() }).from(ordersTable).where(and(
        eq(ordersTable.status, "paid"),
        eq(ordersTable.paymentMethod, "cash"),
      )),
    ]);
  const payload = {
    productCount: Number(productCount[0]?.total ?? 0),
    lowStockCount: Number(lowStockRows[0]?.total ?? 0),
    pendingOrders: Number(pendingRows[0]?.total ?? 0),
    paidSalesMinor: Number(salesRows[0]?.total ?? 0),
    paidTodayMinor: Number(paidTodayRows[0]?.total ?? 0),
    toSendCount: Number(toSendRows[0]?.total ?? 0),
    collectedCount: Number(collectedRows[0]?.total ?? 0),
    recentOrders: await ordersForStudio(recent),
  };
  req.log.info("Loaded admin overview");
  res.json(GetAdminDashboardResponse.parse(payload));
});

router.get("/admin/products", requireAdmin, async (_req, res): Promise<void> => {
  await syncSampleVariants();
  const rows = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
  const products = await productResults(rows);
  res.json(GetAdminProductsResponse.parse(products));
});

router.post("/admin/products", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    const message = path.includes("image")
      ? "Photo links need to start with https://. Leave a photo blank if you do not have one yet."
      : path.includes("sku")
        ? "Each size needs a code, and every code has to be different."
        : path.includes("price")
          ? "Enter a price in dollars for each size, like 95.00."
          : path.includes("stock")
            ? "Stock must be a whole number, zero or more."
            : path.includes("size")
              ? "Each size needs a name, like 100ml."
              : path === "name"
                ? "Enter the fragrance name."
                : path === "brand"
                  ? "Enter the brand."
                  : path === "audience"
                    ? "Enter who it is for, such as Men, Women, or Unisex."
                    : "Check the form. Something required is missing or not in the right format.";
    res.status(400).json({ error: message });
    return;
  }
  const input = parsed.data;
  const baseSlug = slugify(input.name) || `fragrance-${randomUUID().slice(0, 8)}`;
  const slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
  try {
    const product = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(productsTable)
        .values({
          name: input.name,
          slug,
          brand: input.brand,
          description: input.description,
          audience: input.audience,
          concentration: input.concentration ?? null,
          scentFamily: input.scentFamily ?? null,
          notes: input.notes ?? [],
          imageUrl: input.imageUrl ?? null,
          imageUrls: (input.imageUrls ?? []).filter((url) => url !== input.imageUrl),
          status: input.status ?? "draft",
          featured: input.featured ?? false,
          bestseller: input.bestseller ?? false,
        })
        .returning();
      const variants = await tx
        .insert(productVariantsTable)
        .values(
          input.variants.map((variant) => ({
            productId: row.id,
            size: variant.size,
            sku: variant.sku,
            priceMinor: variant.priceMinor,
            compareAtPriceMinor: variant.compareAtPriceMinor ?? null,
            costMinor: variant.costMinor ?? null,
            stock: variant.stock,
          })),
        )
        .returning();
      return toProduct(row, variants);
    });
    res.status(201).json(CreateProductResponse.parse(product));
  } catch (error) {
    req.log.error({ error }, "Failed to create fragrance");
    const details = JSON.stringify(error);
    const duplicate = /23505|unique|duplicate/i.test(details);
    res.status(409).json({ error: duplicate ? "That code is already used on another fragrance. Each size needs its own code." : "Could not save this fragrance. Check the details and try again." });
  }
});

function parseVariantEdits(body: unknown) {
  if (!body || typeof body !== "object" || !("variants" in body)) return { variants: null };
  const raw = (body as { variants?: unknown }).variants;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Keep at least one size." };
  const variants: { id: number | null; size: string; sku: string; priceMinor: number; stock: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "Check each size." };
    const row = item as Record<string, unknown>;
    const id = row.id == null || row.id === "" ? null : Number(row.id);
    const size = typeof row.size === "string" ? row.size.trim() : "";
    const sku = typeof row.sku === "string" ? row.sku.trim() : "";
    const priceMinor = Math.round(Number(row.priceMinor));
    const stock = Number(row.stock);
    if (id !== null && !Number.isInteger(id)) return { error: "A size could not be matched." };
    if (!size || !sku) return { error: "Each size needs a name and a code." };
    if (isSampleSku(sku)) return { error: "Sample codes are kept automatically." };
    if (!Number.isInteger(priceMinor) || priceMinor < 0) return { error: "Enter a price for each size." };
    if (!Number.isInteger(stock) || stock < 0) return { error: "Stock must be zero or more." };
    variants.push({ id, size, sku, priceMinor, stock });
  }
  if (new Set(variants.map((variant) => variant.sku)).size !== variants.length) {
    return { error: "Each size needs its own code." };
  }
  return { variants };
}

router.patch("/admin/products/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  const parsed = UpdateProductBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : !parsed.success
          ? parsed.error.message
          : "Invalid update.",
    });
    return;
  }
  const variantEdits = parseVariantEdits(req.body);
  if ("error" in variantEdits) {
    res.status(400).json({ error: variantEdits.error });
    return;
  }
  try {
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(productsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(productsTable.id, params.data.id))
        .returning();
      if (!updated) return null;
      if (variantEdits.variants) {
        const existing = await tx
          .select()
          .from(productVariantsTable)
          .where(eq(productVariantsTable.productId, updated.id));
        const bottles = existing.filter((variant) => !isSampleSku(variant.sku));
        const kept = new Set<number>();
        for (const variant of variantEdits.variants) {
          if (variant.id === null) {
            await tx.insert(productVariantsTable).values({
              productId: updated.id,
              size: variant.size,
              sku: variant.sku,
              priceMinor: variant.priceMinor,
              stock: variant.stock,
            });
            continue;
          }
          const match = bottles.find((item) => item.id === variant.id);
          if (!match) throw new Error("A size on this fragrance could not be found.");
          kept.add(variant.id);
          await tx.update(productVariantsTable).set({
            size: variant.size,
            sku: variant.sku,
            priceMinor: variant.priceMinor,
            stock: variant.stock,
          }).where(eq(productVariantsTable.id, variant.id));
        }
        const removed = bottles.filter((variant) => !kept.has(variant.id)).map((variant) => variant.id);
        if (removed.length) {
          await tx.delete(productVariantsTable).where(inArray(productVariantsTable.id, removed));
        }
      }
      return updated;
    });
    if (!row) {
      res.status(404).json({ error: "Fragrance not found." });
      return;
    }
    const product = (await productResults([row]))[0];
    res.json(UpdateProductResponse.parse(product));
  } catch (error) {
    req.log.warn({ error }, "Fragrance update rejected");
    const message = error instanceof Error && error.message.startsWith("A size")
      ? error.message
      : "Could not save these sizes. Check that each code is unique.";
    res.status(409).json({ error: message });
  }
});

router.delete("/admin/products/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(productsTable)
    .where(eq(productsTable.id, params.data.id))
    .returning({ id: productsTable.id });
  if (!row) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  res.status(204).end();
});

router.post(
  "/admin/inventory/adjustments",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = AdjustInventoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { variantId, delta, reason } = parsed.data;
    const actorClerkId = getAuth(req).userId ?? null;
    const adjustment = await db.transaction(async (tx) => {
      const [variant] = await tx
        .select()
        .from(productVariantsTable)
        .where(eq(productVariantsTable.id, variantId))
        .for("update");
      if (!variant || variant.stock + delta < 0) return null;
      const [updated] = await tx
        .update(productVariantsTable)
        .set({ stock: variant.stock + delta })
        .where(eq(productVariantsTable.id, variantId))
        .returning();
      await tx.insert(inventoryMovementsTable).values({
        variantId,
        delta,
        reason,
        actorClerkId,
      });
      return {
        variantId,
        previousStock: variant.stock,
        newStock: updated.stock,
      };
    });
    if (!adjustment) {
      res.status(400).json({ error: "Variant not found or stock cannot be negative." });
      return;
    }
    res.json(AdjustInventoryResponse.parse(adjustment));
  },
);

router.get("/admin/orders", requireAdmin, async (_req, res): Promise<void> => {
  const orders = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt))
    .limit(100);
  res.json(GetAdminOrdersResponse.parse(await ordersForStudio(orders)));
});

router.get("/admin/orders/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose an order." });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  res.json({
    id: order.id,
    orderNumber: order.orderNumber,
    email: order.email.endsWith("@arvessofragrances.local") ? "" : order.email,
    recipientName: order.recipientName,
    address1: order.address1,
    address2: order.address2 ?? "",
    city: order.city,
    region: order.region ?? "",
    postcode: order.postcode,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    discountCode: order.discountCode ?? "",
    shippingMinor: order.shippingMinor,
    totalMinor: order.totalMinor,
    currency: order.currency,
    paymentMethod: order.paymentMethod,
    fulfillment: order.fulfillment,
    tracking: order.tracking ?? "",
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    items: items.map((item) => ({
      name: item.productName,
      brand: item.brand,
      size: item.variantSize,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
    })),
  });
});

function trackingUrl(note: string) {
  const code = note.trim();
  if (!/^[A-Za-z0-9]{8,34}$/.test(code)) return "";
  return `https://www.nzpost.co.nz/tools/tracking?trackid=${encodeURIComponent(code)}`;
}

function itemLines(items: { brand: string; productName: string; variantSize: string; quantity: number; unitPriceMinor: number }[]) {
  return items.map((item) => `• ${item.brand} ${item.productName}, ${item.variantSize} × ${item.quantity} — $${money(item.unitPriceMinor * item.quantity)} NZD`);
}

function confirmationLetter(order: OrderRow, items: { brand: string; productName: string; variantSize: string; quantity: number; unitPriceMinor: number }[]) {
  const firstName = order.recipientName.trim().split(/\s+/)[0] || order.recipientName;
  const cash = order.paymentMethod === "cash";
  const body = [
    `Hello ${firstName},`,
    "",
    cash
      ? `This is Arvessó Fragrances. Your in-person order ${order.orderNumber} is recorded, and the $${money(order.totalMinor)} NZD cash payment is received.`
      : `This is Arvessó Fragrances. Your order ${order.orderNumber} is confirmed, and the payment of $${money(order.totalMinor)} NZD has been received.`,
    "",
    "What you ordered:",
    ...itemLines(items),
    "",
    cash ? "This was collected in person, so there is nothing to post." : `Send to: ${deliveryAddress(order)}`,
    cash ? null : "We will email you again when the parcel is posted.",
    "",
    "Arvessó Fragrances",
    "arvessofragrances@gmail.com",
    "New Zealand",
  ].filter((line) => line !== null).join("\n");
  return {
    to: order.email.endsWith("@arvessofragrances.local") ? "" : order.email,
    subject: `Your Arvessó Fragrances order ${order.orderNumber}`,
    body,
  };
}

function postedLetter(order: OrderRow, items: { brand: string; productName: string; variantSize: string; quantity: number; unitPriceMinor: number }[]) {
  const firstName = order.recipientName.trim().split(/\s+/)[0] || order.recipientName;
  const tracking = order.tracking?.trim() ?? "";
  const url = trackingUrl(tracking);
  const body = [
    `Hello ${firstName},`,
    "",
    `This is Arvessó Fragrances. Your order ${order.orderNumber} has been posted.`,
    "",
    tracking ? `Tracking: ${tracking}` : "The courier note was left blank.",
    url ? `Follow it here: ${url}` : null,
    "",
    "What was sent:",
    ...itemLines(items),
    "",
    `Send to: ${deliveryAddress(order)}`,
    "",
    "If the parcel does not show, reply to this email with your order number.",
    "",
    "Arvessó Fragrances",
    "arvessofragrances@gmail.com",
    "New Zealand",
  ].filter((line) => line !== null).join("\n");
  return {
    to: order.email.endsWith("@arvessofragrances.local") ? "" : order.email,
    subject: `Your Arvessó Fragrances order ${order.orderNumber} has been posted`,
    body,
  };
}

async function deliverLetter(req: Request, letter: { to: string; subject: string; body: string }) {
  if (!letter.to) return { sent: false, email: null };
  try {
    const result = await sendStoreMail({ to: letter.to, subject: letter.subject, text: letter.body });
    if (!result.sent) req.log.warn({ reason: result.reason, to: letter.to }, "Store email was not sent");
    return { sent: result.sent, email: result.sent ? null : letter };
  } catch (error) {
    req.log.warn({ error, to: letter.to }, "Store email failed");
    return { sent: false, email: letter };
  }
}

function orderLetter(order: OrderRow, items: { brand: string; productName: string; variantSize: string; quantity: number; unitPriceMinor: number }[], note: string, refunded: boolean) {
  const lines = itemLines(items);
  const firstName = order.recipientName.trim().split(/\s+/)[0] || order.recipientName;
  const paid = order.status === "paid";
  const payment = order.paymentMethod === "cash"
    ? "This was an in-person payment, so nothing further is owed."
    : !paid
      ? "You were not charged."
      : refunded
        ? `The payment of $${money(order.totalMinor)} NZD is being returned to the same PayPal account. It can take a few days to show.`
        : `If you already paid $${money(order.totalMinor)} NZD, reply to this email and we will return it to the same PayPal account.`;
  const body = [
    `Hello ${firstName},`,
    "",
    `This is Arvessó Fragrances. Your order ${order.orderNumber} has been cancelled.`,
    "",
    "What was ordered:",
    ...lines,
    "",
    `Order total: $${money(order.totalMinor)} NZD`,
    note ? "" : null,
    note ? `Note from us: ${note}` : null,
    "",
    payment,
    "",
    "If you still want the fragrance, reply to this email and we will sort it out.",
    "",
    "Arvessó Fragrances",
    "arvessofragrances@gmail.com",
    "New Zealand",
  ].filter((line) => line !== null).join("\n");
  return {
    to: order.email.endsWith("@arvessofragrances.local") ? "" : order.email,
    subject: `Your Arvessó Fragrances order ${order.orderNumber} has been cancelled`,
    body,
  };
}

router.post("/admin/orders/:id/cancel", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 280) : "";
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose an order to cancel." });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  if (order.status === "cancelled" || order.status === "refunded" || order.status === "failed") {
    res.status(400).json({ error: "This order is already closed." });
    return;
  }
  if (order.status !== "pending" && order.status !== "paid") {
    res.status(400).json({ error: "This order cannot be cancelled." });
    return;
  }
  let refunded = false;
  if (order.status === "paid" && order.paymentMethod !== "cash" && order.paypalCaptureId) {
    try {
      const mode = order.paypalApprovalUrl ? paypalModeForOrder(order) : paypalMode();
      await paypalRequest(
        `/v2/payments/captures/${encodeURIComponent(order.paypalCaptureId)}/refund`,
        { method: "POST", body: JSON.stringify({ note_to_payer: note || `Order ${order.orderNumber} was cancelled.` }) },
        randomUUID(),
        mode,
      );
      refunded = true;
    } catch (error) {
      req.log.warn({ error, orderId: order.id }, "PayPal refund failed");
      res.status(502).json({ error: "PayPal did not refund this payment, so the order was not cancelled." });
      return;
    }
  }
  const items = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(ordersTable).where(eq(ordersTable.id, id)).for("update");
    if (!current || (current.status !== "pending" && current.status !== "paid")) {
      throw new Error("This order can no longer be cancelled.");
    }
    const lines = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, id));
    for (const item of lines) {
      if (item.variantId === null) continue;
      await tx.update(productVariantsTable).set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` }).where(eq(productVariantsTable.id, item.variantId));
      await tx.insert(inventoryMovementsTable).values({
        variantId: item.variantId,
        delta: item.quantity,
        reason: `Order ${current.orderNumber} cancelled`,
        actorClerkId: getAuth(req).userId ?? null,
        orderId: id,
      });
    }
    if (current.discountCode) {
      await tx.update(discountCodesTable).set({ usedCount: sql`GREATEST(${discountCodesTable.usedCount} - 1, 0)` }).where(eq(discountCodesTable.code, current.discountCode));
    }
    await tx.update(ordersTable).set({ status: refunded ? "refunded" : "cancelled" }).where(eq(ordersTable.id, id));
    return lines;
  });
  const email = orderLetter(order, items, note, refunded);
  res.json({ status: refunded ? "refunded" : "cancelled", email });
});

router.get("/account/orders", async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Sign in to view your orders." });
    return;
  }

  const orders = await db
    .select({
      id: ordersTable.id,
      orderNumber: ordersTable.orderNumber,
      status: ordersTable.status,
      totalMinor: ordersTable.totalMinor,
      currency: ordersTable.currency,
      createdAt: ordersTable.createdAt,
      paidAt: ordersTable.paidAt,
      paymentMethod: ordersTable.paymentMethod,
      fulfillment: ordersTable.fulfillment,
      tracking: ordersTable.tracking,
    })
    .from(ordersTable)
    .where(eq(ordersTable.clerkUserId, clerkUserId))
    .orderBy(desc(ordersTable.createdAt))
    .limit(25);
  const ids = orders.map((order) => order.id);
  const items = ids.length
    ? await db.select().from(orderItemsTable).where(inArray(orderItemsTable.orderId, ids))
    : [];
  res.json(orders.map((order) => ({
    orderNumber: order.orderNumber,
    status: order.status,
    totalMinor: order.totalMinor,
    currency: order.currency,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    paymentMethod: order.paymentMethod,
    fulfillment: order.fulfillment,
    tracking: order.tracking ?? "",
    trackingUrl: trackingUrl(order.tracking ?? ""),
    items: items
      .filter((item) => item.orderId === order.id)
      .map((item) => ({ name: item.productName, size: item.variantSize, quantity: item.quantity })),
  })));
});

router.get("/admin/cash-sales", requireAdmin, async (_req, res): Promise<void> => {
  const orders = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.paymentMethod, "cash"))
    .orderBy(desc(ordersTable.createdAt))
    .limit(40);
  const ids = orders.map((order) => order.id);
  const items = ids.length
    ? await db.select().from(orderItemsTable).where(inArray(orderItemsTable.orderId, ids))
    : [];
  res.json(orders.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    recipientName: order.recipientName,
    contact: order.email.endsWith("@arvessofragrances.local") ? "" : order.email,
    note: order.address2 ?? "",
    totalMinor: order.totalMinor,
    createdAt: order.createdAt,
    items: items
      .filter((item) => item.orderId === order.id)
      .map((item) => ({
        name: item.productName,
        size: item.variantSize,
        quantity: item.quantity,
        variantId: item.variantId,
        unitPriceMinor: item.unitPriceMinor,
      })),
  })));
});

async function restoreCashStock(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], orderId: number, orderNumber: string, actor: string | null) {
  const lines = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));
  for (const item of lines) {
    if (item.variantId === null) continue;
    await tx.update(productVariantsTable).set({ stock: sql`${productVariantsTable.stock} + ${item.quantity}` }).where(eq(productVariantsTable.id, item.variantId));
    await tx.insert(inventoryMovementsTable).values({
      variantId: item.variantId,
      delta: item.quantity,
      reason: `Cash sale ${orderNumber} reversed`,
      actorClerkId: actor,
      orderId,
    });
  }
  return lines;
}

router.patch("/admin/cash-sales/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const recipientName = typeof req.body?.recipientName === "string" ? req.body.recipientName.trim() : "";
  const contact = typeof req.body?.contact === "string" ? req.body.contact.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 280) : "";
  const variantId = Number(req.body?.variantId);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose a cash sale to edit." });
    return;
  }
  if (recipientName.length < 2) {
    res.status(400).json({ error: "Enter the person's name." });
    return;
  }
  if (!Number.isInteger(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    res.status(400).json({ error: "Choose a fragrance and a quantity." });
    return;
  }
  try {
    const order = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(ordersTable).where(eq(ordersTable.id, id)).for("update");
      if (!current || current.paymentMethod !== "cash" || current.status !== "paid") {
        throw new Error("That cash sale can no longer be edited.");
      }
      const actor = getAuth(req).userId ?? null;
      await restoreCashStock(tx, current.id, current.orderNumber, actor);
      const [variant] = await tx.select().from(productVariantsTable).where(eq(productVariantsTable.id, variantId)).for("update");
      const [product] = variant
        ? await tx.select().from(productsTable).where(and(eq(productsTable.id, variant.productId), eq(productsTable.status, "published"))).limit(1)
        : [];
      if (!variant || !product || variant.stock < quantity) {
        throw new Error("There is not enough stock for that fragrance.");
      }
      const [reserved] = await tx
        .update(productVariantsTable)
        .set({ stock: sql`${productVariantsTable.stock} - ${quantity}` })
        .where(and(eq(productVariantsTable.id, variant.id), gte(productVariantsTable.stock, quantity)))
        .returning();
      if (!reserved) throw new Error("Stock changed while saving this sale.");
      await tx.delete(orderItemsTable).where(eq(orderItemsTable.orderId, current.id));
      await tx.insert(orderItemsTable).values({
        orderId: current.id,
        variantId: variant.id,
        productName: product.name,
        brand: product.brand,
        variantSize: variant.size,
        sku: variant.sku,
        quantity,
        unitPriceMinor: variant.priceMinor,
        unitCostMinor: variant.costMinor,
      });
      await tx.insert(inventoryMovementsTable).values({
        variantId: variant.id,
        delta: -quantity,
        reason: `Cash sale ${current.orderNumber} updated`,
        actorClerkId: actor,
        orderId: current.id,
      });
      const totalMinor = variant.priceMinor * quantity;
      const [saved] = await tx.update(ordersTable).set({
        recipientName,
        email: contact.includes("@") ? contact.toLowerCase() : "in-person@arvessofragrances.local",
        address2: note || null,
        subtotalMinor: totalMinor,
        totalMinor,
      }).where(eq(ordersTable.id, current.id)).returning();
      return saved;
    });
    res.json({ id: order.id, orderNumber: order.orderNumber, totalMinor: order.totalMinor });
  } catch (error) {
    req.log.warn({ error }, "Cash sale edit rejected");
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update this cash sale." });
  }
});

router.delete("/admin/cash-sales/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose a cash sale to delete." });
    return;
  }
  try {
    const removed = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(ordersTable).where(eq(ordersTable.id, id)).for("update");
      if (!current || current.paymentMethod !== "cash") throw new Error("That cash sale could not be found.");
      if (current.status === "paid") {
        await restoreCashStock(tx, current.id, current.orderNumber, getAuth(req).userId ?? null);
      }
      await tx.delete(ordersTable).where(eq(ordersTable.id, current.id));
      return current;
    });
    res.json({ id: removed.id });
  } catch (error) {
    req.log.warn({ error }, "Cash sale delete rejected");
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete this cash sale." });
  }
});

router.post("/admin/cash-sales", requireAdmin, async (req, res): Promise<void> => {
  const recipientName = typeof req.body?.recipientName === "string" ? req.body.recipientName.trim() : "";
  const contact = typeof req.body?.contact === "string" ? req.body.contact.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 280) : "";
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (recipientName.length < 2) {
    res.status(400).json({ error: "Enter the person's name." });
    return;
  }
  const quantities = new Map<number, number>();
  for (const line of lines) {
    const variantId = Number(line?.variantId);
    const quantity = Number(line?.quantity);
    if (!Number.isInteger(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      res.status(400).json({ error: "Choose a fragrance and a quantity." });
      return;
    }
    quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
  }
  if (quantities.size === 0) {
    res.status(400).json({ error: "Choose at least one fragrance." });
    return;
  }
  await syncSampleVariants();
  try {
    const order = await db.transaction(async (tx) => {
      const variants = await tx
        .select()
        .from(productVariantsTable)
        .where(inArray(productVariantsTable.id, [...quantities.keys()]));
      if (variants.length !== quantities.size) throw new Error("One or more fragrances are no longer available.");
      const products = await tx
        .select()
        .from(productsTable)
        .where(and(
          inArray(productsTable.id, [...new Set(variants.map((variant) => variant.productId))]),
          eq(productsTable.status, "published"),
        ));
      const productById = new Map(products.map((product) => [product.id, product]));
      let subtotalMinor = 0;
      for (const variant of variants) {
        const quantity = quantities.get(variant.id) ?? 0;
        if (!productById.has(variant.productId) || variant.stock < quantity) {
          throw new Error("One or more fragrances are out of stock.");
        }
        subtotalMinor += variant.priceMinor * quantity;
      }
      const requestId = randomUUID();
      const orderNumber = `CASH-${Date.now().toString(36).toUpperCase()}`;
      const [created] = await tx.insert(ordersTable).values({
        orderNumber,
        clerkUserId: getAuth(req).userId ?? null,
        email: contact.includes("@") ? contact.toLowerCase() : "in-person@arvessofragrances.local",
        recipientName,
        address1: "Collected in person",
        address2: note || null,
        city: "In person",
        postcode: "0000",
        subtotalMinor,
        discountMinor: 0,
        shippingMinor: 0,
        totalMinor: subtotalMinor,
        currency: NZD,
        paymentMethod: "cash",
        fulfillment: "collected",
        status: "paid",
        cancelTokenHash: createHash("sha256").update(requestId).digest("hex"),
        requestId,
        paidAt: new Date(),
      }).returning();
      for (const variant of variants) {
        const quantity = quantities.get(variant.id) ?? 0;
        const [reserved] = await tx
          .update(productVariantsTable)
          .set({ stock: sql`${productVariantsTable.stock} - ${quantity}` })
          .where(and(eq(productVariantsTable.id, variant.id), gte(productVariantsTable.stock, quantity)))
          .returning();
        if (!reserved) throw new Error("Stock changed while recording this sale.");
        const product = productById.get(variant.productId)!;
        await tx.insert(orderItemsTable).values({
          orderId: created.id,
          variantId: variant.id,
          productName: product.name,
          brand: product.brand,
          variantSize: variant.size,
          sku: variant.sku,
          quantity,
          unitPriceMinor: variant.priceMinor,
          unitCostMinor: variant.costMinor,
        });
        await tx.insert(inventoryMovementsTable).values({
          variantId: variant.id,
          delta: -quantity,
          reason: `Cash sale ${created.orderNumber}`,
          actorClerkId: getAuth(req).userId ?? null,
          orderId: created.id,
        });
      }
      return created;
    });
    try {
      const lines = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
      await deliverLetter(req, confirmationLetter(order, lines));
    } catch (error) {
      req.log.warn({ error, orderId: order.id }, "Cash confirmation email skipped");
    }
    res.status(201).json({ id: order.id, orderNumber: order.orderNumber, totalMinor: order.totalMinor });
  } catch (error) {
    req.log.warn({ error }, "Cash sale rejected");
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not record this cash sale." });
  }
});

function deliveryAddress(order: typeof ordersTable.$inferSelect) {
  return [order.address1, order.address2, order.city, order.region, order.postcode]
    .filter((part) => part && part.trim())
    .join(", ");
}

router.get("/admin/delivery", requireAdmin, async (_req, res): Promise<void> => {
  const settings = await deliverySettings();
  const orders = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.status, "paid"), ne(ordersTable.paymentMethod, "cash")))
    .orderBy(desc(ordersTable.createdAt))
    .limit(40);
  const ids = orders.map((order) => order.id);
  const items = ids.length
    ? await db.select().from(orderItemsTable).where(inArray(orderItemsTable.orderId, ids))
    : [];
  const shape = (order: typeof orders[number]) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    recipientName: order.recipientName,
    email: order.email,
    address: deliveryAddress(order),
    totalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    createdAt: order.createdAt,
    fulfillment: order.fulfillment,
    tracking: order.tracking ?? "",
    shippedAt: order.shippedAt,
    items: items
      .filter((item) => item.orderId === order.id)
      .map((item) => ({ name: item.productName, size: item.variantSize, quantity: item.quantity })),
  });
  res.json({
    ...settings,
    awaiting: orders.filter((order) => order.fulfillment !== "sent").map(shape),
    sent: orders.filter((order) => order.fulfillment === "sent").map(shape),
  });
});

router.put("/admin/delivery", requireAdmin, async (req, res): Promise<void> => {
  try {
    const shippingFeeMinor = dollarsToMinor(req.body?.shippingDollars, "Delivery");
    const freeShipping = req.body?.freeShipping === true;
    const freeShippingThresholdMinor = freeShipping
      ? dollarsToMinor(req.body?.freeOverDollars, "Free delivery")
      : 0;
    if (freeShipping && freeShippingThresholdMinor <= 0) {
      res.status(400).json({ error: "Enter the amount an order has to pass before delivery is free." });
      return;
    }
    await db
      .insert(storeSettingsTable)
      .values({ id: 1, shippingFeeMinor, freeShippingThresholdMinor, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: storeSettingsTable.id,
        set: { shippingFeeMinor, freeShippingThresholdMinor, updatedAt: new Date() },
      });
    res.json({ shippingFeeMinor, freeShippingThresholdMinor });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save delivery." });
  }
});

router.post("/admin/delivery/:id/send", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tracking = typeof req.body?.tracking === "string" ? req.body.tracking.trim().slice(0, 160) : "";
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose an order to send." });
    return;
  }
  const [updated] = await db
    .update(ordersTable)
    .set({ fulfillment: "sent", tracking: tracking || null, shippedAt: new Date() })
    .where(and(
      eq(ordersTable.id, id),
      eq(ordersTable.status, "paid"),
      ne(ordersTable.paymentMethod, "cash"),
      ne(ordersTable.fulfillment, "sent"),
    ))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "That paid order could not be marked as sent." });
    return;
  }
  const lines = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, updated.id));
  const letter = postedLetter(updated, lines);
  const mailed = await deliverLetter(req, letter);
  res.json({ id: updated.id, orderNumber: updated.orderNumber, emailSent: mailed.sent, email: mailed.email });
});

router.patch("/admin/delivery/:id/tracking", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tracking = typeof req.body?.tracking === "string" ? req.body.tracking.trim().slice(0, 160) : "";
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Choose an order." });
    return;
  }
  const [updated] = await db
    .update(ordersTable)
    .set({ tracking: tracking || null })
    .where(and(
      eq(ordersTable.id, id),
      eq(ordersTable.status, "paid"),
      ne(ordersTable.paymentMethod, "cash"),
      eq(ordersTable.fulfillment, "sent"),
    ))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "That posted order could not be updated." });
    return;
  }
  const lines = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, updated.id));
  const letter = postedLetter(updated, lines);
  const mailed = await deliverLetter(req, letter);
  res.json({ id: updated.id, orderNumber: updated.orderNumber, emailSent: mailed.sent, email: mailed.email });
});

router.post("/checkout/quote", async (req, res): Promise<void> => {
  await syncSampleVariants();
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
  if (!lines?.length) {
    res.status(400).json({ error: "Add a fragrance before using a code." });
    return;
  }
  const quantities = new Map<number, number>();
  for (const line of lines) {
    const variantId = Number(line?.variantId);
    const quantity = Number(line?.quantity);
    if (!Number.isInteger(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      res.status(400).json({ error: "The bag could not be priced." });
      return;
    }
    quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
  }
  const variants = await db
    .select()
    .from(productVariantsTable)
    .where(inArray(productVariantsTable.id, [...quantities.keys()]));
  if (variants.length !== quantities.size) {
    res.status(400).json({ error: "One or more fragrances are no longer available." });
    return;
  }
  const products = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(and(inArray(productsTable.id, variants.map((variant) => variant.productId)), eq(productsTable.status, "published")));
  if (products.length !== new Set(variants.map((variant) => variant.productId)).size) {
    res.status(400).json({ error: "One or more fragrances are no longer available." });
    return;
  }
  let subtotalMinor = 0;
  for (const variant of variants) {
    subtotalMinor += variant.priceMinor * (quantities.get(variant.id) ?? 0);
  }
  const normalizedCode = normalizeDiscountCode(req.body?.discountCode);
  let offer: ReturnType<typeof discountOfferFromRow> = null;
  let applied: ReturnType<typeof toDiscountCode> | null = null;
  if (normalizedCode) {
    const [codeRow] = await db
      .select()
      .from(discountCodesTable)
      .where(eq(discountCodesTable.code, normalizedCode))
      .limit(1);
    if (!codeRow || !codeRow.active) {
      res.status(400).json({ error: "That discount code is not valid." });
      return;
    }
    if (codeRow.usageLimit !== null && codeRow.usedCount >= codeRow.usageLimit) {
      res.status(400).json({ error: "That discount code has been fully used." });
      return;
    }
    if (subtotalMinor < codeRow.minSubtotalMinor) {
      res.status(400).json({ error: `This code needs a fragrance subtotal of at least $${money(codeRow.minSubtotalMinor)}.` });
      return;
    }
    offer = discountOfferFromRow(codeRow);
    if (!offer) {
      res.status(400).json({ error: "That discount code is not valid." });
      return;
    }
    applied = toDiscountCode(codeRow);
  }
  let shippingMinor: number;
  let freeThresholdMinor: number;
  try {
    const delivery = await deliverySettings();
    shippingMinor = delivery.shippingFeeMinor;
    freeThresholdMinor = delivery.freeShippingThresholdMinor;
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Shipping is not configured." });
    return;
  }
  const quote = quoteCheckout(subtotalMinor, shippingMinor, offer, freeThresholdMinor);
  res.json({
    ...quote,
    discountCode: applied?.code ?? null,
    discountSummary: applied?.summary ?? null,
  });
});

router.get("/admin/discounts", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(discountCodesTable).orderBy(desc(discountCodesTable.createdAt));
  res.json(rows.map(toDiscountCode));
});

router.post("/admin/discounts", requireAdmin, async (req, res): Promise<void> => {
  const parsed = parseDiscountInput(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const [row] = await db.insert(discountCodesTable).values(parsed.data).returning();
    res.status(201).json(toDiscountCode(row));
  } catch (error) {
    req.log.error({ error }, "Failed to create discount code");
    res.status(409).json({ error: "That code already exists." });
  }
});

router.patch("/admin/discounts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Discount not found." });
    return;
  }
  const parsed = parseDiscountInput(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const [row] = await db
      .update(discountCodesTable)
      .set(parsed.data)
      .where(eq(discountCodesTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Discount not found." });
      return;
    }
    res.json(toDiscountCode(row));
  } catch (error) {
    req.log.error({ error }, "Failed to update discount code");
    res.status(409).json({ error: "That code already exists." });
  }
});

router.delete("/admin/discounts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .delete(discountCodesTable)
    .where(eq(discountCodesTable.id, id))
    .returning({ id: discountCodesTable.id });
  if (!row) {
    res.status(404).json({ error: "Discount not found." });
    return;
  }
  res.status(204).end();
});

router.post("/checkout/paypal/order", async (req, res): Promise<void> => {
  await syncSampleVariants();
  const parsed = CreatePayPalOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let mode: PayPalMode;
  let shippingMinor: number;
  let freeThresholdMinor: number;
  let baseUrl: string;
  try {
    mode = paypalMode();
    paypalCredentials(mode);
    if (mode === "live" && process.env.PAYPAL_LIVE_CHECKOUT_ENABLED !== "true") {
      throw new Error("Live checkout is disabled until store setup is complete.");
    }
    if (mode === "live" && process.env.STORE_POLICIES_FINAL !== "true") {
      throw new Error("Finalize and review store policies before enabling live checkout.");
    }
    const delivery = await deliverySettings();
    shippingMinor = delivery.shippingFeeMinor;
    freeThresholdMinor = delivery.freeShippingThresholdMinor;
    baseUrl = publicBaseUrl(req, mode);
  } catch (error) {
    req.log.warn({ error }, "PayPal checkout is not ready");
    res.status(503).json({
      error: error instanceof Error ? error.message : "PayPal checkout is not configured.",
    });
    return;
  }
  const input = parsed.data;
  const [existing] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.requestId, input.requestId))
    .limit(1);
  if (existing?.paypalOrderId && existing.paypalApprovalUrl) {
    res.status(201).json(
      CreatePayPalOrderResponse.parse({
        orderId: existing.id,
        paypalOrderId: existing.paypalOrderId,
        approvalUrl: existing.paypalApprovalUrl,
        cancelToken: cancelTokenFor(existing.requestId),
        currency: existing.currency,
        totalMinor: existing.totalMinor,
      }),
    );
    return;
  }
  if (existing) {
    res.status(409).json({ error: "Checkout is already being prepared. Please retry shortly." });
    return;
  }

  const cancelToken = cancelTokenFor(input.requestId);
  const cancelTokenHash = createHash("sha256").update(cancelToken).digest("hex");
  const quantities = new Map<number, number>();
  for (const line of input.lines) {
    quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity);
  }
  let pendingOrder: { order: OrderRow; totalMinor: number };
  try {
    pendingOrder = await db.transaction(async (tx) => {
      const ids = [...quantities.keys()];
      const variants = await tx
        .select()
        .from(productVariantsTable)
        .where(inArray(productVariantsTable.id, ids));
      if (variants.length !== ids.length) throw new Error("One or more variants no longer exist.");
      const productIds = [...new Set(variants.map((variant) => variant.productId))];
      const products = await tx
        .select()
        .from(productsTable)
        .where(
          and(
            inArray(productsTable.id, productIds),
            eq(productsTable.status, "published"),
          ),
        );
      if (products.length !== productIds.length) {
        throw new Error("One or more fragrances are no longer available.");
      }
      const productById = new Map(products.map((product) => [product.id, product]));
      const variantById = new Map(variants.map((variant) => [variant.id, variant]));
      if (
        mode === "live" &&
        [...quantities.keys()].some((variantId) => {
          const variant = variantById.get(variantId);
          const product = variant && productById.get(variant.productId);
          return (
            variant?.sku.startsWith("ARV-TEST-") ||
            product?.name.toUpperCase().includes("TEST ONLY")
          );
        })
      ) {
        throw new Error("Test-only fragrances cannot be purchased through live checkout.");
      }
      let subtotalMinor = 0;
      for (const [variantId, quantity] of quantities) {
        const variant = variantById.get(variantId);
        if (!variant || quantity > 10 || variant.stock < quantity) {
          throw new Error("One or more fragrance sizes are out of stock.");
        }
        subtotalMinor += variant.priceMinor * quantity;
      }
      const normalizedCode = normalizeDiscountCode(input.discountCode);
      let offer: ReturnType<typeof discountOfferFromRow> = null;
      let appliedCode: string | null = null;
      if (normalizedCode) {
        const [codeRow] = await tx
          .select()
          .from(discountCodesTable)
          .where(eq(discountCodesTable.code, normalizedCode))
          .for("update");
        if (!codeRow || !codeRow.active) throw new Error("That discount code is not valid.");
        if (codeRow.usageLimit !== null && codeRow.usedCount >= codeRow.usageLimit) {
          throw new Error("That discount code has been fully used.");
        }
        if (subtotalMinor < codeRow.minSubtotalMinor) {
          throw new Error(`This code needs a fragrance subtotal of at least $${money(codeRow.minSubtotalMinor)}.`);
        }
        offer = discountOfferFromRow(codeRow);
        if (!offer) throw new Error("That discount code is not valid.");
        await tx
          .update(discountCodesTable)
          .set({ usedCount: sql`${discountCodesTable.usedCount} + 1` })
          .where(eq(discountCodesTable.id, codeRow.id));
        appliedCode = codeRow.code;
      }
      const quote = quoteCheckout(subtotalMinor, shippingMinor, offer, freeThresholdMinor);
      const discountMinor = quote.automaticDiscountMinor + quote.codeDiscountMinor;
      const chargedShippingMinor = quote.shippingMinor;
      const totalMinor = quote.totalMinor;
      const orderNumber = `SF-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
      const [order] = await tx
        .insert(ordersTable)
        .values({
          orderNumber,
          clerkUserId: getAuth(req).userId ?? null,
          email: input.email.toLowerCase(),
          recipientName: input.recipientName,
          address1: input.address1,
          address2: input.address2 ?? null,
          city: input.city,
          region: input.region ?? null,
          postcode: input.postcode,
          subtotalMinor,
          discountMinor,
          discountCode: appliedCode,
          shippingMinor: chargedShippingMinor,
          totalMinor,
          currency: NZD,
          status: "pending",
          cancelTokenHash,
          requestId: input.requestId,
        })
        .returning();
      for (const [variantId, quantity] of quantities) {
        const [reserved] = await tx
          .update(productVariantsTable)
          .set({ stock: sql`${productVariantsTable.stock} - ${quantity}` })
          .where(
            and(
              eq(productVariantsTable.id, variantId),
              gte(productVariantsTable.stock, quantity),
            ),
          )
          .returning();
        if (!reserved) throw new Error("Stock changed during checkout. Please retry.");
        const variant = variantById.get(variantId)!;
        const product = productById.get(variant.productId)!;
        await tx.insert(orderItemsTable).values({
          orderId: order.id,
          variantId,
          productName: product.name,
          brand: product.brand,
          variantSize: variant.size,
          sku: variant.sku,
          quantity,
          unitPriceMinor: variant.priceMinor,
          unitCostMinor: variant.costMinor,
        });
        await tx.insert(inventoryMovementsTable).values({
          variantId,
          delta: -quantity,
          reason: `Reserved for order ${order.orderNumber}`,
          orderId: order.id,
        });
      }
      return { order, totalMinor };
    });
  } catch (error) {
    req.log.warn({ error }, "Checkout rejected");
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not prepare checkout.",
    });
    return;
  }

  try {
    type CreateResponse = {
      id?: string;
      links?: { rel?: string; href?: string }[];
    };
    const paypalOrder = await paypalRequest<CreateResponse>(
      "/v2/checkout/orders",
      {
        method: "POST",
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: String(pendingOrder.order.id),
              custom_id: pendingOrder.order.orderNumber,
              amount: {
                currency_code: NZD,
                value: money(pendingOrder.totalMinor),
              },
            },
          ],
          application_context: {
            brand_name: "Arvessó Fragrances",
            user_action: "PAY_NOW",
            return_url: `${baseUrl}/order-confirmation/${pendingOrder.order.id}`,
            cancel_url: `${baseUrl}/checkout?cancelled=${pendingOrder.order.id}`,
          },
        }),
      },
      input.requestId,
      mode,
    );
    const approvalUrl = paypalOrder.links?.find(
      (link) => link.rel === "approve" || link.rel === "payer-action",
    )?.href;
    if (!paypalOrder.id || !approvalUrl) {
      throw new Error("PayPal did not return an approval link.");
    }
    await db
      .update(ordersTable)
      .set({ paypalOrderId: paypalOrder.id, paypalApprovalUrl: approvalUrl })
      .where(eq(ordersTable.id, pendingOrder.order.id));
    res.status(201).json(
      CreatePayPalOrderResponse.parse({
        orderId: pendingOrder.order.id,
        paypalOrderId: paypalOrder.id,
        approvalUrl,
        cancelToken,
        currency: NZD,
        totalMinor: pendingOrder.totalMinor,
      }),
    );
  } catch (error) {
    req.log.error({ error, orderId: pendingOrder.order.id }, "PayPal order creation failed");
    await releaseReservation(pendingOrder.order.id, "failed");
    res.status(503).json({ error: "Could not start PayPal checkout. Reserved stock was released." });
  }
});

router.post("/checkout/paypal/capture", async (req, res): Promise<void> => {
  const parsed = CapturePayPalOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let order: OrderRow | undefined;
  try {
    [order] = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.id, parsed.data.orderId),
          eq(ordersTable.paypalOrderId, parsed.data.paypalOrderId),
        ),
      )
      .limit(1);
  } catch (error) {
    req.log.error({ error }, "Failed to load PayPal order");
    res.status(500).json({ error: "Could not load the order." });
    return;
  }
  if (!order) {
    res.status(404).json({ error: "Pending PayPal order not found." });
    return;
  }
  if (order.status === "paid") {
    res.json(CapturePayPalOrderResponse.parse(toOrder(order)));
    return;
  }
  if (order.status !== "pending") {
    res.status(400).json({ error: "This order is no longer awaiting payment." });
    return;
  }

  type CaptureResponse = {
    status?: string;
    purchase_units?: {
      reference_id?: string;
      payments?: {
        captures?: {
          id?: string;
          status?: string;
          amount?: { value?: string; currency_code?: string };
        }[];
      };
    }[];
  };
  try {
    const capture = await paypalRequest<CaptureResponse>(
      `/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId!)}/capture`,
      { method: "POST", body: "{}" },
      `${order.requestId}-capture`,
      paypalModeForOrder(order),
    );
    const purchaseUnit = capture.purchase_units?.[0];
    const payment = purchaseUnit?.payments?.captures?.[0];
    if (
      capture.status !== "COMPLETED" ||
      payment?.status !== "COMPLETED" ||
      purchaseUnit?.reference_id !== String(order.id) ||
      payment.amount?.currency_code !== order.currency ||
      payment.amount.value !== money(order.totalMinor) ||
      !payment.id
    ) {
      req.log.warn({ orderId: order.id, status: capture.status }, "PayPal capture did not match order");
      res.status(400).json({ error: "PayPal payment could not be verified for this order." });
      return;
    }
    const [updated] = await db
      .update(ordersTable)
      .set({
        status: "paid",
        paypalCaptureId: payment.id,
        paidAt: new Date(),
      })
      .where(
        and(
          eq(ordersTable.id, order.id),
          eq(ordersTable.status, "pending"),
          eq(ordersTable.paypalOrderId, parsed.data.paypalOrderId),
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, order.id))
        .limit(1);
      if (current?.status === "paid") {
        res.json(CapturePayPalOrderResponse.parse(toOrder(current)));
        return;
      }
      res.status(409).json({ error: "Order state changed while verifying payment." });
      return;
    }
    try {
      const lines = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, updated.id));
      await deliverLetter(req, confirmationLetter(updated, lines));
    } catch (error) {
      req.log.warn({ error, orderId: updated.id }, "Order confirmation email skipped");
    }
    res.json(CapturePayPalOrderResponse.parse(toOrder(updated)));
  } catch (error) {
    req.log.error({ error, orderId: order.id }, "PayPal capture failed");
    res.status(503).json({ error: "Payment could not be confirmed. The order remains pending." });
  }
});

router.post("/checkout/paypal/cancel", async (req, res): Promise<void> => {
  const parsed = CancelPayPalOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, parsed.data.orderId))
    .limit(1);
  if (!order || order.status !== "pending") {
    res.status(404).json({ error: "Pending order not found." });
    return;
  }
  const tokenHash = createHash("sha256").update(parsed.data.cancelToken).digest("hex");
  const expected = Buffer.from(order.cancelTokenHash);
  const supplied = Buffer.from(tokenHash);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    res.status(404).json({ error: "Pending order not found." });
    return;
  }
  if (order.paypalOrderId) {
    try {
      const remote = await paypalRequest<{ status?: string }>(
        `/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}`,
        {},
        undefined,
        paypalModeForOrder(order),
      );
      if (remote.status === "APPROVED" || remote.status === "COMPLETED") {
        res.status(409).json({
          error: "This payment has been approved. Continue to confirmation instead of cancelling.",
        });
        return;
      }
    } catch (error) {
      req.log.warn({ error, orderId: order.id }, "Could not confirm PayPal cancellation state");
      res.status(503).json({ error: "Could not verify the PayPal order; stock was not released." });
      return;
    }
  }
  await releaseReservation(order.id, "cancelled");
  const [updated] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, order.id))
    .limit(1);
  if (!updated) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  res.json(CancelPayPalOrderResponse.parse(toOrder(updated)));
});

export default router;
