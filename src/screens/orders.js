// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/orders.js
// PURPOSE: Orders screen — list orders, create new order, AI order taker.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  ORDER LIST
// §5  ORDER CARD
// §6  AI ORDER TAKER MODAL
// §7  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, fmtCurrency, orderStatusBadge, emptyState } from '../ui.js';
import { listOrders, createOrder, addOrderItem, updateOrderStatus } from '../services/orders.js';
import { searchByPhone, searchByName }             from '../services/customers.js';
import { loadCache, isCacheLoaded }              from '../services/products.js';
import { renderOrderCreate, renderOrderEdit }    from './order-create.js';
import { analyseMessage }                        from '../ai/order-agent.js';
import { renderOrderDetail }                     from './order-detail.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session     = null;
let _activeTab   = 'all';
let _orders      = [];
let _agentSource  = 'whatsapp';
let _agentResult  = null;
let _ordersLimit  = 100;


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderOrders(session) {
  _session = session;
  console.log('[orders.renderOrders] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Loading orders…');

  // Ensure product cache is loaded for order creation
  if (!isCacheLoaded()) {
    await loadCache(session.businessId);
  }

  await _loadOrders();
  _renderOrderList();
}


// ════════════════════════════════════════════════════════════════════════
// §4 ORDER LIST
// ════════════════════════════════════════════════════════════════════════

async function _loadOrders() {
  const result = await listOrders(_session.businessId, { limitCount: _ordersLimit });
  _orders = result.ok ? result.data : [];
  console.log('[orders._loadOrders]', { count: _orders.length });
}

function _renderOrderList() {
  const counts = {
    all:        _orders.length,
    draft:      _orders.filter(o => o.status === 'draft').length,
    confirmed:  _orders.filter(o => o.status === 'confirmed').length,
    dispatched: _orders.filter(o => o.status === 'dispatched').length,
    delivered:  _orders.filter(o => o.status === 'delivered').length,
    cancelled:  _orders.filter(o => o.status === 'cancelled').length,
  };

  const filtered = _activeTab === 'all'
    ? _orders
    : _orders.filter(o => o.status === _activeTab);

  // Only show tabs that have orders (or are active), to keep the tab bar clean
  const tabDefs = [
    ['all',        'All',        counts.all,        true],
    ['draft',      'Draft',      counts.draft,       true],
    ['confirmed',  'Confirmed',  counts.confirmed,   true],
    ['dispatched', 'Dispatched', counts.dispatched,  true],
    ['delivered',  'Delivered',  counts.delivered,   counts.delivered > 0 || _activeTab === 'delivered'],
    ['cancelled',  'Cancelled',  counts.cancelled,   counts.cancelled > 0 || _activeTab === 'cancelled'],
  ].filter(([,,,show]) => show);

  render(`
    <div class="wrap" style="padding-bottom:160px">

      <!-- Status tabs -->
      <div class="orders-tabs">
        ${tabDefs.map(([id, label, count]) => `
          <button class="orders-tab ${_activeTab === id ? 'active' : ''}" data-tab="${id}">
            ${label}${count > 0 ? ` <span class="orders-tab-badge">${count}</span>` : ''}
          </button>
        `).join('')}
      </div>

      <!-- Order list -->
      <div id="orders-list">
        ${filtered.length
          ? filtered.map(_renderOrderCard).join('')
          : emptyState('📋', 'No orders',
              _activeTab === 'all'
                ? 'Tap ＋ to create your first order.'
                : `No ${_activeTab} orders.`
            )
        }
      </div>

      ${(_activeTab === 'all' && _orders.length >= _ordersLimit) ? `
      <div style="text-align:center;padding:16px 0">
        <button class="btn btn-secondary btn-small" id="btn-load-more-orders"
          style="font-size:12px">Load more orders</button>
      </div>` : ''}
    </div>

    <!-- New Order FAB -->
    <button class="fab fab-primary" id="fab-new-order" title="New Order">＋</button>

    <!-- AI Order Taker FAB -->
    <button class="fab fab-ai" id="fab-ai-order" title="AI Order Taker">🤖</button>

    <!-- AI Order Taker Modal -->
    <div class="agent-overlay hide" id="agent-overlay">
      <div class="agent-modal">
        <div class="agent-modal-header">
          <div class="agent-modal-title">🤖 AI Order Taker</div>
          <button class="agent-close-btn" id="agent-close">✕</button>
        </div>

        <div class="agent-source-row">
          <button class="agent-src-btn active" data-src="whatsapp">💬 WhatsApp</button>
          <button class="agent-src-btn" data-src="instagram">📸 Instagram</button>
          <button class="agent-src-btn" data-src="manual">✍ Manual</button>
        </div>

        <textarea class="input agent-msg-input" id="agent-msg"
          placeholder="Paste the customer message here…&#10;e.g. Hi, I'd like 5 Rose Bush Small and 2 Lavender. — Priya, +91 98765 43210" rows="5"></textarea>

        <button class="btn btn-primary" id="agent-analyse-btn"
          style="width:100%;justify-content:center;margin-top:10px">
          🤖 Analyse
        </button>

        <div id="agent-status" style="margin-top:10px;font-size:12px;display:none"></div>

        <div id="agent-preview" class="hide">

          <!-- Customer — filled dynamically (chip if existing, fields if new) -->
          <div id="agent-customer-section" style="margin-top:14px"></div>

          <!-- Items -->
          <div class="agent-section-label" style="margin-top:14px">Order Items</div>
          <div id="agent-items-list"></div>

          <div id="agent-total" style="font-size:13px;font-weight:600;color:var(--gold);text-align:right;margin-top:10px"></div>

          <button class="btn btn-primary" id="agent-create-btn" disabled
            style="width:100%;justify-content:center;margin-top:12px;padding:13px">
            ✓ Create Draft Order
          </button>
        </div>
      </div>
    </div>
  `);

  _wireEvents(filtered);
}


