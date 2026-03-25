// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/order-detail.js
// PURPOSE: Order detail screen — view order items, manage order lifecycle.
//          Confirm (reserve stock) → Dispatched (deduct stock) → Cancelled (release).
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  ORDER HEADER
// §5  ITEMS LIST
// §6  STAGE ACTIONS  (confirm / dispatch / cancel)
// §7  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, fmtCurrency, orderStatusBadge } from '../ui.js';
import { getOrder, getOrderItems, updateOrderStatus, deleteOrder } from '../services/orders.js';
import { updateCustomerStats } from '../services/customers.js';
import { loadCache } from '../services/products.js';
import {
  reserveStock, deductStock, releaseStock,
  generateIdempotencyKey,
} from '../inventory.js';
import * as Auth from '../auth.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session   = null;
let _orderId   = null;
let _order     = null;
let _items     = [];
let _onBack    = null; // callback to go back to order list


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

// renderOrderDetail(session, orderId, onBack)
// Called from orders.js when a card is tapped.
// onBack: function to call when back button tapped.
export async function renderOrderDetail(session, orderId, onBack) {
  _session = session;
  _orderId = orderId;
  _onBack  = onBack;

  console.log('[orderDetail.renderOrderDetail] called', { orderId });

  _injectStyles();
  renderLoading('Loading order…');

  await _loadOrder();
  _renderDetail();
}

async function _loadOrder() {
  const orderResult = await getOrder(_session.businessId, _orderId);
  _order = orderResult.ok ? orderResult.data : null;
  _items = _order ? await getOrderItems(_session.businessId, _orderId) : [];
  console.log('[orderDetail._loadOrder]', { status: _order?.status, itemCount: _items.length });
}


// ════════════════════════════════════════════════════════════════════════
// §4 FULL RENDER
// ════════════════════════════════════════════════════════════════════════

