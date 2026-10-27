import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  PackageCheck,
  ShoppingBag,
  Truck,
} from "lucide-react";
import "./_group.css";
import "./OrderAccount.css";

type OrderStatus = "In transit" | "Delivered";

type SampleOrder = {
  reference: string;
  placed: string;
  status: OrderStatus;
  description: string;
  action: string;
  tracking?: string;
};

const sampleOrders: SampleOrder[] = [
  {
    reference: "SG-2408",
    placed: "14 May 2026",
    status: "In transit",
    description: "Sample order · 2 items",
    action: "Follow delivery",
    tracking: "Sample tracking update · With the carrier",
  },
  {
    reference: "SG-2371",
    placed: "28 March 2026",
    status: "Delivered",
    description: "Sample order · 1 item",
    action: "View order details",
  },
  {
    reference: "SG-2216",
    placed: "09 December 2025",
    status: "Delivered",
    description: "Sample order · 2 items",
    action: "View order details",
  },
];

function OrderRow({ order }: { order: SampleOrder }) {
  const [expanded, setExpanded] = useState(false);
  const inTransit = order.status === "In transit";

  return (
    <article className={`oa-order ${inTransit ? "oa-order-current" : ""}`}>
      <div className="oa-order-icon" aria-hidden="true">
        {inTransit ? <Truck size={19} strokeWidth={1.5} /> : <PackageCheck size={19} strokeWidth={1.5} />}
      </div>
      <div className="oa-order-main">
        <div className="oa-order-heading">
          <div>
            <span className="oa-order-kicker">Order {order.reference}</span>
            <p className="oa-order-description">{order.description}</p>
          </div>
          <span className={`oa-status ${inTransit ? "oa-status-transit" : "oa-status-delivered"}`}>
            <span className="oa-status-dot" />
            {order.status}
          </span>
        </div>
        <div className="oa-order-bottom">
          <span className="oa-order-date">Placed {order.placed}</span>
          <button
            type="button"
            className="oa-order-action"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? "Close details" : order.action}
            {inTransit ? <ArrowUpRight size={14} /> : <ChevronDown size={14} className={expanded ? "oa-chevron-open" : ""} />}
          </button>
        </div>
        {expanded && (
          <div className="oa-order-details">
            {inTransit ? (
              <>
                <div className="oa-progress" aria-label="Sample order progress">
                  <span className="oa-progress-step complete"><Check size={11} /></span>
                  <span className="oa-progress-line complete" />
                  <span className="oa-progress-step complete"><Check size={11} /></span>
                  <span className="oa-progress-line complete" />
                  <span className="oa-progress-step active"><Truck size={12} /></span>
                  <span className="oa-progress-line" />
                  <span className="oa-progress-step"><span />
                  </span>
                </div>
                <div className="oa-progress-labels"><span>Confirmed</span><span>Packed</span><span>With carrier</span><span>Delivered</span></div>
                <p className="oa-tracking-note">{order.tracking}. This is sample information for the preview.</p>
              </>
            ) : (
              <p className="oa-tracking-note">Sample order details are shown for this preview. No product or payment information is connected.</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function OrderAccount() {
  const [signOutMessage, setSignOutMessage] = useState(false);
  const [showAll, setShowAll] = useState(true);

  return (
    <div className="oa-page min-h-screen">
      <header className="header">
        <a href="#" className="brand" aria-label="Sillage home">sillage</a>
        <nav className="nav-links" aria-label="Main navigation">
          <a href="#">Fragrance</a>
          <a href="#">Our approach</a>
          <a href="#">Studio</a>
        </nav>
        <div className="header-actions">
          <div className="account-state">
            <span className="account-initial">S</span>
            <span className="account-email">Sillage member</span>
            <button className="account-signout" type="button" onClick={() => setSignOutMessage((value) => !value)}>
              {signOutMessage ? "Signed in" : "Sign out"}
            </button>
          </div>
          <a className="icon-button" href="#" aria-label="Shopping bag"><ShoppingBag size={18} /></a>
        </div>
      </header>

      <main className="wrap oa-wrap">
        <div className="oa-breadcrumb"><span>Account</span><span className="oa-breadcrumb-slash">/</span><span>Orders</span></div>
        <section className="oa-intro">
          <div>
            <span className="eyebrow">Your Sillage account</span>
            <h1 className="oa-title">Good to have you back.</h1>
            <p className="oa-intro-copy">A quiet place to keep an eye on your orders and pick up where you left off.</p>
          </div>
          <div className="oa-member">
            <span className="oa-member-mark">S</span>
            <div><span className="oa-member-label">Signed in as</span><strong>Sillage member</strong><span className="oa-member-email">member@example.com</span></div>
            <button type="button" className="oa-signout" onClick={() => setSignOutMessage((value) => !value)}>{signOutMessage ? "Still signed in" : "Sign out"}</button>
          </div>
        </section>

        {signOutMessage && (
          <div className="oa-preview-notice" role="status">
            Sign-out is shown for this visual preview only. Your account remains signed in.
            <button type="button" onClick={() => setSignOutMessage(false)} aria-label="Dismiss sign-out preview message">Dismiss</button>
          </div>
        )}

        <div className="oa-layout">
          <section className="oa-orders-section" aria-labelledby="oa-orders-title">
            <div className="oa-section-head">
              <div>
                <span className="eyebrow">Your account, at a glance</span>
                <h2 id="oa-orders-title">Orders <span className="oa-count">03</span></h2>
              </div>
              <button type="button" className="oa-filter" onClick={() => setShowAll((value) => !value)} aria-pressed={showAll}>
                {showAll ? "All orders" : "Recent order"} <ChevronDown size={14} />
              </button>
            </div>
            <p className="oa-sample-label">Sample order data · for preview only</p>
            <div className="oa-order-list">
              {(showAll ? sampleOrders : sampleOrders.slice(0, 1)).map((order) => <OrderRow key={order.reference} order={order} />)}
            </div>
            <p className="oa-list-footnote">Order information is illustrative and is not connected to a live account.</p>
          </section>

          <aside className="oa-aside">
            <div className="oa-note-card">
              <div className="oa-note-icon"><Truck size={17} strokeWidth={1.5} /></div>
              <span className="eyebrow">A small note</span>
              <h3>On its way?</h3>
              <p>Open an order above to see its latest delivery update. If you need a hand, we’re here to help.</p>
              <a href="mailto:hello@sillage.co.nz" className="oa-help-link">Contact our team <ArrowRight size={14} /></a>
            </div>
            <div className="oa-browse">
              <div className="oa-browse-symbol" aria-hidden="true">S.</div>
              <span className="eyebrow">When you're ready</span>
              <h3>Return to the collection.</h3>
              <a href="#" className="oa-browse-link">Explore fragrance <ArrowRight size={14} /></a>
            </div>
          </aside>
        </div>

        <section className="oa-empty-state" aria-label="Empty order state example">
          <div className="oa-empty-icon"><CircleHelp size={18} strokeWidth={1.5} /></div>
          <div>
            <span className="eyebrow">If no orders appear</span>
            <p>Orders placed with this account will appear here. If you checked out with a different email, get in touch and we’ll help you find the right place.</p>
          </div>
          <a href="mailto:hello@sillage.co.nz" aria-label="Contact Sillage for help"><ArrowRight size={16} /></a>
        </section>
      </main>

      <footer className="footer oa-footer">
        <div className="wrap">
          <div className="footer-main">
            <div><a href="#" className="brand">sillage</a><p>Independent fragrance, thoughtfully selected. From Aotearoa, for wherever you are.</p></div>
            <div className="footer-links">
              <div><span className="eyebrow">Explore</span><a href="#">Fragrance</a><a href="#">Our approach</a></div>
              <div><span className="eyebrow">Help</span><a href="#">Your bag</a><a href="#">Account</a><a href="#">Store admin</a></div>
            </div>
          </div>
          <div className="footer-bottom"><span>© 2026 Sillage Fragrance</span><span>Made for the considered everyday · Aotearoa New Zealand</span></div>
        </div>
      </footer>
    </div>
  );
}
