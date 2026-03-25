// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/activity-log.js
// PURPOSE: Activity Log — shows all stock events across all variants.
//          Filterable by event type and time window.
//          Reads from variants/{vid}/events subcollections.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  EVENT LOADER
// §5  LIST RENDER
// §6  EVENT ROW
// §7  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, fmtCurrency, emptyState } from '../ui.js';
import { dbList, dbListSub, paths } from '../db.js';
import {
  EVENT_STOCK_IN, EVENT_STOCK_OUT, EVENT_RESERVE,
  EVENT_RELEASE, EVENT_ADJUSTMENT, EVENT_RECONCILIATION,
} from '../inventory.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session     = null;
let _onBack      = null;  // callback to return to More menu
let _allEvents   = []; // flat array of enriched events from all variants
let _filterType  = 'all';
let _filterTime  = 'all';


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// Called from more.js _renderActivityLog() or directly
// ════════════════════════════════════════════════════════════════════════

export async function renderActivityLog(session, onBack) {
  _onBack = onBack || null;
  _session    = session;
  _filterType = 'all';
  _filterTime = 'all';
  console.log('[activityLog.renderActivityLog] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Loading activity log…');

  await _loadEvents();
  _renderLog();
}


// ════════════════════════════════════════════════════════════════════════
// §4 EVENT LOADER
// Loads events from all variants and flattens into one sorted array.
// ════════════════════════════════════════════════════════════════════════

