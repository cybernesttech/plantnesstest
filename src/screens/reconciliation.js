// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/reconciliation.js
// PURPOSE: Reconciliation — count physical stock, submit for manager approval.
//          Staff sees system values as reference. Blank = skip (never zero).
//          Manager approves → RECONCILIATION events written per changed variant.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER  (counting list)
// §4  SUBMIT RECONCILIATION
// §5  APPROVE RECONCILIATION  (manager — called from pending screen)
// §6  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, emptyState } from '../ui.js';
import { loadCache, searchProducts, isCacheLoaded } from '../services/products.js';
import { saveDraft, submitDraft } from '../services/drafts.js';
import {
  adjustStock, generateIdempotencyKey,
  ADJ_RECONCILIATION, SOURCE_RECONCILIATION,
} from '../inventory.js';
import { dbList, paths } from '../db.js';
import * as Auth from '../auth.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session = null;
let _onBack      = null;
let _counts  = {}; // { variantId: enteredCount } — only filled-in variants


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderReconciliation(session, onBack) {
  _onBack = onBack || null;
  _session = session;
  _counts  = {};
  console.log('[reconciliation.renderReconciliation] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Building count list…');

  // Ensure cache loaded
  if (!isCacheLoaded()) await loadCache(session.businessId);

  _renderCountList();
}

function _renderCountList() {
  const products = searchProducts('');

  if (!products.length) {
    render(`<div class="wrap">${emptyState('📦', 'No products yet', 'Add products in the Stock tab first.')}</div>`);
    return;
  }

  // Sort: low confidence first (needs counting most), then by name
  const sorted = [...products].sort((a, b) => {
    const aLow = a.variants.some(v => v.isLowConfidence) ? 0 : 1;
    const bLow = b.variants.some(v => v.isLowConfidence) ? 0 : 1;
    if (aLow !== bLow) return aLow - bLow;
    return (a.name || '').localeCompare(b.name || '');
  });

  const isStaff = !Auth.isManager();

  render(`
    <div class="wrap" style="padding-bottom:120px">

      <button class="back-btn" id="sub-back-btn">‹ Back</button>
      <div class="subscreen-title" style="margin-bottom:4px">Count Stock</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:6px;line-height:1.7">
        Enter the actual count for each variant. Leave blank to skip — blank means "not counted", not zero.
      </div>
      ${isStaff ? `
      <div style="font-size:12px;color:var(--gold);background:rgba(201,168,76,.08);border:1px solid var(--gobdr);border-radius:7px;padding:9px 12px;margin-bottom:14px">
        ⚠ Your count will go to the manager for approval before stock is updated.
      </div>` : ''}

      <!-- Product list -->
      ${sorted.map(product => `
        <div class="recon-product-group">
          <div class="recon-product-name">${esc(product.name)}<span class="recon-product-cat"> · ${esc(product.category || '')}</span></div>
          ${product.variants.map(v => `
            <div class="recon-variant-row">
              <div class="recon-variant-info">
                <span class="recon-variant-size">${esc(v.size || 'Default')}</span>
                <span class="recon-system-val ${v.isLowConfidence ? 'low-conf' : ''}">
                  System: ${esc(v.stockLabel)}
                </span>
              </div>
              <input
                type="number" min="0" placeholder="—"
                class="recon-count-input" id="recon-${esc(v.variantId)}"
                data-variant="${esc(v.variantId)}"
                data-product="${esc(v.productId)}"
                data-system="${v.available}"
                inputmode="numeric"
              />
            </div>
          `).join('')}
        </div>
      `).join('')}

    </div>

    <!-- Submit bar -->
    <div class="recon-submit-bar">
      <div style="font-size:12px;color:var(--muted)" id="recon-count-summary">No counts entered yet</div>
      <button class="btn btn-primary" id="btn-recon-submit" disabled style="flex-shrink:0">
        ${isStaff ? 'Submit for Approval' : 'Apply Count'}
      </button>
    </div>
  `);

  _wireCountEvents(isStaff);

  // Back button
  document.getElementById('sub-back-btn')?.addEventListener('click', () =>
    _onBack ? _onBack() : window.switchScreen('more')
  );
}


