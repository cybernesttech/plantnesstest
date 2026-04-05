// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/pending.js
// PURPOSE: Pending submissions screen — manager/owner reviews and
//          approves or rejects stock submissions from staff.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  SUBMISSION CARD
// §5  APPROVE / REJECT
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, fmtCurrency, emptyState } from '../ui.js';
import { listPending, approvePending, rejectPending } from '../services/drafts.js';
import { approveReconciliation } from './reconciliation.js';
import { dbUpdate, dbNow } from '../db.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session     = null;
let _onBack      = null;  // callback to return to More menu
let _submissions = [];


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderPending(session, onBack) {
  _onBack = onBack || null;
  _session = session;
  console.log('[pending.renderPending] called', { businessId: session.businessId });

  renderLoading('Loading pending submissions…');
  await _load();
  _render();
}

async function _load() {
  _submissions = await listPending(_session.businessId);
  console.log('[pending._load]', { count: _submissions.length });
}

function _render() {
  // Group by submitter
  const groups = {};
  for (const s of _submissions) {
    const key = s.submitted_by_name || s.submitted_by_email || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  const staffNames = Object.keys(groups);

  render(`
    <div class="wrap" style="padding-bottom:40px">

      <button class="back-btn" id="sub-back-btn">‹ Back</button>
      <div class="subscreen-title" style="margin-bottom:4px">Pending Submissions</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:14px">
        ${_submissions.length} pending item${_submissions.length !== 1 ? 's' : ''}
      </div>

      ${_submissions.length > 0 ? `
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn btn-primary btn-small" id="btn-approve-all">✓ Approve All (${_submissions.length})</button>
        <button class="btn btn-danger btn-small" id="btn-reject-all">✕ Reject All</button>
      </div>` : ''}

      ${staffNames.length
        ? staffNames.map((name, gi) => _renderGroup(name, groups[name], gi)).join('')
        : emptyState('⏳', 'No pending submissions', 'Staff stock submissions will appear here for review.')
      }

    </div>
  `);

  // Back button
  document.getElementById('sub-back-btn')?.addEventListener('click', () =>
    _onBack ? _onBack() : window.switchScreen('more')
  );

  // Approve / reject all
  document.getElementById('btn-approve-all')?.addEventListener('click', async () => {
    if (!confirm(`Approve all ${_submissions.length} pending submissions?`)) return;
    const btn = document.getElementById('btn-approve-all');
    btn.disabled = true; btn.textContent = 'Approving…';
    let applied = 0, skipped = 0;
    try {
      for (const s of [..._submissions]) {
        const result = await approvePending(_session.businessId, s.id, { reviewedBy: _session.uid });
        if (result.ok) { applied += result.applied; skipped += result.skipped; }
      }
      toast(`✓ ${applied} items applied${skipped ? `, ${skipped} skipped` : ''}`);
    } catch(e) {
      toast('Approve failed: ' + e.message, 'err');
    }
    await _load(); _render();
    if (window.refreshPendingBadge) window.refreshPendingBadge();
  });

  document.getElementById('btn-reject-all')?.addEventListener('click', async () => {
    if (!confirm(`Reject all ${_submissions.length} pending submissions?`)) return;
    for (const s of [..._submissions]) await rejectPending(_session.businessId, s.id);
    toast('All submissions rejected', 'warn');
    await _load(); _render();
    if (window.refreshPendingBadge) window.refreshPendingBadge();
  });

  // Wire individual group actions
  _wireGroupActions(staffNames, groups);
}

function _renderGroup(staffName, items, gi) {
  const initials = staffName.trim().split(' ').map(p => p[0]).slice(0,2).join('').toUpperCase();
  const groupId  = `pend-group-${gi}`;

  const itemsHtml = items.map(s => {
    const fmtDate = s.submitted_at
      ? new Date(s.submitted_at).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
      : '—';

    const isRecon = s.source === 'reconciliation';
    const sourceLabel = isRecon ? '🔍 Reconciliation'
      : s.source === 'ai_scan' ? '⚡ AI Scan' : '✎ Manual';

    const CATEGORIES = ['Plants','Seeds & Bulbs','Soil & Fertilizer','Pots & Planters','Tools & Accessories','Cut Flowers'];

    return `
      <div class="pend-submission-card">
        <div class="pend-submission-meta">
          ${esc(sourceLabel)} · ${esc(fmtDate)}
          ${s.notes ? ` · ${esc(s.notes)}` : ''}
        </div>
        <div class="pend-items-list">
          ${(s.items || []).map((i, idx) => {
            if (i.direction === 'reconciliation' || isRecon) {
              const actual = Number(i.quantity || 0);
              const system = Number(i.systemQty || i.system_qty || 0);
              const delta  = actual - system;
              const dSign  = delta > 0 ? '+' : '';
              const dCol   = delta > 0 ? 'var(--grn2)' : delta < 0 ? 'var(--red)' : 'var(--muted)';
              const name   = i.product_name || i.productName || '';
              const size   = i.variant_size || i.variantSize || '';
              return `<div class="pend-item-row">
                <span class="pend-item-dir pend-item-recon">= COUNT</span>
                <span class="pend-item-name">${esc(name)}${size ? ` <span style="color:var(--muted);font-size:10px">${esc(size)}</span>` : ''}</span>
                <span class="pend-item-qty" style="color:${dCol}">${actual}${delta !== 0 ? ` (${dSign}${delta})` : ' (no change)'}</span>
              </div>`;
            }

            // Full editable card for IN/OUT items
            const isNew    = !i.variant_id;
            const dirLabel = i.direction === 'out' ? '↓ OUT' : '↑ IN';
            const dirClass = i.direction === 'out' ? 'out' : 'in';
            const itemKey  = `${esc(s.id)}-${idx}`;

            return `
            <div class="pend-item-card ${isNew ? 'pend-item-new' : ''}" id="pend-item-${itemKey}">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span class="pend-item-dir ${dirClass}">${dirLabel}</span>
                ${isNew ? `<span style="font-size:9px;background:var(--gdim);color:var(--grn2);border:1px solid var(--gbdr);padding:1px 7px;border-radius:99px;font-weight:700">✦ NEW</span>` : ''}
                <span style="font-size:12px;font-weight:600;flex:1">${esc(i.product_name || '')}${i.variant_size ? ` · <span style="color:var(--muted)">${esc(i.variant_size)}</span>` : ''}</span>
                <span class="pend-item-qty">${i.direction === 'out' ? '−' : '+'}${Number(i.quantity)}</span>
              </div>

              <!-- Editable fields — always shown -->
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Product Name</div>
                  <input class="input pend-edit-name" data-sid="${esc(s.id)}" data-idx="${idx}"
                    value="${esc(i.product_name || '')}" style="font-size:12px;padding:5px 8px"/>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Variant / Size</div>
                  <input class="input pend-edit-variant" data-sid="${esc(s.id)}" data-idx="${idx}"
                    value="${esc(i.variant_size || '')}" placeholder="e.g. Small, Red…" style="font-size:12px;padding:5px 8px"/>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Qty</div>
                  <input class="input pend-edit-qty" data-sid="${esc(s.id)}" data-idx="${idx}"
                    type="number" min="1" value="${Number(i.quantity || 1)}" style="font-size:12px;padding:5px 8px"/>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Price ₹</div>
                  <input class="input pend-edit-price" data-sid="${esc(s.id)}" data-idx="${idx}"
                    type="number" min="0" value="${Number(i.price || 0)}" style="font-size:12px;padding:5px 8px"/>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px">Category</div>
                  <select class="input pend-edit-category" data-sid="${esc(s.id)}" data-idx="${idx}"
                    style="font-size:12px;padding:5px 8px">
                    ${CATEGORIES.map(c => `<option value="${esc(c)}" ${(i.category||'Plants')===c?'selected':''}>${esc(c)}</option>`).join('')}
                  </select>
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div style="display:flex;gap:7px;margin-top:10px">
          <button class="btn btn-primary btn-small" data-approve="${esc(s.id)}">✓ Approve</button>
          <button class="btn btn-danger btn-small" data-reject="${esc(s.id)}">✕ Reject</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="pend-group-card">
      <div class="pend-group-header" data-group="${groupId}">
        <div class="pend-group-avatar">${esc(initials)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${esc(staffName)}</div>
          <div style="font-size:11px;color:var(--muted)">${items.length} submission${items.length !== 1 ? 's' : ''}</div>
        </div>
        <button class="btn btn-primary btn-small" data-approve-group="${gi}">✓ Approve All</button>
        <button class="btn btn-danger btn-small" data-reject-group="${gi}">✕ Reject All</button>
        <span class="pend-arrow" id="${groupId}-arrow">▼</span>
      </div>
      <div id="${groupId}" style="display:block">
        ${itemsHtml}
      </div>
    </div>
  `;
}


// ════════════════════════════════════════════════════════════════════════
// §5 APPROVE / REJECT
// ════════════════════════════════════════════════════════════════════════

function _wireGroupActions(staffNames, groups) {
  // Expand/collapse
  document.querySelectorAll('.pend-group-header').forEach(hdr =>
    hdr.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const gid   = hdr.dataset.group;
      const body  = document.getElementById(gid);
      const arrow = document.getElementById(`${gid}-arrow`);
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display    = open ? 'none' : 'block';
      if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
    })
  );

  // Approve group
  document.querySelectorAll('[data-approve-group]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const gi    = parseInt(btn.dataset.approveGroup);
      const name  = staffNames[gi];
      const items = groups[name];
      if (!items) return;
      btn.disabled = true; btn.textContent = 'Approving…';
      let applied = 0, skipped = 0;
      try {
        for (const s of [...items]) {
          await _syncEditableFields(s.id);
          const r = await approvePending(_session.businessId, s.id, { reviewedBy: _session.uid });
          if (r.ok) { applied += r.applied; skipped += r.skipped; }
        }
        toast(`✓ ${applied} items from ${name} applied${skipped ? `, ${skipped} skipped` : ''}`);
      } catch(e) {
        toast('Approve failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = '✓ Approve All';
        return;
      }
      await _load(); _render();
      if (window.refreshPendingBadge) window.refreshPendingBadge();
    })
  );

  // Reject group
  document.querySelectorAll('[data-reject-group]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const gi    = parseInt(btn.dataset.rejectGroup);
      const name  = staffNames[gi];
      const items = groups[name];
      if (!items || !confirm(`Reject all from ${name}?`)) return;
      for (const s of [...items]) await rejectPending(_session.businessId, s.id);
      toast(`Rejected all from ${name}`, 'warn');
      await _load(); _render();
      if (window.refreshPendingBadge) window.refreshPendingBadge();
    })
  );

  // Individual approve — sync editable fields to Firestore first, then approve
  document.querySelectorAll('[data-approve]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.approve;
      btn.disabled = true; btn.textContent = 'Saving…';
      await _syncEditableFields(sid);
      btn.textContent = 'Approving…';
      const result = await approvePending(_session.businessId, sid, { reviewedBy: _session.uid });
      if (result.error) { toast(result.message, 'err'); btn.disabled = false; btn.textContent = '✓ Approve'; return; }
      toast(`✓ ${result.applied} item${result.applied !== 1 ? 's' : ''} applied${result.skipped ? `, ${result.skipped} skipped` : ''}`);
      await _load(); _render();
      if (window.refreshPendingBadge) window.refreshPendingBadge();
    })
  );

  // Individual reject
  document.querySelectorAll('[data-reject]').forEach(btn =>
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      await rejectPending(_session.businessId, btn.dataset.reject);
      toast('Submission rejected', 'warn');
      await _load(); _render();
      if (window.refreshPendingBadge) window.refreshPendingBadge();
    })
  );
}


// ════════════════════════════════════════════════════════════════════════
// CSS — injected once
// ════════════════════════════════════════════════════════════════════════

// _syncEditableFields(submissionId)
// Reads the editable inputs in the pending card, updates the in-memory
// _submissions array AND writes the updated items back to Firestore
// so that approvePending (which reads from Firestore) sees the edits.
async function _syncEditableFields(sid) {
  const submission = _submissions.find(s => s.id === sid);
  if (!submission) return;

  const updatedItems = (submission.items || []).map((item, idx) => {
    const name     = document.querySelector(`.pend-edit-name[data-sid="${sid}"][data-idx="${idx}"]`)?.value.trim();
    const variant  = document.querySelector(`.pend-edit-variant[data-sid="${sid}"][data-idx="${idx}"]`)?.value.trim();
    const qty      = document.querySelector(`.pend-edit-qty[data-sid="${sid}"][data-idx="${idx}"]`)?.value;
    const price    = document.querySelector(`.pend-edit-price[data-sid="${sid}"][data-idx="${idx}"]`)?.value;
    const category = document.querySelector(`.pend-edit-category[data-sid="${sid}"][data-idx="${idx}"]`)?.value;
    return {
      ...item,
      product_name: name     !== undefined ? name     : item.product_name,
      variant_size: variant  !== undefined ? variant  : item.variant_size,
      quantity:     qty      ? Number(qty)   : item.quantity,
      price:        price    ? Number(price) : item.price,
      category:     category ?? item.category,
    };
  });

  // Update in-memory
  submission.items = updatedItems;

  // Write back to Firestore so approvePending reads the corrected data
  try {
    await dbUpdate(
      `businesses/${_session.businessId}/pending_submissions`,
      sid,
      { items: updatedItems, updated_at: dbNow() }
    );
  } catch(e) {
    console.warn('[pending._syncEditableFields] Firestore update failed', e?.message);
  }
}

(function injectPendingStyles() {
  if (document.getElementById('pending-styles')) return;
  const s = document.createElement('style');
  s.id = 'pending-styles';
  s.textContent = `
.pend-group-card{background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);margin-bottom:10px;overflow:hidden}
.pend-group-header{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;background:var(--bg2);user-select:none}
.pend-group-avatar{width:34px;height:34px;border-radius:50%;background:var(--grn);color:#080f09;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
.pend-arrow{font-size:11px;color:var(--muted);transition:transform .2s;flex-shrink:0}
.pend-submission-card{padding:12px 14px;border-top:1px solid var(--bdr)}
.pend-submission-meta{font-size:10px;color:var(--muted);margin-bottom:8px;letter-spacing:.3px}
.pend-items-list{display:flex;flex-direction:column;gap:8px}
.pend-item-row{display:flex;align-items:center;gap:8px;font-size:12px}
.pend-item-card{background:var(--bg2);border:1px solid var(--bdr);border-radius:var(--r);padding:10px}
.pend-item-new{border-color:var(--gbdr);background:var(--gdim)}
.pend-item-dir{font-size:9px;font-weight:700;padding:2px 7px;border-radius:99px;flex-shrink:0}
.pend-item-dir.in{background:var(--gdim);color:var(--grn2);border:1px solid var(--gbdr)}
.pend-item-dir.out{background:var(--rdim);color:var(--red);border:1px solid var(--rbdr)}
.pend-item-dir.pend-item-recon{background:var(--bdim);color:var(--blue);border:1px solid var(--bbdr)}
.pend-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.pend-item-qty{font-size:12px;font-weight:700;flex-shrink:0;color:var(--txt2)}
`;
  document.head.appendChild(s);
})();
