// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/order-create.js
// PURPOSE: New order creation screen.
//          Phone-first customer lookup → product search → order summary → confirm.
//          This is the most performance-critical screen in the app.
//          All product search is local — zero network calls during typing.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER  (entry point)
// §4  CUSTOMER SECTION  (phone lookup, new customer inline)
// §5  PRODUCT SEARCH    (instant, local cache)
// §6  ORDER ITEMS       (add, remove, edit qty, duplicate detection)
// §7  ORDER SUMMARY     (always visible at bottom)
// §8  CONFIRM ORDER     (reserve stock, save to Firestore)
// §9  EVENT WIRING      (all listeners in one place)
// ════════════════════════════════════════════════════════════════════════

import { esc, toast, fmtCurrency, render } from '../ui.js';
import { searchProducts, getAvailableQty }  from '../services/products.js';
import { searchByPhone, searchByName, createCustomer, getLastOrder, updateCustomerStats } from '../services/customers.js';
import { createOrder, addOrderItem, updateOrderItem, removeOrderItem, getOrderItems, updateOrderStatus } from '../services/orders.js';
import { addRecentItem, getRecentItems }    from '../services/recent-items.js';
import { reserveStock, generateIdempotencyKey } from '../inventory.js';
import * as DB from '../db.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// Reset on every renderOrderCreate() call.
// ════════════════════════════════════════════════════════════════════════

let _session      = null;
let _orderId      = null;  // created in Firestore as soon as screen opens
let _customer     = null;  // { id, name, phone, total_orders, last_order_date } | null
let _isWalkIn     = false;
let _orderItems   = [];    // local copy of items in the order (for display)
let _phoneTimer   = null;  // debounce timer for phone lookup
let _searchTimer  = null;  // debounce timer for product search
let _isEditMode   = false; // true when editing an existing draft
let _onBack       = null;  // callback to return to caller (edit mode only)


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

// renderOrderCreate(session)
// Entry point — called by orders.js when seller taps "+ New Order".
// Creates a draft order immediately so items can be added incrementally.
export async function renderOrderCreate(session) {
  _session    = session;
  _orderId    = null;
  _customer   = null;
  _isWalkIn   = false;
  _orderItems = [];
  _isEditMode = false;
  _onBack     = null;

  console.log('[orderCreate.renderOrderCreate] called', { businessId: session.businessId });

  // Create the draft order document immediately
  const orderResult = await createOrder(session.businessId, {
    createdBy: session.uid,
  });

  if (orderResult.error) {
    toast('Could not create order: ' + orderResult.message, 'err');
    return;
  }

  _orderId = orderResult.orderId;
  console.log('[orderCreate.renderOrderCreate] draft order created', { orderId: _orderId });

  _renderScreen();
}


// renderOrderEdit(session, orderId, onBack)
// Entry point — called when a draft order card is tapped.
// Loads the existing draft and opens the create screen pre-populated.
// onBack: function to call when seller taps back or saves.
export async function renderOrderEdit(session, orderId, onBack) {
  _session    = session;
  _orderId    = orderId;
  _customer   = null;
  _isWalkIn   = false;
  _orderItems = [];
  _isEditMode = true;
  _onBack     = onBack || (() => window.switchScreen('orders'));

  console.log('[orderCreate.renderOrderEdit] called', { orderId });

  // Load existing order and items
  try {
    const { getOrder } = await import('./order-detail.js').catch(() => ({}));
    const orderResult  = await getOrderItems(session.businessId, orderId);
    _orderItems = Array.isArray(orderResult) ? orderResult : [];

    // Load the order doc to get customer info
    const { dbGet, paths } = await import('../db.js');
    const p         = paths(session.businessId);
    const orderDoc  = await dbGet(p.orders, orderId);
    if (orderDoc.ok) {
      const order = orderDoc.data;
      _isWalkIn = !!order.is_walk_in;
      if (!_isWalkIn && order.customer_id) {
        _customer = {
          id:    order.customer_id,
          name:  order.customer_name || '',
          phone: order.customer_phone || '',
        };
      }
    }
  } catch(e) {
    console.warn('[orderCreate.renderOrderEdit] load failed', e?.message);
  }

  _renderScreen();
}


