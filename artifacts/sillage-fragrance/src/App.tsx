import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import { ClerkProvider, Show, SignIn, SignUp, UserProfile, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  ArrowLeft, ArrowRight, Check, CircleHelp, Instagram, ZoomIn,
  KeyRound, LoaderCircle, LogOut, Menu, Minus, Package, PackageCheck, Plus, Search, ShieldCheck, ShoppingBag,
  ThumbsDown, ThumbsUp, Trash2, Truck, UserRound, X,
} from 'lucide-react';
import {
  getGetAdminDashboardQueryKey, getGetAdminOrdersQueryKey, getGetAdminProductsQueryKey,
  getGetProductsQueryKey, getHealthCheckQueryKey, useAdjustInventory, useCapturePayPalOrder,
  useCancelPayPalOrder, useCreatePayPalOrder, useCreateProduct, useGetAdminDashboard, useGetAdminOrders,
  useGetAdminProducts, useGetProduct, useGetProducts, useHealthCheck, useUpdateProduct,
} from '@workspace/api-client-react';
import type { CheckoutInput, Order, Product, ProductInput, ProductUpdate, ProductVariant } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#292723',
    colorForeground: '#292723',
    colorMutedForeground: '#706d65',
    colorDanger: '#9c493e',
    colorBackground: '#f6f3ec',
    colorInput: '#fbf9f4',
    colorInputForeground: '#292723',
    colorNeutral: '#d8d3ca',
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: '2px',
  },
  elements: {
    rootBox: { width: '100%', display: 'flex', justifyContent: 'center' },
    cardBox: { backgroundColor: '#f6f3ec', border: '1px solid #d8d3ca', borderRadius: '2px', width: '440px', maxWidth: '100%', overflow: 'hidden', boxShadow: 'none' },
    card: { boxShadow: 'none', border: '0', backgroundColor: 'transparent', borderRadius: '0' },
    footer: { boxShadow: 'none', border: '0', backgroundColor: 'transparent', borderRadius: '0' },
    headerTitle: { color: '#292723', fontFamily: "'Playfair Display', Georgia, serif", fontWeight: '400' },
    headerSubtitle: { color: '#706d65' },
    socialButtonsBlockButtonText: { color: '#292723' },
    formFieldLabel: { color: '#514e47' },
    footerActionLink: { color: '#292723', textDecoration: 'underline' },
    footerActionText: { color: '#706d65' },
    dividerText: { color: '#706d65' },
    identityPreviewEditButton: { color: '#514e47' },
    formFieldSuccessText: { color: '#56624d' },
    alertText: { color: '#8c4438' },
    logoBox: { width: '100%' },
    logoImage: { maxHeight: '36px' },
    socialButtonsBlockButton: { border: '1px solid #d8d3ca', color: '#292723', backgroundColor: '#f6f3ec' },
    formButtonPrimary: { backgroundColor: '#292723', color: '#f6f3ec', borderRadius: '2px', boxShadow: 'none' },
    formFieldInput: { color: '#292723', backgroundColor: '#fbf9f4', border: '1px solid #d8d3ca', borderRadius: '2px' },
    footerAction: { color: '#706d65' },
    dividerLine: { backgroundColor: '#d8d3ca' },
    alert: { backgroundColor: '#f4e8e4', color: '#8c4438' },
    otpCodeFieldInput: { color: '#292723', backgroundColor: '#fbf9f4', borderColor: '#d8d3ca' },
    formFieldRow: { color: '#514e47' },
    main: { color: '#292723' },
  },
};
const money = (minor: number, currency = 'NZD') => new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(minor / 100);
type CartEntry = { variantId: number; quantity: number; product: Product; variant: ProductVariant };
type PayPalCheckoutConfig = {
  mode: 'sandbox' | 'live';
  shippingMinor: number;
  freeShippingThresholdMinor: number;
  discountThresholdMinor: number;
  discountPercent: number;
  checkoutEnabled: boolean;
};
function deliveryForSubtotal(config: PayPalCheckoutConfig | undefined, subtotalMinor: number) {
  if (!config) return undefined;
  if (config.freeShippingThresholdMinor <= 0) return config.shippingMinor;
  return subtotalMinor > config.freeShippingThresholdMinor ? 0 : config.shippingMinor;
}
const CART_KEY = 'sillage-cart-v1';

function useCart() {
  const [entries, setEntries] = useState<CartEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]') as CartEntry[]; } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(entries)); }, [entries]);
  const add = (product: Product, variant: ProductVariant) => setEntries((current) => {
    const found = current.find((item) => item.variantId === variant.id);
    if (found) return current.map((item) => item.variantId === variant.id ? { ...item, quantity: Math.min(10, item.quantity + 1) } : item);
    return [...current, { product, variant, variantId: variant.id, quantity: 1 }];
  });
  const quantity = (id: number, value: number) => setEntries((all) => value < 1 ? all.filter((item) => item.variantId !== id) : all.map((item) => item.variantId === id ? { ...item, quantity: Math.min(10, value) } : item));
  const remove = (id: number) => setEntries((all) => all.filter((item) => item.variantId !== id));
  const clear = () => setEntries([]);
  return { entries, add, quantity, remove, clear, count: entries.reduce((n, item) => n + item.quantity, 0), total: entries.reduce((n, item) => n + item.variant.priceMinor * item.quantity, 0) };
}
type CartApi = ReturnType<typeof useCart>;

