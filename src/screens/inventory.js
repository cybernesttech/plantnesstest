// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/inventory.js
// PURPOSE: Stock / Inventory screen.
//          Lists products with variants and stock levels.
//          Add product: single screen, product details + inline variant rows.
//          Edit product: same screen, same pattern.
//          Stock IN: tap variant → enter qty → confirm.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  PRODUCT LIST
// §5  PRODUCT CARD
// §6  ADD / EDIT PRODUCT SCREEN
// §7  STOCK IN MODAL
// §8  HELPERS
// §9  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import {
  render, renderLoading, esc, toast,
  fmtCurrency, stockBadge, emptyState,
} from '../ui.js';
import { loadSuppliers, buildSupplierDatalist } from '../services/suppliers.js';
import {
  loadCache, searchProducts, isCacheLoaded,
  getVariantsForProduct,
} from '../services/products.js';
import {
  dbAdd, dbSet, dbUpdate, dbDelete, dbQuery, dbList, dbGet,
  dbNow, paths, COL_BUSINESSES,
} from '../db.js';
import {
  stockIn, adjustStock, generateIdempotencyKey, SOURCE_MANUAL, ADJ_CORRECTION,
} from '../inventory.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session     = null;
let _products    = []; // raw product docs from Firestore
let _searchTimer = null;
let _filterCat   = null; // active category filter
let _filterStatus = null; // 'in_stock' | 'low' | 'out' | null


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderInventory(session) {
  _session = session;
  console.log('[inventory-screen.renderInventory] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Loading stock…');

  // Ensure product cache is loaded
  await loadCache(session.businessId);

  _renderProductList();
}


// ════════════════════════════════════════════════════════════════════════
// §4 PRODUCT LIST
// ════════════════════════════════════════════════════════════════════════

function _renderProductList(searchQuery = '') {
  // Get enriched products from cache
  let results = searchProducts(searchQuery);

  // Apply category filter
  if (_filterCat) {
    results = results.filter(p => p.category === _filterCat);
  }

  // Apply status filter
  if (_filterStatus) {
    results = results.filter(p => {
      if (_filterStatus === 'out')      return !p.hasAvailable && p.variants.length > 0;
      if (_filterStatus === 'low')      return p.variants.some(v => v.isLowStock);
      if (_filterStatus === 'in_stock') return p.hasAvailable;
      return true;
    });
  }

  // Get all categories for filter chips
  const allProducts = searchProducts('');
  const categories  = [...new Set(allProducts.map(p => p.category).filter(Boolean))].sort();

  // Summary counts
  const total    = allProducts.length;
  const outCount = allProducts.filter(p => !p.hasAvailable && p.variants.length > 0).length;
  const lowCount = allProducts.filter(p => p.variants.some(v => v.isLowStock)).length;

  render(`
    <div class="wrap" style="padding-bottom:100px">

      <!-- Summary stats -->
      <div class="stats-row" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-box">
          <div class="stat-value">${total}</div>
          <div class="stat-label">Products</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--gold)">${lowCount}</div>
          <div class="stat-label">Low Stock</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--red)">${outCount}</div>
          <div class="stat-label">Out of Stock</div>
        </div>
      </div>

      <!-- Search -->
      <div class="search-wrap" style="margin-bottom:10px">
        <span class="search-icon">🔍</span>
        <input class="input search-input" id="inv-search" type="search"
          placeholder="Search products…" value="${esc(searchQuery)}"/>
      </div>

      <!-- Status filters -->
      <div class="inv-filter-row" style="margin-bottom:10px">
        <button class="inv-filter-chip ${!_filterStatus ? 'active' : ''}" data-status="">All</button>
        <button class="inv-filter-chip ${_filterStatus === 'in_stock' ? 'active' : ''}" data-status="in_stock">In Stock</button>
        <button class="inv-filter-chip ${_filterStatus === 'low' ? 'active' : ''}" data-status="low">Low</button>
        <button class="inv-filter-chip ${_filterStatus === 'out' ? 'active' : ''}" data-status="out">Out</button>
      </div>

      <!-- Category filters -->
      ${categories.length > 0 ? `
      <div class="inv-filter-row" style="margin-bottom:14px;flex-wrap:wrap">
        <button class="inv-filter-chip ${!_filterCat ? 'active' : ''}" data-cat="">All Categories</button>
        ${categories.map(c => `
          <button class="inv-filter-chip ${_filterCat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>
        `).join('')}
      </div>` : ''}

      <!-- Product list -->
      <div id="inv-product-list">
        ${results.length
          ? results.map(_renderProductCard).join('')
          : total === 0
            ? emptyState('📦', 'No products yet', 'Tap ＋ to add your first product.')
            : `<div style="font-size:13px;color:var(--muted);text-align:center;padding:30px 0">No products match this filter.</div>`
        }
      </div>

    </div>

    <!-- ＋ Add Product FAB -->
    <button class="fab fab-primary" id="fab-add-product" title="Add Product">＋</button>
  `);

  _wireListEvents(searchQuery);
}


