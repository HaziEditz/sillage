import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  ArrowLeft, ArrowRight, Check, CircleHelp,
  LoaderCircle, Menu, Minus, Package, Plus, Search, ShieldCheck, ShoppingBag,
  Trash2, Truck, X,
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

function Header({ cart }: { cart: CartApi }) {
  return <header className="header">
    <Link href="/" className="brand" data-testid="link-home">sillage</Link>
    <nav className="nav-links" aria-label="Main navigation">
      <Link href="/shop" data-testid="link-shop">Fragrance</Link><a href={`${basePath || ''}/#approach`}>Our approach</a>
      <Show when="signed-in"><Link href="/admin" data-testid="link-admin-navigation">Studio</Link></Show>
    </nav>
    <div className="header-actions">
      <AccountControls/>
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
    <div className="footer-main"><div><Link href="/" className="brand">sillage</Link><p>Independent fragrance, thoughtfully selected. From Aotearoa, for wherever you are.</p></div>
      <div className="footer-links"><div><span className="eyebrow">Explore</span><Link href="/shop">Fragrance</Link><a href={`${basePath || ''}/#approach`}>Our approach</a></div><div><span className="eyebrow">Help</span><Link href="/cart">Your bag</Link><Show when="signed-in"><Link href="/account">Account</Link><Link href="/admin">Store admin</Link></Show><Show when="signed-out"><Link href="/sign-in">Sign in</Link></Show></div></div></div>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} Sillage Fragrance</span><span>Made for the considered everyday · Aotearoa New Zealand</span></div>
  </div></footer>;
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

function ProductCard({ product }: { product: Product }) {
  const cheapest = [...product.variants].sort((a, b) => a.priceMinor - b.priceMinor)[0];
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
    <section className="hero"><div className="hero-image"/><div className="hero-content"><span className="eyebrow">Independent fragrance · Aotearoa</span><h1>Find the note<br/>that stays.</h1><p>A considered edit of fragrance for the quietly distinctive. Discover a scent that feels like your own.</p><Link className="button" href="/shop">Explore fragrance <ArrowRight size={14}/></Link></div></section>
    <section className="intro" id="approach"><span className="eyebrow">The Sillage point of view</span><h2>Close to the skin.<br/>Never ordinary.</h2><p>We believe a fragrance should be discovered, not prescribed. Our edit brings together independent perfumery and enduring classics, chosen for character, craft and the way they make you feel.</p></section>
    <section className="section wrap"><div className="section-top"><div><span className="eyebrow">The collection</span><h2 className="section-heading">Selected for you</h2></div><Link className="text-link eyebrow" href="/shop">View the collection <ArrowRight size={13}/></Link></div>
      {isLoading ? <ProductSkeletons/> : isError ? <QueryError retry={() => void refetch()}/> : featured.length ? <div className="product-grid">{featured.slice(0,4).map((p) => <ProductCard key={p.id} product={p}/>)}</div> : <EmptyCatalog/>}
    </section>
    <section className="quiet-band"><div className="wrap quiet-band-inner"><div><span className="eyebrow">An invitation to explore</span><h2>Fragrance is personal.<br/>Finding yours can be, too.</h2></div><div><p>Take your time with the notes, the materials and the feeling each fragrance leaves behind. We’re here for the discovery.</p><Link className="button button-outline" href="/shop">Browse all fragrances <ArrowRight size={14}/></Link></div></div></section>
    <div className="wrap service-strip"><div className="service-item"><Truck size={17}/><b>Thoughtful delivery</b><p>Clear, careful shipping from New Zealand.</p></div><div className="service-item"><ShieldCheck size={17}/><b>Chosen with care</b><p>Real fragrance records and details, always.</p></div><div className="service-item"><CircleHelp size={17}/><b>Here to help</b><p>Guidance for your next considered scent.</p></div></div>
  </>;
}