function useAdminAccess() {
  const { user, isLoaded } = useUser();
  const { data: isAdmin } = useQuery({
    queryKey: ['admin', 'access', user?.id],
    enabled: isLoaded && Boolean(user),
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await fetch('/api/admin/access', { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Admin access check failed (${response.status}).`);
      }

      const result: unknown = await response.json();
      if (
        typeof result !== 'object' ||
        result === null ||
        !('isAdmin' in result) ||
        typeof result.isAdmin !== 'boolean'
      ) {
        throw new Error('Admin access check returned an invalid response.');
      }
      return result.isAdmin;
    },
  });
  return isLoaded && Boolean(user) && isAdmin === true;
}

function AdminStudioLink({
  label,
  className,
  testId,
}: {
  label: string;
  className?: string;
  testId: string;
}) {
  const isAdmin = useAdminAccess();
  return isAdmin ? <Link href="/admin" className={className} data-testid={testId}>{label}</Link> : null;
}

function Header({ cart }: { cart: CartApi }) {
  return <header className="header">
    <Link href="/" className="brand" data-testid="link-home"><span>Arvessó</span><span className="brand-descriptor">FRAGRANCES</span></Link>
    <nav className="nav-links" aria-label="Main navigation">
      <Link href="/shop" data-testid="link-shop">Fragrance</Link><Link href="/samples" data-testid="link-samples">Samples</Link><a href={`${basePath || ''}/#approach`}>Our approach</a><Link href="/account" data-testid="link-account-navigation">Account</Link>
      <Show when="signed-in"><AdminStudioLink label="Studio" testId="link-admin-navigation"/></Show>
    </nav>
    <div className="header-actions">
      <AccountControls/>
      <a className="icon-button social-link" href={STORE_INSTAGRAM} target="_blank" rel="noreferrer" aria-label="Instagram" data-testid="link-instagram"><Instagram size={16}/></a>
      <Link href="/account" className="icon-button mobile-account" aria-label="My account" data-testid="link-mobile-account"><UserRound size={18}/></Link>
      <Link href="/cart" className="icon-button" aria-label="Shopping bag" data-testid="link-cart"><ShoppingBag size={18}/>{cart.count > 0 && <span className="cart-count">{cart.count}</span>}</Link>
      <Link href="/shop" className="icon-button mobile-menu" aria-label="Browse fragrances" data-testid="link-mobile-shop"><Menu size={19}/></Link>
    </div>
  </header>;
}

function AccountControls() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  if (!isLoaded) return <span className="account-state" aria-label="Loading account"><span className="skeleton account-initial"/></span>;
  return <>
    <Show when="signed-out">
      <Link href="/sign-in" className="signin-link" data-testid="link-sign-in">Sign in</Link>
      <Link href="/sign-up" className="signin-link" data-testid="link-sign-up">Join</Link>
    </Show>
    <Show when="signed-in">
      <div className="account-state" data-testid="state-signed-in-account">
        <Link href="/account" className="account-state">
          <span className="account-initial">{user?.firstName?.slice(0,1) || user?.primaryEmailAddress?.emailAddress?.slice(0,1) || 'S'}</span>
          <span className="account-email">{user?.firstName || user?.primaryEmailAddress?.emailAddress || 'Your account'}</span>
        </Link>
        <button className="account-signout" type="button" onClick={() => void signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out">Sign out</button>
      </div>
    </Show>
  </>;
}

function Footer() {
  return <footer className="footer"><div className="wrap">
    <div className="footer-main"><div><Link href="/" className="brand"><span>Arvessó</span><span className="brand-descriptor">FRAGRANCES</span></Link><p>Independent fragrance, thoughtfully selected. From Aotearoa, for wherever you are.</p><a className="footer-social" href={STORE_INSTAGRAM} target="_blank" rel="noreferrer">Instagram</a></div>
      <div className="footer-links"><div><span className="eyebrow">Explore</span><Link href="/shop">Fragrance</Link><Link href="/samples">Samples</Link><Link href="/requests">Requests</Link><a href={`${basePath || ''}/#approach`}>Our approach</a></div><div><span className="eyebrow">Help & information</span><Link href="/contact">Contact</Link><Link href="/report">Report a problem</Link><Link href="/shipping">Shipping</Link><Link href="/returns">Returns</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/cart">Your bag</Link><Show when="signed-in"><Link href="/account">Account</Link><AdminStudioLink label="Store admin" testId="link-footer-store-admin"/></Show><Show when="signed-out"><Link href="/sign-in">Sign in</Link></Show></div></div></div>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} Arvessó Fragrances</span><span>Made for the considered everyday · Aotearoa New Zealand</span></div>
  </div></footer>;
}

type StoreInfoPageKey = 'contact' | 'shipping' | 'returns' | 'privacy' | 'terms';
type PolicyInline = string | { label: string; href: string; external?: boolean };
type PolicyBlock =
  | { kind: 'p'; parts: PolicyInline[] }
  | { kind: 'ul' | 'ol'; items: PolicyInline[][] }
  | { kind: 'lines'; items: { label: string; value: string; href?: string; external?: boolean }[] };

const STORE_EMAIL = 'arvessofragrances@gmail.com';
const STORE_INSTAGRAM = 'https://www.instagram.com/arvesso_fragrances/?hl=en';

function PolicyInlines({ parts }: { parts: PolicyInline[] }) {
  return <>{parts.map((part, index) => (
    typeof part === 'string'
      ? <span key={index}>{part}</span>
      : part.external
        ? <a key={index} href={part.href} target={part.href.startsWith('mailto:') ? undefined : '_blank'} rel={part.href.startsWith('mailto:') ? undefined : 'noreferrer'}>{part.label}</a>
        : <Link key={index} href={part.href}>{part.label}</Link>
  ))}</>;
}

const storeInfoPages: Record<StoreInfoPageKey, {
  title: string;
  updated?: string;
  intro: PolicyInline[][];
  sections: { title: string; blocks: PolicyBlock[] }[];
}> = {
  contact: {
    title: 'Contact',
    intro: [['Questions about an order, a return, or a fragrance — email us or send a message on Instagram. Include your order number when you have one.']],
    sections: [
      { title: 'Email', blocks: [{ kind: 'lines', items: [{ label: 'Email', value: STORE_EMAIL, href: `mailto:${STORE_EMAIL}` }] }] },
      { title: 'Instagram', blocks: [{ kind: 'lines', items: [{ label: 'Instagram', value: '@arvesso_fragrances', href: STORE_INSTAGRAM, external: true }] }] },
      { title: 'Requests and ideas', blocks: [{ kind: 'p', parts: ['Tell us about a fragrance you want to buy, an idea, or a suggestion for the shop. ', { label: 'Send a request', href: '/requests' }] }] },
      { title: 'Report a problem', blocks: [{ kind: 'p', parts: ['Reports are sent to ', { label: STORE_EMAIL, href: `mailto:${STORE_EMAIL}`, external: true }, '. ', { label: 'Send a report', href: '/report' }] }] },
    ],
  },
  shipping: {
    title: 'Shipping & delivery',
    intro: [['We currently accept orders for delivery within New Zealand only.']],
    sections: [
      { title: 'Where we deliver', blocks: [{ kind: 'p', parts: ['Orders are accepted for delivery within New Zealand only.'] }] },
      { title: 'Timing', blocks: [{ kind: 'p', parts: ['Our estimated delivery timeframe is 3–7 business days, subject to the delivery location and circumstances affecting delivery.'] }] },
      { title: 'Charges', blocks: [{ kind: 'p', parts: ['Delivery within New Zealand is $15. Orders over $100 ship free. The delivery charge is shown at checkout, before you pay.'] }] },
      { title: 'Your delivery details', blocks: [{ kind: 'p', parts: ['You are responsible for providing an accurate delivery address. If a parcel cannot be delivered because the address is incomplete or incorrect, contact us at ', { label: STORE_EMAIL, href: `mailto:${STORE_EMAIL}`, external: true }, ' with your order number.'] }] },
      { title: 'Questions', blocks: [{ kind: 'p', parts: ['For anything else about an order in transit, email ', { label: STORE_EMAIL, href: `mailto:${STORE_EMAIL}`, external: true }, ' or message ', { label: '@arvesso_fragrances', href: STORE_INSTAGRAM, external: true }, '.'] }] },
    ],
  },
  returns: {
    title: 'Returns & refunds',
    intro: [['We want you to feel confident when ordering from us. If you change your mind, our voluntary returns policy allows eligible unopened products to be returned within 14 days of delivery.'], ['Your rights under New Zealand consumer law remain protected.']],
    sections: [
      {
        title: '14-day change-of-mind returns',
        blocks: [
          { kind: 'p', parts: ['You may request a return within 14 calendar days of receiving your order, provided that:'] },
          { kind: 'ul', items: [
            ['The product is unopened and unused.'],
            ['Original seals, packaging and protective wrapping remain intact.'],
            ['The product is in its original resaleable condition.'],
            ['You can provide proof of purchase.'],
            ['The return request is made within 14 calendar days of delivery.'],
          ] },
          { kind: 'p', parts: ['For fragrance products, the product must remain unopened, including any original manufacturer seals or cellophane wrapping.'] },
          { kind: 'p', parts: ['We reserve the right to assess whether a returned item meets these conditions.'] },
        ],
      },
      {
        title: 'How to request a return',
        blocks: [
          { kind: 'p', parts: ['To request a change-of-mind return:'] },
          { kind: 'ol', items: [
            ['Contact us at ', { label: STORE_EMAIL, href: `mailto:${STORE_EMAIL}`, external: true }, ' within 14 calendar days of receiving your order.'],
            ['Include your order number and the product you wish to return.'],
            ['Wait for return instructions before sending anything back.'],
            ['Package the product securely and follow the instructions provided.'],
          ] },
          { kind: 'p', parts: ['Please do not send products to us without receiving return instructions first.'] },
        ],
      },
      {
        title: 'Return shipping costs',
        blocks: [
          { kind: 'p', parts: ['For approved change-of-mind returns, the customer is responsible for the cost of returning the product unless we agree otherwise.'] },
        ],
      },
      {
        title: 'Faulty, damaged or incorrect products',
        blocks: [
          { kind: 'p', parts: ['If an item arrives damaged, faulty, incorrect or does not meet the guarantees required by New Zealand law, please contact us.'] },
          { kind: 'p', parts: ['Include:'] },
          { kind: 'ul', items: [
            ['Your order number.'],
            ['A description of the issue.'],
            ['Photographs where relevant.'],
          ] },
          { kind: 'p', parts: ['We will assess the issue and provide an appropriate remedy in accordance with the Consumer Guarantees Act 1993.'] },
          { kind: 'p', parts: ['Depending on the circumstances and the seriousness of the issue, this may include a repair, replacement or refund.'] },
          { kind: 'p', parts: ['We will not use this voluntary change-of-mind policy to restrict your statutory consumer rights.'] },
        ],
      },
      {
        title: 'Refund processing',
        blocks: [
          { kind: 'p', parts: ['Once an approved return has been received and assessed, we will contact you about the outcome.'] },
          { kind: 'p', parts: ['Approved refunds will be made using the original payment method where reasonably possible.'] },
          { kind: 'p', parts: ['We check return requests every Monday at 8:00am, New Zealand time. After that check, a return takes 7 days.'] },
          { kind: 'p', parts: ['Your bank or payment provider may take additional time to display the refunded amount.'] },
        ],
      },
      {
        title: 'Products not eligible for change-of-mind returns',
        blocks: [
          { kind: 'p', parts: ['Opened, used, unsealed or damaged products are not eligible for our voluntary change-of-mind returns policy.'] },
          { kind: 'p', parts: ['This does not exclude remedies that may be available under New Zealand consumer law if a product is faulty, unsafe, misdescribed or otherwise fails to meet applicable consumer guarantees.'] },
        ],
      },
      {
        title: 'Contact',
        blocks: [
          { kind: 'p', parts: ['For returns and refund enquiries:'] },
          { kind: 'lines', items: [
            { label: 'Email', value: STORE_EMAIL, href: `mailto:${STORE_EMAIL}` },
            { label: 'Contact', value: 'Contact page', href: '/contact' },
            { label: 'Instagram', value: '@arvesso_fragrances', href: STORE_INSTAGRAM, external: true },
          ] },
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy',
    updated: '15 November 2026',
    intro: [['Your privacy matters to us. This policy explains how Arvessó Fragrances collects, uses, stores and protects personal information when you visit our website or purchase from us.'], ['We handle personal information in accordance with the New Zealand Privacy Act 2020.']],
    sections: [
      {
        title: '1. Information we collect',
        blocks: [
          { kind: 'p', parts: ['Depending on how you use our website, we may collect:'] },
          { kind: 'ul', items: [
            ['Contact information: your name, email address, phone number and delivery address.'],
            ['Order information: products purchased, order history, order number and delivery details.'],
            ['Payment information: payment status and transaction references supplied by our payment provider. We do not intend to store full payment card details on our own systems.'],
            ['Account information: login details and account preferences, if customer accounts are offered.'],
            ['Website information: technical information such as browser type, device information, IP address and website usage data, where collected through our website or analytics tools.'],
            ['Communications: messages and enquiries you send to us.'],
          ] },
          { kind: 'p', parts: ['We aim to collect only information reasonably needed for our business purposes.'] },
        ],
      },
      {
        title: '2. How we use your information',
        blocks: [
          { kind: 'p', parts: ['We may use your information to:'] },
          { kind: 'ul', items: [
            ['Process and fulfil orders.'],
            ['Arrange delivery and provide order updates.'],
            ['Process payments, refunds and payment enquiries.'],
            ['Respond to customer support requests.'],
            ['Maintain customer accounts, where available.'],
            ['Improve our website and shopping experience.'],
            ['Detect and prevent fraud, misuse and security issues.'],
            ['Meet legal, accounting and record-keeping obligations.'],
            ['Send promotional communications where you have agreed to receive them or where otherwise permitted by law.'],
          ] },
          { kind: 'p', parts: ['You can opt out of marketing emails using the unsubscribe option or by contacting us.'] },
        ],
      },
      {
        title: '3. Payment processing',
        blocks: [
          { kind: 'p', parts: ['Payments may be processed through third-party payment providers, including PayPal.'] },
          { kind: 'p', parts: ['When you make a payment, relevant transaction and payment information may be handled by the payment provider under its own privacy policy and terms.'] },
          { kind: 'p', parts: ['We do not intend to store your full payment card number or security code.'] },
        ],
      },
      {
        title: '4. When we share information',
        blocks: [
          { kind: 'p', parts: ['We do not sell customers’ personal information.'] },
          { kind: 'p', parts: ['We may share relevant information with service providers where necessary to operate our store, including:'] },
          { kind: 'ul', items: [
            ['Payment processors.'],
            ['Courier and delivery providers.'],
            ['Website hosting and infrastructure providers.'],
            ['Customer-support and email service providers.'],
            ['Website security and analytics providers, if used.'],
            ['Professional advisers or government authorities where legally required.'],
          ] },
          { kind: 'p', parts: ['We only intend to share information for legitimate business purposes and where permitted by applicable privacy law.'] },
        ],
      },
      {
        title: '5. Overseas service providers',
        blocks: [{ kind: 'p', parts: ['Some third-party services used to operate an online store may process or store information outside New Zealand. Where personal information is disclosed to an overseas organisation, we will take steps to comply with the applicable requirements of Information Privacy Principle 12 of the Privacy Act 2020.'] }],
      },
      {
        title: '6. Cookies and website analytics',
        blocks: [
          { kind: 'p', parts: ['Our website may use cookies or similar technologies to support essential website functions, remember preferences, maintain shopping sessions and understand website performance.'] },
          { kind: 'p', parts: ['This website does not use advertising or analytics tools. The shopping bag is stored in your browser. Account sign-in is handled by Clerk, which may set cookies required to keep you signed in. PayPal may set cookies when you complete a payment.'] },
          { kind: 'p', parts: ['You can manage cookies through your browser settings. Disabling certain cookies may affect some website functions.'] },
        ],
      },
      {
        title: '7. Keeping information secure',
        blocks: [
          { kind: 'p', parts: ['We take reasonable steps to protect personal information against loss, unauthorised access, misuse, modification or disclosure.'] },
          { kind: 'p', parts: ['However, no online system can be guaranteed to be completely secure.'] },
          { kind: 'p', parts: ['If a privacy breach occurs, we will respond in accordance with our legal obligations, including notifying affected individuals and the Office of the Privacy Commissioner where required.'] },
        ],
      },
      {
        title: '8. How long we retain information',
        blocks: [
          { kind: 'p', parts: ['We retain personal information only for as long as reasonably necessary for the purposes for which it was collected, including order fulfilment, customer support, legal obligations and legitimate business records.'] },
          { kind: 'p', parts: ['When information is no longer required, we will take reasonable steps to securely delete or de-identify it.'] },
        ],
      },
      {
        title: '9. Accessing or correcting your information',
        blocks: [
          { kind: 'p', parts: ['Under the Privacy Act 2020, you can request access to personal information we hold about you.'] },
          { kind: 'p', parts: ['You can also ask us to correct information that is inaccurate, incomplete or misleading.'] },
          { kind: 'p', parts: ['To make a request, email ', { label: STORE_EMAIL, href: `mailto:${STORE_EMAIL}`, external: true }, '. We will respond in accordance with applicable legal timeframes.'] },
        ],
      },
      {
        title: '10. Children’s privacy',
        blocks: [
          { kind: 'p', parts: ['Our website is intended for general retail customers. We do not knowingly seek to collect unnecessary personal information from children.'] },
          { kind: 'p', parts: ['If you believe a child has provided personal information to us inappropriately, contact us so we can review the matter.'] },
        ],
      },
      {
        title: '11. Changes to this policy',
        blocks: [
          { kind: 'p', parts: ['We may update this Privacy Policy when our business practices, website features or legal requirements change.'] },
          { kind: 'p', parts: ['The latest version will be published on this page with its updated date.'] },
        ],
      },
      {
        title: '12. Contact us',
        blocks: [{ kind: 'lines', items: [
          { label: 'Business', value: 'Arvessó Fragrances' },
          { label: 'Email', value: STORE_EMAIL, href: `mailto:${STORE_EMAIL}` },
          { label: 'Contact', value: 'Contact page', href: '/contact' },
          { label: 'Instagram', value: '@arvesso_fragrances', href: STORE_INSTAGRAM, external: true },
        ] }],
      },
    ],
  },
  terms: {
    title: 'Terms & conditions',
    updated: '15 November 2026',
    intro: [
      ['Welcome to Arvessó Fragrances.'],
      ['These Terms & Conditions apply when you access our website or purchase products from us. By placing an order, you agree to these terms, subject to your rights under applicable New Zealand law.'],
      ['Please read these terms before making a purchase.'],
    ],
    sections: [
      {
        title: '1. About our business',
        blocks: [
          { kind: 'p', parts: ['Arvessó Fragrances operates as an independent online fragrance retailer.'] },
          { kind: 'p', parts: ['We offer fragrances from a range of established third-party brands.'] },
          { kind: 'p', parts: ['Unless expressly stated otherwise, we are not the manufacturer of the products listed on our website and are not affiliated with, endorsed by or officially connected to the individual fragrance brands.'] },
          { kind: 'p', parts: ['All brand names, trademarks and product names belong to their respective owners.'] },
        ],
      },
      {
        title: '2. Product information',
        blocks: [
          { kind: 'p', parts: ['We aim to ensure product descriptions, photographs, sizes, prices and other information are accurate and up to date.'] },
          { kind: 'p', parts: ['Product packaging, presentation and manufacturer designs may occasionally vary.'] },
          { kind: 'p', parts: ['Customers should review the product description, size, concentration and other relevant details before purchasing.'] },
          { kind: 'p', parts: ['If you have a question about a product, please contact us before placing your order.'] },
        ],
      },
      {
        title: '3. Product authenticity',
        blocks: [
          { kind: 'p', parts: ['We intend to offer genuine branded fragrance products sourced through legitimate supply channels.'] },
          { kind: 'p', parts: ['We do not knowingly offer counterfeit products.'] },
          { kind: 'p', parts: ['If you have a concern about the authenticity or condition of an item purchased from us, please contact us with your order details so we can investigate.'] },
        ],
      },
      {
        title: '4. Prices and payment',
        blocks: [
          { kind: 'p', parts: ['All prices displayed on our website are shown in New Zealand dollars (NZD).'] },
          { kind: 'p', parts: ['Applicable delivery charges will be displayed during checkout.'] },
          { kind: 'p', parts: ['Payment must be completed using the payment methods made available at checkout.'] },
          { kind: 'p', parts: ['Payments may be processed through third-party providers, including PayPal.'] },
          { kind: 'p', parts: ['We do not receive or store your full payment card details through our own website checkout unless expressly stated.'] },
          { kind: 'p', parts: ['We reserve the right to correct genuine pricing or listing errors. If an error affects an order you have placed, we will contact you before taking any further action.'] },
        ],
      },
      {
        title: '5. Placing an order',
        blocks: [
          { kind: 'p', parts: ['When you submit an order, you are making an offer to purchase the selected products.'] },
          { kind: 'p', parts: ['An order confirmation acknowledges that we have received your order. It does not necessarily mean that the order has been accepted or dispatched.'] },
          { kind: 'p', parts: ['We may need to contact you if:'] },
          { kind: 'ul', items: [
            ['A product is unavailable.'],
            ['Payment cannot be confirmed.'],
            ['Delivery information is incomplete.'],
            ['There is a genuine pricing or listing error.'],
            ['We identify a suspected fraudulent transaction.'],
          ] },
          { kind: 'p', parts: ['If we cannot fulfil an order after payment has been received, we will arrange an appropriate refund.'] },
        ],
      },
      {
        title: '6. Availability and stock',
        blocks: [
          { kind: 'p', parts: ['Product availability may change without notice.'] },
          { kind: 'p', parts: ['Although we aim to keep our website updated, an item may occasionally become unavailable between the time it is displayed and the time an order is processed.'] },
          { kind: 'p', parts: ['If an item you have purchased cannot be supplied, we will contact you to discuss an appropriate resolution, including a refund where applicable.'] },
        ],
      },
      {
        title: '7. Shipping and delivery',
        blocks: [
          { kind: 'p', parts: ['We currently intend to accept orders for delivery within New Zealand only.'] },
          { kind: 'p', parts: ['Our estimated delivery timeframe is 3–7 business days, subject to the delivery location and circumstances affecting delivery.'] },
          { kind: 'p', parts: ['Delivery within New Zealand is $15. Orders over $100 ship free. The delivery charge is shown at checkout.'] },
          { kind: 'p', parts: ['Customers are responsible for providing accurate delivery information.'] },
          { kind: 'p', parts: ['For more information, please refer to our ', { label: 'Shipping & delivery', href: '/shipping' }, ' page.'] },
        ],
      },
      {
        title: '8. Returns and refunds',
        blocks: [
          { kind: 'p', parts: ['Our voluntary change-of-mind policy allows eligible unopened products to be returned within 14 calendar days of delivery.'] },
          { kind: 'p', parts: ['Products must remain unused, unopened and in their original sealed packaging.'] },
          { kind: 'p', parts: ['This voluntary policy operates alongside, and does not replace or restrict, your rights under the Consumer Guarantees Act 1993.'] },
          { kind: 'p', parts: ['For full details, please refer to our ', { label: 'Returns & refunds', href: '/returns' }, ' page.'] },
        ],
      },
      {
        title: '9. Consumer rights',
        blocks: [
          { kind: 'p', parts: ['Nothing in these Terms & Conditions is intended to exclude, restrict or modify any rights or remedies that cannot legally be excluded under New Zealand law.'] },
          { kind: 'p', parts: ['Where applicable, the Consumer Guarantees Act 1993 and Fair Trading Act 1986 protect customers purchasing from businesses operating in New Zealand.'] },
        ],
      },
      {
        title: '10. Website use',
        blocks: [
          { kind: 'p', parts: ['You agree to use our website lawfully and responsibly.'] },
          { kind: 'p', parts: ['You must not:'] },
          { kind: 'ul', items: [
            ['Attempt to interfere with website security or functionality.'],
            ['Use the website for fraudulent or unlawful activities.'],
            ['Attempt to gain unauthorised access to accounts or systems.'],
            ['Copy or misuse website content, branding or materials without permission.'],
          ] },
          { kind: 'p', parts: ['We may restrict access where reasonably necessary to protect our website, customers or business operations.'] },
        ],
      },
      {
        title: '11. Intellectual property',
        blocks: [
          { kind: 'p', parts: ['Website content, including original text, graphics, logos, design elements and other materials, belongs to Arvessó Fragrances or its respective licensors unless otherwise stated.'] },
          { kind: 'p', parts: ['Third-party product names, brand logos and trademarks remain the property of their respective owners.'] },
          { kind: 'p', parts: ['Their appearance on our website is for product identification and retail purposes and does not imply an official partnership or endorsement.'] },
        ],
      },
      {
        title: '12. Limitation of liability',
        blocks: [
          { kind: 'p', parts: ['To the extent permitted by New Zealand law, we are not responsible for losses arising from circumstances outside our reasonable control.'] },
          { kind: 'p', parts: ['Nothing in this section excludes liability or remedies that cannot legally be excluded or limited, including rights under applicable consumer protection laws.'] },
        ],
      },
      {
        title: '13. Privacy',
        blocks: [
          { kind: 'p', parts: ['Your use of our website is also subject to our ', { label: 'Privacy', href: '/privacy' }, ' policy, which explains how we collect, use and protect personal information.'] },
        ],
      },
      {
        title: '14. Changes to these terms',
        blocks: [
          { kind: 'p', parts: ['We may update these Terms & Conditions from time to time to reflect changes to our business, website or legal requirements.'] },
          { kind: 'p', parts: ['The latest version will be published on this page.'] },
          { kind: 'p', parts: ['Any changes will not remove rights that have already accrued to customers or override applicable consumer law.'] },
        ],
      },
      {
        title: '15. Governing law',
        blocks: [
          { kind: 'p', parts: ['These Terms & Conditions are governed by the laws of New Zealand.'] },
          { kind: 'p', parts: ['Any disputes will be dealt with in accordance with applicable New Zealand law.'] },
        ],
      },
      {
        title: '16. Contact information',
        blocks: [{ kind: 'lines', items: [
          { label: 'Business', value: 'Arvessó Fragrances' },
          { label: 'Email', value: STORE_EMAIL, href: `mailto:${STORE_EMAIL}` },
          { label: 'Contact', value: 'Contact page', href: '/contact' },
          { label: 'Instagram', value: '@arvesso_fragrances', href: STORE_INSTAGRAM, external: true },
        ] }],
      },
    ],
  },
};

function PolicyBlockView({ block }: { block: PolicyBlock }) {
  if (block.kind === 'p') return <p><PolicyInlines parts={block.parts}/></p>;
  if (block.kind === 'lines') {
    return <div className="policy-contact">{block.items.map((item) => <div key={item.label}><strong>{item.label}</strong>{item.href ? item.external ? <a href={item.href} target="_blank" rel="noreferrer">{item.value}</a> : item.href.startsWith('mailto:') ? <a href={item.href}>{item.value}</a> : <Link href={item.href}>{item.value}</Link> : <span>{item.value}</span>}</div>)}</div>;
  }
  const ListTag = block.kind === 'ol' ? 'ol' : 'ul';
  return <ListTag>{block.items.map((item, index) => <li key={index}><PolicyInlines parts={item}/></li>)}</ListTag>;
}

function StoreInfoPage({ page }: { page: StoreInfoPageKey }) {
  const configQuery = useQuery({
    queryKey: ['paypal-checkout-config'],
    queryFn: loadPayPalCheckoutConfig,
    enabled: page === 'shipping' || page === 'terms',
    retry: false,
  });
  const content = storeInfoPages[page];
  const chargeLine = configQuery.data
    ? `Delivery within New Zealand is ${money(configQuery.data.shippingMinor)}. ${configQuery.data.freeShippingThresholdMinor > 0 ? `Orders over ${money(configQuery.data.freeShippingThresholdMinor)} ship free. ` : ''}The delivery charge is shown at checkout${page === 'shipping' ? ', before you pay' : ''}.`
    : null;
  const sections = content.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      if (!chargeLine || block.kind !== 'p' || typeof block.parts[0] !== 'string' || !block.parts[0].startsWith('Delivery within New Zealand is')) return block;
      return { ...block, parts: [chargeLine] };
    }),
  }));
  return <main className="wrap policy-page">
    <div className="page-head"><span className="eyebrow">Arvessó Fragrances{content.updated ? ` · Updated ${content.updated}` : ''}</span><h1>{content.title}</h1>{content.intro.map((parts, index) => <p key={index}><PolicyInlines parts={parts}/></p>)}</div>
    <div className="policy-content">{sections.map((section) => <section className="policy-section" key={section.title}><h2>{section.title}</h2>{section.blocks.map((block, index) => <PolicyBlockView key={index} block={block}/>)}</section>)}</div>
  </main>;
}

function Shell({ children, cart }: { children: ReactNode; cart: CartApi }) {
  const [path] = useLocation();
  const isAdmin = path.startsWith('/admin');
  return <><Header cart={cart}/>{children}{!isAdmin && <Footer/>}</>;
}

function ProductImage({ product, className = '' }: { product?: Product | null; className?: string }) {
  return <div className={`product-art ${className}`} data-testid={product ? `img-product-${product.id}` : 'img-product-placeholder'}>
    {product?.imageUrl ? <img src={product.imageUrl} alt={`${product.brand} ${product.name}`} loading="lazy"/> :
      <div className="art-placeholder"><span className="art-label">{product ? 'Image not supplied' : 'A considered collection'}</span></div>}
  </div>;
}

const isSample = (variant: ProductVariant) => variant.sku.startsWith('SAMPLE-');
const bottleVariants = (product: Product) => product.variants.filter((variant) => !isSample(variant));

function ProductCard({ product }: { product: Product }) {
  const cheapest = [...bottleVariants(product)].sort((a, b) => a.priceMinor - b.priceMinor)[0];
  return <Link href={`/product/${product.slug}`} className="product-card" data-testid={`card-product-${product.id}`}>
    <ProductImage product={product}/>
    <div className="product-meta"><div><p className="product-brand">{product.brand}</p><h3 className="product-name">{product.name}</h3><p className="product-size">{product.scentFamily || product.audience}</p></div>
      {cheapest && <span className="product-price">{money(cheapest.priceMinor)}</span>}</div>
  </Link>;
}

function ProductSkeletons() { return <div className="product-grid">{[1,2,3,4].map((n) => <div className="loading-card skeleton" key={n}/>)}</div>; }
function QueryError({ retry }: { retry: () => void }) { return <div className="empty-state"><div className="empty-mark"><CircleHelp size={21}/></div><h2>We couldn’t reach the collection</h2><p>Please try again. Your browsing session is safe.</p><button className="button button-outline" onClick={retry} data-testid="button-retry">Try again</button></div>; }
function EmptyCatalog({ admin = false }: { admin?: boolean }) { return <div className="empty-state"><div className="empty-mark"><Package size={20}/></div><h2>{admin ? 'Your collection begins here' : 'A collection in the making'}</h2><p>{admin ? 'There are no fragrance records yet. Add the first real product when you are ready.' : 'We are preparing the first edit. Check back soon for fragrances selected with care.'}</p>{admin && <Link className="button button-outline" href="/admin/products">Add a fragrance</Link>}</div>; }

function HomePage() {
  const { data, isLoading, isError, refetch } = useGetProducts({ page: 1, pageSize: 8, sort: 'newest' });
  const featured = useMemo(() => {
    if (!data?.items.length) return [];
    const marked = data.items.filter((item) => item.featured);
    return marked.length ? marked : data.items;
  }, [data]);
  return <>
    <section className="hero scroll-reveal"><div className="hero-image"/><div className="hero-content"><span className="eyebrow">Independent fragrance · Aotearoa</span><h1>Find the note<br/>that stays.</h1><p>A considered edit of fragrance for the quietly distinctive. Discover a scent that feels like your own.</p><Link className="button" href="/shop">Explore fragrance <ArrowRight size={14}/></Link></div></section>
    <section className="intro scroll-reveal" id="approach"><span className="eyebrow">The Arvessó point of view</span><h2>Close to the skin.<br/>Never ordinary.</h2><p>We believe a fragrance should be discovered, not prescribed. Our edit brings together independent perfumery and enduring classics, chosen for character, craft and the way they make you feel.</p></section>
    <section className="section wrap scroll-reveal"><div className="section-top"><div><span className="eyebrow">The collection</span><h2 className="section-heading">Selected for you</h2></div><Link className="text-link eyebrow" href="/shop">View the collection <ArrowRight size={13}/></Link></div>
      {isLoading ? <ProductSkeletons/> : isError ? <QueryError retry={() => void refetch()}/> : featured.length ? <div className="product-grid">{featured.slice(0,4).map((p) => <ProductCard key={p.id} product={p}/>)}</div> : <EmptyCatalog/>}
    </section>
    <section className="quiet-band scroll-reveal"><div className="wrap quiet-band-inner"><div><span className="eyebrow">An invitation to explore</span><h2>Fragrance is personal.<br/>Finding yours can be, too.</h2></div><div><p>Take your time with the notes, the materials and the feeling each fragrance leaves behind. We’re here for the discovery.</p><Link className="button button-outline" href="/shop">Browse all fragrances <ArrowRight size={14}/></Link></div></div></section>
    <div className="wrap service-strip scroll-reveal"><div className="service-item"><Truck size={17}/><b>Thoughtful delivery</b><p>Clear, careful shipping from New Zealand.</p></div><div className="service-item"><ShieldCheck size={17}/><b>Chosen with care</b><p>Real fragrance records and details, always.</p></div><div className="service-item"><CircleHelp size={17}/><b>Here to help</b><p>Guidance for your next considered scent.</p></div></div>
  </>;
}

function ShopPage() {
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState('');
  const [audience, setAudience] = useState('');
  const [sort, setSort] = useState<'newest'|'price-asc'|'price-desc'|'name'>('newest');
  const [brands, setBrands] = useState<string[]>([]);
  useEffect(() => {
    void fetch('/api/products/brands').then(async (response) => {
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body)) setBrands(body.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
    });
  }, []);
  const { data, isLoading, isError, refetch } = useGetProducts({ q: q || undefined, brand: brand || undefined, audience: audience || undefined, sort, page: 1, pageSize: 48 }, { query: { placeholderData: (previous) => previous } });
  return <main className="wrap"><div className="page-head"><span className="eyebrow">The Arvessó edit</span><h1>Fragrance</h1><p>Explore an evolving collection of distinctive fragrance. Search by name, brand or the notes you love.</p></div>
    <div className="catalog-tools"><label style={{position:'relative',flex:1}}><Search size={15} style={{position:'absolute',left:13,top:14,color:'#77736b'}}/><input className="field" style={{paddingLeft:38}} value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search name, brand or notes" aria-label="Search fragrances" data-testid="input-search-products"/></label>
      <select className="select brand-filter" value={brand} onChange={(e)=>setBrand(e.target.value)} aria-label="Filter by brand" data-testid="select-brand"><option value="">All brands</option>{brands.map((name) => <option key={name} value={name}>{name}</option>)}</select>
      <select className="select" value={audience} onChange={(e)=>setAudience(e.target.value)} aria-label="Filter by audience" data-testid="select-audience"><option value="">All audiences</option><option value="women">Women</option><option value="men">Men</option><option value="unisex">Unisex</option></select>
      <select className="select" value={sort} onChange={(e)=>setSort(e.target.value as typeof sort)} aria-label="Sort collection" data-testid="select-sort"><option value="newest">Recently added</option><option value="name">Name</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select>
    </div>
    {isLoading ? <ProductSkeletons/> : isError ? <QueryError retry={() => void refetch()}/> : data?.items.length ? <><p className="eyebrow" style={{marginBottom:20}}>{data.total} {data.total === 1 ? 'fragrance' : 'fragrances'}</p><div className="product-grid">{data.items.map((product) => <ProductCard key={product.id} product={product}/>)}</div></> : <EmptyCatalog/>}
  </main>;
}

function SamplesPage({ cart }: { cart: CartApi }) {
  const { data, isLoading, isError, refetch } = useGetProducts({ page: 1, pageSize: 48, sort: 'name' });
  const [added, setAdded] = useState<number | null>(null);
  const samples = (data?.items ?? []).flatMap((product) => {
    const sample = product.variants.find((variant) => isSample(variant));
    const inStock = bottleVariants(product).some((variant) => variant.stock > 0) && (sample?.stock ?? 0) > 0;
    return sample && inStock ? [{ product, sample }] : [];
  });
  return <main className="wrap"><div className="page-head"><span className="eyebrow">2 ml · $7</span><h1>Samples</h1><p>Every fragrance in stock is also available as a 2 ml sample for $7. The same scent, a smaller amount, so you can meet it before a full bottle.</p></div>
    {isLoading ? <ProductSkeletons/> : isError ? <QueryError retry={() => void refetch()}/> : samples.length ? <div className="product-grid">{samples.map(({ product, sample }) => <article className="product-card" key={product.id} data-testid={`card-sample-${product.id}`}><ProductImage product={product}/><div className="product-meta"><div><p className="product-brand">{product.brand}</p><h3 className="product-name">{product.name}</h3><p className="product-size">2 ml sample</p></div><span className="product-price">{money(sample.priceMinor)}</span></div><button className="button button-small" style={{marginTop:16}} onClick={() => { cart.add(product, sample); setAdded(product.id); }} data-testid={`button-add-sample-${product.id}`}>{added === product.id ? 'Added to bag' : 'Add sample'}</button></article>)}</div> : <div className="empty-state"><div className="empty-mark"><Package size={20}/></div><h2>Samples follow the inventory</h2><p>When a fragrance is in stock, its 2 ml sample appears here for $7.</p></div>}
  </main>;
}

function productPhotos(product: Product) {
  return [...new Set([product.imageUrl, ...(product.imageUrls ?? [])].filter((url): url is string => Boolean(url)))];
}

function ProductGallery({ product }: { product: Product }) {
  const photos = productPhotos(product);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const photo = photos[active] ?? null;
  if (!photo) return <ProductImage product={product} className="detail-image"/>;
  return <div className="detail-gallery">
    <button type="button" className="product-art detail-image gallery-open" onClick={() => setOpen(true)} aria-label="Open photo and zoom" data-testid="button-open-photo">
      <img src={photo} alt={`${product.brand} ${product.name}`}/>
      <span className="zoom-hint"><ZoomIn size={14}/> Zoom</span>
    </button>
    {photos.length > 1 && <div className="photo-thumbs">{photos.map((url, index) => <button type="button" key={url} className={index === active ? 'selected' : ''} onClick={() => setActive(index)} aria-label={`Photo ${index + 1}`} aria-pressed={index === active}><img src={url} alt=""/></button>)}</div>}
    {open && <PhotoZoom photos={photos} index={active} name={`${product.brand} ${product.name}`} onIndex={setActive} onClose={() => setOpen(false)}/>}
  </div>;
}

function PhotoZoom({ photos, index, name, onIndex, onClose }: { photos: string[]; index: number; name: string; onIndex: (index: number) => void; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const changeScale = (next: number) => {
    const value = Math.min(4, Math.max(1, next));
    setScale(value);
    if (value === 1) setOffset({ x: 0, y: 0 });
  };
  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, [index]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') onIndex((index + 1) % photos.length);
      if (event.key === 'ArrowLeft') onIndex((index - 1 + photos.length) % photos.length);
    };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKey); };
  }, [index, onClose, onIndex, photos.length]);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      changeScale(scale + (event.deltaY < 0 ? 0.25 : -0.25));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [scale]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name} photos`}>
    <div className="lightbox-bar">
      <span>{index + 1} / {photos.length}</span>
      <div>
        <button type="button" aria-label="Zoom out" onClick={() => changeScale(scale - 0.5)}><Minus size={16}/></button>
        <button type="button" aria-label="Zoom in" onClick={() => changeScale(scale + 0.5)}><Plus size={16}/></button>
        {photos.length > 1 && <button type="button" aria-label="Previous photo" onClick={() => onIndex((index - 1 + photos.length) % photos.length)}><ArrowLeft size={16}/></button>}
        {photos.length > 1 && <button type="button" aria-label="Next photo" onClick={() => onIndex((index + 1) % photos.length)}><ArrowRight size={16}/></button>}
        <button type="button" aria-label="Close photos" onClick={onClose}><X size={16}/></button>
      </div>
    </div>
    <div
      className="lightbox-stage"
      ref={stage}
      onPointerDown={(event) => { if (scale <= 1) return; drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (!drag.current) return; setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => changeScale(scale === 1 ? 2 : 1)}
    >
      <img src={photos[index]} alt={name} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}/>
    </div>
  </div>;
}

function ProductPageView({ cart }: { cart: CartApi }) {
  const { slug = '' } = useParams<{slug:string}>();
  const { data: product, isLoading, isError, refetch } = useGetProduct(slug);
  const [selected, setSelected] = useState<number | null>(null);
  const [added, setAdded] = useState(false);
  useEffect(()=>{ setSelected(null); setAdded(false); },[slug]);
  if (isLoading) return <main className="wrap detail-grid"><div className="skeleton loading-card"/><div className="skeleton" style={{height:400}}/></main>;
  if (isError || !product) return <main className="wrap" style={{padding:'60px 0'}}><QueryError retry={()=>void refetch()}/></main>;
  const bottles = bottleVariants(product);
  const sample = product.variants.find((item) => isSample(item));
  const variant = bottles.find((item)=>item.id === selected) || bottles[0];
  return <main className="wrap">
    <div style={{paddingTop:30}}><Link href="/shop" className="eyebrow"><ArrowLeft size={13}/> Back to fragrance</Link></div>
    <div className="detail-grid"><ProductGallery key={product.slug} product={product}/><div className="detail-info"><span className="detail-brand">{product.brand}</span><h1>{product.name}</h1><p className="detail-description">{product.description}</p>
      <div className="detail-price">{variant ? money(variant.priceMinor) : 'Price unavailable'}</div>
      <span className="eyebrow">Choose a size</span><div className="variant-list">{bottles.map((item)=> <button key={item.id} onClick={()=>{setSelected(item.id);setAdded(false);}} className={`variant-option ${variant?.id===item.id?'selected':''}`} aria-pressed={variant?.id===item.id} data-testid={`button-variant-${item.id}`}>{item.size}</button>)}</div>
      <button className="button" disabled={!variant || variant.stock < 1} onClick={()=>{if(variant){cart.add(product,variant);setAdded(true);}}} data-testid="button-add-to-cart">{variant?.stock===0?'Currently unavailable':added?<><Check size={15}/> Added to bag</>:<>Add to bag <ArrowRight size={14}/></>}</button>
      {sample && sample.stock > 0 && <button className="button button-outline" style={{marginTop:12}} onClick={()=>cart.add(product, sample)} data-testid="button-add-sample">Add a 2 ml sample · {money(sample.priceMinor)}</button>}
      {variant && variant.stock > 0 && variant.stock <= 3 && <p className="product-size">Only {variant.stock} remaining</p>}
      <div className="detail-notes"><div><span>Audience</span><strong>{product.audience}</strong></div>{product.concentration && <div><span>Concentration</span><strong>{product.concentration}</strong></div>}{product.scentFamily && <div><span>Scent family</span><strong>{product.scentFamily}</strong></div>}{product.notes?.length ? <div><span>Notes</span><strong>{product.notes.join(' · ')}</strong></div>:null}</div>
    </div></div>
    <ProductFeedback key={product.slug} slug={product.slug}/>
  </main>;
}

type FragranceFeedback = {
  likes: number;
  dislikes: number;
  mine: 'like' | 'dislike' | null;
  reviews: { id: number; authorName: string; body: string; createdAt: string; mine: boolean }[];
};

function ProductFeedback({ slug }: { slug: string }) {
  const { isLoaded, isSignedIn } = useUser();
  const isAdmin = useAdminAccess();
  const [feedback, setFeedback] = useState<FragranceFeedback | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = async (fillText: boolean) => {
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}/feedback`, { credentials: 'include' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body !== 'object' || !('reviews' in body) || !Array.isArray(body.reviews)) return;
    const data = body as FragranceFeedback;
    setFeedback(data);
    if (fillText) setText(data.reviews.find((review) => review.mine)?.body ?? '');
  };
  useEffect(() => { void load(true); }, [slug]);
  const vote = async (choice: 'like' | 'dislike') => {
    setError('');
    setMessage('');
    if (!isSignedIn) return;
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}/reaction`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: choice }),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not save that.');
      return;
    }
    await load(false);
  };
  const saveReview = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const response = await fetch(`/api/products/${encodeURIComponent(slug)}/reviews`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not save your review.');
      return;
    }
    setMessage('Review saved.');
    await load(true);
  };
  const removeReview = async (id: number) => {
    const response = await fetch(`/api/admin/reviews/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok) {
      setError('Could not remove that review.');
      return;
    }
    await load(true);
  };
  const mine = feedback?.reviews.some((review) => review.mine);
  return <section className="feedback">
    <div className="section-top"><div><span className="eyebrow">From people who tried it</span><h2 className="section-heading" style={{fontSize:42}}>Reviews</h2></div>
      <div className="reaction-row">
        <button type="button" className={`reaction ${feedback?.mine === 'like' ? 'selected' : ''}`} disabled={!isLoaded || !isSignedIn} onClick={() => void vote('like')} data-testid="button-like"><ThumbsUp size={14}/> {feedback?.likes ?? 0}</button>
        <button type="button" className={`reaction ${feedback?.mine === 'dislike' ? 'selected' : ''}`} disabled={!isLoaded || !isSignedIn} onClick={() => void vote('dislike')} data-testid="button-dislike"><ThumbsDown size={14}/> {feedback?.dislikes ?? 0}</button>
      </div>
    </div>
    {isLoaded && !isSignedIn && <p className="product-size">Sign in to like, dislike, or leave a review. <Link href="/sign-in">Sign in</Link></p>}
    {error && <div className="notice error">{error}</div>}
    {message && <div className="notice">{message}</div>}
    {isSignedIn && <form className="review-form" onSubmit={(event) => void saveReview(event)}>
      <label className="wide">{mine ? 'Update your review' : 'Your review'}<textarea className="textarea" rows={4} maxLength={600} value={text} onChange={(event) => setText(event.target.value)} placeholder="How did it wear, and who would you recommend it to?" data-testid="input-review"/></label>
      <button className="button button-small" data-testid="button-save-review">{mine ? 'Update review' : 'Post review'}</button>
    </form>}
    {feedback?.reviews.length ? <div className="review-list">{feedback.reviews.map((review) => <article className="review" key={review.id}><div><strong>{review.authorName}</strong>{review.mine && <span className="product-size"> · You</span>}<div className="product-size">{new Date(review.createdAt).toLocaleDateString('en-NZ')}</div></div><p>{review.body}</p>{isAdmin && <button type="button" className="button button-outline button-small" onClick={() => void removeReview(review.id)}>Remove</button>}</article>)}</div> : <p className="product-size">No reviews yet.</p>}
  </section>;
}