// ════════════════════════════════════════════════════════════════════════
// §5 PRODUCT CARD
// ════════════════════════════════════════════════════════════════════════

function _renderProductCard(product) {
  const variantRows = product.variants.map(v => `
    <div class="inv-variant-row">
      <div class="inv-variant-info">
        <span class="inv-variant-size">${esc(v.size || 'Default')}</span>
        <span class="inv-variant-stock ${v.isLowStock ? 'low' : ''} ${v.isOutOfStock ? 'out' : ''}">
          ${esc(v.stockLabel)}
        </span>
      </div>
      <div class="inv-variant-right">
        <span class="inv-variant-price">${fmtCurrency(v.price)}</span>
        <button class="inv-stock-in-btn" data-variant="${esc(v.variantId)}"
          data-product="${esc(product.productId)}" data-name="${esc(product.name)}"
          data-size="${esc(v.size)}" data-available="${v.available}"
          title="Stock IN">＋ Stock
        </button>
      </div>
    </div>
  `).join('');

  return `
    <div class="inv-product-card">
      <div class="inv-product-header">
        <div class="inv-product-info">
          <div class="inv-product-name">${esc(product.name)}</div>
          <div class="inv-product-cat">${esc(product.category || '')}</div>
        </div>
        <button class="inv-edit-btn" data-product-id="${esc(product.productId)}"
          title="Edit product">✎</button>
      </div>
      <div class="inv-variants">
        ${variantRows || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No variants</div>'}
      </div>
    </div>
  `;
}

function _wireListEvents(searchQuery) {
  // Search
  document.getElementById('inv-search')?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _renderProductList(document.getElementById('inv-search')?.value || '');
    }, 200);
  });

  // Status filters
  document.querySelectorAll('[data-status]').forEach(btn =>
    btn.addEventListener('click', () => {
      _filterStatus = btn.dataset.status || null;
      _renderProductList(document.getElementById('inv-search')?.value || '');
    })
  );

  // Category filters
  document.querySelectorAll('[data-cat]').forEach(btn =>
    btn.addEventListener('click', () => {
      _filterCat = btn.dataset.cat || null;
      _renderProductList(document.getElementById('inv-search')?.value || '');
    })
  );

  // Stock IN buttons
  document.querySelectorAll('.inv-stock-in-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _openStockInModal({
        variantId:   btn.dataset.variant,
        productId:   btn.dataset.product,
        productName: btn.dataset.name,
        variantSize: btn.dataset.size,
        available:   Number(btn.dataset.available),
      });
    })
  );

  // Edit product buttons
  document.querySelectorAll('.inv-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _renderAddEditScreen(btn.dataset.productId);
    })
  );

  // Add product FAB
  document.getElementById('fab-add-product')?.addEventListener('click', () => {
    _renderAddEditScreen(null);
  });
}


// ════════════════════════════════════════════════════════════════════════
// §6 ADD / EDIT PRODUCT SCREEN
// Single screen: product details + inline variant rows.
// productId = null → add mode. productId = string → edit mode.
// ════════════════════════════════════════════════════════════════════════