function ShopPage() {
  const [q, setQ] = useState('');
  const [audience, setAudience] = useState('');
  const [sort, setSort] = useState<'newest'|'price-asc'|'price-desc'|'name'>('newest');
  const { data, isLoading, isError, refetch } = useGetProducts({ q: q || undefined, audience: audience || undefined, sort, page: 1, pageSize: 48 });
  return <main className="wrap"><div className="page-head"><span className="eyebrow">The Sillage edit</span><h1>Fragrance</h1><p>Explore an evolving collection of distinctive fragrance. Search by name, brand or the notes you love.</p></div>
    <div className="catalog-tools"><label style={{position:'relative',flex:1}}><Search size={15} style={{position:'absolute',left:13,top:14,color:'#77736b'}}/><input className="field" style={{paddingLeft:38}} value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search the collection" aria-label="Search fragrances" data-testid="input-search-products"/></label>
      <select className="select" value={audience} onChange={(e)=>setAudience(e.target.value)} aria-label="Filter by audience" data-testid="select-audience"><option value="">All audiences</option><option value="women">Women</option><option value="men">Men</option><option value="unisex">Unisex</option></select>
      <select className="select" value={sort} onChange={(e)=>setSort(e.target.value as typeof sort)} aria-label="Sort collection" data-testid="select-sort"><option value="newest">Recently added</option><option value="name">Name</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select>
    </div>
    {isLoading ? <ProductSkeletons/> : isError ? <QueryError retry={() => void refetch()}/> : data?.items.length ? <><p className="eyebrow" style={{marginBottom:20}}>{data.total} {data.total === 1 ? 'fragrance' : 'fragrances'}</p><div className="product-grid">{data.items.map((product) => <ProductCard key={product.id} product={product}/>)}</div></> : <EmptyCatalog/>}
  </main>;
}

function ProductPageView({ cart }: { cart: CartApi }) {
  const { slug = '' } = useParams<{slug:string}>();
  const { data: product, isLoading, isError, refetch } = useGetProduct(slug);
  const [selected, setSelected] = useState<number | null>(null);
  const [added, setAdded] = useState(false);
  useEffect(()=>{ setSelected(null); setAdded(false); },[slug]);
  if (isLoading) return <main className="wrap detail-grid"><div className="skeleton loading-card"/><div className="skeleton" style={{height:400}}/></main>;
  if (isError || !product) return <main className="wrap" style={{padding:'60px 0'}}><QueryError retry={()=>void refetch()}/></main>;
  const variant = product.variants.find((item)=>item.id === selected) || product.variants[0];
  return <main className="wrap">
    <div style={{paddingTop:30}}><Link href="/shop" className="eyebrow"><ArrowLeft size={13}/> Back to fragrance</Link></div>
    <div className="detail-grid"><ProductImage product={product} className="detail-image"/><div className="detail-info"><span className="detail-brand">{product.brand}</span><h1>{product.name}</h1><p className="detail-description">{product.description}</p>
      <div className="detail-price">{variant ? money(variant.priceMinor) : 'Price unavailable'}</div>
      <span className="eyebrow">Choose a size</span><div className="variant-list">{product.variants.map((item)=> <button key={item.id} onClick={()=>{setSelected(item.id);setAdded(false);}} className={`variant-option ${variant?.id===item.id?'selected':''}`} aria-pressed={variant?.id===item.id} data-testid={`button-variant-${item.id}`}>{item.size}</button>)}</div>
      <button className="button" disabled={!variant || variant.stock < 1} onClick={()=>{if(variant){cart.add(product,variant);setAdded(true);}}} data-testid="button-add-to-cart">{variant?.stock===0?'Currently unavailable':added?<><Check size={15}/> Added to bag</>:<>Add to bag <ArrowRight size={14}/></>}</button>
      {variant && variant.stock > 0 && variant.stock <= 3 && <p className="product-size">Only {variant.stock} remaining</p>}
      <div className="detail-notes"><div><span>Audience</span><strong>{product.audience}</strong></div>{product.concentration && <div><span>Concentration</span><strong>{product.concentration}</strong></div>}{product.scentFamily && <div><span>Scent family</span><strong>{product.scentFamily}</strong></div>}{product.notes?.length ? <div><span>Notes</span><strong>{product.notes.join(' · ')}</strong></div>:null}</div>
    </div></div>
  </main>;
}