// ════════════════════════════════════════════════════════════════════════
// §5 ORDER CARD
// ════════════════════════════════════════════════════════════════════════

function _renderOrderCard(order) {
  const customer = order.is_walk_in ? 'Walk-in' : (order.customer_name || 'Unknown');
  const items    = `${order.items_count || 0} item${order.items_count !== 1 ? 's' : ''}`;
  const phone    = order.customer_phone && !order.is_walk_in ? order.customer_phone : '';
  return `
    <div class="order-card" data-order-id="${esc(order.id)}" data-status="${esc(order.status || 'draft')}">
      <div class="order-card-top">
        <div class="order-card-customer">${esc(customer)}${phone ? ` <span class="order-card-phone">${esc(phone)}</span>` : ''}</div>
        ${orderStatusBadge(order.status)}
      </div>
      <div class="order-card-meta">
        ${items}${order.total_value ? ' · ' + fmtCurrency(order.total_value) : ''}
        · ${_fmtRelative(order.created_at)}
      </div>
    </div>`;
}

function _fmtRelative(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1)    return 'just now';
  if (m < 60)   return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}


// ════════════════════════════════════════════════════════════════════════
// §6 AI ORDER TAKER MODAL
// ════════════════════════════════════════════════════════════════════════
// Flow:
//   1. Paste message → AI extracts customer + items
//   2. Customer matched against existing by phone/name → chip shown or new
//   3. Ambiguous variants shown as dropdowns to resolve
//   4. Unmatched items shown with ✕ — user can remove or keep (skipped on create)
//   5. Qty editable per item, items removable
//   6. "Create Draft Order" → creates order, links customer, adds items
// ════════════════════════════════════════════════════════════════════════

// _agentCustomer — resolved customer { id, name, phone } | null (new)
let _agentCustomer = null;

function _openAgentModal() {
  document.getElementById('agent-overlay')?.classList.remove('hide');
  document.getElementById('agent-msg')?.focus();
  // Reset state
  _agentResult   = null;
  _agentCustomer = null;
}

function _closeAgentModal() {
  document.getElementById('agent-overlay')?.classList.add('hide');
  _agentResult   = null;
  _agentCustomer = null;
}

function _setAgentStatus(msg, type) {
  const el = document.getElementById('agent-status');
  if (!el) return;
  el.textContent  = msg;
  el.style.color  = type === 'ok' ? 'var(--grn2)' : type === 'err' ? 'var(--red)' : type === 'warn' ? 'var(--gold)' : 'var(--muted)';
  el.style.display = msg ? 'block' : 'none';
}