// _variantRowHtml(idx, variant) — renders one variant row
// All fields in a single tidy row: Size | Price | Stock Op | Qty | ✕
// For new variants: Stock Op is hidden (always "add"), label shows "Initial Stock".
function _variantRowHtml(idx, v = {}) {
  const isExisting = !!v.variantId;
  return `
    <div class="inv-ve-variant-row" data-row="${idx}" data-variant-id="${esc(v.variantId || '')}">
      <div class="inv-ve-variant-fields">

        <div class="inv-ve-field">
          <label class="label">Size / Name</label>
          <input class="input inv-ve-size" id="ve-size-${idx}"
            value="${esc(v.size || '')}" placeholder="e.g. Small"/>
        </div>

        <div class="inv-ve-field">
          <label class="label">Price ₹</label>
          <input class="input inv-ve-price" id="ve-price-${idx}" type="number"
            value="${v.price || ''}" placeholder="0" min="0"/>
        </div>

        ${isExisting ? `
        <div class="inv-ve-field">
          <label class="label">Stock Op</label>
          <select class="input inv-ve-stock-op" id="ve-stock-op-${idx}">
            <option value="add">＋ Add</option>
            <option value="deduct">− Deduct</option>
          </select>
        </div>` : ''}

        <div class="inv-ve-field">
          <label class="label">${isExisting ? 'Qty' : 'Initial Stock'}</label>
          <input class="input inv-ve-stock" id="ve-stock-${idx}" type="number"
            value="${v.stock || ''}" placeholder="0" min="0"/>
        </div>

        <div class="inv-ve-field">
          <label class="label">Low Stock Alert</label>
          <input class="input inv-ve-threshold" id="ve-threshold-${idx}" type="number"
            value="${v.low_stock_threshold ?? 5}" placeholder="5" min="0" title="Alert when stock falls to or below this number"/>
        </div>

      </div>
      <button class="inv-ve-remove-btn" data-row="${idx}" title="Remove variant">✕</button>
    </div>
  `;
}

