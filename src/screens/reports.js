// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/reports.js
// PURPOSE: Reports screen — manager/owner only.
//          Top products, stock value, movement summary, low stock summary.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  REPORT SECTIONS
// §5  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, fmtCurrency, emptyState } from '../ui.js';
import { searchProducts, loadCache, isCacheLoaded } from '../services/products.js';
import { dbListSub, dbList, dbQuery, paths } from '../db.js';
import {
  EVENT_STOCK_IN, EVENT_STOCK_OUT,
  EVENT_RESERVE, EVENT_RELEASE,
} from '../inventory.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session  = null;
let _onBack      = null;
let _allEvents = [];
let _products  = [];
let _orders    = []; // dispatched + delivered orders for revenue stats


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderReports(session, onBack) {
  _onBack = onBack || null;
  _session = session;
  console.log('[reports.renderReports] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Building reports…');

  if (!isCacheLoaded()) await loadCache(session.businessId);

  _products  = searchProducts('');
  await Promise.all([_loadEvents(), _loadOrders()]);
  _render();

  // Back button — wired after render
  setTimeout(() => {
    document.getElementById('sub-back-btn')?.addEventListener('click', () =>
      _onBack ? _onBack() : window.switchScreen('more')
    );
  }, 0);
}

async function _loadEvents() {
  const p = paths(_session.businessId);
  _allEvents = [];

  try {
    const variantsResult = await dbList(p.variants);
    if (!variantsResult.ok) return;

    const variants     = variantsResult.data;
    const prodsResult  = await dbList(p.products);
    const productDocs  = prodsResult.ok ? prodsResult.data : [];

    const arrays = await Promise.all(
      variants.map(async v => {
        try {
          const r = await dbListSub(p.variants, v.id, 'events');
          if (!r.ok) return [];
          const prod = productDocs.find(p => p.id === v.product_id);
          return r.data.map(e => ({
            ...e,
            productName: prod?.name || '',
            variantSize: v.size     || '',
            variantId:   v.id,
          }));
        } catch(e) { return []; }
      })
    );

    _allEvents = arrays.flat().sort((a, b) => (b.created_at || '') > (a.created_at || '') ? 1 : -1);
    console.log('[reports._loadEvents]', { count: _allEvents.length });
  } catch(e) {
    console.error('[reports._loadEvents] failed', e);
  }
}