function CartPage({ cart }: {cart:CartApi}) {
  if (!cart.entries.length) return <main className="wrap"><div className="page-head"><span className="eyebrow">Your selection</span><h1>Your bag</h1></div><EmptyCart/></main>;
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Your selection</span><h1>Your bag</h1></div><div className="cart-layout"><div>{cart.entries.map((line)=><div className="cart-line" key={line.variantId}><ProductImage product={line.product}/><div><span className="product-brand">{line.product.brand}</span><h3>{line.product.name}</h3><span className="product-size">{line.variant.size}</span><div className="quantity-control"><button aria-label="Decrease quantity" onClick={()=>cart.quantity(line.variantId,line.quantity-1)} data-testid={`button-decrease-${line.variantId}`}><Minus size={12}/></button><span>{line.quantity}</span><button aria-label="Increase quantity" onClick={()=>cart.quantity(line.variantId,line.quantity+1)} data-testid={`button-increase-${line.variantId}`}><Plus size={12}/></button></div></div><div style={{textAlign:'right'}}><strong style={{fontSize:12}}>{money(line.variant.priceMinor*line.quantity)}</strong><button className="icon-button" aria-label={`Remove ${line.product.name}`} onClick={()=>cart.remove(line.variantId)} data-testid={`button-remove-${line.variantId}`}><Trash2 size={15}/></button></div></div>)}</div>
    <aside className="summary"><h2>Order summary</h2><div className="summary-row"><span>Subtotal</span><span>{money(cart.total)}</span></div><div className="summary-row"><span>Delivery</span><span>Calculated at checkout</span></div><div className="summary-row" style={{borderTop:'1px solid #d2cdc3',paddingTop:15,fontWeight:600}}><span>Total</span><span>{money(cart.total)}</span></div><Link className="button" href="/checkout">Continue to checkout <ArrowRight size={14}/></Link><Link className="text-link eyebrow" style={{display:'block',textAlign:'center',marginTop:18}} href="/shop">Continue browsing</Link></aside></div></main>;
}
function EmptyCart(){return <div className="empty-state"><div className="empty-mark"><ShoppingBag size={20}/></div><h2>Your bag is at rest</h2><p>There’s nothing here just yet. Take a moment to explore the collection.</p><Link className="button" href="/shop">Explore fragrance</Link></div>;}

