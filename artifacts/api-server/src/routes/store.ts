import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
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
  inventoryMovementsTable,
  orderItemsTable,
  ordersTable,
  productVariantsTable,
  productsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();
const PAYPAL_API = "https://api-m.sandbox.paypal.com";
const LOW_STOCK_THRESHOLD = 5;
const NZD = "NZD";

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

function toOrder(row: OrderRow) {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    email: row.email,
    status: row.status,
    totalMinor: row.totalMinor,
    currency: row.currency,
    paypalOrderId: row.paypalOrderId,
    createdAt: row.createdAt,
  };
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

function paypalCredentials() {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const secret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !secret) {
    throw new Error("PayPal sandbox credentials are not configured.");
  }
  return { clientId, secret };
}

function cancelTokenFor(requestId: string) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be configured before checkout is enabled.");
  }
  return createHmac("sha256", sessionSecret).update(requestId).digest("hex");
}

async function paypalAccessToken(): Promise<string> {
  const { clientId, secret } = paypalCredentials();
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error("PayPal could not authorize the sandbox request.");
  }
  const result = (await response.json()) as { access_token?: string };
  if (!result.access_token) throw new Error("PayPal returned no access token.");
  return result.access_token;
}

async function paypalRequest<T>(
  path: string,
  init: RequestInit = {},
  requestId?: string,
): Promise<T> {
  const token = await paypalAccessToken();
  const response = await fetch(`${PAYPAL_API}${path}`, {
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

function publicBaseUrl(req: Request) {
  const domain = (
    process.env.REPLIT_DOMAINS ??
    process.env.REPLIT_DEV_DOMAIN ??
    ""
  )
    .split(",")[0]
    .trim();
  if (domain) return `https://${domain}`;
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
    await tx
      .update(ordersTable)
      .set({ status: finalStatus })
      .where(eq(ordersTable.id, orderId));
  });
}

router.get("/products", async (req, res): Promise<void> => {
  const params = GetProductsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { q, brand, audience, sort, page = 1, pageSize = 12 } = params.data;
  const conditions = [eq(productsTable.status, "published")];
  if (brand) conditions.push(eq(productsTable.brand, brand));
  if (audience) conditions.push(eq(productsTable.audience, audience));
  if (q) {
    const term = `%${q.replace(/[%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(productsTable.name, term),
        ilike(productsTable.brand, term),
        ilike(productsTable.description, term),
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

router.get("/products/:slug", async (req, res): Promise<void> => {
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

router.get("/admin/dashboard", requireAdmin, async (req, res): Promise<void> => {
  const [productCount, lowStockRows, pendingRows, salesRows, recent] =
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
    ]);
  const payload = {
    productCount: Number(productCount[0]?.total ?? 0),
    lowStockCount: Number(lowStockRows[0]?.total ?? 0),
    pendingOrders: Number(pendingRows[0]?.total ?? 0),
    paidSalesMinor: Number(salesRows[0]?.total ?? 0),
    recentOrders: recent.map(toOrder),
  };
  req.log.info("Loaded admin overview");
  res.json(GetAdminDashboardResponse.parse(payload));
});

router.get("/admin/products", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
  const products = await productResults(rows);
  res.json(GetAdminProductsResponse.parse(products));
});

router.post("/admin/products", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
    res.status(409).json({ error: "Could not save product. Check that each SKU is unique." });
  }
});

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
  const updates = parsed.data;
  const [row] = await db
    .update(productsTable)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(productsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Fragrance not found." });
    return;
  }
  const product = (await productResults([row]))[0];
  res.json(UpdateProductResponse.parse(product));
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
  res.json(GetAdminOrdersResponse.parse(orders.map(toOrder)));
});

router.post("/checkout/paypal/order", async (req, res): Promise<void> => {
  const parsed = CreatePayPalOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    paypalCredentials();
  } catch {
    res.status(503).json({ error: "PayPal sandbox is not configured." });
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
  const baseUrl = publicBaseUrl(req);

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
      let subtotalMinor = 0;
      for (const [variantId, quantity] of quantities) {
        const variant = variantById.get(variantId);
        if (!variant || quantity > 10 || variant.stock < quantity) {
          throw new Error("One or more fragrance sizes are out of stock.");
        }
        subtotalMinor += variant.priceMinor * quantity;
      }
      const shippingMinor = 0;
      const totalMinor = subtotalMinor + shippingMinor;
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
          shippingMinor,
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
            brand_name: "Sillage Fragrance",
            user_action: "PAY_NOW",
            return_url: `${baseUrl}/order-confirmation/${pendingOrder.order.id}`,
            cancel_url: `${baseUrl}/checkout?cancelled=${pendingOrder.order.id}`,
          },
        }),
      },
      input.requestId,
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