// ════════════════════════════════════════════════════════════════════════
// §3b SCREEN HTML
// ════════════════════════════════════════════════════════════════════════

function _renderScreen() {
  const recentItems = getRecentItems(_session.businessId, _session.uid);

  // In edit mode, customer is locked — show chip immediately if we have one
  const lockedCustomer = _isEditMode && (_customer || _isWalkIn);
  const customerChipHtml = lockedCustomer
    ? `<div class="oc-customer-chip-locked">
        <span class="oc-chip-avatar">${_isWalkIn ? '👤' : _initials(_customer?.name || '?')}</span>
        <span class="oc-chip-name">${_isWalkIn ? 'Walk-in' : esc(_customer?.name || '')}</span>
        <span class="oc-chip-phone">${_customer?.phone ? esc(_customer.phone) : ''}</span>
       </div>`
    : '';

  render(`
    <div class="oc-wrap">

      ${_isEditMode ? `<button class="back-btn" id="oc-back-btn">‹ Orders</button>` : ''}
      ${_isEditMode ? `<div class="subscreen-title" style="margin-bottom:10px">Edit Order</div>` : ''}

      <!-- ── Customer section ──────────────────────────────────── -->
      <div class="oc-section" id="oc-customer-section">
        <div class="oc-section-label">CUSTOMER</div>

        ${lockedCustomer
          ? customerChipHtml
          : `<!-- Phone input -->
          <div class="oc-phone-wrap">
            <input class="input oc-phone-input" id="oc-phone"
              type="tel" placeholder="Phone number…" autocomplete="off"
              inputmode="tel"/>
            <button class="oc-walkin-btn" id="oc-walkin-btn" title="Walk-in customer">Walk-in</button>
          </div>

          <!-- Customer lookup result — shown as seller types -->
          <div id="oc-customer-result"></div>

          <!-- Name field — shown only when new customer -->
          <div id="oc-name-wrap" class="hide">
            <input class="input oc-name-input" id="oc-name"
              placeholder="Customer name…" autocomplete="off"/>
          </div>

          <!-- Selected customer chip -->
          <div id="oc-customer-chip" class="hide"></div>`
        }
      </div>

      <!-- ── Recent items ───────────────────────────────────────── -->
      ${!_isEditMode && recentItems.length > 0 ? `
      <div class="oc-section" id="oc-recent-section">
        <div class="oc-section-label">RECENT</div>
        <div class="oc-recent-chips" id="oc-recent-chips">
          ${recentItems.map(item => `
            <button class="oc-recent-chip" data-variant="${esc(item.variantId)}"
              data-product="${esc(item.productId)}" data-name="${esc(item.productName)}"
              data-size="${esc(item.variantSize)}" data-price="${item.price}">
              ${esc(item.productName)}${item.variantSize ? ' ' + esc(item.variantSize) : ''}
            </button>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- ── Order summary ──────────────────────────────────────── -->
      <div class="oc-summary-wrap" id="oc-summary-wrap">
        <div class="oc-summary-header">ORDER SUMMARY</div>
        <div id="oc-summary-items"></div>
        <div class="oc-summary-total" id="oc-summary-total"></div>
      </div>

      <!-- ── Product search — always below summary so user sees items then adds more -->
      <div class="oc-section" id="oc-search-section">
        <div class="oc-section-label" id="oc-add-label">ADD PRODUCTS</div>
        <div class="oc-search-wrap">
          <span class="oc-search-icon">🔍</span>
          <input class="input oc-search-input" id="oc-search"
            type="search" placeholder="Search products…" autocomplete="off"/>
        </div>
        <!-- Results shown here -->
        <div id="oc-search-results"></div>
      </div>

      <!-- ── Actions ──────────────────────────────────────────────── -->
      <div class="oc-actions" id="oc-actions-bar">
        <button class="btn btn-secondary oc-draft-btn" id="oc-save-draft">
          ${_isEditMode ? '‹ Back to Orders' : 'Save Draft'}
        </button>
        <button class="btn btn-primary oc-confirm-btn" id="oc-confirm-btn"
          ${_isEditMode && (_customer || _isWalkIn) ? '' : 'disabled'}>
          Confirm Order →
        </button>
      </div>

    </div>
  `);

  _wireEvents();
  _renderSummary();
}


// ════════════════════════════════════════════════════════════════════════
// §4 CUSTOMER SECTION
// ════════════════════════════════════════════════════════════════════════

// _onPhoneInput() — called on every keystroke in phone field
// Debounced 300ms to avoid hammering Firestore on every character.
async function _onPhoneInput() {
  const phone = document.getElementById('oc-phone')?.value?.trim() || '';
  const resultEl = document.getElementById('oc-customer-result');
  const nameWrap = document.getElementById('oc-name-wrap');

  // Clear customer if phone cleared
  if (!phone) {
    _customer = null;
    _isWalkIn = false;
    if (resultEl) resultEl.innerHTML = '';
    if (nameWrap) nameWrap.classList.add('hide');
    _updateChip();
    _renderSummary();
    return;
  }

  // Need at least 7 digits before searching
  const digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.length < 7) {
    if (resultEl) resultEl.innerHTML = '';
    return;
  }

  if (resultEl) resultEl.innerHTML = `<div class="oc-lookup-status">Looking up…</div>`;

  const result = await searchByPhone(_session.businessId, phone);

  if (result.found) {
    // Returning customer found
    _customer = result.customer;
    _isWalkIn = false;
    if (nameWrap) nameWrap.classList.add('hide');
    _renderCustomerFound(result.customer);
  } else {
    // New customer — show inline name field
    _customer = null;
    if (resultEl) resultEl.innerHTML = `<div class="oc-new-customer-label">✦ New customer</div>`;
    if (nameWrap) nameWrap.classList.remove('hide');
    document.getElementById('oc-name')?.focus();
  }

  _updateChip();
  _renderSummary();
}

// _renderCustomerFound(customer) — shows the returning customer card
async function _renderCustomerFound(customer) {
  const resultEl = document.getElementById('oc-customer-result');
  if (!resultEl) return;

  const lastOrderResult = await getLastOrder(_session.businessId, customer.id);
  const lastOrder       = lastOrderResult.ok ? lastOrderResult.order : null;

  resultEl.innerHTML = `
    <div class="oc-customer-found">
      <div class="oc-customer-found-info">
        <div class="oc-customer-name">${esc(customer.name)}</div>
        <div class="oc-customer-meta">
          ${customer.total_orders || 0} orders
          ${lastOrder ? `· Last: ${_daysSince(lastOrder.created_at)} days ago` : ''}
        </div>
      </div>
      ${lastOrder ? `
        <button class="btn btn-secondary btn-small" id="oc-repeat-btn">
          ↺ Repeat last order
        </button>` : ''}
    </div>
  `;

  // Wire repeat last order
  document.getElementById('oc-repeat-btn')?.addEventListener('click', () =>
    _repeatLastOrder(lastOrder)
  );
}

// _repeatLastOrder(lastOrder) — pre-populates items from last order
async function _repeatLastOrder(lastOrder) {
  if (!lastOrder) return;
  console.log('[orderCreate._repeatLastOrder]', { orderId: lastOrder.id });

  const items = await getOrderItems(_session.businessId, lastOrder.id);
  if (!items.length) { toast('Last order had no items', 'warn'); return; }

  for (const item of items) {
    await _addItem({
      productId:   item.product_id,
      productName: item.product_name,
      variantId:   item.variant_id,
      variantSize: item.variant_size,
      quantity:    item.ordered_qty,
      price:       item.price,
    });
  }

  toast(`✓ ${items.length} items from last order added`);
}

// _onWalkIn() — creates anonymous walk-in order
function _onWalkIn() {
  _customer = null;
  _isWalkIn = true;
  const phoneEl  = document.getElementById('oc-phone');
  const nameWrap = document.getElementById('oc-name-wrap');
  const resultEl = document.getElementById('oc-customer-result');
  if (phoneEl)  { phoneEl.value = ''; phoneEl.disabled = true; }
  if (nameWrap) nameWrap.classList.add('hide');
  if (resultEl) resultEl.innerHTML = `<div class="oc-walkin-label">👤 Walk-in customer — no profile created</div>`;
  _updateChip();
  _renderSummary();
  toast('Walk-in order — no customer profile');
}

// _updateChip() — updates order status in top of form
function _updateChip() {
  const chipEl = document.getElementById('oc-customer-chip');
  if (!chipEl) return;

  if (_isWalkIn) {
    chipEl.className = 'oc-chip-walkin';
    chipEl.classList.remove('hide');
    chipEl.innerHTML = '👤 Walk-in';
    return;
  }

  if (_customer) {
    chipEl.className = 'oc-chip-customer';
    chipEl.classList.remove('hide');
    chipEl.innerHTML = `✓ ${esc(_customer.name)}`;
    return;
  }

  chipEl.classList.add('hide');
}


// ════════════════════════════════════════════════════════════════════════
// §5 PRODUCT SEARCH
// ════════════════════════════════════════════════════════════════════════

// _onSearchInput() — called on every keystroke, debounced 150ms
function _onSearchInput() {
  const query     = document.getElementById('oc-search')?.value || '';
  const resultsEl = document.getElementById('oc-search-results');
  if (!resultsEl) return;

  if (!query.trim()) {
    resultsEl.innerHTML = '';
    return;
  }

  // Instant — reads from local cache
  const results = searchProducts(query);

  if (!results.length) {
    resultsEl.innerHTML = `
      <div class="oc-no-results">
        Not found. Check inventory or add new product.
      </div>`;
    return;
  }

  resultsEl.innerHTML = results.map(product => `
    <div class="oc-product-group">
      <div class="oc-product-name">${esc(product.name)}</div>
      ${product.variants.map(v => `
        <div class="oc-variant-row ${v.isOutOfStock ? 'oc-variant-out' : ''}"
          data-variant="${esc(v.variantId)}"
          data-product="${esc(v.productId)}"
          data-name="${esc(product.name)}"
          data-size="${esc(v.size)}"
          data-price="${v.price}"
          data-available="${v.available}">

          <div class="oc-variant-info">
            <span class="oc-variant-size">${esc(v.size || 'Default')}</span>
            <span class="oc-variant-stock ${v.isLowStock ? 'low' : ''} ${v.isOutOfStock ? 'out' : ''}">
              ${esc(v.stockLabel)}
            </span>
          </div>

          <div class="oc-variant-right">
            <span class="oc-variant-price">${fmtCurrency(v.price)}</span>
            ${!v.isOutOfStock
              ? `<button class="oc-add-btn" data-action="add-variant">＋</button>`
              : `<span class="oc-out-label">Out</span>`
            }
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');

  // Wire add buttons
  resultsEl.querySelectorAll('[data-action="add-variant"]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const row = e.target.closest('[data-variant]');
      if (!row) return;
      await _addItem({
        productId:   row.dataset.product,
        productName: row.dataset.name,
        variantId:   row.dataset.variant,
        variantSize: row.dataset.size,
        quantity:    1,
        price:       Number(row.dataset.price),
      });
    });
  });
}