function CartPage({ cart }: {cart:CartApi}) {
  const paymentConfigQuery=useQuery({queryKey:['paypal-checkout-config'],queryFn:loadPayPalCheckoutConfig});
  const discountMinor = paymentConfigQuery.data && cart.total > paymentConfigQuery.data.discountThresholdMinor
    ? Math.round(cart.total * paymentConfigQuery.data.discountPercent / 100)
    : 0;
  const shippingMinor = deliveryForSubtotal(paymentConfigQuery.data, cart.total);
  if (!cart.entries.length) return <main className="wrap"><div className="page-head"><span className="eyebrow">Your selection</span><h1>Your bag</h1></div><EmptyCart/></main>;
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Your selection</span><h1>Your bag</h1></div><div className="cart-layout"><div>{cart.entries.map((line)=><div className="cart-line" key={line.variantId}><ProductImage product={line.product}/><div><span className="product-brand">{line.product.brand}</span><h3>{line.product.name}</h3><span className="product-size">{line.variant.size}</span><div className="quantity-control"><button aria-label="Decrease quantity" onClick={()=>cart.quantity(line.variantId,line.quantity-1)} data-testid={`button-decrease-${line.variantId}`}><Minus size={12}/></button><span>{line.quantity}</span><button aria-label="Increase quantity" onClick={()=>cart.quantity(line.variantId,line.quantity+1)} data-testid={`button-increase-${line.variantId}`}><Plus size={12}/></button></div></div><div style={{textAlign:'right'}}><strong style={{fontSize:12}}>{money(line.variant.priceMinor*line.quantity)}</strong><button className="icon-button" aria-label={`Remove ${line.product.name}`} onClick={()=>cart.remove(line.variantId)} data-testid={`button-remove-${line.variantId}`}><Trash2 size={15}/></button></div></div>)}</div>
    <aside className="summary"><h2>Order summary</h2><div className="summary-row"><span>Subtotal</span><span>{money(cart.total)}</span></div>{discountMinor > 0 && <div className="summary-row"><span>Automatic discount ({paymentConfigQuery.data?.discountPercent}%)</span><span>−{money(discountMinor)}</span></div>}<div className="summary-row"><span>Delivery</span><span>{shippingMinor === undefined ? '—' : shippingMinor === 0 ? 'Free' : money(shippingMinor)}</span></div><div className="summary-row" style={{borderTop:'1px solid #d2cdc3',paddingTop:15,fontWeight:600}}><span>Total</span><span>{shippingMinor === undefined ? money(cart.total-discountMinor) : money(cart.total-discountMinor+shippingMinor)}</span></div>{paymentConfigQuery.data && <p className="product-size">Delivery is {money(paymentConfigQuery.data.shippingMinor)}. Orders over {money(paymentConfigQuery.data.freeShippingThresholdMinor)} ship free.</p>}<Link className="button" href="/checkout">Continue to checkout <ArrowRight size={14}/></Link><Link className="text-link eyebrow" style={{display:'block',textAlign:'center',marginTop:18}} href="/shop">Continue browsing</Link></aside></div></main>;
}
function EmptyCart(){return <div className="empty-state"><div className="empty-mark"><ShoppingBag size={20}/></div><h2>Your bag is at rest</h2><p>There’s nothing here just yet. Take a moment to explore the collection.</p><Link className="button" href="/shop">Explore fragrance</Link></div>;}