function CheckoutPage({ cart }: {cart:CartApi}) {
  const [form,setForm] = useState({email:'',recipientName:'',address1:'',address2:'',city:'',region:'',postcode:'',discountCode:''});
  const [error,setError]=useState('');
  const mutation=useCreatePayPalOrder();
  const change=(key:keyof typeof form,value:string)=>setForm((old)=>({...old,[key]:value}));
  const submit=(event:FormEvent)=>{event.preventDefault();setError('');
    const input:CheckoutInput={...form, requestId:crypto.randomUUID(), lines:cart.entries.map((item)=>({variantId:item.variantId,quantity:item.quantity}))};
    mutation.mutate({data:input},{onSuccess:(order)=>{sessionStorage.setItem('sillage-pending-paypal',JSON.stringify({orderId:order.orderId,paypalOrderId:order.paypalOrderId,cancelToken:order.cancelToken}));window.location.assign(order.approvalUrl);},onError:()=>setError('We couldn’t begin checkout. Please check your details and try again.')});
  };
  const search = new URLSearchParams(window.location.search);
  const returnedCancelled = search.has('cancel') || search.has('cancelled') || search.get('useraction') === 'cancel';
  if (returnedCancelled) return <main className="wrap"><div className="page-head"><span className="eyebrow">PayPal checkout</span><h1>Checkout cancelled</h1><p>Your approval was cancelled. We’ll release the reserved stock securely.</p></div><PayPalCancellationReturn cart={cart}/></main>;
  if (!cart.entries.length) return <main className="wrap"><div className="page-head"><span className="eyebrow">Checkout</span><h1>Your bag is empty</h1></div><EmptyCart/></main>;
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Almost yours</span><h1>Checkout</h1><p>Enter your delivery details to continue to secure PayPal checkout.</p></div>
    <form className="checkout-grid" onSubmit={submit}><div className="checkout-form">
      <section className="form-section"><h2>Contact</h2><div className="form-grid"><label className="wide">Email<input className="field" type="email" required value={form.email} onChange={(e)=>change('email',e.target.value)} data-testid="input-checkout-email"/></label><label className="wide">Recipient name<input className="field" required value={form.recipientName} onChange={(e)=>change('recipientName',e.target.value)} data-testid="input-recipient-name"/></label></div></section>
      <section className="form-section"><h2>Delivery address</h2><div className="form-grid"><label className="wide">Address<input className="field" required value={form.address1} onChange={(e)=>change('address1',e.target.value)} data-testid="input-address1"/></label><label className="wide">Apartment, suite, etc. <span style={{textTransform:'none'}}>(optional)</span><input className="field" value={form.address2} onChange={(e)=>change('address2',e.target.value)} data-testid="input-address2"/></label><label>City<input className="field" required value={form.city} onChange={(e)=>change('city',e.target.value)} data-testid="input-city"/></label><label>Region<input className="field" value={form.region} onChange={(e)=>change('region',e.target.value)} data-testid="input-region"/></label><label>Postcode<input className="field" required value={form.postcode} onChange={(e)=>change('postcode',e.target.value)} data-testid="input-postcode"/></label><label>Discount code<input className="field" value={form.discountCode} onChange={(e)=>change('discountCode',e.target.value)} data-testid="input-discount"/></label></div></section>
      {error && <div className="notice error" role="alert">{error}</div>}<div className="sandbox-note"><ShieldCheck size={16}/><span><strong>PayPal sandbox checkout.</strong> This store is configured for sandbox transactions; no live payment credentials are used.</span></div>
      <button className="button" type="submit" disabled={mutation.isPending} data-testid="button-paypal-checkout">{mutation.isPending?<><LoaderCircle size={15}/> Preparing checkout</>:<>Continue with PayPal <ArrowRight size={14}/></>}</button>
    </div><aside className="summary"><h2>Your order</h2>{cart.entries.map((line)=><div className="summary-row" key={line.variantId}><span>{line.product.name} · {line.variant.size} × {line.quantity}</span><span>{money(line.variant.priceMinor*line.quantity)}</span></div>)}<div className="summary-row" style={{borderTop:'1px solid #d2cdc3',paddingTop:15,fontWeight:600}}><span>Total</span><span>{money(cart.total)}</span></div><p style={{fontSize:10,lineHeight:1.6,color:'#706d65'}}>Final prices are confirmed by the store at checkout.</p></aside></form>
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
    capture.mutate({data:{orderId:pending.orderId,paypalOrderId:token}},{onSuccess:(order)=>{setConfirmed(order);sessionStorage.removeItem('sillage-pending-paypal');cart.clear();queryClient.invalidateQueries({queryKey:getGetAdminOrdersQueryKey()});},onError:()=>setCaptureError('PayPal returned to Sillage, but we could not confirm the capture. Please contact us before trying to pay again.')});
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
  return <><Show when="signed-in"><Redirect to="/account"/></Show><Show when="signed-out"><HomePage/></Show></>;
}
function AccountPage() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  return <main className="wrap"><div className="page-head"><span className="eyebrow">Your Sillage account</span><h1>A little closer.</h1><p>Manage your account access and return to the collection.</p></div>
    <Show when="signed-in">{isLoaded && user ? <section className="auth-card" style={{marginBottom:80}}><span className="eyebrow">Signed in</span><h2 className="serif" style={{fontSize:30,margin:'12px 0'}}>{user.fullName || user.primaryEmailAddress?.emailAddress || 'Sillage customer'}</h2><p>{user.primaryEmailAddress?.emailAddress}</p><div className="admin-actions"><Link href="/shop" className="button">Explore fragrance</Link><button className="button button-outline" onClick={()=>void signOut({redirectUrl:basePath||'/'})} data-testid="button-account-sign-out">Sign out</button></div></section>:<div className="skeleton" style={{height:170,marginBottom:80}}/>}</Show>
    <Show when="signed-out"><Redirect to="/"/></Show>
  </main>;
}

