// ─────────────────────────────────────────────────────────────────────────
// <snagged-topbar> — the ONE shared top bar for every Snagged surface.
//
// Single source of truth: this file is hosted by the umbrella at
//   https://app.snagged.com/brand/topbar.js
// and loaded by BOTH apps (the umbrella hub/admin AND the research SPA, which is
// proxied at app.snagged.com/research — same origin, so a root-absolute
// /brand/topbar.js URL hits this exact file). Edit here once; both update.
//
// Styles live in this component's Shadow DOM, so they're fully encapsulated —
// no cross-app source-order / specificity collisions. Brand color tokens
// (--navy, --cream-2, …) are inherited from the host page through the shadow
// boundary, so each app's palette still applies; hard fallbacks are provided so
// the bar still renders if a token is missing.
//
// Usage:
//   <script src="/brand/topbar.js" defer></script>
//   <snagged-topbar current="research" email="you@x.com" show-research show-admin></snagged-topbar>
//
// Attributes:
//   current        "research" | "admin" | ""   — which switcher link is active
//   email          signed-in email (account block); empty hides the account
//   show-research  present → render the Research switch link
//   show-admin     present → render the Admin switch link
//   home-href      logo target            (default "/")
//   research-href  Research link target   (default "/research")
//   admin-href     Admin link target      (default "/admin")
//   logout-href    Log out target         (default "/api/logout")
//
// Mobile (≤760px): the wordmark drops to just the blue circle, the account
// moves into a top-right hamburger menu, and any module sub-nav the app passes
// via `slot="menu"` is shown in that same menu. On desktop the slotted menu is
// hidden (apps render their own desktop sub-nav: research's sidebar, admin's
// tabs).
// ─────────────────────────────────────────────────────────────────────────
(function () {
  if (customElements.get('snagged-topbar')) return;

  const TPL = document.createElement('template');
  TPL.innerHTML = `
<style>
  :host { display: block; }
  * { box-sizing: border-box; }

  .bar {
    display: flex; align-items: center; gap: 20px;
    padding-bottom: 14px; margin-bottom: 28px;
    border-bottom: 1px solid var(--line, #e6ddc9);
  }
  .brand {
    display: inline-flex; align-items: center; gap: 11px;
    text-decoration: none; white-space: nowrap;
    font-family: var(--body, inherit); font-weight: 800; font-size: 1.4rem;
    color: var(--navy, #173042); letter-spacing: -.01em;
  }
  .brand:hover { opacity: .9; }
  .mark { width: 44px; height: 44px; flex: none; border-radius: 50%; display: block; }
  .wm { color: var(--navy, #173042); }

  .switch { display: flex; gap: 6px; }
  .switch a {
    padding: 6px 13px; border-radius: 999px; font-size: 14px; font-weight: 600;
    color: var(--navy-2, #5b6b73); text-decoration: none;
  }
  .switch a:hover { background: var(--cream-2, #f3ecd9); color: var(--navy, #173042); }
  .switch a.active { background: var(--navy, #173042); color: var(--cream-2, #f3ecd9); }

  .acct { margin-left: auto; display: flex; align-items: center; gap: 14px; font-size: 14px; }
  .acct .email { color: var(--navy-2, #5b6b73); }
  .acct .logout { color: var(--teal-deep, #1f7a8c); font-weight: 700; text-decoration: none; }

  .burger { display: none; }
  .menu { display: none; }

  @media (max-width: 760px) {
    /* Just the blue circle on phones, to free up nav space. */
    .wm { display: none; }
    .mark { width: 34px; height: 34px; }
    /* Account moves into the hamburger menu. */
    .acct { display: none; }
    .burger {
      display: inline-flex; align-items: center; justify-content: center;
      margin-left: auto; width: 44px; height: 34px; padding: 0;
      font-size: 20px; line-height: 1; cursor: pointer;
      background: var(--cream, #faf4e7); color: var(--navy, #173042);
      border: 2px solid var(--line, #e6ddc9); border-radius: 10px;
    }
    .menu[data-open] {
      display: flex; flex-direction: column; gap: 6px;
      margin: -16px 0 24px; padding: 12px 16px;
      background: var(--cream-2, #f3ecd9);
      border: 1.5px solid var(--line, #e6ddc9); border-radius: 12px;
      box-shadow: 0 14px 30px rgba(8, 40, 60, .14);
    }
    .menu ::slotted(*) { width: 100%; }
    .menu-acct {
      display: flex; flex-direction: column; gap: 8px;
      margin-top: 6px; padding-top: 12px;
      border-top: 1.5px solid var(--line, #e6ddc9);
    }
    .menu-acct .email { color: var(--navy-2, #5b6b73); font-size: 14px; overflow-wrap: anywhere; }
    .menu-acct .logout { color: var(--teal-deep, #1f7a8c); font-weight: 700; font-size: 14px; text-decoration: none; }
  }
</style>
<header class="bar">
  <a class="brand" id="home">
    <img class="mark" src="/brand/logomark-round.svg" alt="">
    <span class="wm">Snagged</span>
  </a>
  <nav class="switch" id="switch"></nav>
  <span class="acct" id="acct">
    <span class="email" id="email-d"></span>
    <a class="logout" id="logout-d">Log out</a>
  </span>
  <button class="burger" id="burger" type="button" aria-label="Menu" aria-expanded="false">&#9776;</button>
</header>
<div class="menu" id="menu">
  <slot name="menu"></slot>
  <div class="menu-acct" id="menu-acct">
    <span class="email" id="email-m"></span>
    <a class="logout" id="logout-m">Log out</a>
  </div>
</div>`;

  class SnaggedTopbar extends HTMLElement {
    static get observedAttributes() {
      return ['current', 'email', 'show-research', 'show-admin', 'home-href', 'research-href', 'admin-href', 'logout-href'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).appendChild(TPL.content.cloneNode(true));
      const sr = this.shadowRoot;
      this._burger = sr.getElementById('burger');
      this._menu = sr.getElementById('menu');
      this._burger.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(); });
      // Close after activating any link/button inside the menu (e.g. a sub-nav item).
      this._menu.addEventListener('click', (e) => { if (e.target.closest('a, button')) this._close(); });
      // Close when tapping outside the component.
      this._onDocClick = (e) => { if (!e.composedPath().includes(this)) this._close(); };
      document.addEventListener('click', this._onDocClick);
    }
    disconnectedCallback() { document.removeEventListener('click', this._onDocClick); }
    connectedCallback() { this._render(); }
    attributeChangedCallback() { this._render(); }

    _toggle() { this._menu.hasAttribute('data-open') ? this._close() : this._open(); }
    _open() { this._menu.setAttribute('data-open', ''); this._burger.setAttribute('aria-expanded', 'true'); }
    _close() { this._menu.removeAttribute('data-open'); this._burger.setAttribute('aria-expanded', 'false'); }

    _render() {
      const sr = this.shadowRoot;
      const attr = (n, d) => this.getAttribute(n) || d;
      const cur = attr('current', '');
      const email = attr('email', '');
      const logout = attr('logout-href', '/api/logout');

      sr.getElementById('home').setAttribute('href', attr('home-href', '/'));

      const sw = sr.getElementById('switch');
      sw.textContent = '';
      if (this.hasAttribute('show-research')) sw.appendChild(this._link(attr('research-href', '/research'), 'Research', cur === 'research'));
      if (this.hasAttribute('show-admin')) sw.appendChild(this._link(attr('admin-href', '/admin'), 'Admin', cur === 'admin'));

      sr.getElementById('email-d').textContent = email;
      sr.getElementById('email-m').textContent = email;
      sr.getElementById('logout-d').setAttribute('href', logout);
      sr.getElementById('logout-m').setAttribute('href', logout);

      // Hide the account entirely until we know who's signed in.
      const show = email ? '' : 'none';
      sr.getElementById('acct').style.display = show;
      sr.getElementById('menu-acct').style.display = show;
    }
    _link(href, label, active) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (active) a.className = 'active';
      return a;
    }
  }

  customElements.define('snagged-topbar', SnaggedTopbar);
})();