async function loadPayPalCheckoutConfig(): Promise<PayPalCheckoutConfig> {
  const response = await fetch('/api/checkout/config');
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Could not load checkout configuration (${response.status}).`;
    throw new Error(message);
  }
  if (
    typeof payload !== 'object' || payload === null ||
    !('mode' in payload) || (payload.mode !== 'sandbox' && payload.mode !== 'live') ||
    !('shippingMinor' in payload) || typeof payload.shippingMinor !== 'number' ||
    !('freeShippingThresholdMinor' in payload) || typeof payload.freeShippingThresholdMinor !== 'number' ||
    !('discountThresholdMinor' in payload) || typeof payload.discountThresholdMinor !== 'number' ||
    !('discountPercent' in payload) || typeof payload.discountPercent !== 'number' ||
    !('checkoutEnabled' in payload) || typeof payload.checkoutEnabled !== 'boolean'
  ) {
    throw new Error('Checkout configuration was not in the expected format.');
  }
  return {
    mode: payload.mode,
    shippingMinor: payload.shippingMinor,
    freeShippingThresholdMinor: payload.freeShippingThresholdMinor,
    discountThresholdMinor: payload.discountThresholdMinor,
    discountPercent: payload.discountPercent,
    checkoutEnabled: payload.checkoutEnabled,
  };
}

type CheckoutQuote = {
  subtotalMinor: number;
  automaticDiscountMinor: number;
  codeDiscountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  freeShipping: boolean;
  discountCode: string | null;
  discountSummary: string | null;
};

function CheckoutPage({ cart }: {cart:CartApi}) {
  const [form,setForm] = useState({email:'',recipientName:'',address1:'',address2:'',city:'',region:'',postcode:''});
  const [error,setError]=useState('');
  const [codeInput,setCodeInput]=useState('');
  const [quote,setQuote]=useState<CheckoutQuote|null>(null);
  const [codeError,setCodeError]=useState('');
  const [codeNote,setCodeNote]=useState('');
  const [applyingCode,setApplyingCode]=useState(false);
  const mutation=useCreatePayPalOrder();
  const paymentConfigQuery=useQuery({queryKey:['paypal-checkout-config'],queryFn:loadPayPalCheckoutConfig});
  useEffect(() => { setQuote(null); setCodeNote(''); setCodeError(''); }, [cart.total, cart.count]);
  const change=(key:keyof typeof form,value:string)=>setForm((old)=>({...old,[key]:value}));
  const applyCode=async()=>{
    setCodeError(''); setCodeNote(''); setApplyingCode(true);
    try {
      const response = await fetch('/api/checkout/quote', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ discountCode: codeInput, lines: cart.entries.map((item)=>({ variantId: item.variantId, quantity: item.quantity })) }) });
      const body: unknown = await response.json().catch(()=>null);
      if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'That code could not be applied.';
        throw new Error(message);
      }
      setQuote(body as CheckoutQuote);
      const applied = body as CheckoutQuote;
      setCodeNote(applied.discountCode ? `${applied.discountCode} applied. ${applied.discountSummary}.` : 'Code applied.');
    } catch (err) {
      setQuote(null);
      setCodeError(err instanceof Error ? err.message : 'That code could not be applied.');
    } finally {
      setApplyingCode(false);
    }
  };
  const submit=(event:FormEvent)=>{event.preventDefault();setError('');
    if (!paymentConfigQuery.data?.checkoutEnabled) {
      setError('PayPal checkout is not ready. Please try again later.');
      return;
    }
    const input:CheckoutInput={...form, requestId:crypto.randomUUID(), discountCode: quote?.discountCode ?? null, lines:cart.entries.map((item)=>({variantId:item.variantId,quantity:item.quantity}))};
    mutation.mutate({data:input},{onSuccess:(order)=>{sessionStorage.setItem('sillage-pending-paypal',JSON.stringify({orderId:order.orderId,paypalOrderId:order.paypalOrderId,cancelToken:order.cancelToken}));window.location.assign(order.approvalUrl);},onError:()=>setError('We couldn’t begin checkout. Please check your details and try again.')});
  };
  const search = new URLSearchParams(window.location.search);
  const returnedCancelled = search.has('cancel') || search.has('cancelled') || search.get('useraction') === 'cancel';
  if (returnedCancelled) return <main className="wrap"><div className="page-head"><span className="eyebrow">PayPal checkout</span><h1>Checkout cancelled</h1><p>Your approval was cancelled. We’ll release the reserved stock securely.</p></div><PayPalCancellationReturn cart={cart}/></main>;
  if (!cart.entries.length) return <main className="wrap"><div className="page-head"><span className="eyebrow">Checkout</span><h1>Your bag is empty</h1></div><EmptyCart/></main>;
  const canCheckout = paymentConfigQuery.data?.checkoutEnabled === true;
  const shippingMinor = quote?.shippingMinor ?? deliveryForSubtotal(paymentConfigQuery.data, cart.total);
  const discountMinor = quote?.automaticDiscountMinor ?? (paymentConfigQuery.data && cart.total > paymentConfigQuery.data.discountThresholdMinor
    ? Math.round(cart.total * paymentConfigQuery.data.discountPercent / 100)
    : 0);
  const codeDiscountMinor = quote?.codeDiscountMinor ?? 0;
  const orderTotal = shippingMinor === undefined ? undefined : cart.total - discountMinor - codeDiscountMinor + shippingMinor;
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Almost yours</span><h1>Checkout</h1><p>Enter your delivery details to continue to secure PayPal checkout.</p></div>
    <form className="checkout-grid" onSubmit={submit}><div className="checkout-form">
      <section className="form-section"><h2>Contact</h2><div className="form-grid"><label className="wide">Email<input className="field" type="email" required value={form.email} onChange={(e)=>change('email',e.target.value)} data-testid="input-checkout-email"/></label><label className="wide">Recipient name<input className="field" required value={form.recipientName} onChange={(e)=>change('recipientName',e.target.value)} data-testid="input-recipient-name"/></label></div></section>
      <section className="form-section"><h2>Delivery address</h2><div className="form-grid"><label className="wide">Address<input className="field" required value={form.address1} onChange={(e)=>change('address1',e.target.value)} data-testid="input-address1"/></label><label className="wide">Apartment, suite, etc. <span style={{textTransform:'none'}}>(optional)</span><input className="field" value={form.address2} onChange={(e)=>change('address2',e.target.value)} data-testid="input-address2"/></label><label>City<input className="field" required value={form.city} onChange={(e)=>change('city',e.target.value)} data-testid="input-city"/></label><label>Region<input className="field" value={form.region} onChange={(e)=>change('region',e.target.value)} data-testid="input-region"/></label><label>Postcode<input className="field" required value={form.postcode} onChange={(e)=>change('postcode',e.target.value)} data-testid="input-postcode"/></label></div></section>
      <section className="form-section"><h2>Discount code</h2><div className="form-grid"><label className="wide">Code<input className="field" value={codeInput} onChange={(e)=>setCodeInput(e.target.value.toUpperCase())} placeholder="Enter a code" autoComplete="off" data-testid="input-discount-code"/></label></div><div className="admin-actions" style={{marginTop:12}}><button type="button" className="button button-outline button-small" disabled={applyingCode || !codeInput.trim()} onClick={()=>void applyCode()} data-testid="button-apply-discount">{applyingCode ? 'Checking…' : 'Apply code'}</button>{quote?.discountCode && <button type="button" className="button button-outline button-small" onClick={()=>{ setQuote(null); setCodeInput(''); setCodeNote(''); setCodeError(''); }}>Remove</button>}</div>{codeNote && <div className="notice" role="status">{codeNote}</div>}{codeError && <div className="notice error" role="alert">{codeError}</div>}</section>
      {error && <div className="notice error" role="alert">{error}</div>}
      {paymentConfigQuery.isError && <div className="notice error" role="alert">{paymentConfigQuery.error.message}</div>}
      {!paymentConfigQuery.isError && paymentConfigQuery.data && !canCheckout && <div className="notice" role="status">{paymentConfigQuery.data.mode === 'live' ? 'Live checkout is disabled until the PayPal account, public HTTPS domain, shipping settings, and final store policies are ready.' : 'PayPal sandbox credentials are not configured yet.'}</div>}
      {paymentConfigQuery.data && <div className="sandbox-note"><ShieldCheck size={16}/><span><strong>{paymentConfigQuery.data.mode === 'live' ? 'PayPal live payments.' : 'PayPal sandbox checkout.'}</strong> {paymentConfigQuery.data.mode === 'live' ? 'Approved payments will be charged to the customer’s selected payment method.' : 'Sandbox transactions do not charge real money.'}</span></div>}
      <button className="button" type="submit" disabled={mutation.isPending||paymentConfigQuery.isLoading||!canCheckout} data-testid="button-paypal-checkout">{mutation.isPending?<><LoaderCircle size={15}/> Preparing checkout</>:<>Continue with PayPal <ArrowRight size={14}/></>}</button>
    </div><aside className="summary"><h2>Your order</h2>{cart.entries.map((line)=><div className="summary-row" key={line.variantId}><span>{line.product.name} · {line.variant.size} × {line.quantity}</span><span>{money(line.variant.priceMinor*line.quantity)}</span></div>)}<div className="summary-row"><span>Subtotal</span><span>{money(cart.total)}</span></div>{discountMinor > 0 && <div className="summary-row"><span>Automatic discount ({paymentConfigQuery.data?.discountPercent}%)</span><span>−{money(discountMinor)}</span></div>}{codeDiscountMinor > 0 && <div className="summary-row"><span>Code {quote?.discountCode}</span><span>−{money(codeDiscountMinor)}</span></div>}{quote?.freeShipping && <div className="summary-row"><span>Code {quote.discountCode}</span><span>Free delivery</span></div>}<div className="summary-row"><span>Shipping</span><span>{shippingMinor === undefined ? '—' : shippingMinor === 0 ? 'Free' : money(shippingMinor)}</span></div><div className="summary-row" style={{borderTop:'1px solid #d2cdc3',paddingTop:15,fontWeight:600}}><span>Total</span><span>{orderTotal === undefined ? '—' : money(orderTotal)}</span></div><p style={{fontSize:10,lineHeight:1.6,color:'#706d65'}}>Final prices are confirmed by the store at checkout.</p></aside></form>
  </main>;
}

function ConfirmationPage({cart}:{cart:CartApi}) {
  const { id = '' }=useParams<{id:string}>();
  const [,setLocation]=useLocation();
  const [params]=useState(()=>new URLSearchParams(window.location.search));
  const returnedCancelled = params.has('cancel') || params.has('cancelled') || params.get('useraction') === 'cancel';
  const pending=useMemo(()=>{try{return JSON.parse(sessionStorage.getItem('sillage-pending-paypal')||'null') as {orderId:number;paypalOrderId:string}|null;}catch{return null;}},[]);
  const token=params.get('token');
  const capture=useCapturePayPalOrder();
  const [confirmed,setConfirmed]=useState<Order|null>(null);
  const [captureError,setCaptureError]=useState('');
  useEffect(()=>{
    if(returnedCancelled || !token || !pending || capture.isPending || confirmed) return;
    capture.mutate({data:{orderId:pending.orderId,paypalOrderId:token}},{onSuccess:(order)=>{setConfirmed(order);sessionStorage.removeItem('sillage-pending-paypal');cart.clear();queryClient.invalidateQueries({queryKey:getGetAdminOrdersQueryKey()});},onError:()=>setCaptureError('PayPal returned to Arvessó Fragrances, but we could not confirm the capture. Please contact us before trying to pay again.')});
  },[token,pending,returnedCancelled]);
  const openId=confirmed?.orderNumber || confirmed?.id?.toString() || id;
  if (returnedCancelled) return <main className="wrap"><div className="page-head"><span className="eyebrow">PayPal checkout</span><h1>Checkout cancelled</h1><p>Your approval was cancelled. We’ll release the reserved stock securely.</p></div><PayPalCancellationReturn cart={cart}/></main>;
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Order update</span><h1>{confirmed?'Thank you.':capture.isPending?'Confirming your order.':'Your order is awaiting confirmation.'}</h1><p>{confirmed?'Your PayPal capture has been confirmed by the store. We’ll send the order details to your email.':capture.isPending?'We are verifying the payment with PayPal. Please keep this page open.':'We have not yet confirmed a payment for this order.'}</p></div>
    {capture.isPending && <div className="notice"><LoaderCircle size={15}/> Verifying payment with PayPal…</div>}
    {captureError && <div className="notice error" role="alert">{captureError}</div>}
    {confirmed && <div className="notice success"><Check size={15}/> Payment confirmed · Order {openId} · {money(confirmed.totalMinor,confirmed.currency)}</div>}
    {!confirmed && !capture.isPending && <div className="notice">Order reference: {id}. Payment is not marked complete until the PayPal capture is confirmed.</div>}
    <Link className="button" href="/shop">Return to fragrance</Link>
  </main>;
}

function PayPalCancellationReturn({cart}:{cart:CartApi}) {
  const cancelOrder=useCancelPayPalOrder();
  const qc=useQueryClient();
  const [result,setResult]=useState<Order|null>(null);
  const [error,setError]=useState('');
  const [started,setStarted]=useState(false);
  const startedRef=useRef(false);
  const pending=useMemo(()=>{
    try { return JSON.parse(sessionStorage.getItem('sillage-pending-paypal')||'null') as {orderId:number;paypalOrderId:string;cancelToken:string}|null; }
    catch { return null; }
  },[]);
  const cancel=()=>{
    if(!pending || cancelOrder.isPending || result || startedRef.current) return;
    startedRef.current=true;
    setStarted(true);setError('');
    cancelOrder.mutate({data:{orderId:pending.orderId,cancelToken:pending.cancelToken}},{onSuccess:(order)=>{
      setResult(order);
      sessionStorage.removeItem('sillage-pending-paypal');
      void qc.invalidateQueries({queryKey:getGetAdminOrdersQueryKey()});
      void qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});
    },onError:()=>{startedRef.current=false;setError('We couldn’t confirm the cancellation yet. The reserved stock has not been reported as released. Please retry.');}});
  };
  useEffect(()=>{if(pending && !started) cancel();},[pending,started]);
  if(!pending) return <><div className="notice">There is no active PayPal reservation to cancel. No payment has been marked complete.</div><Link href="/shop" className="button">Return to fragrance</Link></>;
  return <><div className={error?'notice error':result?'notice success':'notice'} role={error?'alert':'status'}>
    {cancelOrder.isPending?<><LoaderCircle size={15}/> Confirming cancellation and releasing reserved stock…</>:result?<><Check size={15}/> Cancellation confirmed by the store. Reserved stock has been released. Order {result.orderNumber} remains {result.status}.</>:error?error:'Sending the cancellation request…'}
  </div>
  {error && <button className="button button-outline button-small" onClick={cancel} disabled={cancelOrder.isPending} data-testid="button-retry-cancel-paypal">Retry cancellation</button>}
  {!error && !result && !cancelOrder.isPending && <button className="button button-outline button-small" onClick={cancel} data-testid="button-cancel-paypal-reservation">Confirm cancellation</button>}
  {result && <Link href="/shop" className="button">Return to fragrance</Link>}</>;
}

function SignInPage() {
  return <div className="auth-clerk"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/></div>;
}
function SignUpPage() {
  return <div className="auth-clerk"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/></div>;
}
function HomeRedirect() {
  return <HomePage/>;
}
function AccountPage() {
  const { user, isLoaded } = useUser();
  const isAdmin = useAdminAccess();
  const { signOut } = useClerk();
  const { data: orders, isLoading: ordersLoading, isError: ordersError, refetch } = useQuery({
    queryKey: ['account', 'orders'],
    enabled: isLoaded && Boolean(user),
    queryFn: loadAccountOrders,
  });

  if (!isLoaded) {
    return <main className="wrap account-page"><div className="skeleton account-loading"/></main>;
  }

  if (!user) {
    return <main className="wrap account-page">
      <div className="account-heading"><span className="eyebrow">Your Arvessó account</span><h1>A more personal fragrance journey.</h1><p>Keep your details close, revisit your orders, and return to scents you love.</p></div>
      <section className="account-welcome">
        <div className="account-welcome-mark"><UserRound size={25}/></div>
        <div><span className="eyebrow">A considered experience</span><h2>Make it yours.</h2><p>Sign in to manage your details and see your Arvessó orders in one place.</p></div>
        <div className="account-actions"><Link className="button" href="/sign-in">Sign in <ArrowRight size={14}/></Link><Link className="button button-outline" href="/sign-up">Create an account</Link></div>
      </section>
      <div className="account-feature-grid">
        <AccountFeature icon={<UserRound size={18}/>} title="Your details" description="Keep your profile and contact information up to date."/>
        <AccountFeature icon={<PackageCheck size={18}/>} title="Order history" description="Review your recent fragrance orders and their status."/>
        <AccountFeature icon={<KeyRound size={18}/>} title="Account security" description="Manage your sign-in methods and security settings."/>
      </div>
      <div className="account-help"><span>New to Arvessó?</span><Link href="/shop">Explore the fragrance collection <ArrowRight size={13}/></Link></div>
    </main>;
  }

  const email = user.primaryEmailAddress?.emailAddress;
  const joined = user.createdAt
    ? new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric' }).format(user.createdAt)
    : null;

  return <main className="wrap account-page">
    <div className="account-heading"><span className="eyebrow">Your Arvessó account</span><h1>Your space.</h1><p>Your profile, orders and account settings, all together.</p></div>
    <div className="account-layout">
      <aside className="account-sidebar">
        <span className="eyebrow">My account</span>
        {isAdmin && <Link className="account-nav-link" href="/admin" data-testid="link-account-store-admin"><Package size={15}/> Store studio</Link>}
        <a className="account-nav-link active" href="#account-overview"><UserRound size={15}/> Overview</a>
        <Link className="account-nav-link" href="/account/settings"><KeyRound size={15}/> Profile & security</Link>
        <a className="account-nav-link" href="#account-orders"><PackageCheck size={15}/> My orders</a>
        <button className="account-nav-link account-nav-button" type="button" onClick={() => void signOut({ redirectUrl: basePath || '/' })}><LogOut size={15}/> Sign out</button>
        <div className="account-sidebar-note">Need a hand? We’re here to help with your fragrance journey.</div>
      </aside>
      <div className="account-content" id="account-overview">
        <section className="account-profile-card">
          <div className="account-avatar">{user.imageUrl ? <img src={user.imageUrl} alt=""/> : <span>{user.firstName?.slice(0, 1) || email?.slice(0, 1) || 'A'}</span>}</div>
          <div className="account-profile-copy"><span className="eyebrow">Welcome back</span><h2>{user.fullName || 'Arvessó customer'}</h2><p>{email || 'Add an email address in profile settings'}</p></div>
          {joined && <span className="account-member-since">Member since {joined}</span>}
        </section>

        <section className="account-section">
          <div className="account-section-heading"><div><span className="eyebrow">Your details</span><h2>Profile & security</h2></div><Link className="text-link eyebrow" href="/account/settings">Manage details <ArrowRight size={13}/></Link></div>
          <div className="account-detail-grid">
            <AccountDetail label="Email address" value={email || 'Not added'} verified={user.primaryEmailAddress?.verification?.status === 'verified'}/>
            <AccountDetail label="Name" value={user.fullName || 'Add your name'} />
            <AccountDetail label="Username" value={user.username || 'Not set'} />
            <AccountDetail label="Phone" value={user.primaryPhoneNumber?.phoneNumber || 'Not added'} />
          </div>
          <Link className="account-settings-link" href="/account/settings"><KeyRound size={17}/><span><strong>Sign-in & security settings</strong><small>Update your profile, password and sign-in methods securely with Clerk.</small></span><ArrowRight size={15}/></Link>
        </section>

        <section className="account-section" id="account-orders">
          <div className="account-section-heading"><div><span className="eyebrow">Your purchases</span><h2>Order history</h2></div><Link className="text-link eyebrow" href="/shop">Explore fragrance <ArrowRight size={13}/></Link></div>
          {ordersLoading ? <div className="skeleton account-orders-loading"/> : ordersError ? <div className="notice error">We couldn’t load your orders. <button className="text-link" type="button" onClick={() => void refetch()}>Try again</button></div> : orders?.length ? <div className="account-order-list">{orders.map((order) => <article className="account-order" key={order.orderNumber}><div><span className="eyebrow">{order.orderNumber}</span><p>{new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium' }).format(new Date(order.createdAt))}</p>{order.items.length > 0 && <p>{order.items.map((item) => `${item.name} · ${item.size} × ${item.quantity}`).join(', ')}</p>}{order.paymentMethod === 'cash' ? <p>Collected in person</p> : order.fulfillment === 'sent' ? <p>Posted{order.tracking ? ` · ${order.tracking}` : ''}{order.trackingUrl ? <> · <a href={order.trackingUrl} target="_blank" rel="noreferrer">Track on NZ Post</a></> : null}</p> : order.status === 'paid' ? <p>Paid. We will email you when it is posted.</p> : null}</div><span className={`account-order-status status-${order.status}`}>{order.status}</span><strong>{money(order.totalMinor, order.currency)}</strong></article>)}</div> : <div className="account-empty-orders"><Package size={20}/><div><strong>No orders just yet</strong><p>Your completed fragrance orders will appear here.</p></div><Link className="button button-outline button-small" href="/shop">Browse fragrances</Link></div>}
        </section>
      </div>
    </div>
  </main>;
}

type AccountOrder = {
  orderNumber: string;
  status: string;
  totalMinor: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  paymentMethod: string;
  fulfillment: string;
  tracking: string;
  trackingUrl: string;
  items: { name: string; size: string; quantity: number }[];
};

async function loadAccountOrders(): Promise<AccountOrder[]> {
  const response = await fetch('/api/account/orders');
  if (!response.ok) {
    throw new Error(`Could not load orders (${response.status}).`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every((order) =>
    typeof order === 'object' && order !== null &&
    'orderNumber' in order && typeof order.orderNumber === 'string' &&
    'status' in order && typeof order.status === 'string' &&
    'totalMinor' in order && typeof order.totalMinor === 'number' &&
    'currency' in order && typeof order.currency === 'string' &&
    'createdAt' in order && typeof order.createdAt === 'string' &&
    'paidAt' in order && (typeof order.paidAt === 'string' || order.paidAt === null) &&
    'paymentMethod' in order && typeof order.paymentMethod === 'string' &&
    'fulfillment' in order && typeof order.fulfillment === 'string' &&
    'tracking' in order && typeof order.tracking === 'string' &&
    'trackingUrl' in order && typeof order.trackingUrl === 'string' &&
    'items' in order && Array.isArray(order.items)
  )) {
    throw new Error('The orders response was not in the expected format.');
  }
  return payload;
}

function AccountFeature({icon,title,description}:{icon:ReactNode;title:string;description:string}) {
  return <article className="account-feature"><span className="account-feature-icon">{icon}</span><h2>{title}</h2><p>{description}</p></article>;
}

function AccountDetail({label,value,verified}:{label:string;value:string;verified?:boolean}) {
  return <div className="account-detail"><span>{label}</span><strong>{value}</strong>{verified && <small><Check size={12}/> Verified</small>}</div>;
}

function AccountSettingsPage() {
  const { isLoaded, user } = useUser();
  if (!isLoaded) return <main className="wrap account-page"><div className="skeleton account-loading"/></main>;
  if (!user) return <main className="wrap account-page"><div className="account-heading"><span className="eyebrow">Account settings</span><h1>Sign in to continue.</h1><p>Your profile and security settings are private to your account.</p><Link className="button" href="/sign-in">Sign in <ArrowRight size={14}/></Link></div></main>;
  return <main className="wrap account-settings-page"><div className="account-settings-heading"><Link className="text-link eyebrow" href="/account"><ArrowLeft size={13}/> Back to your account</Link><h1>Profile & security</h1></div><UserProfile routing="hash"/></main>;
}

const adminRoutes=[['/admin','Overview'],['/admin/products','Products'],['/admin/inventory','Inventory'],['/admin/orders','Orders'],['/admin/cash','Cash'],['/admin/delivery','Delivery'],['/admin/inbox','Inbox'],['/admin/discounts','Discounts']];
function AdminLayout({children}:{children:ReactNode}) {
  const [path]=useLocation();
  const {data:health,isLoading}=useHealthCheck({query:{queryKey:getHealthCheckQueryKey(),retry:1}});
  return <div className="admin-shell"><aside className="admin-side"><span className="eyebrow">Arvessó · Studio</span><nav className="admin-nav">{adminRoutes.map(([href,label])=><Link key={href} href={href} className={path===href?'active':''} data-testid={`link-admin-${label.toLowerCase()}`}>{label}<ArrowRight size={13}/></Link>)}</nav><div style={{marginTop:35,fontSize:10,color:'#77736b'}}>{isLoading?'Checking service…':health?.status==='ok'?'Store service operational':health?.status?`Service: ${health.status}`:'Service status unavailable'}</div></aside><section className="admin-main">{children}</section></div>;
}
function AdminError({error}:{error:unknown}){return <div className="notice error"><CircleHelp size={15}/> {error instanceof Error?error.message:'The admin service could not be reached. Check your sign-in and try again.'}</div>;}
function AdminOverview() {
  const {data,isLoading,isError,error,refetch}=useGetAdminDashboard({query:{queryKey:getGetAdminDashboardQueryKey()}});
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Store overview</span><h1>Good morning.</h1></div><Link className="button button-outline button-small" href="/admin/products">Manage collection</Link></div>
    {isLoading?<div className="metric-grid">{[1,2,3,4].map((i)=><div className="metric skeleton" key={i}/>)}</div>:isError?<><AdminError error={error}/><button className="button button-outline button-small" onClick={()=>void refetch()}>Retry</button></>:<>
      {data && <><div className="metric-grid"><Metric label="Products" value={data.productCount}/><Metric label="Low stock" value={data.lowStockCount}/><Metric label="Pending orders" value={data.pendingOrders}/><Metric label="Paid sales" value={money(data.paidSalesMinor)}/></div>
      <div className="metric-grid"><Metric label="Paid today" value={money(data.paidTodayMinor)}/><Metric label="To send" value={data.toSendCount}/><Metric label="Collected in person" value={data.collectedCount}/></div>
      <div className="section-top"><div><span className="eyebrow">Latest activity</span><h2 className="section-heading" style={{fontSize:34}}>Recent orders</h2></div><Link className="eyebrow" href="/admin/orders">All orders <ArrowRight size={13}/></Link></div>
      {data.recentOrders.length?<OrderTable orders={data.recentOrders}/>:<EmptyAdmin message="Orders will appear here when customers complete checkout."/>}
      </>}
    </>}
  </AdminLayout>;
}
function Metric({label,value}:{label:string;value:string|number}){return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;}
function EmptyAdmin({message}:{message:string}){return <div className="notice">{message}</div>;}
type OrderDetail = {
  id: number; orderNumber: string; email: string; recipientName: string;
  address1: string; address2: string; city: string; region: string; postcode: string;
  subtotalMinor: number; discountMinor: number; discountCode: string; shippingMinor: number; totalMinor: number; currency: string;
  paymentMethod: string; fulfillment: string; tracking: string; status: string; createdAt: string; paidAt: string | null;
  items: { name: string; brand: string; size: string; sku: string; quantity: number; unitPriceMinor: number }[];
};

function shopMail(to: string, subject: string, body: string) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;
}

function Letter({ email }: { email: { to: string; subject: string; body: string } }) {
  const [copied, setCopied] = useState(false);
  return <div className="letter-wrap">
    <span className="eyebrow">{email.to ? `To ${email.to}` : 'No email on this order'}</span>
    <strong className="letter-subject">{email.subject}</strong>
    <pre className="letter">{email.body}</pre>
    {email.to && <div className="admin-actions"><a className="button button-small" href={shopMail(email.to, email.subject, email.body)}>Open this email</a><button type="button" className="button button-outline button-small" onClick={() => { void navigator.clipboard.writeText(`To: ${email.to}\nSubject: ${email.subject}\n\n${email.body}`); setCopied(true); }}>{copied ? 'Copied' : 'Copy email'}</button></div>}
  </div>;
}

function orderHow(order: Order) {
  const pay = order.paymentMethod === 'cash' ? 'Cash' : 'PayPal';
  const send = order.fulfillment === 'sent' ? 'Sent' : order.paymentMethod === 'cash' || order.fulfillment === 'collected' ? 'Collected' : 'To send';
  return `${pay} · ${send}`;
}

function OrderTable({orders}:{orders:Order[]}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState('');
  const [sending, setSending] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [note, setNote] = useState('');
  const [letter, setLetter] = useState<{ to: string; subject: string; body: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLetter(null);
    setNote('');
    if (!selected) { setDetail(null); return; }
    let ignore = false;
    void (async () => {
      const response = await fetch(`/api/admin/orders/${selected}`, { credentials: 'include' });
      const body: unknown = await response.json().catch(() => null);
      if (ignore) return;
      if (!response.ok || !body || typeof body !== 'object' || !('items' in body)) {
        setError('Could not open this order.');
        setDetail(null);
        return;
      }
      setError('');
      setDetail(body as OrderDetail);
    })();
    return () => { ignore = true; };
  }, [selected]);
  const term = query.trim().toLowerCase();
  const shown = orders.filter((order) => {
    if (status && order.status !== status) return false;
    if (payment && order.paymentMethod !== payment) return false;
    if (sending === 'to_send' && (order.paymentMethod === 'cash' || order.fulfillment !== 'to_send')) return false;
    if (sending === 'sent' && order.fulfillment !== 'sent') return false;
    if (sending === 'collected' && order.paymentMethod !== 'cash' && order.fulfillment !== 'collected') return false;
    if (!term) return true;
    return [order.orderNumber, order.recipientName, order.email, ...order.items.map((item) => `${item.name} ${item.size}`)].join(' ').toLowerCase().includes(term);
  });
  return <>
    <div className="catalog-tools"><label style={{position:'relative',flex:1}}><Search size={15} style={{position:'absolute',left:13,top:14,color:'#77736b'}}/><input className="field" style={{paddingLeft:38}} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, fragrance or order" aria-label="Search orders" data-testid="input-search-orders"/></label>
      <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by order status"><option value="">All statuses</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="cancelled">Cancelled</option><option value="refunded">Refunded</option></select>
      <select className="select" value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Filter by payment"><option value="">Cash and PayPal</option><option value="cash">Cash</option><option value="paypal">PayPal</option></select>
      <select className="select" value={sending} onChange={(e) => setSending(e.target.value)} aria-label="Filter by delivery"><option value="">Any delivery</option><option value="to_send">To send</option><option value="sent">Sent</option><option value="collected">Collected</option></select>
    </div>
    {shown.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Order</th><th>Customer</th><th>What they ordered</th><th>How</th><th>Status</th><th>Total</th></tr></thead><tbody>{shown.map((order)=><tr key={order.id} className={selected===order.id?'selected':''}><td><button type="button" className="text-link" onClick={() => setSelected(selected===order.id?null:order.id)} data-testid={`button-order-${order.id}`}>{order.orderNumber}</button><div className="product-size">{new Date(order.createdAt).toLocaleDateString('en-NZ')}</div></td><td><strong>{order.recipientName}</strong>{order.email && <div className="product-size">{order.email}</div>}</td><td>{order.items.map((item) => `${item.name} · ${item.size} × ${item.quantity}`).join(', ') || '—'}</td><td>{orderHow(order)}</td><td><span className="status-pill">{order.status}</span></td><td>{money(order.totalMinor,order.currency)}{order.discountMinor ? <div className="product-size">−{money(order.discountMinor, order.currency)}</div> : null}</td></tr>)}</tbody></table></div> : <div className="empty-state"><h2>Nothing matches</h2><p>Try another name, fragrance, or filter.</p></div>}
    {error && <div className="notice error">{error}</div>}
    {detail && <article className="order-detail">
      <div className="admin-top"><div><span className="eyebrow">{detail.paymentMethod === 'cash' ? 'Cash, in person' : 'Paid online'} · {detail.fulfillment === 'sent' ? 'Sent' : detail.fulfillment === 'collected' ? 'Collected' : 'To send'}</span><h2>{detail.recipientName}</h2></div><button type="button" className="icon-button" aria-label="Close order" onClick={() => setSelected(null)}><X size={16}/></button></div>
      <p className="product-size">{detail.orderNumber} · {new Date(detail.createdAt).toLocaleString('en-NZ')}{detail.email ? ` · ${detail.email}` : ''}</p>
      <p>{[detail.address1, detail.address2, detail.city, detail.region, detail.postcode].filter(Boolean).join(', ')}</p>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Fragrance</th><th>Size</th><th>Qty</th><th>Price</th></tr></thead><tbody>{detail.items.map((item, index) => <tr key={`${item.sku}-${index}`}><td><strong>{item.name}</strong><div className="product-size">{item.brand} · {item.sku}</div></td><td>{item.size}</td><td>{item.quantity}</td><td>{money(item.unitPriceMinor * item.quantity, detail.currency)}</td></tr>)}</tbody></table></div>
      <div className="order-totals"><span>Subtotal</span><strong>{money(detail.subtotalMinor, detail.currency)}</strong>{detail.discountMinor > 0 && <><span>Discount{detail.discountCode ? ` ${detail.discountCode}` : ''}</span><strong>−{money(detail.discountMinor, detail.currency)}</strong></>}<span>Delivery</span><strong>{detail.shippingMinor ? money(detail.shippingMinor, detail.currency) : 'Free'}</strong><span>Total</span><strong>{money(detail.totalMinor, detail.currency)}</strong></div>
      {detail.tracking && <p className="product-size">Tracking: {detail.tracking}</p>}
      <p className="product-size">Status: {detail.status}{detail.paidAt ? ` · Paid ${new Date(detail.paidAt).toLocaleString('en-NZ')}` : ''}</p>
      {detail.status !== 'cancelled' && detail.status !== 'refunded' && detail.status !== 'failed' && <div className="cancel-order"><label>Note for the customer, optional<textarea className="textarea" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why it is cancelled, or when they can expect a refund"/></label><button type="button" className="button button-outline button-small" disabled={busy} onClick={() => void (async () => { if (!window.confirm(`Cancel ${detail.orderNumber}? Stock goes back, and you can email ${detail.recipientName}.`)) return; setBusy(true); setError(''); const response = await fetch(`/api/admin/orders/${detail.id}/cancel`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); const body: unknown = await response.json().catch(() => null); setBusy(false); if (!response.ok || !body || typeof body !== 'object' || !('email' in body)) { setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not cancel this order.'); return; } const result = body as { status: string; email: { to: string; subject: string; body: string } }; setDetail({ ...detail, status: result.status }); setLetter(result.email); await qc.invalidateQueries({ queryKey: getGetAdminOrdersQueryKey() }); await qc.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() }); })()}>Cancel order</button></div>}
      {letter && <Letter email={letter}/>}
    </article>}
  </>;
}

function ProductEditor({product,onClose}:{product?:Product;onClose:()=>void}) {
  const qc=useQueryClient();
  const create=useCreateProduct();
  const update=useUpdateProduct();
  const [error,setError]=useState('');
  const [fields,setFields]=useState({name:product?.name||'',brand:product?.brand||'',description:product?.description||'',audience:product?.audience||'',concentration:product?.concentration||'',scentFamily:product?.scentFamily||'',imageUrl:product?.imageUrl||'',imageUrls:(product?.imageUrls??[]).join('\n'),status:product?.status||'draft',featured:product?.featured||false,bestseller:product?.bestseller||false,notes:product?.notes?.join(', ')||''});
  const [variants,setVariants]=useState(()=>product?.variants.filter(v=>!v.sku.startsWith('SAMPLE-')).map(v=>({id:v.id,size:v.size,sku:v.sku,price:(v.priceMinor/100).toFixed(2),stock:String(v.stock)}))||[{id:undefined as number|undefined,size:'',sku:'',price:'',stock:'0'}]);
  const set=(key:keyof typeof fields,value:string|boolean)=>setFields((old)=>({...old,[key]:value}));
  const variantPayload=()=>variants.map(v=>({id:v.id,size:v.size,sku:v.sku,priceMinor:Math.round(Number(v.price)*100),stock:Number(v.stock)}));
  const submit=(e:FormEvent)=>{e.preventDefault();setError('');
    const imageUrls=fields.imageUrls.split('\n').map(line=>line.trim()).filter(Boolean);
    if(imageUrls.length>8){setError('Add up to 8 extra photos.');return;}
    const badLink=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol!=='http:'&&parsed.protocol!=='https:';}catch{return true;}};
    if(fields.imageUrl.trim()&&badLink(fields.imageUrl.trim())){setError('The main photo needs a full link starting with https://, or leave it blank.');return;}
    if(imageUrls.some(badLink)){setError('Each extra photo needs a full image link, one per line.');return;}
    if(variants.some(v=>!v.size.trim()||!v.sku.trim())){setError('Each size needs a name and its own code.');return;}
    if(variants.some(v=>!Number.isFinite(Number(v.price))||Number(v.price)<0||!Number.isInteger(Number(v.stock))||Number(v.stock)<0)){setError('Enter a price like 95.00 and a whole number for stock.');return;}
    const explain=(err:unknown)=>{const raw=err instanceof Error && err.message ? err.message : 'Could not save this fragrance. Check the form and try again.';return raw.startsWith('HTTP ') ? raw.slice(raw.indexOf(': ')+2) : raw;};
    if(!variants.length){setError('Keep at least one size.');return;}
    const common={name:fields.name,brand:fields.brand,description:fields.description,audience:fields.audience,concentration:fields.concentration||null,scentFamily:fields.scentFamily||null,imageUrl:fields.imageUrl||null,imageUrls,status:fields.status as ProductInput['status'],featured:fields.featured,bestseller:fields.bestseller,notes:fields.notes.split(',').map(x=>x.trim()).filter(Boolean)};
    if(product){update.mutate({id:product.id,data:{...common,variants:variantPayload()} as ProductUpdate},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetProductsQueryKey()});onClose();},onError:(err)=>setError(explain(err))});}
    else {const data:ProductInput={...common,variants:variantPayload()};create.mutate({data},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});onClose();},onError:(err)=>setError(explain(err))});}
  };
  const busy=create.isPending||update.isPending;
  return <form className="admin-form" onSubmit={submit}><div className="wide" style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><span className="eyebrow">{product?'Edit fragrance':'New fragrance'}</span><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor" data-testid="button-close-editor"><X size={17}/></button></div>
    <label>Name<input required className="field" value={fields.name} onChange={(e)=>set('name',e.target.value)} data-testid="input-product-name"/></label><label>Brand<input required className="field" value={fields.brand} onChange={(e)=>set('brand',e.target.value)} data-testid="input-product-brand"/></label>
    <label className="wide">Description<textarea className="textarea" rows={4} value={fields.description} onChange={(e)=>set('description',e.target.value)} data-testid="input-product-description"/></label>
    <label>Audience<input required className="field" value={fields.audience} onChange={(e)=>set('audience',e.target.value)} placeholder="Use the product’s actual audience" data-testid="input-product-audience"/></label><label>Concentration<input className="field" value={fields.concentration} onChange={(e)=>set('concentration',e.target.value)} data-testid="input-product-concentration"/></label>
    <label>Scent family<input className="field" value={fields.scentFamily} onChange={(e)=>set('scentFamily',e.target.value)} data-testid="input-product-family"/></label><label>Main photo URL<input className="field" value={fields.imageUrl} onChange={(e)=>set('imageUrl',e.target.value)} data-testid="input-product-image"/></label><label className="wide">More photos, one link per line<textarea className="textarea" rows={4} value={fields.imageUrls} onChange={(e)=>set('imageUrls',e.target.value)} placeholder="https://…" data-testid="input-product-photos"/></label>
    <label>Notes, separated by commas<input className="field" value={fields.notes} onChange={(e)=>set('notes',e.target.value)} data-testid="input-product-notes"/></label><label>Status<select className="select" value={fields.status} onChange={(e)=>set('status',e.target.value)} data-testid="select-product-status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
    <label><span>Featured</span><input type="checkbox" checked={fields.featured} onChange={(e)=>set('featured',e.target.checked)} data-testid="input-product-featured"/></label><label><span>Bestseller</span><input type="checkbox" checked={fields.bestseller} onChange={(e)=>set('bestseller',e.target.checked)} data-testid="input-product-bestseller"/></label>
    <div className="variant-editor wide"><span className="eyebrow">Sizes · price, code and stock</span>{variants.map((variant,index)=><div className="variant-row" key={variant.id ?? `new-${index}`}><input required className="field" placeholder="Size" value={variant.size} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,size:e.target.value}:v))} aria-label={`Variant ${index+1} size`}/><input required className="field" placeholder="Code" value={variant.sku} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,sku:e.target.value}:v))} aria-label={`Variant ${index+1} code`}/><input required type="number" min="0" step=".01" className="field" placeholder="Price NZD" value={variant.price} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,price:e.target.value}:v))} aria-label={`Variant ${index+1} price`}/><input required type="number" min="0" className="field" placeholder="Stock" value={variant.stock} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,stock:e.target.value}:v))} aria-label={`Variant ${index+1} stock`}/><button type="button" className="icon-button" aria-label="Remove size" onClick={()=>setVariants(a=>a.length>1?a.filter((_,i)=>i!==index):a)}><Trash2 size={15}/></button></div>)}<button type="button" className="button button-outline button-small" onClick={()=>setVariants(a=>[...a,{id:undefined,size:'',sku:'',price:'',stock:'0'}])} data-testid="button-add-variant"><Plus size={13}/> Add size</button></div>
    {error&&<div className="notice error wide">{error}</div>}<div className="wide admin-actions"><button className="button button-small" disabled={busy} data-testid="button-save-product">{busy?'Saving…':product?'Save changes':'Create fragrance'}</button><button type="button" className="button button-outline button-small" onClick={onClose}>Cancel</button></div>
  </form>;
}

function AdminProducts() {
  const {data:products,isLoading,isError,error,refetch}=useGetAdminProducts({query:{queryKey:getGetAdminProductsQueryKey()}});
  const [editing,setEditing]=useState<Product|null|false>(false);
  const [deletingId,setDeletingId]=useState<number|null>(null);
  const [deleteError,setDeleteError]=useState('');
  const [query,setQuery]=useState('');
  const [brand,setBrand]=useState('');
  const brands=useMemo(()=>[...new Set((products??[]).map(product=>product.brand.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),[products]);
  const shown=useMemo(()=>{
    const term=query.trim().toLowerCase();
    return (products??[]).filter((product)=>{
      if(brand && product.brand!==brand) return false;
      if(!term) return true;
      const haystack=[product.name,product.brand,product.audience,product.scentFamily??'',product.description,...(product.notes??[]),...product.variants.map(variant=>`${variant.sku} ${variant.size}`)].join(' ').toLowerCase();
      return haystack.includes(term);
    });
  },[products,query,brand]);
  const update=useUpdateProduct(); const qc=useQueryClient();
  const remove=async (product:Product)=>{
    if(!window.confirm(`Delete ${product.name}? It will leave the shop and the studio. Past orders keep their own record.`)) return;
    setDeleteError('');
    setDeletingId(product.id);
    try {
      const response=await fetch(`/api/admin/products/${product.id}`,{method:'DELETE',credentials:'include'});
      if(!response.ok){
        const body:unknown=await response.json().catch(()=>null);
        const message=body && typeof body==='object' && 'error' in body && typeof body.error==='string' ? body.error : 'Unable to delete this fragrance.';
        throw new Error(message);
      }
      await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});
      await qc.invalidateQueries({queryKey:getGetProductsQueryKey()});
      await qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});
      setEditing((current)=>current && current.id===product.id ? false : current);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unable to delete this fragrance.');
    } finally {
      setDeletingId(null);
    }
  };
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Catalogue management</span><h1>Products</h1></div><button className="button button-small" onClick={()=>setEditing(null)} data-testid="button-new-product"><Plus size={14}/> Add fragrance</button></div>
    {deleteError&&<div className="notice error">{deleteError}</div>}
    {editing!==false&&<ProductEditor product={editing||undefined} onClose={()=>setEditing(false)}/>}
    {!isLoading&&!isError&&!!products?.length&&<div className="catalog-tools"><label style={{position:'relative',flex:1}}><Search size={15} style={{position:'absolute',left:13,top:14,color:'#77736b'}}/><input className="field" style={{paddingLeft:38}} value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search name, brand, code or notes" aria-label="Search studio fragrances" data-testid="input-search-admin-products"/></label><select className="select brand-filter" value={brand} onChange={(e)=>setBrand(e.target.value)} aria-label="Filter studio by brand" data-testid="select-admin-brand"><option value="">All brands</option>{brands.map((name)=><option key={name} value={name}>{name}</option>)}</select></div>}
    {isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:shown.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>Fragrance</th><th>Variants</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>{shown.map(p=><tr key={p.id}><td><strong>{p.name}</strong><div className="product-size">{p.brand}</div></td><td>{p.variants.length}</td><td>{p.variants.filter(v=>!v.sku.startsWith('SAMPLE-')).reduce((sum,v)=>sum+v.stock,0)}</td><td><span className="status-pill">{p.status}</span></td><td><div className="admin-actions"><button className="button button-outline button-small" onClick={()=>setEditing(p)} data-testid={`button-edit-product-${p.id}`}>Edit</button><button className="button button-outline button-small" disabled={update.isPending} onClick={()=>update.mutate({id:p.id,data:{status:p.status==='published'?'draft':'published'}},{onSuccess:()=>{void qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});void qc.invalidateQueries({queryKey:getGetProductsQueryKey()});}})} data-testid={`button-toggle-publish-${p.id}`}>{p.status==='published'?'Unpublish':'Publish'}</button><button className="button button-outline button-small" disabled={deletingId===p.id} onClick={()=>void remove(p)} data-testid={`button-delete-product-${p.id}`}>{deletingId===p.id?'Deleting…':'Delete'}</button></div></td></tr>)}</tbody></table></div>:products?.length?<div className="empty-state"><h2>Nothing matches</h2><p>Try another brand or clear the search.</p></div>:<EmptyCatalog admin/>}
  </AdminLayout>;
}

function AdminInventory() {
  const {data:products,isLoading,isError,error,refetch}=useGetAdminProducts({query:{queryKey:getGetAdminProductsQueryKey()}});
  const adjust=useAdjustInventory(); const qc=useQueryClient();
  const [draft,setDraft]=useState<Record<number,{delta:string;reason:string}>>({});
  const [message,setMessage]=useState('');
  const variants=products?.flatMap(p=>p.variants.filter(v=>!v.sku.startsWith('SAMPLE-')).map(v=>({product:p,variant:v})))||[];
  const change=(id:number,key:'delta'|'reason',value:string)=>setDraft(old=>({...old,[id]:{delta:old[id]?.delta||'',reason:old[id]?.reason||'', [key]:value}}));
  const submit=(id:number)=>{const item=draft[id];if(!item||Number(item.delta)===0||item.reason.trim().length<3){setMessage('Enter a non-zero adjustment and a reason of at least three characters.');return;}setMessage('');adjust.mutate({data:{variantId:id,delta:Number(item.delta),reason:item.reason}},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});setDraft(o=>({...o,[id]:{delta:'',reason:''}}));setMessage('Stock adjustment recorded.');},onError:()=>setMessage('Stock could not be adjusted. Please check the amount and try again.')});};
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div></div>{message&&<div className="notice">{message}</div>}{isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:variants.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>Product / size</th><th>SKU</th><th>On hand</th><th>Adjust stock</th></tr></thead><tbody>{variants.map(({product,variant})=><tr key={variant.id}><td><strong>{product.name}</strong><div className="product-size">{variant.size}</div></td><td>{variant.sku}</td><td><span className={variant.stock<=3?'status-pill':''}>{variant.stock}</span></td><td><div className="admin-actions"><input className="field" style={{width:76}} type="number" value={draft[variant.id]?.delta||''} onChange={e=>change(variant.id,'delta',e.target.value)} placeholder="+ / −" aria-label={`Stock delta ${variant.id}`} data-testid={`input-stock-delta-${variant.id}`}/><input className="field" style={{width:170}} value={draft[variant.id]?.reason||''} onChange={e=>change(variant.id,'reason',e.target.value)} placeholder="Adjustment reason" aria-label={`Reason ${variant.id}`} data-testid={`input-stock-reason-${variant.id}`}/><button className="button button-outline button-small" disabled={adjust.isPending} onClick={()=>submit(variant.id)} data-testid={`button-adjust-stock-${variant.id}`}>Apply</button></div></td></tr>)}</tbody></table></div>:<EmptyCatalog admin/>}</AdminLayout>;
}
function AdminOrders(){const {data:orders,isLoading,isError,error,refetch}=useGetAdminOrders({query:{queryKey:getGetAdminOrdersQueryKey()}});return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Fulfilment</span><h1>Orders</h1></div></div>{isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:orders?.length?<OrderTable orders={orders}/>:<EmptyAdmin message="No orders yet. Customer orders will appear here after checkout."/>}</AdminLayout>;}

type StudioDiscount = {
  id: number;
  code: string;
  label: string;
  type: 'percent' | 'fixed' | 'free_shipping';
  percent: number | null;
  amountMinor: number | null;
  minSubtotalMinor: number;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  summary: string;
};

function AdminDiscounts() {
  const [codes, setCodes] = useState<StudioDiscount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ code: '', label: '', type: 'percent', percent: '10', amount: '', minSubtotal: '', usageLimit: '' });
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/discounts', { credentials: 'include' });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Discount codes could not be loaded.';
        throw new Error(message);
      }
      setCodes(Array.isArray(body) ? body as StudioDiscount[] : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discount codes could not be loaded.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const response = await fetch('/api/admin/discounts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: form.code,
        label: form.label,
        type: form.type,
        percent: form.percent,
        amount: form.amount,
        minSubtotal: form.minSubtotal,
        usageLimit: form.usageLimit,
        active: true,
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not create this code.';
      setError(message);
      return;
    }
    setForm({ code: '', label: '', type: 'percent', percent: '10', amount: '', minSubtotal: '', usageLimit: '' });
    await load();
  };
  const toggle = async (code: StudioDiscount) => {
    const response = await fetch(`/api/admin/discounts/${code.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.code,
        label: code.label,
        type: code.type,
        percent: code.percent ?? '',
        amount: code.amountMinor == null ? '' : (code.amountMinor / 100).toFixed(2),
        minSubtotal: code.minSubtotalMinor ? (code.minSubtotalMinor / 100).toFixed(2) : '',
        usageLimit: code.usageLimit ?? '',
        active: !code.active,
      }),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not update this code.';
      setError(message);
      return;
    }
    await load();
  };
  const remove = async (code: StudioDiscount) => {
    if (!window.confirm(`Delete code ${code.code}? Customers will no longer be able to use it.`)) return;
    const response = await fetch(`/api/admin/discounts/${code.id}`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok && response.status !== 204) {
      setError('Could not delete this code.');
      return;
    }
    await load();
  };
  return <AdminLayout>
    <div className="admin-top"><div><span className="eyebrow">Offers</span><h1>Discount codes</h1></div></div>
    <p className="product-size" style={{marginTop:0}}>A code can take a percent off the fragrance subtotal, a fixed New Zealand dollar amount off that subtotal, or make delivery free. The fragrance total never goes below zero.</p>
    {error && <div className="notice error">{error}</div>}
    <form className="admin-form" onSubmit={(event) => void create(event)}>
      <label>Code<input required className="field" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="WELCOME10" data-testid="input-discount-code-admin"/></label>
      <label>Private note<input className="field" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Launch offer"/></label>
      <label>What it does<select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} data-testid="select-discount-type"><option value="percent">Percent off</option><option value="fixed">Fixed amount off</option><option value="free_shipping">Free delivery</option></select></label>
      {form.type === 'percent' && <label>Percent<input required className="field" type="number" min="1" max="100" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })}/></label>}
      {form.type === 'fixed' && <label>Amount NZD<input required className="field" type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}/></label>}
      <label>Minimum spend NZD<input className="field" type="number" min="0" step="0.01" value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })} placeholder="Optional"/></label>
      <label>Use limit<input className="field" type="number" min="1" value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} placeholder="Unlimited"/></label>
      <div className="wide"><button className="button button-small" data-testid="button-create-discount">Create code</button></div>
    </form>
    {loading ? <div className="skeleton" style={{ height: 180 }}/> : codes.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Code</th><th>Offer</th><th>Minimum</th><th>Uses</th><th>Status</th><th></th></tr></thead><tbody>{codes.map((code) => <tr key={code.id}><td><strong>{code.code}</strong>{code.label && <div className="product-size">{code.label}</div>}</td><td>{code.summary}</td><td>{code.minSubtotalMinor ? money(code.minSubtotalMinor) : '—'}</td><td>{code.usedCount}{code.usageLimit ? ` / ${code.usageLimit}` : ''}</td><td><span className="status-pill">{code.active ? 'active' : 'paused'}</span></td><td><div className="admin-actions"><button type="button" className="button button-outline button-small" onClick={() => void toggle(code)}>{code.active ? 'Pause' : 'Activate'}</button><button type="button" className="button button-outline button-small" onClick={() => void remove(code)}>Delete</button></div></td></tr>)}</tbody></table></div> : <EmptyAdmin message="No discount codes yet."/>}
  </AdminLayout>;
}