// ════════════════════════════════════════════════════════════════════════
// §6 ORDER ITEMS
// ════════════════════════════════════════════════════════════════════════

// _addItem(item) — adds or merges a product variant into the order
async function _addItem({ productId, productName, variantId, variantSize, quantity, price }) {
  console.log('[orderCreate._addItem]', { variantId, quantity });

  // Duplicate detection — check if variant already in order
  const existing = _orderItems.find(i => i.variant_id === variantId);
  if (existing) {
    const newQty = existing.ordered_qty + quantity;
    // Check availability
    const available = getAvailableQty(variantId);
    if (newQty > available) {
      toast(`Only ${available} available for ${productName}${variantSize ? ' ' + variantSize : ''}`, 'warn');
      return;
    }
    // Merge — update quantity
    await _updateItemQty(existing.id, newQty);
    toast(`↑ ${productName}${variantSize ? ' ' + variantSize : ''} now ×${newQty}`);
    return;
  }

  // Availability check
  const available = getAvailableQty(variantId);
  if (quantity > available && available > 0) {
    toast(`Only ${available} available`, 'warn');
    quantity = available;
  }

  // Add to Firestore order
  const result = await addOrderItem(_session.businessId, _orderId, {
    productId, productName, variantId, variantSize, quantity, price,
  });

  if (result.error) {
    toast('Could not add item: ' + result.message, 'err');
    return;
  }

  // Update local copy
  _orderItems.push({
    id:           result.itemId,
    product_id:   productId,
    product_name: productName,
    variant_id:   variantId,
    variant_size: variantSize,
    ordered_qty:  quantity,
    price,
    line_total:   quantity * price,
  });

  // Add to recent items
  addRecentItem(_session.businessId, _session.uid, {
    variantId, productId, productName, variantSize, price,
  });

  _renderSummary();

  // Update "ADD PRODUCTS" label to reflect items in cart
  const addLabel = document.getElementById('oc-add-label');
  if (addLabel) addLabel.textContent = `ADD MORE PRODUCTS (${_orderItems.length} in order)`;

  // Scroll search into view and keep focus — user should see they can add more
  const searchEl = document.getElementById('oc-search');
  if (searchEl) {
    searchEl.focus();
    searchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// _updateItemQty(itemId, newQty) — updates quantity of existing item
async function _updateItemQty(itemId, newQty) {
  if (newQty <= 0) {
    await _removeItem(itemId);
    return;
  }

  const item = _orderItems.find(i => i.id === itemId);
  if (!item) return;

  const available = getAvailableQty(item.variant_id);
  if (newQty > available) {
    toast(`Only ${available} available`, 'warn');
    newQty = available;
  }

  await updateOrderItem(_session.businessId, _orderId, itemId, { quantity: newQty });

  // Update local copy
  item.ordered_qty = newQty;
  item.line_total  = newQty * item.price;

  _renderSummary();
}

// _removeItem(itemId) — removes an item from the order
async function _removeItem(itemId) {
  await removeOrderItem(_session.businessId, _orderId, itemId);
  _orderItems = _orderItems.filter(i => i.id !== itemId);
  _renderSummary();
}


// ════════════════════════════════════════════════════════════════════════
// §7 ORDER SUMMARY
// ════════════════════════════════════════════════════════════════════════

function _renderSummary() {
  const summaryEl = document.getElementById('oc-summary-items');
  const totalEl   = document.getElementById('oc-summary-total');
  const confirmEl = document.getElementById('oc-confirm-btn');
  if (!summaryEl) return;

  const total = _orderItems.reduce((s, i) => s + Number(i.line_total || 0), 0);

  if (!_orderItems.length) {
    summaryEl.innerHTML = `<div class="oc-summary-empty">No items added yet</div>`;
    if (totalEl)   totalEl.innerHTML   = '';
    if (confirmEl) confirmEl.disabled  = true;
    return;
  }

  summaryEl.innerHTML = _orderItems.map(item => `
    <div class="oc-summary-item" data-item-id="${esc(item.id)}">
      <div class="oc-summary-item-name">
        ${esc(item.product_name)}${item.variant_size ? ' ' + esc(item.variant_size) : ''}
      </div>
      <div class="oc-summary-item-right">
        <div class="oc-qty-controls">
          <button class="oc-qty-btn" data-action="dec" data-item="${esc(item.id)}">−</button>
          <span class="oc-qty-val">${item.ordered_qty}</span>
          <button class="oc-qty-btn" data-action="inc" data-item="${esc(item.id)}"
            data-variant="${esc(item.variant_id)}">＋</button>
        </div>
        <span class="oc-summary-line-total">${fmtCurrency(item.line_total)}</span>
        <button class="oc-remove-btn" data-action="remove" data-item="${esc(item.id)}">✕</button>
      </div>
    </div>
  `).join('');

  if (totalEl) {
    totalEl.innerHTML = `
      <div class="oc-total-row">
        <span>Total</span>
        <span class="oc-total-amount">${fmtCurrency(total)}</span>
      </div>`;
  }

  // Enable confirm if items exist and customer is set (or walk-in)
  const hasCustomer = _isWalkIn || _customer || _getPendingNewCustomer();
  if (confirmEl) confirmEl.disabled = !(_orderItems.length > 0 && hasCustomer);

  // Keep add-label in sync when summary re-renders (e.g. qty changes)
  const addLabel2 = document.getElementById('oc-add-label');
  if (addLabel2 && _orderItems.length > 0) {
    addLabel2.textContent = `ADD MORE PRODUCTS (${_orderItems.length} in order)`;
  } else if (addLabel2) {
    addLabel2.textContent = 'ADD PRODUCTS';
  }

  // Wire qty controls and remove buttons
  summaryEl.querySelectorAll('[data-action="dec"]').forEach(btn =>
    btn.addEventListener('click', () => {
      const item = _orderItems.find(i => i.id === btn.dataset.item);
      if (item) _updateItemQty(item.id, item.ordered_qty - 1);
    })
  );
  summaryEl.querySelectorAll('[data-action="inc"]').forEach(btn =>
    btn.addEventListener('click', () => {
      const item      = _orderItems.find(i => i.id === btn.dataset.item);
      const available = getAvailableQty(btn.dataset.variant);
      if (item) {
        if (item.ordered_qty >= available) {
          toast(`Only ${available} available`, 'warn');
          return;
        }
        _updateItemQty(item.id, item.ordered_qty + 1);
      }
    })
  );
  summaryEl.querySelectorAll('[data-action="remove"]').forEach(btn =>
    btn.addEventListener('click', () => _removeItem(btn.dataset.item))
  );
}

// _getPendingNewCustomer() — returns { name, phone } if new customer fields filled
function _getPendingNewCustomer() {
  const phone = document.getElementById('oc-phone')?.value?.trim() || '';
  const name  = document.getElementById('oc-name')?.value?.trim()  || '';
  const nameWrap = document.getElementById('oc-name-wrap');
  const nameVisible = nameWrap && !nameWrap.classList.contains('hide');
  if (phone && name && nameVisible) return { name, phone };
  return null;
}


// ════════════════════════════════════════════════════════════════════════
// §8 CONFIRM ORDER
// Reserve stock + update order status + create customer if new.
// ════════════════════════════════════════════════════════════════════════

async function _confirmOrder() {
  console.log('[orderCreate._confirmOrder] called', { orderId: _orderId });

  if (!_orderItems.length) {
    toast('Add at least one item first', 'warn');
    return;
  }

  const confirmBtn = document.getElementById('oc-confirm-btn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Confirming…'; }

  try {
    // ── Step 1: Resolve customer ────────────────────────────────────────
    let customerId    = _customer?.id    || null;
    let customerName  = _customer?.name  || '';
    let customerPhone = _customer?.phone || '';

    if (!customerId && !_isWalkIn) {
      const pending = _getPendingNewCustomer();
      if (!pending) {
        toast('Add a customer or choose Walk-in first', 'warn');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
        return;
      }
      // Create new customer
      const createResult = await createCustomer(_session.businessId, pending);
      if (createResult.error) {
        toast('Could not create customer: ' + createResult.message, 'err');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
        return;
      }
      customerId    = createResult.customerId;
      customerName  = createResult.customer.name;
      customerPhone = createResult.customer.phone || '';
    }

    // ── Step 2: Check low confidence ────────────────────────────────────
    const hasLowConfidence = _orderItems.some(item => {
      const { searchProducts: sp } = { searchProducts };
      // Check from local cache
      const products = searchProducts('');
      const product  = products.find(p => p.productId === item.product_id);
      const variant  = product?.variants.find(v => v.variantId === item.variant_id);
      return variant?.isLowConfidence;
    });

    if (hasLowConfidence) {
      const proceed = confirm('⚠ Stock confidence is low for one or more items. Proceed with confirmation?');
      if (!proceed) {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
        return;
      }
    }

    // ── Step 3: Check online ─────────────────────────────────────────────
    if (!navigator.onLine) {
      toast('You must be online to confirm an order', 'err');
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
      return;
    }

    // ── Step 4: Reserve stock ────────────────────────────────────────────
    const idempotencyKey = generateIdempotencyKey('reserve');
    const reserveItems   = _orderItems.map(i => ({
      variantId:  i.variant_id,
      productId:  i.product_id,
      quantity:   i.ordered_qty,
    }));

    const reserveResult = await reserveStock({
      businessId:     _session.businessId,
      orderId:        _orderId,
      items:          reserveItems,
      idempotencyKey,
    });

    if (reserveResult.error) {
      // Check if it's insufficient stock — show specific message
      if (reserveResult.code === 'INSUFFICIENT_STOCK') {
        toast(reserveResult.message, 'err');
      } else {
        toast('Reservation failed: ' + reserveResult.message, 'err');
      }
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
      return;
    }

    // ── Step 5: Write reserved_qty back to each item doc ───────────────────
    if (reserveResult.reservedItems?.length) {
      const p = DB.paths(_session.businessId);
      for (const reserved of reserveResult.reservedItems) {
        const item = _orderItems.find(i => i.variant_id === reserved.variantId);
        if (item?.id) {
          await DB.dbUpdate(`${p.orders}/${_orderId}/items`, item.id, {
            reserved_qty: reserved.quantity,
          }).catch(e => console.warn('[confirmOrder] reserved_qty write failed', e));
        }
      }
    }

    // ── Step 6: Update order document ────────────────────────────────────
    await updateOrderStatus(_session.businessId, _orderId, 'confirmed', {
      customer_id:      customerId,
      customer_name:    _isWalkIn ? 'Walk-in' : customerName,
      customer_phone:   _isWalkIn ? '' : customerPhone,
      is_walk_in:       _isWalkIn,
      reserved_at:      DB.dbNow(),
      idempotency_key:  idempotencyKey,
    });

    toast('✓ Order confirmed — stock reserved');
    console.log('[orderCreate._confirmOrder] success', { orderId: _orderId });

    // Update customer stats — non-critical, fire and forget
    if (customerId) {
      updateCustomerStats(_session.businessId, customerId, {
        orderValue: _orderItems.reduce((s, i) => s + (Number(i.price||0) * Number(i.ordered_qty||0)), 0),
      }).catch(e => console.warn('[confirmOrder] updateCustomerStats failed (non-critical)', e));
    }

    // Navigate back to orders list
    window.switchScreen('orders');

  } catch(e) {
    console.error('[orderCreate._confirmOrder] failed', e);
    toast('Confirmation failed: ' + e.message, 'err');
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Order →'; }
  }
}


// ════════════════════════════════════════════════════════════════════════
// §9 EVENT WIRING
// ════════════════════════════════════════════════════════════════════════

function _wireEvents() {
  // Back button (edit mode only)
  document.getElementById('oc-back-btn')?.addEventListener('click', () => {
    if (_onBack) _onBack();
    else window.switchScreen('orders');
  });

  // Phone input — debounced 300ms (new order mode only)
  document.getElementById('oc-phone')?.addEventListener('input', () => {
    clearTimeout(_phoneTimer);
    _phoneTimer = setTimeout(_onPhoneInput, 300);
  });

  // Walk-in button
  document.getElementById('oc-walkin-btn')?.addEventListener('click', _onWalkIn);

  // Product search — debounced 150ms
  document.getElementById('oc-search')?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(_onSearchInput, 150);
  });

  // Recent item chips — one tap adds with qty 1
  document.querySelectorAll('.oc-recent-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      await _addItem({
        productId:   chip.dataset.product,
        productName: chip.dataset.name,
        variantId:   chip.dataset.variant,
        variantSize: chip.dataset.size,
        quantity:    1,
        price:       Number(chip.dataset.price),
      });
    });
  });

  // Name field — update confirm button state on change
  document.getElementById('oc-name')?.addEventListener('input', () => {
    _renderSummary();
  });

  // Save draft / Back
  document.getElementById('oc-save-draft')?.addEventListener('click', () => {
    toast('✓ Draft saved');
    if (_isEditMode && _onBack) _onBack();
    else window.switchScreen('orders');
  });

  // Confirm order
  document.getElementById('oc-confirm-btn')?.addEventListener('click', _confirmOrder);
}

// _daysSince(isoString) — returns number of days since a date
function _daysSince(isoString) {
  if (!isoString) return '?';
  return Math.floor((Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24));
}

// _initials(name) — "Sadu Kumar" → "SK"
function _initials(name) {
  return (name || '?').trim().split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
}