async function _renderAddEditScreen(productId) {
  // Pre-load supplier list for autocomplete
  await loadSuppliers(_session.businessId);
  const isEdit = !!productId;
  console.log('[inventory-screen._renderAddEditScreen]', { productId, isEdit });

  // Load existing product data if editing
  let productDoc  = null;
  let variantDocs = [];

  if (isEdit) {
    renderLoading('Loading product…');
    const p = paths(_session.businessId);

    // Find product by productId field
    try {
      const result = await dbQuery(
        p.products,
        [{ field: 'id', op: '==', value: productId }],
        [], 1
      );

      // Fallback: search all products by productId field value
      const allProds = await dbList(p.products);
      productDoc = allProds.ok
        ? allProds.data.find(d => d.productId === productId || d.id === productId)
        : null;

      if (productDoc) {
        const vResult = await dbQuery(
          p.variants,
          [{ field: 'product_id', op: '==', value: productDoc.id }],
          [], 50
        );
        variantDocs = vResult.ok ? vResult.data : [];
      }
    } catch(e) {
      console.error('[inventory-screen._renderAddEditScreen] load failed', e);
      toast('Failed to load product', 'err');
      return;
    }
  }

  // Build categories list
  const CATEGORIES = ['Plants', 'Seeds & Bulbs', 'Soil & Fertilizer', 'Pots & Planters', 'Tools & Accessories', 'Cut Flowers'];

  // Build initial variant rows
  // Edit mode: one row per existing variant (stock field = "add stock" amount)
  // Add mode: one default empty row
  const initialVariants = isEdit && variantDocs.length > 0
    ? variantDocs.map(v => ({
        variantId:           v.id,
        size:                v.size               || '',
        price:               v.price              || 0,
        stock:               '',
        low_stock_threshold: v.low_stock_threshold ?? 5,
      }))
    : [{ variantId: null, size: '', price: '', stock: '', low_stock_threshold: 5 }];

  render(`
    <div class="wrap" style="padding-bottom:100px">

      <!-- Back button -->
      <button class="back-btn" id="btn-inv-back">‹ Back</button>
      <div class="subscreen-title">${isEdit ? 'Edit Product' : 'Add Product'}</div>

      <!-- ── Section 1: Product details ──────────────────────────── -->
      <div class="card" style="margin-bottom:12px">
        <div class="section-title">Product Details</div>

        <div class="form-group">
          <label class="label">Name *</label>
          <input class="input" id="ve-name" value="${esc(productDoc?.name || '')}"
            placeholder="e.g. Rose Bush"/>
          <div class="form-error hide" id="ve-name-err">Name is required</div>
        </div>

        <div class="form-group">
          <label class="label">Category</label>
          <select class="input" id="ve-category">
            <option value="">Select…</option>
            ${CATEGORIES.map(c =>
              `<option value="${esc(c)}" ${(productDoc?.category || '') === c ? 'selected' : ''}>${esc(c)}</option>`
            ).join('')}
          </select>
        </div>

        <div class="form-group">
          <label class="label">Supplier <span style="font-size:10px;color:var(--muted);font-weight:400">optional</span></label>
          <input class="input" id="ve-supplier"
            value="${esc(productDoc?.supplier_name || '')}"
            placeholder="e.g. Green Leaf Co."
            list="ve-supplier-list" autocomplete="off"/>
          ${buildSupplierDatalist('ve-supplier-list')}
        </div>
      </div>

      <!-- ── Section 2: Variants ─────────────────────────────────── -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="section-title" style="margin-bottom:0">Variants</div>
          <button class="btn btn-secondary btn-small" id="btn-add-variant-row">＋ Add variant</button>
        </div>

        <div id="ve-variants-container">
          ${initialVariants.map((v, i) => _variantRowHtml(i, v)).join('')}
        </div>
      </div>

      <!-- Save button -->
      <button class="btn btn-primary" id="btn-ve-save"
        style="width:100%;justify-content:center;padding:13px">
        ${isEdit ? 'Save Changes' : 'Save Product'}
      </button>
      <div id="ve-save-result" style="font-size:12px;margin-top:8px;display:none"></div>

    </div>
  `);

  let rowCount = initialVariants.length;

  // ── Wire events ────────────────────────────────────────────────────

  // Back button
  document.getElementById('btn-inv-back')?.addEventListener('click', async () => {
    await loadCache(_session.businessId);
    _renderProductList();
  });

  // Add variant row
  document.getElementById('btn-add-variant-row')?.addEventListener('click', () => {
    const container = document.getElementById('ve-variants-container');
    if (!container) return;
    const div = document.createElement('div');
    div.innerHTML = _variantRowHtml(rowCount, {});
    container.appendChild(div.firstElementChild);
    rowCount++;
    _wireRemoveVariantBtns();
  });

  _wireRemoveVariantBtns();

  // Save
  document.getElementById('btn-ve-save')?.addEventListener('click', () =>
    _saveProduct(isEdit, productDoc, variantDocs, rowCount)
  );
}

// _wireRemoveVariantBtns() — wires all ✕ remove buttons in variant rows
function _wireRemoveVariantBtns() {
  document.querySelectorAll('.inv-ve-remove-btn').forEach(btn =>
    btn.onclick = () => {
      const row = document.querySelector(`.inv-ve-variant-row[data-row="${btn.dataset.row}"]`);
      if (row) row.remove();
    }
  );
}