async function _runAnalysis() {
  const msg = document.getElementById('agent-msg')?.value?.trim() || '';
  const btn = document.getElementById('agent-analyse-btn');
  if (!msg) { toast('Paste a message first', 'warn'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
  _setAgentStatus('Reading with AI…', 'muted');
  document.getElementById('agent-preview')?.classList.add('hide');

  const result = await analyseMessage(_session.businessId, msg, _agentSource);
  if (btn) { btn.disabled = false; btn.textContent = '🤖 Analyse'; }

  if (result.error) { _setAgentStatus('✕ ' + result.message, 'err'); return; }

  _agentResult   = result;
  _agentCustomer = null;

  // ── Customer matching ──────────────────────────────────────────────────
  const cName  = (result.customer?.name  || '').trim();
  const cPhone = (result.customer?.phone || '').trim();
  const custEl = document.getElementById('agent-customer-section');

  let matchedCustomer = null;

  // 1. Exact phone match — highest confidence
  if (cPhone) {
    const phoneResult = await searchByPhone(_session.businessId, cPhone);
    if (phoneResult.found) matchedCustomer = phoneResult.customer;
  }

  // 2. Name match — only if no phone match
  if (!matchedCustomer && cName) {
    const nameResult = await searchByName(_session.businessId, cName);
    if (nameResult.ok && nameResult.data?.length === 1) {
      matchedCustomer = nameResult.data[0];
    }
  }

  if (custEl) {
    if (matchedCustomer) {
      _agentCustomer = matchedCustomer;
      custEl.innerHTML = `
        <div class="agent-section-label">Customer</div>
        <div class="agent-cust-chip" id="agent-cust-chip">
          <div class="agent-cust-chip-info">
            <div class="agent-cust-chip-name">${esc(matchedCustomer.name)}</div>
            <div class="agent-cust-chip-meta">${esc(matchedCustomer.phone || '')}${matchedCustomer.total_orders > 0 ? ' · ' + matchedCustomer.total_orders + ' orders' : ''}</div>
          </div>
          <button class="agent-cust-chip-change" id="btn-agent-cust-change">Change</button>
        </div>`;
      document.getElementById('btn-agent-cust-change')?.addEventListener('click', () => {
        _agentCustomer = null;
        _renderAgentCustomerFields(cName, cPhone);
      });
    } else {
      _renderAgentCustomerFields(cName, cPhone);
    }
  }

  // ── Items summary status ───────────────────────────────────────────────
  const matched   = result.items.filter(i => i.matched).length;
  const ambiguous = result.items.filter(i => !i.matched && i.reason === 'ambiguous_variant').length;
  const notFound  = result.items.filter(i => !i.matched && i.reason === 'not_found').length;
  const parts = [
    matched   > 0 && `${matched} matched`,
    ambiguous > 0 && `${ambiguous} need variant pick`,
    notFound  > 0 && `${notFound} not found`,
  ].filter(Boolean).join(' · ');
  _setAgentStatus(`✓ ${parts}`, ambiguous || notFound ? 'warn' : 'ok');

  document.getElementById('agent-preview')?.classList.remove('hide');
  _renderAgentItems(result.items);
  _updateAgentTotal();
}

function _renderAgentCustomerFields(name, phone) {
  const custEl = document.getElementById('agent-customer-section');
  if (!custEl) return;
  custEl.innerHTML = `
    <div class="agent-section-label">Customer <span style="font-size:9px;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">— new</span></div>
    <div class="agent-customer-row">
      <input class="input" id="agent-c-name"  placeholder="Name"  value="${esc(name)}"  style="flex:1"/>
      <input class="input" id="agent-c-phone" placeholder="Phone" value="${esc(phone)}" style="flex:1" type="tel"/>
    </div>`;
}

function _renderAgentItems(items) {
  const listEl = document.getElementById('agent-items-list');
  if (!listEl) return;

  listEl.innerHTML = items.map((item, i) => {
    if (item.matched) {
      const lowStock = item.isLowStock  ? `<span style="color:var(--gold)">⚠ ${esc(item.stockLabel)}</span>` : '';
      const outStock = item.isOutOfStock ? `<span style="color:var(--red)">✕ Out of stock</span>` : '';
      return `<div class="agent-item-row" data-item-idx="${i}">
        <div class="agent-item-info">
          <span class="agent-item-name">${esc(item.productName)}${item.variantSize ? ' <span style=\"color:var(--muted);font-size:11px\">' + esc(item.variantSize) + '</span>' : ''}</span>
          <span class="agent-item-stock">${outStock || lowStock || esc(item.stockLabel || '')}</span>
        </div>
        <div class="agent-item-right">
          <span class="agent-item-price">${fmtCurrency(item.price)}</span>
          <div style="display:flex;align-items:center;gap:4px">
            <button class="oc-qty-btn agent-qty-dec" data-idx="${i}">−</button>
            <span class="oc-qty-val agent-qty-val" id="agent-qty-val-${i}">${item.qty||1}</span>
            <button class="oc-qty-btn agent-qty-inc" data-idx="${i}">＋</button>
          </div>
          <button class="oc-remove-btn agent-item-remove" data-idx="${i}" title="Remove">✕</button>
        </div>
      </div>`;
    }

    if (item.reason === 'ambiguous_variant') {
      return `<div class="agent-item-row" style="flex-direction:column;align-items:stretch;gap:7px;padding:10px;background:rgba(201,168,76,.05);border:1px solid rgba(201,168,76,.2);border-radius:8px" data-item-idx="${i}">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:12px;font-weight:600">${esc(item.rawText || item.productName || '')}</div>
            <div style="font-size:10px;color:var(--gold);margin-top:2px">⚠ Multiple variants — pick one</div>
          </div>
          <button class="oc-remove-btn agent-item-remove" data-idx="${i}" title="Remove">✕</button>
        </div>
        <select class="input agent-variant-pick" data-idx="${i}" style="font-size:12px;padding:6px 9px">
          <option value="">— select variant —</option>
          ${(item.variantOptions||[]).map(v =>
            `<option value="${esc(v.variantId)}" data-price="${v.price}" data-size="${esc(v.size||'Default')}" data-pid="${esc(item.productId||'')}">
              ${esc(v.size||'Default')} · ${esc(v.stockLabel)} · ${fmtCurrency(v.price)}
            </option>`
          ).join('')}
        </select>
      </div>`;
    }

    // Not found
    return `<div class="agent-item-row" style="opacity:.55" data-item-idx="${i}">
      <div class="agent-item-info">
        <span class="agent-item-name">${esc(item.rawText || item.productName || 'Unknown item')}</span>
        <span style="font-size:10px;color:var(--red)">✕ Not in inventory — will be skipped</span>
      </div>
      <button class="oc-remove-btn agent-item-remove" data-idx="${i}" title="Remove">✕</button>
    </div>`;

  }).join('');

  // Variant picker
  listEl.querySelectorAll('.agent-variant-pick').forEach(sel =>
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      const opt = sel.options[sel.selectedIndex];
      if (_agentResult?.items[idx] && opt.value) {
        _agentResult.items[idx].variantId   = opt.value;
        _agentResult.items[idx].variantSize = opt.dataset.size;
        _agentResult.items[idx].price       = Number(opt.dataset.price);
        _agentResult.items[idx].productId   = opt.dataset.pid || _agentResult.items[idx].productId;
        _agentResult.items[idx].matched     = true;
        _renderAgentItems(_agentResult.items);
        _updateAgentTotal();
      }
    })
  );

  // Qty −/＋
  listEl.querySelectorAll('.agent-qty-dec').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      if (!_agentResult?.items[i]) return;
      const newQty = Math.max(1, (_agentResult.items[i].qty || 1) - 1);
      _agentResult.items[i].qty = newQty;
      const valEl = document.getElementById(`agent-qty-val-${i}`);
      if (valEl) valEl.textContent = newQty;
      _updateAgentTotal();
    })
  );
  listEl.querySelectorAll('.agent-qty-inc').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      if (!_agentResult?.items[i]) return;
      const available = _agentResult.items[i].available ?? 999;
      const newQty    = Math.min(available, (_agentResult.items[i].qty || 1) + 1);
      if (newQty === available && _agentResult.items[i].qty >= available) {
        toast(`Only ${available} available`, 'warn'); return;
      }
      _agentResult.items[i].qty = newQty;
      const valEl = document.getElementById(`agent-qty-val-${i}`);
      if (valEl) valEl.textContent = newQty;
      _updateAgentTotal();
    })
  );

  // Remove
  listEl.querySelectorAll('.agent-item-remove').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      if (_agentResult?.items) {
        _agentResult.items.splice(i, 1);
        _renderAgentItems(_agentResult.items);
        _updateAgentTotal();
      }
    })
  );
}

