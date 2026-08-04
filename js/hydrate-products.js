// Hydration for the four product pages (index.html / pens.html /
// photoframes.html / stands.html). Fetches /api/products and rewrites the
// existing .product-card blocks in place — the static HTML stays as the
// no-JS / pre-fetch fallback. After hydration, calls the existing
// window.silverPriceUpdater.updateAllProductPrices() so new weights drive
// new prices + WhatsApp hrefs.

(function () {
  'use strict';

  function pageSlugFromLocation() {
    var path = (location.pathname || '').toLowerCase();
    if (path.endsWith('/pens.html') || path.endsWith('pens.html')) return 'pens';
    if (path.endsWith('/photoframes.html') || path.endsWith('photoframes.html')) return 'frames';
    if (path.endsWith('/stands.html') || path.endsWith('stands.html')) return 'stands';
    if (path.endsWith('/index.html') || path.endsWith('index.html') || path === '/' || path === '') return 'home';
    return null;
  }

  async function fetchJson(url) {
    try {
      var res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function rewriteCard(card, product, availableImages) {
    card.setAttribute('data-weight', String(product.weight));
    card.setAttribute('data-making-charge', String(product.makingCharge));
    card.setAttribute('data-product-id', product.id);
    card.setAttribute('data-order', String(product.order));

    var img = card.querySelector('.product-img-box img');
    if (img) {
      img.alt = product.imageAlt || '';
      var filename = product.image || '';
      var known = availableImages === null ||
                  availableImages.size === 0 ||
                  availableImages.has(filename);
      if (known && filename) {
        img.src = 'images/' + filename;
      } else {
        img.removeAttribute('src');
      }
    }

    var h3 = card.querySelector('.product-info h3');
    if (h3) h3.textContent = product.title || '';

    var desc = card.querySelector('.product-description');
    if (desc) desc.textContent = product.description || '';

    var weightEl = card.querySelector('.product-meta .weight');
    if (weightEl) {
      weightEl.setAttribute('data-weight', String(product.weight));
      weightEl.textContent = 'Weight: ' + product.weight + 'g';
    }

    card.classList.add('hydrated');
  }

  function reorderGrid(grid, cards) {
    var ordered = cards
      .map(function (c) { return { c: c, o: Number(c.getAttribute('data-order')) || 0 }; })
      .sort(function (a, b) { return a.o - b.o; })
      .map(function (x) { return x.c; });
    ordered.forEach(function (c) { grid.appendChild(c); });
  }

  async function hydrate() {
    var slug = pageSlugFromLocation();
    if (!slug) return;

    var data = await fetchJson('/api/products');
    if (!data || !data.products || !data.products.pages) return;

    var page = data.products.pages[slug];
    if (!page || !Array.isArray(page.products) || page.products.length === 0) return;

    var sorted = page.products.slice().sort(function (a, b) { return a.order - b.order; });

    var availableImages = null;
    var imgData = await fetchJson('/api/images');
    if (imgData && Array.isArray(imgData.images)) {
      availableImages = new Set(imgData.images.map(function (p) {
        return String(p).replace(/^images\//, '');
      }));
    }

    var cards = Array.prototype.slice.call(document.querySelectorAll('.product-card'));
    for (var i = 0; i < cards.length && i < sorted.length; i++) {
      rewriteCard(cards[i], sorted[i], availableImages);
    }

    var grid = document.querySelector('.gallery-grid');
    if (grid) reorderGrid(grid, cards);

    if (window.silverPriceUpdater &&
        typeof window.silverPriceUpdater.updateAllProductPrices === 'function') {
      window.silverPriceUpdater.updateAllProductPrices();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
})();