type CashSale = { id: number; orderNumber: string; recipientName: string; contact: string; note: string; totalMinor: number; createdAt: string; items: { name: string; size: string; quantity: number; variantId: number | null; unitPriceMinor: number }[] };
type CashOption = { id: number; brand: string; name: string; size: string; sku: string; priceMinor: number; stock: number; sample: boolean };

function CashFragranceField({ options, value, onChange }: { options: CashOption[]; value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => String(option.id) === value);
  const term = query.trim().toLowerCase();
  const matches = options.filter((option) => !term || `${option.brand} ${option.name} ${option.size} ${option.sku}`.toLowerCase().includes(term));
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return <div className="cash-picker" ref={box}>
    <input className="field" value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search brand, name or size" aria-label="Search fragrance for this cash sale" data-testid="input-cash-search" autoComplete="off"/>
    {open && <div className="cash-results" role="listbox">{matches.length ? matches.map((option) => <button type="button" key={option.id} onClick={() => { onChange(String(option.id)); setQuery(''); setOpen(false); }} data-testid={`button-cash-option-${option.id}`}><span className="product-brand">{option.brand}</span><strong>{option.name}</strong><span className="product-size">{option.sample ? '2 ml sample' : option.size} · {option.stock} on hand</span><span className="cash-price">{money(option.priceMinor)}</span></button>) : <p className="product-size" style={{margin:0,padding:'14px'}}>No fragrance matches that search.</p>}</div>}
    {selected && <div className="cash-choice"><div><p className="product-brand" style={{margin:0}}>{selected.brand}</p><strong>{selected.name}</strong><div className="product-size">{selected.sample ? '2 ml sample' : selected.size} · {money(selected.priceMinor)} · {selected.stock} on hand</div></div><button type="button" onClick={() => onChange('')}>Clear</button></div>}
  </div>;
}

