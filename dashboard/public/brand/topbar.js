// ─────────────────────────────────────────────────────────────────────────
// <snagged-topbar> — the ONE shared top bar for every Snagged surface.
//
// CANONICAL COPY lives here (umbrella). It is MIRRORED verbatim into the
// research repo at domain-research/public/topbar.js so each app serves the file
// from its OWN deployment (no cross-origin asset routing to depend on). The two
// files must stay byte-identical — edit here, copy there. The only per-app
// difference is the `logo-src` attribute passed in the markup.
//
// Styles live in this component's Shadow DOM, so they're fully encapsulated —
// no cross-app source-order / specificity collisions. Brand color tokens
// (--navy, --cream-2, …) are inherited from the host page through the shadow
// boundary; hard fallbacks are provided so the bar still renders if a token is
// missing.
//
// Usage:
//   <script src="/brand/topbar.js" defer></script>
//   <snagged-topbar current="research" email="you@x.com" show-research show-admin
//                   logo-src="/brand/logomark-round.svg"></snagged-topbar>
//
// Attributes:
//   current        "research" | "admin" | ""   — which switcher link is active
//   email          signed-in email (account block); empty hides the account
//   show-research  present → render the Research switch link
//   show-admin     present → render the Admin switch link
//   logo-src       logomark URL           (default "/brand/logomark-round.svg")
//   home-href      logo target            (default "/")
//   research-href  Research link target   (default "/research")
//   admin-href     Admin link target      (default "/admin")
//   logout-href    Log out target         (default "/api/logout")
//
// Mobile (≤760px): the wordmark drops to just the blue circle, the account
// moves into a top-right hamburger menu, and any module sub-nav the app passes
// via `slot="menu"` is shown in that same menu. On desktop the slotted menu is
// hidden (apps render their own desktop sub-nav).
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
    .wm { display: none; }
    .mark { width: 34px; height: 34px; }
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
    <img class="mark" id="mark" alt="">
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
      return ['current', 'email', 'show-research', 'show-admin', 'logo-src', 'home-href', 'research-href', 'admin-href', 'logout-href'];
    }
    constructor() {
      super();
      const sr = this.attachShadow({ mode: 'open' });
      sr.appendChild(TPL.content.cloneNode(true));
      this._burger = sr.querySelector('#burger');
      this._menu = sr.querySelector('#menu');
      this._burger.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(); });
      this._menu.addEventListener('click', (e) => { if (e.target.closest('a, button')) this._close(); });
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
      if (!sr) return;
      const attr = (n, d) => this.getAttribute(n) || d;
      const cur = attr('current', '');
      const email = attr('email', '');
      const logout = attr('logout-href', '/api/logout');

      sr.querySelector('#mark').setAttribute('src', attr('logo-src', '/brand/logomark-round.svg'));
      sr.querySelector('#home').setAttribute('href', attr('home-href', '/'));

      const sw = sr.querySelector('#switch');
      sw.textContent = '';
      if (this.hasAttribute('show-research')) sw.appendChild(this._link(attr('research-href', '/research'), 'Research', cur === 'research'));
      if (this.hasAttribute('show-admin')) sw.appendChild(this._link(attr('admin-href', '/admin'), 'Admin', cur === 'admin'));

      sr.querySelector('#email-d').textContent = email;
      sr.querySelector('#email-m').textContent = email;
      sr.querySelector('#logout-d').setAttribute('href', logout);
      sr.querySelector('#logout-m').setAttribute('href', logout);

      const show = email ? '' : 'none';
      sr.querySelector('#acct').style.display = show;
      sr.querySelector('#menu-acct').style.display = show;
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