function _updateAgentTotal() {
  const total   = (_agentResult?.items || []).filter(i => i.matched).reduce((s, i) => s + (i.qty||1)*(i.price||0), 0);
  const totalEl = document.getElementById('agent-total');
  if (totalEl) totalEl.textContent = total > 0 ? `Order Total: ${fmtCurrency(total)}` : '';
  // Update create button state
  const createBtn = document.getElementById('agent-create-btn');
  const matched   = (_agentResult?.items || []).filter(i => i.matched && i.variantId).length;
  if (createBtn) createBtn.disabled = matched === 0;
}

async function _createDraftFromAgent() {
  if (!_agentResult) return;

  // Resolve customer
  let customerId   = _agentCustomer?.id   || null;
  let customerName = _agentCustomer?.name || '';
  let customerPhone = _agentCustomer?.phone || '';

  if (!customerId) {
    // New customer — read from fields
    customerName  = document.getElementById('agent-c-name')?.value?.trim()  || '';
    customerPhone = document.getElementById('agent-c-phone')?.value?.trim() || '';
    if (!customerName && !customerPhone) {
      toast('Add a customer name or phone', 'warn'); return;
    }
  }

  const matched = (_agentResult.items || []).filter(i => i.matched && i.variantId);
  if (!matched.length) { toast('No matched items — resolve variants first', 'warn'); return; }

  const btn = document.getElementById('agent-create-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  try {
    // Create order
    const orderResult = await createOrder(_session.businessId, {
      customerId:    customerId,
      customerName:  customerName || 'Customer',
      customerPhone: customerPhone,
      isWalkIn:      !customerId && !customerPhone,
      createdBy:     _session.uid,
    });
    if (orderResult.error) { toast('Could not create order: ' + orderResult.message, 'err'); return; }

    // Add items
    for (const item of matched) {
      await addOrderItem(_session.businessId, orderResult.orderId, {
        productId:   item.productId,
        productName: item.productName,
        variantId:   item.variantId,
        variantSize: item.variantSize,
        quantity:    item.qty || 1,
        price:       item.price || 0,
      });
    }

    const skipped = (_agentResult.items || []).filter(i => !i.matched || !i.variantId).length;
    toast(`✓ Draft order created — ${matched.length} item${matched.length !== 1 ? 's' : ''}${skipped ? ', ' + skipped + ' skipped' : ''}`);
    _closeAgentModal();
    await _loadOrders();
    _renderOrderList();
  } catch(e) {
    console.error('[orders._createDraftFromAgent] failed', e);
    toast('Failed: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '✓ Create Draft Order'; }
  }
}


// ════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ════════════════════════════════════════════════════════════════════════

function _wireEvents() {
  document.querySelectorAll('.orders-tab').forEach(btn =>
    btn.addEventListener('click', () => { _activeTab = btn.dataset.tab; _renderOrderList(); })
  );

  // Load more orders
  document.getElementById('btn-load-more-orders')?.addEventListener('click', async () => {
    _ordersLimit += 100;
    await _loadOrders();
    _renderOrderList();
  });

  document.querySelectorAll('.order-card').forEach(card =>
    card.addEventListener('click', () => {
      const orderId = card.dataset.orderId;
      const status  = card.dataset.status;

      if (status === 'draft') {
        // Draft → open in edit mode
        renderOrderEdit(_session, orderId, async () => {
          await _loadOrders();
          _renderOrderList();
        });
      } else {
        // Confirmed / dispatched / etc → read-only detail
        renderOrderDetail(_session, orderId, async () => {
          await _loadOrders();
          _renderOrderList();
        });
      }
    })
  );

  document.getElementById('fab-new-order')?.addEventListener('click', () =>
    renderOrderCreate(_session)
  );

  document.getElementById('fab-ai-order')?.addEventListener('click', _openAgentModal);
  document.getElementById('agent-close')?.addEventListener('click', _closeAgentModal);

  document.querySelectorAll('.agent-src-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agent-src-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _agentSource = btn.dataset.src;
    })
  );

  document.getElementById('agent-analyse-btn')?.addEventListener('click', _runAnalysis);
  document.getElementById('agent-create-btn')?.addEventListener('click', _createDraftFromAgent);
  document.getElementById('agent-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'agent-overlay') _closeAgentModal();
  });
}


