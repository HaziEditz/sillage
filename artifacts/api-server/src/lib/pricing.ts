export const DISCOUNT_THRESHOLD_MINOR = 10_000;
export const DISCOUNT_PERCENT = 10;
export const FREE_SHIPPING_THRESHOLD_MINOR = 10_000;

export function discountForSubtotal(subtotalMinor: number) {
  return subtotalMinor > DISCOUNT_THRESHOLD_MINOR
    ? Math.round(subtotalMinor * DISCOUNT_PERCENT / 100)
    : 0;
}

export function shippingForSubtotal(subtotalMinor: number, shippingFeeMinor: number) {
  return subtotalMinor > FREE_SHIPPING_THRESHOLD_MINOR ? 0 : shippingFeeMinor;
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
    : shippingForSubtotal(subtotalMinor, shippingFee);
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
