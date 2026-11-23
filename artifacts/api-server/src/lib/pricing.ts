export const SAMPLE_PRICE_MINOR = 700;
export const SAMPLE_SIZE = "2 ml";
export const SAMPLE_AVAILABLE_STOCK = 25;

export function sampleSku(productId: number) {
  return `SAMPLE-${productId}`;
}

export function isSampleSku(sku: string) {
  return sku.startsWith("SAMPLE-");
}

export const DISCOUNT_THRESHOLD_MINOR = 10_000;
export const DISCOUNT_PERCENT = 0;
export const FREE_SHIPPING_THRESHOLD_MINOR = 10_000;

export function discountForSubtotal(_subtotalMinor: number) {
  return 0;
}

export function shippingForSubtotal(
  subtotalMinor: number,
  shippingFeeMinor: number,
  freeThresholdMinor = FREE_SHIPPING_THRESHOLD_MINOR,
) {
  if (freeThresholdMinor <= 0) return shippingFeeMinor;
  return subtotalMinor > freeThresholdMinor ? 0 : shippingFeeMinor;
}

export type DiscountCodeType = "percent" | "fixed" | "free_shipping";

export type DiscountOffer = {
  type: DiscountCodeType;
  percent: number | null;
  amountMinor: number | null;
};

export type CheckoutQuote = {
  subtotalMinor: number;
  automaticDiscountMinor: number;
  codeDiscountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  freeShipping: boolean;
};

export function quoteCheckout(
  subtotalMinor: number,
  shippingFee: number,
  offer: DiscountOffer | null,
  freeThresholdMinor = FREE_SHIPPING_THRESHOLD_MINOR,
): CheckoutQuote {
  const automaticDiscountMinor = discountForSubtotal(subtotalMinor);
  let rawCodeDiscount = 0;
  let freeShipping = false;
  if (offer?.type === "percent" && offer.percent) {
    rawCodeDiscount = Math.round((subtotalMinor * offer.percent) / 100);
  } else if (offer?.type === "fixed" && offer.amountMinor) {
    rawCodeDiscount = Math.max(0, offer.amountMinor);
  } else if (offer?.type === "free_shipping") {
    freeShipping = true;
  }
  const merchandiseDiscount = Math.min(
    subtotalMinor,
    automaticDiscountMinor + rawCodeDiscount,
  );
  const shippingMinor = freeShipping
    ? 0
    : shippingForSubtotal(subtotalMinor, shippingFee, freeThresholdMinor);
  return {
    subtotalMinor,
    automaticDiscountMinor,
    codeDiscountMinor: merchandiseDiscount - automaticDiscountMinor,
    shippingMinor,
    totalMinor: subtotalMinor - merchandiseDiscount + shippingMinor,
    freeShipping,
  };
}

export function discountOfferLabel(offer: DiscountOffer) {
  if (offer.type === "percent") return `${offer.percent ?? 0}% off the fragrance subtotal`;
  if (offer.type === "fixed") {
    return `$${((offer.amountMinor ?? 0) / 100).toFixed(2)} off the fragrance subtotal`;
  }
  return "Free delivery";
}