function AdminCash() {
  const qc = useQueryClient();
  const { data: products, isLoading } = useGetAdminProducts({ query: { queryKey: getGetAdminProductsQueryKey() } });
  const [form, setForm] = useState({ recipientName: '', contact: '', note: '', variantId: '', quantity: '1' });
  const [formKey, setFormKey] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sales, setSales] = useState<CashSale[]>([]);
  const [ledger, setLedger] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const editingSale = sales.find((sale) => sale.id === editingId);
  const held = new Map((editingSale?.items ?? []).filter((item) => item.variantId != null).map((item) => [item.variantId as number, item.quantity]));
  const options: CashOption[] = (products ?? []).filter((product) => product.status === 'published').flatMap((product) => product.variants.filter((variant) => variant.stock > 0 || held.has(variant.id) || variant.id === Number(form.variantId)).map((variant) => ({ id: variant.id, brand: product.brand, name: product.name, size: variant.size, sku: variant.sku, priceMinor: variant.priceMinor, stock: variant.stock + (held.get(variant.id) ?? 0), sample: variant.sku.startsWith('SAMPLE-') }))).sort((a, b) => Number(a.sample) - Number(b.sample) || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  const selected = options.find((option) => String(option.id) === form.variantId);
  const available = selected?.stock ?? 0;
  const quantity = Number(form.quantity);
  const totalMinor = selected && Number.isInteger(quantity) ? selected.priceMinor * quantity : 0;
  const ledgerTerm = ledger.trim().toLowerCase();
  const visibleSales = sales.filter((sale) => !ledgerTerm || [sale.recipientName, sale.contact, sale.note, sale.orderNumber, ...sale.items.map((item) => `${item.name} ${item.size}`)].join(' ').toLowerCase().includes(ledgerTerm));
  const resetForm = () => { setForm({ recipientName: '', contact: '', note: '', variantId: '', quantity: '1' }); setEditingId(null); setFormKey((key) => key + 1); };
  const load = async () => {
    const response = await fetch('/api/admin/cash-sales', { credentials: 'include' });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && Array.isArray(body)) setSales(body as CashSale[]);
  };
  useEffect(() => { void load(); }, []);
  const refreshStock = async () => {
    await qc.invalidateQueries({ queryKey: getGetAdminProductsQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!selected) { setError('Search for the fragrance and choose it from the list.'); return; }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) { setError('Quantity must be a whole number from 1 to 10.'); return; }
    if (quantity > available) { setError(`Only ${available} ${available === 1 ? 'is' : 'are'} on hand for that fragrance.`); return; }
    const payload = { recipientName: form.recipientName, contact: form.contact, note: form.note, variantId: Number(form.variantId), quantity };
    const response = await fetch(editingId ? `/api/admin/cash-sales/${editingId}` : '/api/admin/cash-sales', {
      method: editingId ? 'PATCH' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingId ? payload : { recipientName: payload.recipientName, contact: payload.contact, note: payload.note, lines: [{ variantId: payload.variantId, quantity: payload.quantity }] }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const text = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not save this cash sale.';
      setError(text);
      return;
    }
    resetForm();
    setMessage(editingId ? 'Cash sale updated. The stock has been adjusted.' : 'Cash sale recorded. The stock has been reduced.');
    await load();
    await refreshStock();
  };
  const editSale = (sale: CashSale) => {
    const item = sale.items[0];
    setEditingId(sale.id);
    setError('');
    setMessage('');
    setFormKey((key) => key + 1);
    setForm({ recipientName: sale.recipientName, contact: sale.contact, note: sale.note, variantId: item?.variantId ? String(item.variantId) : '', quantity: String(item?.quantity ?? 1) });
  };
  const removeSale = async (sale: CashSale) => {
    if (!window.confirm(`Delete ${sale.orderNumber}? The fragrance goes back into stock.`)) return;
    setError('');
    const response = await fetch(`/api/admin/cash-sales/${sale.id}`, { method: 'DELETE', credentials: 'include' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not delete this cash sale.');
      return;
    }
    if (editingId === sale.id) resetForm();
    setMessage('Cash sale deleted. The stock has been put back.');
    await load();
    await refreshStock();
  };
  return <AdminLayout>
    <div className="admin-top"><div><span className="eyebrow">In person</span><h1>Cash sales</h1></div></div>
    <p className="product-size" style={{marginTop:0}}>When someone pays you in cash at a meetup, record it here. It shows as a paid order, with no PayPal charge, and the bottle or sample leaves the inventory.</p>
    {error && <div className="notice error">{error}</div>}
    {message && <div className="notice">{message}</div>}
    <form className="admin-form" onSubmit={(event) => void submit(event)}>
      <label>Name<input required className="field" value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} data-testid="input-cash-name"/></label>
      <label>Phone or email<input className="field" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="Optional"/></label>
      <label className="wide">Fragrance<CashFragranceField key={formKey} options={options} value={form.variantId} onChange={(variantId) => setForm({ ...form, variantId })}/></label>
      <label>Quantity<input className="field" type="number" min="1" max="10" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} data-testid="input-cash-quantity"/></label>
      <div className="cash-total"><span className="product-size" style={{margin:0}}>{selected ? `${quantity || 0} × ${money(selected.priceMinor)}` : 'Choose a fragrance to see the total'}</span><strong>{selected ? money(totalMinor) : '—'}</strong></div>
      <label className="wide">Note<textarea className="textarea" rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Where you met, or anything you want to remember"/></label>
      <div className="wide admin-actions"><button className="button button-small" disabled={isLoading} data-testid="button-record-cash">{editingId ? 'Save cash sale' : 'Record cash payment'}</button>{editingId && <button type="button" className="button button-outline button-small" onClick={resetForm}>Cancel edit</button>}</div>
    </form>
    {sales.length ? <><div className="catalog-tools"><label style={{position:'relative',flex:1}}><Search size={15} style={{position:'absolute',left:13,top:14,color:'#77736b'}}/><input className="field" style={{paddingLeft:38,maxWidth:'none'}} value={ledger} onChange={(e) => setLedger(e.target.value)} placeholder="Search recorded sales by person, fragrance or order" aria-label="Search cash sales" data-testid="input-search-cash-sales"/></label></div>{visibleSales.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Person</th><th>Items</th><th>Total</th><th></th></tr></thead><tbody>{visibleSales.map((sale) => <tr key={sale.id}><td>{new Date(sale.createdAt).toLocaleDateString('en-NZ')}<div className="product-size">{sale.orderNumber}</div></td><td><strong>{sale.recipientName}</strong>{sale.contact && <div className="product-size">{sale.contact}</div>}{sale.note && <div className="product-size">{sale.note}</div>}</td><td>{sale.items.map((item) => `${item.name} · ${item.size} × ${item.quantity}`).join(', ')}</td><td>{money(sale.totalMinor)}</td><td><div className="admin-actions"><button type="button" className="button button-outline button-small" onClick={() => editSale(sale)}>Edit</button><button type="button" className="button button-outline button-small" onClick={() => void removeSale(sale)}>Delete</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state"><h2>Nothing matches</h2><p>Try another name or fragrance.</p></div>}</> : <EmptyAdmin message="No cash sales recorded yet."/>}
  </AdminLayout>;
}

type DeliveryOrder = { id: number; orderNumber: string; recipientName: string; email: string; address: string; totalMinor: number; shippingMinor: number; createdAt: string; tracking: string; items: { name: string; size: string; quantity: number }[] };

function AdminDelivery() {
  const [fee, setFee] = useState('15.00');
  const [freeOn, setFreeOn] = useState(true);
  const [freeOver, setFreeOver] = useState('100.00');
  const [awaiting, setAwaiting] = useState<DeliveryOrder[]>([]);
  const [sent, setSent] = useState<DeliveryOrder[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [letter, setLetter] = useState<{ to: string; subject: string; body: string } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const response = await fetch('/api/admin/delivery', { credentials: 'include' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body !== 'object' || !('awaiting' in body) || !Array.isArray(body.awaiting) || !('sent' in body) || !Array.isArray(body.sent)) {
      setError('Could not load delivery.');
      setLoading(false);
      return;
    }
    const data = body as { shippingFeeMinor: number; freeShippingThresholdMinor: number; awaiting: DeliveryOrder[]; sent: DeliveryOrder[] };
    setFee((data.shippingFeeMinor / 100).toFixed(2));
    setFreeOn(data.freeShippingThresholdMinor > 0);
    if (data.freeShippingThresholdMinor > 0) setFreeOver((data.freeShippingThresholdMinor / 100).toFixed(2));
    setAwaiting(data.awaiting);
    setSent(data.sent);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/delivery', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shippingDollars: Number(fee), freeShipping: freeOn, freeOverDollars: Number(freeOver) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not save delivery.');
      return;
    }
    setMessage('Delivery charge saved. Checkout uses it straight away.');
    await load();
  };
  const markSent = async (order: DeliveryOrder) => {
    setError('');
    setMessage('');
    const response = await fetch(`/api/admin/delivery/${order.id}/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking: notes[order.id] ?? '' }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not mark this order as sent.');
      return;
    }
    const mailed = body && typeof body === 'object' && 'emailSent' in body ? body as { emailSent: boolean; email: { to: string; subject: string; body: string } | null } : null;
    setLetter(mailed?.email ?? null);
    setMessage(mailed?.emailSent ? `${order.orderNumber} is marked sent and the customer has been emailed.` : mailed?.email ? `${order.orderNumber} is marked sent. The email was not sent automatically, so open it below.` : `${order.orderNumber} is marked sent. This order has no customer email.`);
    await load();
  };
  const saveTracking = async (order: DeliveryOrder) => {
    setError('');
    setMessage('');
    const response = await fetch(`/api/admin/delivery/${order.id}/tracking`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking: edits[order.id] ?? order.tracking }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not update this tracking note.');
      return;
    }
    const mailed = body && typeof body === 'object' && 'emailSent' in body ? body as { emailSent: boolean; email: { to: string; subject: string; body: string } | null } : null;
    setLetter(mailed?.email ?? null);
    setMessage(mailed?.emailSent ? `${order.orderNumber} tracking was updated and emailed.` : mailed?.email ? `${order.orderNumber} tracking was saved. Open the email below to send it yourself.` : `${order.orderNumber} tracking was saved.`);
    await load();
  };
  return <AdminLayout>
    <div className="admin-top"><div><span className="eyebrow">New Zealand</span><h1>Delivery</h1></div></div>
    <p className="product-size" style={{marginTop:0}}>Keep one flat courier charge for the whole country. Orders still show the amount at checkout before anyone pays. Cash meetups stay separate and are not posted. Marking an order sent emails the customer when mail is connected.</p>
    {error && <div className="notice error">{error}</div>}
    {message && <div className="notice">{message}</div>}
    {letter && <Letter email={letter}/>}
    <form className="admin-form" onSubmit={(event) => void save(event)}>
      <label>Delivery charge (NZD)<input required className="field" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} data-testid="input-delivery-fee"/></label>
      <label>Free when the order is over<input className="field" inputMode="decimal" value={freeOver} disabled={!freeOn} onChange={(e) => setFreeOver(e.target.value)} data-testid="input-delivery-free"/></label>
      <label className="wide" style={{display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={freeOn} onChange={(e) => setFreeOn(e.target.checked)}/> Free delivery over that amount</label>
      <div className="wide"><button className="button button-small" data-testid="button-save-delivery">Save delivery</button></div>
    </form>
    <div className="section-top"><div><span className="eyebrow">To post</span><h2 className="section-heading" style={{fontSize:34}}>Paid orders</h2></div></div>
    {loading ? <div className="skeleton" style={{height:180}}/> : awaiting.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Order</th><th>Send to</th><th>Items</th><th>Tracking</th></tr></thead><tbody>{awaiting.map((order) => <tr key={order.id}><td>{order.orderNumber}<div className="product-size">{new Date(order.createdAt).toLocaleDateString('en-NZ')} · {money(order.totalMinor)}</div></td><td><strong>{order.recipientName}</strong><div className="product-size">{order.address}</div><div className="product-size">{order.email}</div></td><td>{order.items.map((item) => `${item.name} · ${item.size} × ${item.quantity}`).join(', ')}</td><td><div className="admin-actions"><input className="field" style={{width:180}} value={notes[order.id] ?? ''} onChange={(e) => setNotes((current) => ({ ...current, [order.id]: e.target.value }))} placeholder="Courier or tracking note"/><button type="button" className="button button-outline button-small" onClick={() => void markSent(order)}>Mark sent</button></div></td></tr>)}</tbody></table></div> : <EmptyAdmin message="No paid orders are waiting to be posted."/>}
    {sent.length > 0 && <div className="table-wrap" style={{marginTop:24}}><table className="data-table"><thead><tr><th>Sent</th><th>Person</th><th>Tracking</th></tr></thead><tbody>{sent.map((order) => <tr key={order.id}><td>{order.orderNumber}</td><td>{order.recipientName}</td><td><div className="admin-actions"><input className="field" style={{width:180}} value={edits[order.id] ?? order.tracking} onChange={(e) => setEdits((current) => ({ ...current, [order.id]: e.target.value }))} placeholder="Tracking number"/><button type="button" className="button button-outline button-small" onClick={() => void saveTracking(order)}>Save and email</button></div></td></tr>)}</tbody></table></div>}
  </AdminLayout>;
}

const messageKinds: Record<string, string> = { suggestion: 'Suggestion', idea: 'Idea', purchase: 'Fragrance request', report: 'Report' };

function CustomerMessagePage({ mode }: { mode: 'request' | 'report' }) {
  const { isLoaded, user } = useUser();
  const [form, setForm] = useState({ kind: mode === 'report' ? 'report' : 'purchase', name: '', email: '', topic: 'An order', body: '' });
  const [filled, setFilled] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [letter, setLetter] = useState<{ to: string; subject: string; body: string } | null>(null);
  useEffect(() => {
    if (!isLoaded || filled) return;
    setForm((current) => ({
      ...current,
      name: user?.fullName || current.name,
      email: user?.primaryEmailAddress?.emailAddress || current.email,
    }));
    setFilled(true);
  }, [filled, isLoaded, user]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === 'report' ? form : { ...form, topic: '' }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setError(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Could not send that.');
      return;
    }
    setSent(true);
    if (mode === 'report') {
      setLetter({
        to: STORE_EMAIL,
        subject: `Customer report from ${form.name.trim()} — ${form.topic}`,
        body: [
          'Arvessó Fragrances',
          'Customer report',
          '',
          `From: ${form.name.trim()}`,
          `Email: ${form.email.trim()}`,
          `About: ${form.topic}`,
          `Sent: ${new Date().toLocaleString('en-NZ')}`,
          '',
          'What they reported:',
          form.body.trim(),
          '',
          `Reply directly to ${form.email.trim()}.`,
        ].join('\n'),
      });
    }
  };
  return <main className="wrap"><div className="page-head"><span className="eyebrow">{mode === 'report' ? 'Customer report' : 'For the shop'}</span><h1>{mode === 'report' ? 'Report a problem' : 'Requests and ideas'}</h1><p>{mode === 'report' ? `Tell us what happened. This opens an email to ${STORE_EMAIL}, and a copy is kept in the studio.` : 'Ask for a fragrance you want to buy, share an idea, or leave a suggestion.'}</p></div>
    {sent ? <div>{mode === 'report' && letter ? <><div className="notice">The report is saved in the studio. Open the email below so it arrives at {STORE_EMAIL} with the details filled in.</div><Letter email={letter}/></> : <div className="notice">Saved. We will read it in the studio.</div>}</div> : <form className="admin-form" onSubmit={(event) => void submit(event)}>
      {error && <div className="notice error wide">{error}</div>}
      {mode === 'request' ? <label>What is this<select className="select" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} data-testid="select-message-kind"><option value="purchase">A fragrance I want to buy</option><option value="idea">An idea</option><option value="suggestion">A suggestion</option></select></label> : <label>What it is about<select className="select" value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })}><option>An order</option><option>A product</option><option>The website</option><option>Something else</option></select></label>}
      <label>Name<input required className="field" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} data-testid="input-message-name"/></label>
      <label>Email<input required type="email" className="field" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} data-testid="input-message-email"/></label>
      <label className="wide">{mode === 'report' ? 'What happened' : 'Your message'}<textarea required className="textarea" rows={5} maxLength={1000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} data-testid="input-message-body"/></label>
      <div className="wide"><button className="button button-small" data-testid="button-send-message">{mode === 'report' ? 'Send report' : 'Send'}</button></div>
    </form>}
  </main>;
}

type CustomerMessage = { id: number; kind: string; name: string; email: string; topic: string | null; body: string; createdAt: string };

function AdminInbox() {
  const [rows, setRows] = useState<CustomerMessage[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/admin/messages', { credentials: 'include' });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body)) {
        setError('Could not load messages.');
        return;
      }
      setRows(body as CustomerMessage[]);
    })();
  }, []);
  const requests = rows.filter((row) => row.kind !== 'report');
  const reports = rows.filter((row) => row.kind === 'report');
  const table = (items: CustomerMessage[]) => items.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>From</th><th>Message</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleDateString('en-NZ')}<div className="product-size">{messageKinds[item.kind] || item.kind}{item.topic ? ` · ${item.topic}` : ''}</div></td><td><strong>{item.name}</strong><div className="product-size">{item.email}</div></td><td>{item.body}</td></tr>)}</tbody></table></div> : <EmptyAdmin message="Nothing here yet."/>;
  return <AdminLayout>
    <div className="admin-top"><div><span className="eyebrow">From customers</span><h1>Inbox</h1></div></div>
    {error && <div className="notice error">{error}</div>}
    <div className="section-top"><div><span className="eyebrow">Reports</span><h2 className="section-heading" style={{fontSize:34}}>Sent to the store email</h2></div></div>
    {table(reports)}
    <div className="section-top"><div><span className="eyebrow">Requests</span><h2 className="section-heading" style={{fontSize:34}}>Ideas and fragrances they want</h2></div></div>
    {table(requests)}
  </AdminLayout>;
}

function Router({cart}:{cart:CartApi}) {
  const [location]=useLocation();
  return <ErrorBoundary resetKey={location}><Shell cart={cart}><Switch>
    <Route path="/" component={HomeRedirect}/><Route path="/shop" component={ShopPage}/><Route path="/samples"><SamplesPage cart={cart}/></Route>
    <Route path="/product/:slug"><ProductPageView cart={cart}/></Route>
    <Route path="/cart"><CartPage cart={cart}/></Route><Route path="/checkout"><CheckoutPage cart={cart}/></Route>
    <Route path="/order-confirmation/:id"><ConfirmationPage cart={cart}/></Route>
    <Route path="/contact"><StoreInfoPage page="contact"/></Route>
    <Route path="/requests"><CustomerMessagePage mode="request"/></Route>
    <Route path="/report"><CustomerMessagePage mode="report"/></Route>
    <Route path="/shipping"><StoreInfoPage page="shipping"/></Route>
    <Route path="/returns"><StoreInfoPage page="returns"/></Route>
    <Route path="/privacy"><StoreInfoPage page="privacy"/></Route>
    <Route path="/terms"><StoreInfoPage page="terms"/></Route>
    <Route path="/account/settings"><AccountSettingsPage/></Route><Route path="/account"><AccountPage/></Route>
    <Route path="/sign-in/*?" component={SignInPage}/><Route path="/sign-up/*?" component={SignUpPage}/>
    <Route path="/admin"><AdminOverview/></Route><Route path="/admin/products"><AdminProducts/></Route><Route path="/admin/inventory"><AdminInventory/></Route><Route path="/admin/orders"><AdminOrders/></Route><Route path="/admin/cash"><AdminCash/></Route><Route path="/admin/delivery"><AdminDelivery/></Route><Route path="/admin/inbox"><AdminInbox/></Route><Route path="/admin/discounts"><AdminDiscounts/></Route>
    <Route><main className="wrap" style={{padding:'100px 0'}}><span className="eyebrow">404 · Not found</span><h1 className="section-heading">This page has drifted.</h1><Link className="button" href="/">Return home</Link></main></Route>
  </Switch></Shell></ErrorBoundary>;
}
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) client.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}
function ClerkProviderWithRoutes({cart}:{cart:CartApi}) {
  const [,setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      signIn:{start:{title:'Welcome back',subtitle:'Sign in to return to your Arvessó account'}},
      signUp:{start:{title:'Create your Arvessó account',subtitle:'A considered account for your fragrance journey'}},
    }}
    routerPush={(to)=>setLocation(stripBase(to))}
    routerReplace={(to)=>setLocation(stripBase(to),{replace:true})}
  >
    <ClerkQueryClientCacheInvalidator/>
    <Router cart={cart}/>
  </ClerkProvider>;
}
function App() {
  const cart=useCart();
  useEffect(() => {
    const revealSelector = '.scroll-reveal:not(.is-visible)';
    const elements = document.querySelectorAll<HTMLElement>('.scroll-reveal');
    const showAll = () => elements.forEach((element) => element.classList.add('is-visible'));

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      showAll();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -36px 0px' });

    const observe = (element: HTMLElement) => {
      if (element.dataset.revealObserved) return;
      element.dataset.revealObserved = 'true';
      observer.observe(element);
    };
    const scan = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(revealSelector)) observe(node);
      node.querySelectorAll<HTMLElement>(revealSelector).forEach(observe);
    };

    scan(document.documentElement);
    const mutations = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach(scan));
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes cart={cart}/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;