const adminRoutes=[['/admin','Overview'],['/admin/products','Products'],['/admin/inventory','Inventory'],['/admin/orders','Orders']];
function AdminLayout({children}:{children:ReactNode}) {
  const [path]=useLocation();
  const {data:health,isLoading}=useHealthCheck({query:{queryKey:getHealthCheckQueryKey(),retry:1}});
  return <div className="admin-shell"><aside className="admin-side"><span className="eyebrow">Sillage · Studio</span><nav className="admin-nav">{adminRoutes.map(([href,label])=><Link key={href} href={href} className={path===href?'active':''} data-testid={`link-admin-${label.toLowerCase()}`}>{label}<ArrowRight size={13}/></Link>)}</nav><div style={{marginTop:35,fontSize:10,color:'#77736b'}}>{isLoading?'Checking service…':health?.status==='ok'?'Store service operational':health?.status?`Service: ${health.status}`:'Service status unavailable'}</div></aside><section className="admin-main">{children}</section></div>;
}
function AdminError({error}:{error:unknown}){return <div className="notice error"><CircleHelp size={15}/> {error instanceof Error?error.message:'The admin service could not be reached. Check your sign-in and try again.'}</div>;}
function AdminOverview() {
  const {data,isLoading,isError,error,refetch}=useGetAdminDashboard({query:{queryKey:getGetAdminDashboardQueryKey()}});
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Store overview</span><h1>Good morning.</h1></div><Link className="button button-outline button-small" href="/admin/products">Manage collection</Link></div>
    {isLoading?<div className="metric-grid">{[1,2,3,4].map((i)=><div className="metric skeleton" key={i}/>)}</div>:isError?<><AdminError error={error}/><button className="button button-outline button-small" onClick={()=>void refetch()}>Retry</button></>:<>
      {data && <><div className="metric-grid"><Metric label="Products" value={data.productCount}/><Metric label="Low stock" value={data.lowStockCount}/><Metric label="Pending orders" value={data.pendingOrders}/><Metric label="Paid sales" value={money(data.paidSalesMinor)}/></div>
      <div className="section-top"><div><span className="eyebrow">Latest activity</span><h2 className="section-heading" style={{fontSize:34}}>Recent orders</h2></div><Link className="eyebrow" href="/admin/orders">All orders <ArrowRight size={13}/></Link></div>
      {data.recentOrders.length?<OrderTable orders={data.recentOrders}/>:<EmptyAdmin message="Orders will appear here when customers complete checkout."/>}
      </>}
    </>}
  </AdminLayout>;
}
function Metric({label,value}:{label:string;value:string|number}){return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;}
function EmptyAdmin({message}:{message:string}){return <div className="notice">{message}</div>;}
function OrderTable({orders}:{orders:Order[]}){return <div className="table-wrap"><table className="data-table"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>{orders.map((order)=><tr key={order.id}><td>{order.orderNumber}</td><td>{new Date(order.createdAt).toLocaleDateString('en-NZ')}</td><td>{order.email}</td><td><span className="status-pill">{order.status}</span></td><td>{money(order.totalMinor,order.currency)}</td></tr>)}</tbody></table></div>;}