// _saveProduct(isEdit, productDoc, variantDocs, rowCount)
// Reads all form fields, validates, writes to Firestore.
async function _saveProduct(isEdit, productDoc, variantDocs, rowCount) {
  const name     = document.getElementById('ve-name')?.value.trim()     || '';
  const category = document.getElementById('ve-category')?.value        || '';
  const supplier = document.getElementById('ve-supplier')?.value.trim() || '';
  const resultEl = document.getElementById('ve-save-result');

  // Validate name
  if (!name) {
    document.getElementById('ve-name-err')?.classList.remove('hide');
    document.getElementById('ve-name')?.focus();
    return;
  }
  document.getElementById('ve-name-err')?.classList.add('hide');

  // Collect variant rows from DOM
  const variantRows = [];
  const container   = document.getElementById('ve-variants-container');
  if (container) {
    container.querySelectorAll('.inv-ve-variant-row').forEach(row => {
      const idx       = row.dataset.row;
      const variantId = row.dataset.variantId || null;
      const size      = document.getElementById(`ve-size-${idx}`)?.value.trim()  || '';
      const price     = Number(document.getElementById(`ve-price-${idx}`)?.value) || 0;
      const stock     = Number(document.getElementById(`ve-stock-${idx}`)?.value) || 0;
      const stockOp   = document.getElementById(`ve-stock-op-${idx}`)?.value      || 'add';
      const stockRaw  = document.getElementById(`ve-stock-${idx}`)?.value;       // raw string — blank means no-op
      const threshold = Number(document.getElementById(`ve-threshold-${idx}`)?.value ?? 5) || 5;
      variantRows.push({ variantId, size, price, stock, stockOp, stockRaw, threshold });
    });
  }

  if (!variantRows.length) {
    _showResult(resultEl, 'Add at least one variant.', 'warn');
    return;
  }

  const btn = document.getElementById('btn-ve-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const p   = paths(_session.businessId);
  const now = dbNow();

  try {
    let firestoreProductId; // the Firestore doc id (not the productId field)

    if (isEdit && productDoc) {
      // Update product document
      firestoreProductId = productDoc.id;
      await dbUpdate(p.products, firestoreProductId, {
        name, category, supplier_name: supplier, updated_at: now,
      });

    } else {
      // Create product document
      const productData = {
        name,
        category,
        supplier_name: supplier,
        created_at:    now,
        updated_at:    now,
      };
      const addResult   = await dbAdd(p.products, productData);
      firestoreProductId = addResult.id;

      // Write stable productId field (same as Firestore doc id for simplicity)
      await dbUpdate(p.products, firestoreProductId, { productId: firestoreProductId });
    }

    // Process each variant row
    for (const vRow of variantRows) {
      let firestoreVariantId;

      if (vRow.variantId) {
        // Existing variant — update metadata only
        firestoreVariantId = vRow.variantId;
        // Update metadata including threshold
        await dbUpdate(p.variants, firestoreVariantId, {
          size:                vRow.size,
          price:               vRow.price,
          low_stock_threshold: vRow.threshold,
          updated_at:          now,
        });
      } else {
        // New variant — create
        const variantData = {
          product_id:                 firestoreProductId,
          size:                       vRow.size,
          price:                      vRow.price,
          low_stock_threshold:        vRow.threshold,
          lastPhysicalCountAt:        null,
          transactionCountSinceCount: 0,
          lastUpdateSource:           SOURCE_MANUAL,
          created_at:                 now,
          updated_at:                 now,
        };
        const vAddResult  = await dbAdd(p.variants, variantData);
        firestoreVariantId = vAddResult.id;

        // Initialise inventory_state for new variant
        await dbSet(p.inventoryState, firestoreVariantId, {
          total_quantity:    0,
          reserved_quantity: 0,
          available_quantity:0,
          last_event_id:     null,
          last_idempotency_key: null,
          updated_at:        now,
        });
      }

      // Stock operation — skip only if field left blank (undefined/empty string)
      // Note: "Set to 0" is valid so we only skip when the field was not touched (stock is NaN/null)
      const op           = vRow.stockOp || 'add';
      const stockBlank   = vRow.stockRaw === '' || vRow.stockRaw === null || vRow.stockRaw === undefined;
      const shouldRun    = !stockBlank && (op === 'set' ? vRow.stock >= 0 : vRow.stock > 0);

      if (shouldRun) {
        const idempotencyKey = generateIdempotencyKey('stock_op');

        if (op === 'add' || !isEdit) {
          const stockResult = await stockIn({
            businessId:     _session.businessId,
            variantId:      firestoreVariantId,
            productId:      firestoreProductId,
            quantity:       vRow.stock,
            reason:         isEdit ? 'Stock added via product edit' : 'Initial stock on product creation',
            source:         SOURCE_MANUAL,
            idempotencyKey,
          });
          if (stockResult.error) toast('Add stock failed: ' + stockResult.message, 'err');

        } else if (op === 'deduct') {
          try {
            const stateRes     = await dbGet(paths(_session.businessId).inventoryState, firestoreVariantId);
            const currentTotal = stateRes.ok ? (stateRes.data?.total_quantity    || 0) : 0;
            const reserved     = stateRes.ok ? (stateRes.data?.reserved_quantity || 0) : 0;
            const available    = Math.max(0, currentTotal - reserved);
            const label        = vRow.size ? ` (${vRow.size})` : '';

            if (vRow.stock > available) {
              toast(`Can only deduct up to ${available}${label} — ${reserved} unit${reserved !== 1 ? 's' : ''} are reserved for a confirmed order.`, 'warn');
            } else {
              const adjResult = await adjustStock({
                businessId:     _session.businessId,
                variantId:      firestoreVariantId,
                productId:      firestoreProductId,
                actualQuantity: currentTotal - vRow.stock,
                reason:         'Stock deducted via product edit',
                source:         SOURCE_MANUAL,
                adjustmentType: ADJ_CORRECTION,
                idempotencyKey,
              });
              if (adjResult.error) toast('Deduct failed: ' + adjResult.message, 'err');
            }
          } catch(e) { toast('Deduct failed: ' + (e.message || 'unknown'), 'err'); }
        }
      }
    }

    // Refresh cache
    await loadCache(_session.businessId);

    toast(isEdit ? '✓ Product updated' : '✓ Product saved');
    _renderProductList();

  } catch(e) {
    console.error('[inventory-screen._saveProduct] failed', e);
    _showResult(resultEl, 'Save failed: ' + (e.message || 'unknown error'), 'err');
    if (btn) { btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Save Product'; }
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 STOCK IN MODAL
// Quick stock addition for an existing variant.
// ════════════════════════════════════════════════════════════════════════

let _stockInTarget = null;

function _openStockInModal({ variantId, productId, productName, variantSize, available }) {
  _stockInTarget = { variantId, productId, productName, variantSize, available };

  // Remove existing modal if any
  document.getElementById('stock-in-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'stock-in-modal-overlay';
  overlay.className = 'cust-overlay';
  overlay.innerHTML = `
    <div class="cust-modal" style="max-width:380px">
      <div class="cust-modal-header">
        <div class="cust-modal-title">＋ Stock IN</div>
        <button class="agent-close-btn" id="si-close">✕</button>
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(productName)}${variantSize ? ' · ' + esc(variantSize) : ''}</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:16px">Current: ${available} available</div>

      <div class="form-group">
        <label class="label">Quantity to add *</label>
        <input class="input" id="si-qty" type="number" min="1" placeholder="e.g. 20"
          style="font-size:18px;text-align:center;padding:12px"/>
      </div>

      <div class="form-group">
        <label class="label">Reason *</label>
        <input class="input" id="si-reason" placeholder="e.g. Delivery from supplier"
          value="Delivery received"/>
      </div>

      <div id="si-result" style="font-size:12px;margin-bottom:10px;display:none"></div>

      <button class="btn btn-primary" id="si-confirm"
        style="width:100%;justify-content:center;padding:13px">
        ✓ Confirm Stock IN
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  // Focus quantity field
  setTimeout(() => document.getElementById('si-qty')?.focus(), 100);

  // Wire events
  document.getElementById('si-close')?.addEventListener('click', _closeStockInModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) _closeStockInModal(); });
  document.getElementById('si-confirm')?.addEventListener('click', _confirmStockIn);
}

function _closeStockInModal() {
  document.getElementById('stock-in-modal-overlay')?.remove();
  _stockInTarget = null;
}

async function _confirmStockIn() {
  if (!_stockInTarget) return;

  const qty    = Number(document.getElementById('si-qty')?.value)    || 0;
  const reason = document.getElementById('si-reason')?.value.trim()  || '';
  const resultEl = document.getElementById('si-result');

  if (qty <= 0) { _showResult(resultEl, 'Enter a quantity greater than 0.', 'err'); return; }
  if (!reason)  { _showResult(resultEl, 'Reason is required.', 'err'); return; }

  const btn = document.getElementById('si-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const idempotencyKey = generateIdempotencyKey('stock_in');
  const result = await stockIn({
    businessId:     _session.businessId,
    variantId:      _stockInTarget.variantId,
    productId:      _stockInTarget.productId,
    quantity:       qty,
    reason,
    source:         SOURCE_MANUAL,
    idempotencyKey,
  });

  if (result.error) {
    _showResult(resultEl, 'Stock IN failed: ' + result.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '✓ Confirm Stock IN'; }
    return;
  }

  const newAvailable = _stockInTarget.available + qty;
  toast(`✓ +${qty} added · ${_stockInTarget.productName}${_stockInTarget.variantSize ? ' ' + _stockInTarget.variantSize : ''} · now ${newAvailable} available`);
  _closeStockInModal();

  // Refresh cache and re-render list
  await loadCache(_session.businessId);
  _renderProductList();
}


// ════════════════════════════════════════════════════════════════════════
// §8 HELPERS
// ════════════════════════════════════════════════════════════════════════

function _showResult(el, msg, type) {
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = type === 'ok' ? 'var(--grn2)' : type === 'warn' ? 'var(--gold)' : 'var(--red)';
  el.textContent   = msg;
}


// ════════════════════════════════════════════════════════════════════════
// §9 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('inventory-styles')) return;
  const s = document.createElement('style');
  s.id = 'inventory-styles';
  s.textContent = `
.inv-filter-row{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.inv-filter-row::-webkit-scrollbar{display:none}
.inv-filter-chip{padding:5px 12px;border-radius:99px;border:1px solid var(--bdr2);background:var(--sur2);color:var(--muted);font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .15s;flex-shrink:0}
.inv-filter-chip.active{background:var(--gdim);border-color:var(--gbdr);color:var(--grn2)}

.inv-product-card{background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);margin-bottom:10px;overflow:hidden}
.inv-product-header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--bdr)}
.inv-product-info{flex:1;min-width:0}
.inv-product-name{font-size:14px;font-weight:600;margin-bottom:2px}
.inv-product-cat{font-size:11px;color:var(--muted)}
.inv-edit-btn{background:none;border:1px solid var(--bdr2);border-radius:6px;color:var(--muted);font-size:14px;cursor:pointer;padding:5px 9px;transition:all .15s;flex-shrink:0}
.inv-edit-btn:hover{color:var(--txt2);border-color:var(--bdr)}

.inv-variants{padding:0 0 4px}
.inv-variant-row{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--bdr)}
.inv-variant-row:last-child{border-bottom:none}
.inv-variant-info{flex:1;min-width:0}
.inv-variant-size{font-size:13px;font-weight:500;display:block}
.inv-variant-stock{font-size:11px;color:var(--muted);display:block;margin-top:1px}
.inv-variant-stock.low{color:var(--gold)}
.inv-variant-stock.out{color:var(--red)}
.inv-variant-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.inv-variant-price{font-size:12px;font-weight:600;color:var(--grn2)}
.inv-stock-in-btn{padding:5px 10px;border-radius:6px;border:1px solid var(--gbdr);background:var(--gdim);color:var(--grn2);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.inv-stock-in-btn:hover{background:var(--grn);color:#080f09}

.inv-ve-variant-row{display:flex;align-items:flex-end;gap:8px;padding:10px 0;border-bottom:1px solid var(--bdr)}
.inv-ve-variant-row:last-child{border-bottom:none}
.inv-ve-variant-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px;flex:1;min-width:0}
@media(max-width:480px){.inv-ve-variant-fields{grid-template-columns:1fr 1fr}}
.inv-ve-field{}
.inv-ve-remove-btn{background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;padding:4px;flex-shrink:0;margin-bottom:4px}
.inv-ve-remove-btn:hover{color:var(--red)}
`;
  document.head.appendChild(s);
}