async function _loadEvents() {
  const p = paths(_session.businessId);
  _allEvents = [];

  try {
    // Load all variants
    const variantsResult = await dbList(p.variants);
    if (!variantsResult.ok) return;

    const variants = variantsResult.data;

    // Load all products for name lookup
    const prodsResult = await dbList(p.products);
    const products    = prodsResult.ok ? prodsResult.data : [];

    // Load events from each variant in parallel
    const eventArrays = await Promise.all(
      variants.map(async v => {
        try {
          const result = await dbListSub(p.variants, v.id, 'events');
          if (!result.ok) return [];

          // Enrich events with product/variant names
          const product = products.find(p => p.id === v.product_id);
          return result.data.map(e => ({
            ...e,
            productName: product?.name   || 'Unknown product',
            variantSize: v.size          || '',
            variantId:   v.id,
          }));
        } catch(err) {
          console.warn('[activityLog._loadEvents] failed for variant', v.id, err?.message);
          return [];
        }
      })
    );

    // Flatten and sort by created_at descending
    _allEvents = eventArrays
      .flat()
      .sort((a, b) => (b.created_at || '') > (a.created_at || '') ? 1 : -1);

    console.log('[activityLog._loadEvents] loaded', { count: _allEvents.length });

  } catch(e) {
    console.error('[activityLog._loadEvents] failed', e);
    _allEvents = [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 LIST RENDER
// ════════════════════════════════════════════════════════════════════════

function _renderLog() {
  // Apply filters
  let filtered = _allEvents;

  if (_filterType !== 'all') {
    filtered = filtered.filter(e => e.type === _filterType);
  }

  if (_filterTime !== 'all') {
    const now   = new Date();
    const start = new Date();
    if (_filterTime === 'today') {
      start.setHours(0, 0, 0, 0);
    } else if (_filterTime === 'week') {
      start.setDate(now.getDate() - 7);
    } else if (_filterTime === 'month') {
      start.setDate(now.getDate() - 30);
    }
    filtered = filtered.filter(e => new Date(e.created_at || '') >= start);
  }

  render(`
    <div class="wrap" style="padding-bottom:40px">

      <button class="back-btn" id="sub-back-btn">‹ Back</button>
      <div class="subscreen-title" style="margin-bottom:4px">Activity Log</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:14px">
        ${_allEvents.length} total event${_allEvents.length !== 1 ? 's' : ''}
      </div>

      <!-- Type filters -->
      <div class="inv-filter-row" style="margin-bottom:8px">
        ${[
          ['all',                      'All'],
          [EVENT_STOCK_IN,             '↑ Stock In'],
          [EVENT_STOCK_OUT,            '↓ Stock Out'],
          [EVENT_RESERVE,              '🔒 Reserved'],
          [EVENT_RELEASE,              '🔓 Released'],
          [EVENT_ADJUSTMENT,           '✎ Adjusted'],
        ].map(([type, label]) =>
          `<button class="inv-filter-chip ${_filterType === type ? 'active' : ''}" data-type="${esc(type)}">${label}</button>`
        ).join('')}
      </div>

      <!-- Time filters -->
      <div class="inv-filter-row" style="margin-bottom:16px">
        ${[
          ['all',   'All Time'],
          ['today', 'Today'],
          ['week',  'This Week'],
          ['month', 'Last 30 Days'],
        ].map(([time, label]) =>
          `<button class="inv-filter-chip ${_filterTime === time ? 'active' : ''}" data-time="${time}">${label}</button>`
        ).join('')}
      </div>

      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">
        Showing ${filtered.length} record${filtered.length !== 1 ? 's' : ''}
      </div>

      <!-- Events list -->
      ${filtered.length
        ? filtered.map(_renderEventRow).join('')
        : emptyState('📋', 'No activity', _allEvents.length === 0
            ? 'Stock movements will appear here.'
            : 'No events match the current filter.')
      }

    </div>
  `);

  // Back button
  document.getElementById('sub-back-btn')?.addEventListener('click', () =>
    _onBack ? _onBack() : window.switchScreen('more')
  );

  // Wire type filters
  document.querySelectorAll('[data-type]').forEach(btn =>
    btn.addEventListener('click', () => {
      _filterType = btn.dataset.type;
      _renderLog();
    })
  );

  // Wire time filters
  document.querySelectorAll('[data-time]').forEach(btn =>
    btn.addEventListener('click', () => {
      _filterTime = btn.dataset.time;
      _renderLog();
    })
  );
}


// ════════════════════════════════════════════════════════════════════════
// §6 EVENT ROW
// ════════════════════════════════════════════════════════════════════════

function _renderEventRow(event) {
  const typeConfig = {
    [EVENT_STOCK_IN]:       { icon: '↑', color: 'var(--grn2)',  label: 'Stock In',  sign: '+' },
    [EVENT_STOCK_OUT]:      { icon: '↓', color: 'var(--red)',   label: 'Stock Out', sign: '−' },
    [EVENT_RESERVE]:        { icon: '🔒', color: 'var(--gold)', label: 'Reserved',  sign: '🔒' },
    [EVENT_RELEASE]:        { icon: '🔓', color: 'var(--muted)',label: 'Released',  sign: '🔓' },
    [EVENT_ADJUSTMENT]:     { icon: '✎', color: 'var(--gold)',  label: 'Adjusted',  sign: '±' },
    [EVENT_RECONCILIATION]: { icon: '🔍', color: 'var(--blue)', label: 'Reconciled',sign: '=' },
  };

  const config = typeConfig[event.type] || { icon: '?', color: 'var(--muted)', label: event.type, sign: '' };

  const dateStr = event.created_at
    ? new Date(event.created_at).toLocaleString('en-IN', {
        day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
      })
    : '—';

  const qty        = Number(event.quantity || 0);
  const deltaTotal = event.delta_total ?? null;

  // For adjustments: use stored delta_total sign (written since latest build).
  // For older events without delta_total, fall back to reason text.
  let sign = config.sign;
  if (config.sign === '±') {
    if (deltaTotal !== null) {
      sign = deltaTotal >= 0 ? '+' : '−';
    } else {
      const reason = (event.reason || '').toLowerCase();
      sign = reason.includes('deduct') ? '−' : '+';
    }
  }
  const qtyStr = qty > 0 ? `${sign}${qty}` : `${qty}`;

  // For adjustments: red if deduction, green if addition
  const displayColor = config.sign === '±'
    ? (sign === '−' ? 'var(--red)' : 'var(--grn2)')
    : config.color;

  return `
    <div class="actlog-row">
      <div class="actlog-icon" style="background:${displayColor}22;color:${displayColor}">
        ${config.icon}
      </div>
      <div class="actlog-info">
        <div class="actlog-name">
          ${esc(event.productName)}${event.variantSize ? ` <span style="color:var(--muted);font-size:11px">${esc(event.variantSize)}</span>` : ''}
        </div>
        <div class="actlog-meta">
          ${esc(config.label)}
          ${event.reason ? ` · ${esc(event.reason)}` : ''}
          · ${esc(event.source || '')}
        </div>
        <div class="actlog-date">${esc(dateStr)}</div>
      </div>
      <div class="actlog-qty" style="color:${displayColor}">${esc(qtyStr)}</div>
    </div>
  `;
}


// ════════════════════════════════════════════════════════════════════════
// §7 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('actlog-styles')) return;
  const s = document.createElement('style');
  s.id = 'actlog-styles';
  s.textContent = `
.actlog-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--bdr)}
.actlog-row:last-child{border-bottom:none}
.actlog-icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.actlog-info{flex:1;min-width:0}
.actlog-name{font-size:13px;font-weight:600;margin-bottom:2px}
.actlog-meta{font-size:11px;color:var(--muted)}
.actlog-date{font-size:10px;color:var(--muted);margin-top:1px}
.actlog-qty{font-size:14px;font-weight:700;flex-shrink:0}
`;
  document.head.appendChild(s);
}