function ProductEditor({product,onClose}:{product?:Product;onClose:()=>void}) {
  const qc=useQueryClient();
  const create=useCreateProduct();
  const update=useUpdateProduct();
  const [error,setError]=useState('');
  const [fields,setFields]=useState({name:product?.name||'',brand:product?.brand||'',description:product?.description||'',audience:product?.audience||'',concentration:product?.concentration||'',scentFamily:product?.scentFamily||'',imageUrl:product?.imageUrl||'',status:product?.status||'draft',featured:product?.featured||false,bestseller:product?.bestseller||false,notes:product?.notes?.join(', ')||''});
  const [variants,setVariants]=useState(()=>product?.variants.map(v=>({size:v.size,sku:v.sku,price:(v.priceMinor/100).toFixed(2),stock:String(v.stock)}))||[{size:'',sku:'',price:'',stock:'0'}]);
  const set=(key:keyof typeof fields,value:string|boolean)=>setFields((old)=>({...old,[key]:value}));
  const submit=(e:FormEvent)=>{e.preventDefault();setError('');
    const common={name:fields.name,brand:fields.brand,description:fields.description,audience:fields.audience,concentration:fields.concentration||null,scentFamily:fields.scentFamily||null,imageUrl:fields.imageUrl||null,status:fields.status as ProductInput['status'],featured:fields.featured,bestseller:fields.bestseller,notes:fields.notes.split(',').map(x=>x.trim()).filter(Boolean)};
    if(product){update.mutate({id:product.id,data:common as ProductUpdate},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetProductsQueryKey()});onClose();},onError:()=>setError('Unable to update this fragrance. Check your fields and try again.')});}
    else {const data:ProductInput={...common,variants:variants.map(v=>({size:v.size,sku:v.sku,priceMinor:Math.round(Number(v.price)*100),stock:Number(v.stock)}))};create.mutate({data},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});onClose();},onError:()=>setError('Unable to create this fragrance. Check required details and try again.')});}
  };
  const busy=create.isPending||update.isPending;
  return <form className="admin-form" onSubmit={submit}><div className="wide" style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><span className="eyebrow">{product?'Edit fragrance':'New fragrance'}</span><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor" data-testid="button-close-editor"><X size={17}/></button></div>
    <label>Name<input required className="field" value={fields.name} onChange={(e)=>set('name',e.target.value)} data-testid="input-product-name"/></label><label>Brand<input required className="field" value={fields.brand} onChange={(e)=>set('brand',e.target.value)} data-testid="input-product-brand"/></label>
    <label className="wide">Description<textarea className="textarea" rows={4} value={fields.description} onChange={(e)=>set('description',e.target.value)} data-testid="input-product-description"/></label>
    <label>Audience<input required className="field" value={fields.audience} onChange={(e)=>set('audience',e.target.value)} placeholder="Use the product’s actual audience" data-testid="input-product-audience"/></label><label>Concentration<input className="field" value={fields.concentration} onChange={(e)=>set('concentration',e.target.value)} data-testid="input-product-concentration"/></label>
    <label>Scent family<input className="field" value={fields.scentFamily} onChange={(e)=>set('scentFamily',e.target.value)} data-testid="input-product-family"/></label><label>Image URL<input className="field" value={fields.imageUrl} onChange={(e)=>set('imageUrl',e.target.value)} data-testid="input-product-image"/></label>
    <label>Notes, separated by commas<input className="field" value={fields.notes} onChange={(e)=>set('notes',e.target.value)} data-testid="input-product-notes"/></label><label>Status<select className="select" value={fields.status} onChange={(e)=>set('status',e.target.value)} data-testid="select-product-status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
    <label><span>Featured</span><input type="checkbox" checked={fields.featured} onChange={(e)=>set('featured',e.target.checked)} data-testid="input-product-featured"/></label><label><span>Bestseller</span><input type="checkbox" checked={fields.bestseller} onChange={(e)=>set('bestseller',e.target.checked)} data-testid="input-product-bestseller"/></label>
    {!product && <div className="variant-editor"><span className="eyebrow">Variants · at least one required</span>{variants.map((variant,index)=><div className="variant-row" key={index}><input required className="field" placeholder="Size" value={variant.size} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,size:e.target.value}:v))} aria-label={`Variant ${index+1} size`}/><input required className="field" placeholder="SKU" value={variant.sku} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,sku:e.target.value}:v))} aria-label={`Variant ${index+1} SKU`}/><input required type="number" min="0" step=".01" className="field" placeholder="Price NZD" value={variant.price} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,price:e.target.value}:v))} aria-label={`Variant ${index+1} price`}/><input required type="number" min="0" className="field" placeholder="Stock" value={variant.stock} onChange={(e)=>setVariants(a=>a.map((v,i)=>i===index?{...v,stock:e.target.value}:v))} aria-label={`Variant ${index+1} stock`}/><button type="button" className="icon-button" aria-label="Remove variant" onClick={()=>setVariants(a=>a.length>1?a.filter((_,i)=>i!==index):a)}><Trash2 size={15}/></button></div>)}<button type="button" className="button button-outline button-small" onClick={()=>setVariants(a=>[...a,{size:'',sku:'',price:'',stock:'0'}])} data-testid="button-add-variant"><Plus size={13}/> Add variant</button></div>}
    {error&&<div className="notice error wide">{error}</div>}<div className="wide admin-actions"><button className="button button-small" disabled={busy} data-testid="button-save-product">{busy?'Saving…':product?'Save changes':'Create fragrance'}</button><button type="button" className="button button-outline button-small" onClick={onClose}>Cancel</button></div>
  </form>;
}