// ════════════════════════════════════════════════════════════════════════
// §4 SUBMIT RECONCILIATION
// ════════════════════════════════════════════════════════════════════════

function _wireCountEvents(isStaff) {
  // Track counts as user types
  document.querySelectorAll('.recon-count-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const variantId = inp.dataset.variant;
      const val       = inp.value.trim();

      // Blank = remove from counts (skip)
      if (val === '' || val === null) {
        delete _counts[variantId];
      } else {
        const num = Number(val);
        if (!isNaN(num) && num >= 0) {
          _counts[variantId] = {
            variantId,
            productId:  inp.dataset.product,
            actual:     num,
            system:     Number(inp.dataset.system),
          };
        }
      }

      // Update summary
      const count    = Object.keys(_counts).length;
      const changes  = Object.values(_counts).filter(c => c.actual !== c.system).length;
      const summaryEl = document.getElementById('recon-count-summary');
      const submitBtn = document.getElementById('btn-recon-submit');

      if (summaryEl) {
        summaryEl.textContent = count === 0
          ? 'No counts entered yet'
          : `${count} variant${count !== 1 ? 's' : ''} counted · ${changes} differ from system`;
      }
      if (submitBtn) submitBtn.disabled = count === 0;
    });
  });

  // Submit / Apply
  document.getElementById('btn-recon-submit')?.addEventListener('click', () => {
    isStaff ? _submitForApproval() : _applyDirectly();
  });
}