// ════════════════════════════════════════════════════════════════════════
// §7 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('orders-styles')) return;
  const s = document.createElement('style');
  s.id = 'orders-styles';
  s.textContent = `
.orders-tabs{display:flex;gap:4px;background:var(--sur);border:1px solid var(--bdr);border-radius:var(--r);padding:3px;margin-bottom:14px;overflow-x:auto;scrollbar-width:none}
.orders-tabs::-webkit-scrollbar{display:none}
.orders-tab{flex-shrink:0;padding:6px 12px;border-radius:6px;border:none;background:transparent;color:var(--muted);font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;transition:all .15s}
.orders-tab.active{background:var(--sur2);color:var(--grn2);border:1px solid var(--gbdr)}
.orders-tab-badge{background:var(--grn);color:#080f09;font-size:9px;font-weight:700;padding:1px 5px;border-radius:99px}
.order-card{background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);padding:13px 14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}
.order-card:hover{border-color:var(--bdr2)}
.order-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
.order-card-customer{font-size:14px;font-weight:600;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.order-card-phone{font-size:11px;font-weight:400;color:var(--muted)}
.order-card-meta{font-size:12px;color:var(--muted)}
.fab{position:fixed;width:52px;height:52px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:all .15s;z-index:400}
.fab:active{transform:scale(.92)}
.fab-primary{bottom:80px;right:16px;background:var(--grn);color:#080f09;font-size:28px;font-weight:300}
.fab-ai{bottom:144px;right:16px;background:var(--sur2);border:1px solid var(--bdr2);color:var(--txt2);font-size:20px}
.agent-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:flex-end;justify-content:center}
.agent-modal{background:var(--sur);border:1px solid var(--bdr2);border-radius:var(--rl) var(--rl) 0 0;padding:20px;width:100%;max-height:88vh;overflow-y:auto}
@media(min-width:560px){.agent-overlay{align-items:center;padding:16px}.agent-modal{border-radius:var(--rl);max-width:480px}}
.agent-modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.agent-modal-title{font-size:16px;font-weight:600}
.agent-close-btn{background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:5px}
.agent-source-row{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.agent-src-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--bdr2);background:var(--sur2);color:var(--muted);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.agent-src-btn.active{background:var(--gdim);border-color:var(--gbdr);color:var(--grn2)}
.agent-msg-input{width:100%;min-height:100px}
.agent-section-label{font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.7px;text-transform:uppercase;margin-bottom:7px;margin-top:4px}
.agent-customer-row{display:flex;gap:8px;flex-wrap:wrap}
.agent-customer-row .input{flex:1;min-width:120px;font-size:13px}
.agent-item-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--bdr)}
.agent-item-row:last-child{border-bottom:none}
.agent-item-info{flex:1;min-width:0}
.agent-item-name{font-size:12px;font-weight:600;display:block}
.agent-item-stock{font-size:10px;color:var(--muted)}
.agent-item-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.agent-item-price{font-size:12px;color:var(--grn2);font-weight:600}
.oc-wrap{max-width:720px;margin:0 auto;padding:14px 14px 200px}
.oc-section{margin-bottom:14px}
.oc-section-label{font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;margin-bottom:7px}
.oc-phone-wrap{display:flex;gap:8px}
.oc-phone-input{flex:1;font-size:15px}
.oc-walkin-btn{padding:8px 12px;border-radius:var(--r);border:1px solid var(--bdr2);background:var(--sur2);color:var(--muted);font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.oc-walkin-btn:hover{border-color:var(--bdr);color:var(--txt2)}
.oc-lookup-status{font-size:12px;color:var(--muted);padding:6px 0}
.oc-new-customer-label{font-size:12px;color:var(--grn2);padding:6px 0}
.oc-walkin-label{font-size:12px;color:var(--muted);padding:6px 0}
.oc-name-input{margin-top:7px;font-size:15px}
.oc-customer-found{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--gdim);border:1px solid var(--gbdr);border-radius:var(--r);margin-top:7px}
.oc-customer-found-info{flex:1}
.oc-customer-name{font-size:13px;font-weight:600}
.oc-customer-meta{font-size:11px;color:var(--muted);margin-top:2px}
.oc-chip-customer{display:inline-block;padding:3px 10px;background:var(--gdim);border:1px solid var(--gbdr);color:var(--grn2);border-radius:99px;font-size:11px;font-weight:600;margin-top:6px}
.oc-chip-walkin{display:inline-block;padding:3px 10px;background:var(--sur2);border:1px solid var(--bdr2);color:var(--muted);border-radius:99px;font-size:11px;margin-top:6px}
.oc-recent-chips{display:flex;gap:6px;flex-wrap:wrap}
.oc-recent-chip{padding:5px 11px;border-radius:99px;border:1px solid var(--bdr2);background:var(--sur2);color:var(--txt2);font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.oc-recent-chip:hover{border-color:var(--gbdr);background:var(--gdim);color:var(--grn2)}
.oc-search-wrap{position:relative;margin-bottom:8px}
.oc-search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none}
.oc-search-input{padding-left:34px}
.oc-no-results{font-size:12px;color:var(--muted);padding:10px 0}
.oc-product-group{margin-bottom:8px;background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);overflow:hidden}
.oc-product-name{font-size:10px;font-weight:700;color:var(--muted);padding:9px 12px 5px;letter-spacing:.5px;text-transform:uppercase}
.oc-variant-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-top:1px solid var(--bdr);transition:background .1s;cursor:pointer}
.oc-variant-row:hover:not(.oc-variant-out){background:var(--sur2)}
.oc-variant-out{opacity:.45;cursor:default}
.oc-variant-info{flex:1;min-width:0}
.oc-variant-size{font-size:13px;font-weight:500;display:block}
.oc-variant-stock{font-size:11px;color:var(--muted);display:block;margin-top:1px}
.oc-variant-stock.low{color:var(--gold)}
.oc-variant-stock.out{color:var(--red)}
.oc-variant-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.oc-variant-price{font-size:12px;font-weight:600;color:var(--grn2)}
.oc-add-btn{width:28px;height:28px;border-radius:50%;border:none;background:var(--grn);color:#080f09;font-size:20px;font-weight:300;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1}
.oc-add-btn:active{opacity:.7}
.oc-out-label{font-size:10px;color:var(--muted)}
.oc-summary-wrap{position:fixed;bottom:var(--nav-h);left:0;right:0;background:var(--bg);border-top:2px solid var(--bdr2);padding:12px 14px;z-index:300;max-height:45vh;overflow-y:auto}
.oc-summary-header{font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;margin-bottom:8px}
.oc-summary-empty{font-size:12px;color:var(--muted);padding:4px 0 8px}
.oc-summary-item{display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bdr);gap:8px}
.oc-summary-item:last-child{border-bottom:none}
.oc-summary-item-name{font-size:12px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oc-summary-item-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.oc-qty-controls{display:flex;align-items:center;gap:5px}
.oc-qty-btn{width:22px;height:22px;border-radius:50%;border:1px solid var(--bdr2);background:var(--sur2);color:var(--txt2);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}
.oc-qty-val{font-size:12px;font-weight:600;min-width:20px;text-align:center}
.oc-summary-line-total{font-size:12px;font-weight:600;color:var(--grn2);min-width:52px;text-align:right}
.oc-remove-btn{background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:2px}
.oc-remove-btn:hover{color:var(--red)}
.oc-total-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0 4px;border-top:1px solid var(--bdr2);margin-top:4px}
.oc-total-amount{font-size:15px;font-weight:700;color:var(--grn2)}
.oc-actions{display:flex;gap:8px;margin-top:10px}
.oc-draft-btn{flex:1;justify-content:center}
.oc-confirm-btn{flex:2;justify-content:center}
.agent-cust-chip{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--gdim);border:1px solid var(--gbdr);border-radius:var(--r)}
.agent-cust-chip-info{flex:1;min-width:0}
.agent-cust-chip-name{font-size:13px;font-weight:600;color:var(--grn2)}
.agent-cust-chip-meta{font-size:11px;color:var(--muted);margin-top:2px}
.agent-cust-chip-change{padding:4px 10px;border-radius:6px;border:1px solid var(--bdr2);background:var(--sur2);color:var(--muted);font-size:11px;cursor:pointer;white-space:nowrap}
.agent-item-variant{color:var(--muted);font-size:11px;font-weight:400}
`;
  document.head.appendChild(s);
}