function AdminProducts() {
  const {data:products,isLoading,isError,error,refetch}=useGetAdminProducts({query:{queryKey:getGetAdminProductsQueryKey()}});
  const [editing,setEditing]=useState<Product|null|false>(false);
  const update=useUpdateProduct(); const qc=useQueryClient();
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Catalogue management</span><h1>Products</h1></div><button className="button button-small" onClick={()=>setEditing(null)} data-testid="button-new-product"><Plus size={14}/> Add fragrance</button></div>
    {editing!==false&&<ProductEditor product={editing||undefined} onClose={()=>setEditing(false)}/>}
    {isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:products?.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>Fragrance</th><th>Variants</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>{products.map(p=><tr key={p.id}><td><strong>{p.name}</strong><div className="product-size">{p.brand}</div></td><td>{p.variants.length}</td><td>{p.variants.reduce((sum,v)=>sum+v.stock,0)}</td><td><span className="status-pill">{p.status}</span></td><td><div className="admin-actions"><button className="button button-outline button-small" onClick={()=>setEditing(p)} data-testid={`button-edit-product-${p.id}`}>Edit</button><button className="button button-outline button-small" disabled={update.isPending} onClick={()=>update.mutate({id:p.id,data:{status:p.status==='published'?'draft':'published'}},{onSuccess:()=>{void qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});void qc.invalidateQueries({queryKey:getGetProductsQueryKey()});}})} data-testid={`button-toggle-publish-${p.id}`}>{p.status==='published'?'Unpublish':'Publish'}</button></div></td></tr>)}</tbody></table></div>:<EmptyCatalog admin/>}
  </AdminLayout>;
}

