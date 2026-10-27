import { ArrowRight, ShoppingBag } from "lucide-react";
import "./_group.css";

export function Current() {
  return (
    <div className="min-h-screen">
      <header className="header">
        <a href="#" className="brand">sillage</a>
        <nav className="nav-links" aria-label="Main navigation">
          <a href="#">Fragrance</a>
          <a href="#">Our approach</a>
          <a href="#">Studio</a>
        </nav>
        <div className="header-actions">
          <div className="account-state">
            <span className="account-initial">S</span>
            <span className="account-email">Sillage member</span>
            <button className="account-signout" type="button">Sign out</button>
          </div>
          <a className="icon-button" href="#" aria-label="Shopping bag"><ShoppingBag size={18} /></a>
        </div>
      </header>
      <main className="wrap">
        <div className="page-head">
          <span className="eyebrow">Your Sillage account</span>
          <h1>A little closer.</h1>
          <p>Manage your account access and return to the collection.</p>
        </div>
        <section className="auth-card" style={{ marginBottom: 80 }}>
          <span className="eyebrow">Signed in</span>
          <h2 className="serif" style={{ fontSize: 30, margin: "12px 0" }}>Sillage member</h2>
          <p>member@example.com</p>
          <div className="admin-actions">
            <a href="#" className="button">Explore fragrance <ArrowRight size={13} /></a>
            <button className="button button-outline" type="button">Sign out</button>
          </div>
        </section>
      </main>
      <footer className="footer">
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
