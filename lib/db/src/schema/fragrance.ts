import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const productsTable = pgTable(
  "fragrance_products",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    brand: text("brand").notNull(),
    description: text("description").notNull().default(""),
    audience: text("audience").notNull().default("Unisex"),
    concentration: text("concentration"),
    scentFamily: text("scent_family"),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
    imageUrl: text("image_url"),
    imageUrls: jsonb("image_urls").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    featured: boolean("featured").notNull().default(false),
    bestseller: boolean("bestseller").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("fragrance_products_slug_idx").on(table.slug),
    index("fragrance_products_status_idx").on(table.status),
    index("fragrance_products_brand_idx").on(table.brand),
  ],
);

export const productVariantsTable = pgTable(
  "fragrance_product_variants",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    size: text("size").notNull(),
    sku: text("sku").notNull(),
    priceMinor: integer("price_minor").notNull(),
    compareAtPriceMinor: integer("compare_at_price_minor"),
    costMinor: integer("cost_minor"),
    stock: integer("stock").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("fragrance_product_variants_sku_idx").on(table.sku),
    index("fragrance_product_variants_product_idx").on(table.productId),
  ],
);

export const ordersTable = pgTable(
  "fragrance_orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: text("order_number").notNull(),
    clerkUserId: text("clerk_user_id"),
    email: text("email").notNull(),
    recipientName: text("recipient_name").notNull(),
    address1: text("address1").notNull(),
    address2: text("address2"),
    city: text("city").notNull(),
    region: text("region"),
    postcode: text("postcode").notNull(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    discountCode: text("discount_code"),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull().default("NZD"),
    paymentMethod: text("payment_method").notNull().default("paypal"),
    fulfillment: text("fulfillment").notNull().default("to_send"),
    tracking: text("tracking"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    paypalOrderId: text("paypal_order_id"),
    paypalApprovalUrl: text("paypal_approval_url"),
    paypalCaptureId: text("paypal_capture_id"),
    cancelTokenHash: text("cancel_token_hash").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("fragrance_orders_order_number_idx").on(table.orderNumber),
    uniqueIndex("fragrance_orders_request_id_idx").on(table.requestId),
    uniqueIndex("fragrance_orders_paypal_order_idx").on(table.paypalOrderId),
    uniqueIndex("fragrance_orders_paypal_capture_idx").on(
      table.paypalCaptureId,
    ),
    index("fragrance_orders_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const orderItemsTable = pgTable(
  "fragrance_order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").references(() => productVariantsTable.id, {
      onDelete: "set null",
    }),
    productName: text("product_name").notNull(),
    brand: text("brand").notNull(),
    variantSize: text("variant_size").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    unitCostMinor: integer("unit_cost_minor"),
  },
  (table) => [index("fragrance_order_items_order_idx").on(table.orderId)],
);

export const discountCodesTable = pgTable(
  "fragrance_discount_codes",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    label: text("label").notNull().default(""),
    type: text("type").notNull(),
    percent: integer("percent"),
    amountMinor: integer("amount_minor"),
    minSubtotalMinor: integer("min_subtotal_minor").notNull().default(0),
    usageLimit: integer("usage_limit"),
    usedCount: integer("used_count").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("fragrance_discount_codes_code_idx").on(table.code)],
);

export const storeSettingsTable = pgTable("fragrance_store_settings", {
  id: integer("id").primaryKey(),
  shippingFeeMinor: integer("shipping_fee_minor").notNull().default(1500),
  freeShippingThresholdMinor: integer("free_shipping_threshold_minor")
    .notNull()
    .default(10000),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inventoryMovementsTable = pgTable(
  "fragrance_inventory_movements",
  {
    id: serial("id").primaryKey(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => productVariantsTable.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    actorClerkId: text("actor_clerk_id"),
    orderId: integer("order_id").references(() => ordersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("fragrance_inventory_movements_variant_idx").on(table.variantId),
    index("fragrance_inventory_movements_created_idx").on(table.createdAt),
  ],
);

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertVariantSchema = createInsertSchema(productVariantsTable).omit({
  id: true,
  createdAt: true,
});
export const insertOrderSchema = createInsertSchema(ordersTable).omit({
  id: true,
  createdAt: true,
  paidAt: true,
});

export type Product = typeof productsTable.$inferSelect;
export type ProductVariant = typeof productVariantsTable.$inferSelect;
export type Order = typeof ordersTable.$inferSelect;
export type OrderItem = typeof orderItemsTable.$inferSelect;
export type InventoryMovement = typeof inventoryMovementsTable.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type InsertVariant = z.infer<typeof insertVariantSchema>;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
