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