function _renderDetail() {
  if (!_order) {
    render(`<div class="wrap"><button class="back-btn" id="od-back">‹ Back</button><div class="status-err" style="margin-top:16px">Order not found.</div></div>`);
    document.getElementById('od-back')?.addEventListener('click', _onBack);
    return;
  }

  const stage       = _order.status || 'draft';
  const canAct      = Auth.isManager();
  const customer    = _order.is_walk_in ? 'Walk-in' : (_order.customer_name || 'Unknown');
  const total       = _order.total_value || 0;

  // Stage action buttons
  const actions = _stageActions(stage, canAct);

  render(`
    <div class="wrap" style="padding-bottom:120px">

      <!-- Back -->
      <button class="back-btn" id="od-back">‹ Orders</button>

      <!-- Order header -->
      <div class="card od-header-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px">
          <div>
            <div class="od-customer-name">${esc(customer)}</div>
            ${_order.customer_phone ? `<div class="od-customer-meta">📞 ${esc(_order.customer_phone)}</div>` : ''}
            <div class="od-customer-meta" style="margin-top:4px">${_fmtRelative(_order.created_at)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${orderStatusBadge(stage)}
            ${_canDelete(stage) ? `<button class="btn btn-danger btn-small" id="btn-od-delete" style="flex-shrink:0">🗑</button>` : ''}
          </div>
        </div>

        <!-- Stage indicator -->
        <div class="od-stage-track">
          ${['draft','confirmed','dispatched','delivered'].map(s => `
            <div class="od-stage-step ${stage === s ? 'active' : ''} ${_isStageCompleted(s, stage) ? 'done' : ''} ${stage === 'cancelled' && s !== 'draft' ? 'cancelled' : ''}">
              <div class="od-stage-dot"></div>
              <div class="od-stage-label">${_stageName(s)}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Items list -->
      <div class="card">
        <div class="section-title">Items (${_items.length})</div>
        ${_items.length
          ? _items.map(item => _renderItemRow(item, stage)).join('')
          : '<div style="font-size:13px;color:var(--muted)">No items in this order.</div>'
        }

        <!-- Total -->
        ${total > 0 ? `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;border-top:1px solid var(--bdr);margin-top:8px">
          <span style="font-size:13px;font-weight:600">Total</span>
          <span style="font-size:16px;font-weight:700;color:var(--grn2)">${fmtCurrency(total)}</span>
        </div>` : ''}
      </div>

      <!-- Stage actions -->
      ${actions.length > 0 ? `
      <div class="od-actions">
        ${actions.map(a =>
          `<button class="btn ${a.cls} od-action-btn" data-action="${esc(a.action)}"
            style="flex:1;justify-content:center;padding:13px">
            ${a.label}
          </button>`
        ).join('')}
      </div>` : ''}

    </div>
  `);

  // Wire back
  document.getElementById('od-back')?.addEventListener('click', _onBack);

  // Wire delete button
  document.getElementById('btn-od-delete')?.addEventListener('click', () => _handleDelete());

  // Wire action buttons
  document.querySelectorAll('.od-action-btn').forEach(btn =>
    btn.addEventListener('click', () => _handleAction(btn.dataset.action, btn))
  );
}

function _renderItemRow(item, stage) {
  // Use nullish coalescing so we can distinguish "field missing" (reservation not attempted)
  // from "field present but 0" (reservation attempted but failed / zero stock).
  const reservedRaw = item.reserved_qty ?? item.reservedQty ?? null;
  const reserved    = Number(reservedRaw || 0);
  const ordered     = item.ordered_qty || 0;
  const reservationAttempted = reservedRaw !== null; // field was written by confirm flow
  const fullyReserved   = reservationAttempted && reserved >= ordered && ordered > 0;
  const partialReserved = reservationAttempted && reserved < ordered;

  return `
    <div class="od-item-row">
      <div class="od-item-info">
        <div class="od-item-name">
          ${esc(item.product_name || '')}
          ${item.variant_size ? `<span style="color:var(--muted);font-size:11px"> · ${esc(item.variant_size)}</span>` : ''}
        </div>
        <div class="od-item-meta">
          ${ordered} × ${fmtCurrency(item.price || 0)}
          ${stage === 'confirmed' && fullyReserved
            ? ` · <span style="color:var(--gold)">🔒 ${reserved} reserved</span>`
            : ''}
          ${stage === 'confirmed' && partialReserved
            ? ` · <span style="color:var(--red)">⚠ Only ${reserved}/${ordered} reserved</span>`
            : ''}
        </div>
      </div>
      <div style="font-size:13px;font-weight:600;color:var(--grn2);flex-shrink:0">
        ${fmtCurrency((item.price || 0) * ordered)}
      </div>
    </div>
  `;
}


// ════════════════════════════════════════════════════════════════════════
// §6 STAGE ACTIONS
// ════════════════════════════════════════════════════════════════════════

function _stageActions(stage, canAct) {
  if (!canAct) return [];
  const map = {
    draft:           [{ action: 'confirm',  label: '✓ Confirm Order',    cls: 'btn-primary' },
                     { action: 'cancel',   label: '✕ Cancel',           cls: 'btn-danger' }],
    confirmed:       [{ action: 'dispatch', label: '🚚 Mark Dispatched',  cls: 'btn-primary' },
                     { action: 'cancel',   label: '✕ Cancel Order',      cls: 'btn-danger' }],
    dispatched:      [{ action: 'deliver',  label: '✓ Mark Delivered',    cls: 'btn-primary' }],
    delivered:       [],
    cancelled:       [],
  };
  return map[stage] || [];
}

async function _handleAction(action, btn) {
  // 'deliver' doesn't require items — only stock-related actions do
  if (!_order) return;
  if (action !== 'deliver' && !_items.length) return;

  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Processing…';

  try {
    if (action === 'confirm') {
      await _confirmOrder();
    } else if (action === 'dispatch') {
      await _dispatchOrder();
    } else if (action === 'cancel') {
      await _cancelOrder();
    } else if (action === 'deliver') {
      await updateOrderStatus(_session.businessId, _orderId, 'delivered');
      toast('✓ Order marked as delivered');
      await _loadOrder();
      _renderDetail();
    }
  } catch(e) {
    console.error('[orderDetail._handleAction] failed', { action, error: e });
    toast(e.message || 'Operation failed', 'err');
    btn.disabled = false; btn.textContent = originalText;
  }
}

async function _confirmOrder() {
  console.log('[orderDetail._confirmOrder] called', { orderId: _orderId });

  if (!navigator.onLine) { toast('Must be online to confirm an order', 'err'); return; }

  // Build items for reserve
  const reserveItems = _items.map(i => ({
    variantId: i.variant_id,
    productId: i.product_id,
    quantity:  i.ordered_qty || 0,
  }));

  const idempotencyKey = generateIdempotencyKey('reserve');
  const result = await reserveStock({
    businessId:     _session.businessId,
    orderId:        _orderId,
    items:          reserveItems,
    idempotencyKey,
    reason:         'Order confirmed',
  });

  if (result.error) {
    toast(result.message, 'err');
    return;
  }

  // Write reserved_qty back to each item doc so the detail screen can show it
  // result.reservedItems = [{ variantId, quantity }]
  if (result.reservedItems?.length) {
    const { dbUpdate, paths } = await import('../db.js');
    const p = paths(_session.businessId);
    for (const reserved of result.reservedItems) {
      const item = _items.find(i => i.variant_id === reserved.variantId);
      if (item?.id) {
        await dbUpdate(`${p.orders}/${_orderId}/items`, item.id, {
          reserved_qty: reserved.quantity,
        }).catch(e => console.warn('[confirmOrder] reserved_qty write failed (non-critical)', e));
      }
    }
  }

  await updateOrderStatus(_session.businessId, _orderId, 'confirmed', {
    reserved_at:     new Date().toISOString(),
    idempotency_key: idempotencyKey,
  });

  // Refresh product cache
  await loadCache(_session.businessId);

  // Update customer order stats — non-critical
  if (_order.customer_id) {
    updateCustomerStats(_session.businessId, _order.customer_id, {
      orderValue: _order.total_value || 0,
    }).catch(e => console.warn('[confirmOrder] updateCustomerStats non-critical:', e));
  }

  toast('✓ Order confirmed — stock reserved');
  await _loadOrder();
  _renderDetail();
}

async function _dispatchOrder() {
  console.log('[orderDetail._dispatchOrder] called', { orderId: _orderId });

  if (!navigator.onLine) { toast('Must be online to dispatch', 'err'); return; }

  const deductItems = _items.map(i => ({
    variantId:   i.variant_id,
    productId:   i.product_id,
    orderedQty:  i.ordered_qty  || 0,
    fulfilledQty: i.reserved_qty || i.ordered_qty || 0,
  }));

  const idempotencyKey = generateIdempotencyKey('deduct');
  const result = await deductStock({
    businessId:     _session.businessId,
    orderId:        _orderId,
    items:          deductItems,
    idempotencyKey,
    reason:         'Order dispatched',
  });

  if (result.error) {
    toast(result.message, 'err');
    return;
  }

  await updateOrderStatus(_session.businessId, _orderId, 'dispatched', {
    dispatched_at: new Date().toISOString(),
  });

  await loadCache(_session.businessId);
  toast('✓ Order dispatched — stock deducted');

  // Update customer stats — non-critical, fire-and-forget
  if (_order.customer_id) {
    const orderTotal = _items.reduce((s, i) => s + (Number(i.price||0) * Number(i.ordered_qty||0)), 0);
    updateCustomerStats(_session.businessId, _order.customer_id, { orderValue: orderTotal })
      .catch(e => console.warn('[dispatchOrder] updateCustomerStats failed (non-critical)', e));
  }

  await _loadOrder();
  _renderDetail();
}

async function _cancelOrder() {
  const stage = _order.status;
  console.log('[orderDetail._cancelOrder] called', { orderId: _orderId, stage });

  // Only release reservations if order was confirmed
  if (stage === 'confirmed') {
    const releaseItems = _items.map(i => ({
      variantId: i.variant_id,
      productId: i.product_id,
      quantity:  i.reserved_qty || i.ordered_qty || 0,
    }));
    const idempotencyKey = generateIdempotencyKey('release');
    const result = await releaseStock({
      businessId:     _session.businessId,
      orderId:        _orderId,
      items:          releaseItems,
      idempotencyKey,
      reason:         'Order cancelled',
    });

    if (result.error) { toast(result.message, 'err'); return; }
    await loadCache(_session.businessId);
  }

  await updateOrderStatus(_session.businessId, _orderId, 'cancelled');
  toast('Order cancelled', 'warn');
  await _loadOrder();
  _renderDetail();
}


// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function _stageOrder() { return ['draft','confirmed','dispatched','delivered','cancelled']; }

function _isStageCompleted(step, currentStage) {
  const order = ['draft','confirmed','dispatched','delivered'];
  return order.indexOf(step) < order.indexOf(currentStage);
}

function _stageName(s) {
  return { draft:'Draft', confirmed:'Confirmed', dispatched:'Dispatched', delivered:'Delivered' }[s] || s;
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
// DELETE ORDER
// ════════════════════════════════════════════════════════════════════════

// _canDelete(stage) — only owner can delete any order
function _canDelete(stage) {
  return Auth.isOwner();
}

async function _handleDelete() {
  const stage = _order?.status || 'draft';

  // Warn for irreversible stages
  if (stage === 'dispatched' || stage === 'delivered') {
    if (!confirm(`⚠ This order has already been ${stage}. Deleting it will remove it from records permanently. This cannot be undone. Proceed?`)) return;
  } else {
    if (!confirm('Delete this order? This cannot be undone.')) return;
  }

  const btn = document.getElementById('btn-od-delete');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    // Release stock if confirmed
    if (stage === 'confirmed' && _items.length) {
      const releaseItems = _items.map(i => ({
        variantId: i.variant_id,
        productId: i.product_id,
        quantity:  i.reserved_qty || i.ordered_qty || 0,
      }));
      const idempotencyKey = generateIdempotencyKey('release');
      await releaseStock({
        businessId: _session.businessId,
        orderId:    _orderId,
        items:      releaseItems,
        idempotencyKey,
        reason:     'Order deleted',
      });
      await loadCache(_session.businessId);
    }

    const result = await deleteOrder(_session.businessId, _orderId);
    if (result.error) { toast('Delete failed: ' + result.message, 'err'); return; }

    toast('Order deleted', 'warn');
    if (_onBack) _onBack();

  } catch(e) {
    toast('Delete failed: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '🗑'; }
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('order-detail-styles')) return;
  const s = document.createElement('style');
  s.id = 'order-detail-styles';
  s.textContent = `
.od-header-card{margin-bottom:12px}
.od-customer-name{font-size:17px;font-weight:600;margin-bottom:2px}
.od-customer-meta{font-size:12px;color:var(--muted)}
.od-stage-track{display:flex;align-items:flex-start;gap:0;margin-top:14px;position:relative}
.od-stage-track::before{content:'';position:absolute;top:7px;left:7px;right:7px;height:2px;background:var(--bdr2);z-index:0}
.od-stage-step{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;z-index:1}
.od-stage-dot{width:16px;height:16px;border-radius:50%;background:var(--bdr2);border:2px solid var(--bdr2);transition:all .2s}
.od-stage-step.done .od-stage-dot{background:var(--grn);border-color:var(--grn)}
.od-stage-step.active .od-stage-dot{background:var(--gold);border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.2)}
.od-stage-step.cancelled .od-stage-dot{background:var(--rdim);border-color:var(--red)}
.od-stage-label{font-size:9px;color:var(--muted);text-align:center;white-space:nowrap;letter-spacing:.3px}
.od-stage-step.active .od-stage-label{color:var(--gold);font-weight:600}
.od-stage-step.done .od-stage-label{color:var(--grn2)}
.od-item-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--bdr)}
.od-item-row:last-child{border-bottom:none}
.od-item-info{flex:1;min-width:0}
.od-item-name{font-size:13px;font-weight:600;margin-bottom:2px}
.od-item-meta{font-size:11px;color:var(--muted)}
.od-actions{position:fixed;bottom:var(--nav-h);left:0;right:0;background:var(--bg);border-top:1px solid var(--bdr2);padding:12px 14px;display:flex;gap:8px;z-index:300}
`;
  document.head.appendChild(s);
}