async function _loadOrders() {
  const p = paths(_session.businessId);
  try {
    const r = await dbQuery(p.orders, [], [{ field: 'created_at', direction: 'desc' }], 500);
    _orders = r.ok ? r.data : [];
  } catch(e) {
    console.warn('[reports._loadOrders] failed (non-critical):', e?.message);
    _orders = [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 REPORT SECTIONS
// ════════════════════════════════════════════════════════════════════════

function _render() {
  // ── Time windows ──────────────────────────────────────────────────────
  const now    = new Date();
  const day30  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recent = _allEvents.filter(e => new Date(e.created_at || '') >= day30);

  // ── Revenue (from orders) ─────────────────────────────────────────────
  const fulfilledOrders30 = _orders.filter(o =>
    (o.status === 'dispatched' || o.status === 'delivered') &&
    new Date(o.created_at || '') >= day30
  );
  const revenue30    = fulfilledOrders30.reduce((s, o) => s + Number(o.total_value || o.value || 0), 0);
  const orderCount30 = fulfilledOrders30.length;
  const pendingOrders = _orders.filter(o => o.status === 'confirmed').length;

  // ── Stock value ───────────────────────────────────────────────────────
  let totalValue = 0;
  for (const product of _products) {
    for (const v of product.variants) {
      totalValue += v.available * v.price;
    }
  }

  // ── Top stocked in (30 days) ──────────────────────────────────────────
  const inMap = {};
  recent.filter(e => e.type === EVENT_STOCK_IN).forEach(e => {
    const key = `${e.productName}${e.variantSize ? ' ' + e.variantSize : ''}`;
    inMap[key] = (inMap[key] || 0) + Number(e.quantity || 0);
  });
  const topIn = Object.entries(inMap).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // ── Top sold / dispatched (30 days) ───────────────────────────────────
  const outMap = {};
  recent.filter(e => e.type === EVENT_STOCK_OUT).forEach(e => {
    const key = `${e.productName}${e.variantSize ? ' ' + e.variantSize : ''}`;
    outMap[key] = (outMap[key] || 0) + Number(e.quantity || 0);
  });
  const topOut = Object.entries(outMap).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // ── Low stock summary ─────────────────────────────────────────────────
  const lowItems = _products
    .flatMap(p => p.variants.filter(v => v.isLowStock || v.isOutOfStock).map(v => ({
      name:   p.name + (v.size ? ' ' + v.size : ''),
      stock:  v.stockLabel,
      isOut:  v.isOutOfStock,
    })))
    .sort((a, b) => (a.isOut ? 0 : 1) - (b.isOut ? 0 : 1));

  // ── Movement summary (30 days) ────────────────────────────────────────
  const totalIn  = recent.filter(e => e.type === EVENT_STOCK_IN) .reduce((s, e) => s + Number(e.quantity||0), 0);
  const totalOut = recent.filter(e => e.type === EVENT_STOCK_OUT).reduce((s, e) => s + Number(e.quantity||0), 0);
  const reserved = recent.filter(e => e.type === EVENT_RESERVE)  .reduce((s, e) => s + Number(e.quantity||0), 0);

  render(`
    <div class="wrap" style="padding-bottom:40px">

      <button class="back-btn" id="sub-back-btn">‹ Back</button>
      <div class="subscreen-title" style="margin-bottom:4px">Reports</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:16px">Last updated now · Last 30 days unless noted</div>

      <!-- Summary stats -->
      <div class="stats-row" style="grid-template-columns:repeat(2,1fr);margin-bottom:14px">
        <div class="stat-box">
          <div class="stat-value" style="color:var(--grn2)">${fmtCurrency(revenue30)}</div>
          <div class="stat-label">Revenue (30 days)</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${orderCount30}</div>
          <div class="stat-label">Orders Fulfilled</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--gold)">${fmtCurrency(totalValue)}</div>
          <div class="stat-label">Stock Value</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:${pendingOrders > 0 ? 'var(--gold)' : 'var(--muted)'}">${pendingOrders}</div>
          <div class="stat-label">Awaiting Dispatch</div>
        </div>
      </div>

      <!-- 30-day movement -->
      <div class="card" style="margin-bottom:12px">
        <div class="section-title">30-Day Movement</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <div style="text-align:center">
            <div style="font-size:18px;font-weight:600;color:var(--grn2)">+${totalIn}</div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">Stocked In</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:18px;font-weight:600;color:var(--red)">−${totalOut}</div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">Dispatched</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:18px;font-weight:600;color:var(--gold)">${reserved}</div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">Reserved</div>
          </div>
        </div>
      </div>

      <!-- Top stocked in -->
      <div class="card" style="margin-bottom:12px">
        <div class="section-title">Most Stocked In (30 days)</div>
        ${topIn.length
          ? topIn.map(([name, qty]) => `
            <div class="rep-row">
              <span class="rep-name">${esc(name)}</span>
              <span class="rep-val" style="color:var(--grn2)">+${qty}</span>
            </div>`).join('')
          : '<div style="font-size:12px;color:var(--muted)">No stock IN in last 30 days.</div>'
        }
      </div>

      <!-- Top dispatched -->
      <div class="card" style="margin-bottom:12px">
        <div class="section-title">Most Dispatched (30 days)</div>
        ${topOut.length
          ? topOut.map(([name, qty]) => `
            <div class="rep-row">
              <span class="rep-name">${esc(name)}</span>
              <span class="rep-val" style="color:var(--red)">−${qty}</span>
            </div>`).join('')
          : '<div style="font-size:12px;color:var(--muted)">No dispatches in last 30 days.</div>'
        }
      </div>

      <!-- Low stock -->
      <div class="card">
        <div class="section-title">Needs Attention</div>
        ${lowItems.length
          ? lowItems.slice(0, 12).map(item => `
            <div class="rep-row">
              <span class="rep-name">${esc(item.name)}</span>
              <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px;${item.isOut ? 'background:var(--rdim);color:var(--red)' : 'background:rgba(201,168,76,.12);color:var(--gold)'}">
                ${esc(item.stock)}
              </span>
            </div>`).join('')
          : '<div style="font-size:12px;color:var(--muted)">All products well stocked 🎉</div>'
        }
      </div>

    </div>
  `);
}


// ════════════════════════════════════════════════════════════════════════
// §5 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('reports-styles')) return;
  const s = document.createElement('style');
  s.id = 'reports-styles';
  s.textContent = `
.rep-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--bdr);gap:8px}
.rep-row:last-child{border-bottom:none}
.rep-name{flex:1;min-width:0;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rep-val{font-size:13px;font-weight:700;flex-shrink:0}
`;
  document.head.appendChild(s);
}