async function _submitForApproval() {
  const entries = Object.values(_counts);
  if (!entries.length) { toast('Enter at least one count', 'warn'); return; }

  const btn = document.getElementById('btn-recon-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  // Build items for draft — only include variants with changes
  const items = entries.map(e => ({
    productId:   e.productId,
    variantId:   e.variantId,
    productName: '', // enriched by pending screen from cache
    variantSize: '',
    quantity:    e.actual,
    direction:   'reconciliation', // special direction flag
    price:       0,
    unit:        'pcs',
    systemQty:   e.system,
    delta:       e.actual - e.system,
  }));

  try {
    const draftResult = await saveDraft(_session.businessId, _session.uid, {
      items,
      source:   'reconciliation',
      rawInput: `Reconciliation count — ${items.length} variants`,
    });

    if (draftResult.error) { toast('Save failed: ' + draftResult.message, 'err'); return; }

    const submitResult = await submitDraft(_session.businessId, draftResult.draftId, {
      userId:      _session.uid,
      displayName: _session.displayName,
      email:       _session.email,
      notes:       `Reconciliation — ${items.length} variant${items.length !== 1 ? 's' : ''} counted`,
    });

    if (submitResult.error) { toast('Submit failed: ' + submitResult.message, 'err'); return; }

    toast(`✓ Count submitted for approval (${items.length} variants)`);
    if (window.refreshPendingBadge) window.refreshPendingBadge();
    _counts = {};
    _renderCountList();

  } catch(e) {
    toast('Failed: ' + e.message, 'err');
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Submit for Approval'; }
}

async function _applyDirectly() {
  const entries = Object.values(_counts);
  if (!entries.length) { toast('Enter at least one count', 'warn'); return; }

  // Only apply variants where actual ≠ system
  const changes = entries.filter(e => e.actual !== e.system);
  if (!changes.length) {
    toast('All counts match system — nothing to update', 'warn');
    return;
  }

  const btn = document.getElementById('btn-recon-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }

  let applied = 0;
  let failed  = 0;

  for (const entry of changes) {
    const idempotencyKey = generateIdempotencyKey('recon');
    const result = await adjustStock({
      businessId:     _session.businessId,
      variantId:      entry.variantId,
      productId:      entry.productId,
      actualQuantity: entry.actual,
      reason:         'Physical count reconciliation',
      source:         SOURCE_RECONCILIATION,
      adjustmentType: ADJ_RECONCILIATION,
      idempotencyKey,
    });

    if (result.error) { failed++; console.warn('[reconciliation] adjustStock failed', result); }
    else               applied++;
  }

  // Refresh cache
  await loadCache(_session.businessId);

  const msg = `✓ ${applied} variant${applied !== 1 ? 's' : ''} reconciled`
    + (failed ? ` · ${failed} failed` : '')
    + (entries.length - changes.length > 0 ? ` · ${entries.length - changes.length} unchanged` : '');

  toast(msg, failed ? 'warn' : 'ok');
  _counts = {};
  _renderCountList();

  if (btn) { btn.disabled = false; btn.textContent = 'Apply Count'; }
}


// ════════════════════════════════════════════════════════════════════════
// §5 APPROVE RECONCILIATION  (called from pending.js)
// ════════════════════════════════════════════════════════════════════════

// approveReconciliation(businessId, items, submittedByName)
// Called by the pending screen when manager approves a reconciliation submission.
// items: [{ variantId, productId, quantity (=actual), systemQty, delta }]
// Returns: { ok, applied, skipped }
export async function approveReconciliation(businessId, items, submittedByName = 'staff') {
  console.log('[reconciliation.approveReconciliation] called', { itemCount: items.length });

  let applied = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.variant_id && !item.variantId) { skipped++; continue; }
    const variantId = item.variant_id || item.variantId;
    const productId = item.product_id || item.productId;
    const actual    = Number(item.quantity); // quantity field = actual count

    const idempotencyKey = generateIdempotencyKey('recon_approve');
    const result = await adjustStock({
      businessId,
      variantId,
      productId,
      actualQuantity: actual,
      reason:         `Reconciliation approved — submitted by ${submittedByName}`,
      source:         SOURCE_RECONCILIATION,
      adjustmentType: ADJ_RECONCILIATION,
      idempotencyKey,
    });

    if (result.error) {
      console.warn('[reconciliation.approveReconciliation] adjustStock failed', { variantId, result });
      skipped++;
    } else {
      applied++;
    }
  }

  // Refresh cache
  await loadCache(businessId);

  console.log('[reconciliation.approveReconciliation] done', { applied, skipped });
  return { ok: true, applied, skipped };
}


// ════════════════════════════════════════════════════════════════════════
// §6 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('recon-styles')) return;
  const s = document.createElement('style');
  s.id = 'recon-styles';
  s.textContent = `
.recon-product-group{background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);margin-bottom:10px;overflow:hidden}
.recon-product-name{font-size:13px;font-weight:600;padding:10px 14px 6px;border-bottom:1px solid var(--bdr)}
.recon-product-cat{font-size:11px;color:var(--muted);font-weight:400}
.recon-variant-row{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--bdr);gap:10px}
.recon-variant-row:last-child{border-bottom:none}
.recon-variant-info{flex:1;min-width:0}
.recon-variant-size{font-size:13px;font-weight:500;display:block}
.recon-system-val{font-size:11px;color:var(--muted);display:block;margin-top:1px}
.recon-system-val.low-conf{color:var(--gold)}
.recon-count-input{width:72px;padding:7px 8px;font-size:15px;font-weight:600;text-align:center;background:var(--bg2);border:1px solid var(--bdr);border-radius:7px;color:var(--txt);flex-shrink:0}
.recon-count-input:focus{border-color:var(--gbdr);outline:none}
.recon-count-input:not(:placeholder-shown){border-color:var(--grn);color:var(--grn2)}
.recon-submit-bar{position:fixed;bottom:var(--nav-h);left:0;right:0;background:var(--bg);border-top:2px solid var(--bdr2);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:300}
`;
  document.head.appendChild(s);
}