function AdminInventory() {
  const {data:products,isLoading,isError,error,refetch}=useGetAdminProducts({query:{queryKey:getGetAdminProductsQueryKey()}});
  const adjust=useAdjustInventory(); const qc=useQueryClient();
  const [draft,setDraft]=useState<Record<number,{delta:string;reason:string}>>({});
  const [message,setMessage]=useState('');
  const variants=products?.flatMap(p=>p.variants.map(v=>({product:p,variant:v})))||[];
  const change=(id:number,key:'delta'|'reason',value:string)=>setDraft(old=>({...old,[id]:{delta:old[id]?.delta||'',reason:old[id]?.reason||'', [key]:value}}));
  const submit=(id:number)=>{const item=draft[id];if(!item||Number(item.delta)===0||item.reason.trim().length<3){setMessage('Enter a non-zero adjustment and a reason of at least three characters.');return;}setMessage('');adjust.mutate({data:{variantId:id,delta:Number(item.delta),reason:item.reason}},{onSuccess:async()=>{await qc.invalidateQueries({queryKey:getGetAdminProductsQueryKey()});await qc.invalidateQueries({queryKey:getGetAdminDashboardQueryKey()});setDraft(o=>({...o,[id]:{delta:'',reason:''}}));setMessage('Stock adjustment recorded.');},onError:()=>setMessage('Stock could not be adjusted. Please check the amount and try again.')});};
  return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div></div>{message&&<div className="notice">{message}</div>}{isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:variants.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>Product / size</th><th>SKU</th><th>On hand</th><th>Adjust stock</th></tr></thead><tbody>{variants.map(({product,variant})=><tr key={variant.id}><td><strong>{product.name}</strong><div className="product-size">{variant.size}</div></td><td>{variant.sku}</td><td><span className={variant.stock<=3?'status-pill':''}>{variant.stock}</span></td><td><div className="admin-actions"><input className="field" style={{width:76}} type="number" value={draft[variant.id]?.delta||''} onChange={e=>change(variant.id,'delta',e.target.value)} placeholder="+ / −" aria-label={`Stock delta ${variant.id}`} data-testid={`input-stock-delta-${variant.id}`}/><input className="field" style={{width:170}} value={draft[variant.id]?.reason||''} onChange={e=>change(variant.id,'reason',e.target.value)} placeholder="Adjustment reason" aria-label={`Reason ${variant.id}`} data-testid={`input-stock-reason-${variant.id}`}/><button className="button button-outline button-small" disabled={adjust.isPending} onClick={()=>submit(variant.id)} data-testid={`button-adjust-stock-${variant.id}`}>Apply</button></div></td></tr>)}</tbody></table></div>:<EmptyCatalog admin/>}</AdminLayout>;
}
function AdminOrders(){const {data:orders,isLoading,isError,error,refetch}=useGetAdminOrders({query:{queryKey:getGetAdminOrdersQueryKey()}});return <AdminLayout><div className="admin-top"><div><span className="eyebrow">Fulfilment</span><h1>Orders</h1></div></div>{isLoading?<div className="skeleton" style={{height:220}}/>:isError?<><AdminError error={error}/><button className="button button-small" onClick={()=>void refetch()}>Retry</button></>:orders?.length?<OrderTable orders={orders}/>:<EmptyAdmin message="No orders yet. Customer orders will appear here after checkout."/>}</AdminLayout>;}

function Router({cart}:{cart:CartApi}) {
  const [location]=useLocation();
  return <ErrorBoundary resetKey={location}><Shell cart={cart}><Switch>
    <Route path="/" component={HomeRedirect}/><Route path="/shop" component={ShopPage}/>
    <Route path="/product/:slug"><ProductPageView cart={cart}/></Route>
    <Route path="/cart"><CartPage cart={cart}/></Route><Route path="/checkout"><CheckoutPage cart={cart}/></Route>
    <Route path="/order-confirmation/:id"><ConfirmationPage cart={cart}/></Route>
    <Route path="/account"><AccountPage/></Route>
    <Route path="/sign-in/*?" component={SignInPage}/><Route path="/sign-up/*?" component={SignUpPage}/>
    <Route path="/admin"><AdminOverview/></Route><Route path="/admin/products"><AdminProducts/></Route><Route path="/admin/inventory"><AdminInventory/></Route><Route path="/admin/orders"><AdminOrders/></Route>
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
      signIn:{start:{title:'Welcome back',subtitle:'Sign in to return to your Sillage account'}},
      signUp:{start:{title:'Create your Sillage account',subtitle:'A considered account for your fragrance journey'}},
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
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes cart={cart}/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;
