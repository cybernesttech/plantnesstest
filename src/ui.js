// ════════════════════════════════════════════════════════════════════════
// FILE: src/ui.js
// PURPOSE: Shared UI component builders used by all screen modules.
//          Pure functions — take data, return HTML strings or DOM elements.
//          No Firestore calls here. No auth calls here.
//          Import this in every screen module.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  STRING HELPERS
// §2  BADGE BUILDERS
// §3  CARD BUILDERS
// §4  EMPTY STATE BUILDER
// §5  TOAST
// §6  LOADING SPINNER
// §7  SCREEN RENDERER  (mounts content into #screen-content)
// §8  MODAL HELPERS
// §9  FORM HELPERS
// ════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════
// §1 STRING HELPERS
// Used everywhere — always escape user data before inserting into innerHTML.
// ════════════════════════════════════════════════════════════════════════

// esc(str) — HTML-escape a string before inserting into innerHTML
export function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// initials(name) — "John Smith" → "JS", "Plantness" → "P"
export function initials(name) {
  const parts = (name || '?').trim().split(' ');
  return (parts.length > 1
    ? parts[0][0] + parts[parts.length - 1][0]
    : parts[0][0]
  ).toUpperCase();
}

// fmtDate(isoString) — "2026-03-21T07:03:00.873Z" → "Mar 21, 2026"
export function fmtDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch(e) { return '—'; }
}

// fmtDateTime(isoString) — "Mar 21, 2026 · 12:30 PM"
export function fmtDateTime(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch(e) { return '—'; }
}

// fmtCurrency(amount) — 1500 → "₹1,500"
export function fmtCurrency(amount) {
  if (amount == null || amount === '') return '—';
  return '₹' + Number(amount).toLocaleString('en-IN');
}

// fmtQty(qty, unit) — 12, "pcs" → "12 pcs"
export function fmtQty(qty, unit = 'pcs') {
  return `${Number(qty || 0).toLocaleString('en-IN')} ${esc(unit)}`;
}


// ════════════════════════════════════════════════════════════════════════
// §2 BADGE BUILDERS
// Return HTML strings. All values are escaped.
// ════════════════════════════════════════════════════════════════════════

// orderStatusBadge(status) — coloured pill for order status
export function orderStatusBadge(status) {
  const map = {
    draft:                  ['badge-draft',      'Draft'],
    confirmed:              ['badge-confirmed',  'Confirmed'],
    dispatched:             ['badge-dispatched', 'Dispatched'],
    delivered:              ['badge-delivered',  'Delivered'],
    cancelled:              ['badge-cancelled',  'Cancelled'],
    EXPIRED_PENDING_ACTION: ['badge-expired',    'Expired'],
  };
  const [cls, label] = map[status] || ['badge-draft', esc(status)];
  return `<span class="badge ${cls}">${label}</span>`;
}

// stockBadge(totalQty, reservedQty, threshold)
// Shows availability state as a coloured pill.
// Uses availableQty = total - reserved for the display.
export function stockBadge(totalQty, reservedQty = 0, threshold = 5) {
  const available = Math.max(0, Number(totalQty || 0) - Number(reservedQty || 0));
  if (available <= 0)                                        return `<span class="badge badge-none">Out of stock</span>`;
  if (Number(threshold) > 0 && available <= Number(threshold)) return `<span class="badge badge-low">Low stock</span>`;
  return `<span class="badge badge-high">In stock</span>`;
}

// roleBadge(role) — owner / manager / staff pill
export function roleBadge(role) {
  const map = {
    owner:   'role-owner',
    manager: 'role-manager',
    staff:   'role-staff',
  };
  return `<span class="role-badge ${map[role] || 'role-staff'}">${esc(role)}</span>`;
}

// confidencePrefix(isLowConfidence)
// Returns '~' prefix string if confidence is low.
// Used before quantity values to signal uncertainty.
export function confidencePrefix(isLowConfidence) {
  return isLowConfidence ? '<span class="confidence-low"></span>' : '';
}


// ════════════════════════════════════════════════════════════════════════
// §3 CARD BUILDERS
// Return HTML strings for common card layouts.
// ════════════════════════════════════════════════════════════════════════

// sectionTitle(text) — uppercase label above a section
export function sectionTitle(text) {
  return `<div class="section-title">${esc(text)}</div>`;
}

// infoRow(label, value) — single label:value row inside a card
export function infoRow(label, value) {
  return `<div class="info-row">
    <span class="info-label">${esc(label)}</span>
    <span class="info-value">${value}</span>
  </div>`;
}

// statBox(value, label, colour) — small summary stat box
// colour: 'grn' | 'gold' | 'red' | 'default'
export function statBox(value, label, colour = 'default') {
  const colourMap = {
    grn:     'color:var(--grn2)',
    gold:    'color:var(--gold)',
    red:     'color:var(--red)',
    default: '',
  };
  return `<div class="stat-box">
    <div class="stat-value" style="${colourMap[colour] || ''}">${esc(String(value))}</div>
    <div class="stat-label">${esc(label)}</div>
  </div>`;
}


// ════════════════════════════════════════════════════════════════════════
// §4 EMPTY STATE BUILDER
// ════════════════════════════════════════════════════════════════════════

// emptyState(icon, title, subtitle, actionHtml)
// actionHtml: optional button HTML to show below the subtitle
export function emptyState(icon, title, subtitle, actionHtml = '') {
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${esc(title)}</div>
    <div class="empty-state-sub">${esc(subtitle)}</div>
    ${actionHtml}
  </div>`;
}


// ════════════════════════════════════════════════════════════════════════
// §5 TOAST
// Global notification. Type: 'ok' | 'warn' | 'err'
// ════════════════════════════════════════════════════════════════════════

let _toastTimer = null;

// toast(message, type)
// Shows a brief notification at the bottom of the screen.
export function toast(message, type = 'ok') {
  console.log('[ui.toast]', { message, type });
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;

  toastEl.textContent      = message;
  toastEl.style.background = type === 'err'  ? 'var(--red)'  :
                             type === 'warn' ? '#7a5c10'     : 'var(--grn)';
  toastEl.style.display    = 'block';

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3200);
}


// ════════════════════════════════════════════════════════════════════════
// §6 LOADING SPINNER
// Inline spinner HTML — used inside screen content while data loads.
// ════════════════════════════════════════════════════════════════════════

// loadingSpinner(message)
// Returns full-screen-height centered spinner HTML.
export function loadingSpinner(message = 'Loading…') {
  return `<div class="screen-loading-inner">
    <div class="spinner"></div>
    <div class="screen-loading-msg">${esc(message)}</div>
  </div>`;
}


// ════════════════════════════════════════════════════════════════════════
// §7 SCREEN RENDERER
// All screens call render() to mount their content.
// Handles scroll reset and loading state automatically.
// ════════════════════════════════════════════════════════════════════════

// render(html)
// Mounts HTML into #screen-content and resets scroll.
// Called by every screen module's main render function.
export function render(html) {
  const content = document.getElementById('screen-content');
  if (!content) {
    console.error('[ui.render] #screen-content not found');
    return;
  }
  content.innerHTML   = html;
  content.scrollTop   = 0;
}

// renderLoading(message)
// Shows a loading spinner while screen data is being fetched.
export function renderLoading(message = 'Loading…') {
  render(loadingSpinner(message));
}

// renderError(message)
// Shows an error state when a screen fails to load.
export function renderError(message) {
  render(`<div class="wrap">${
    `<div class="status-err" style="margin-top:20px">${esc(message)}</div>`
  }</div>`);
}


// ════════════════════════════════════════════════════════════════════════
// §8 MODAL HELPERS
// Lightweight modal system — single modal element reused across screens.
// ════════════════════════════════════════════════════════════════════════

// openModal(title, bodyHtml, footerHtml)
// Shows the shared modal overlay with given content.
// footerHtml: button row HTML
export function openModal(title, bodyHtml, footerHtml = '') {
  const overlay = document.getElementById('modal-overlay');
  const modal   = document.getElementById('modal-box');
  if (!overlay || !modal) {
    console.error('[ui.openModal] modal elements not found in DOM');
    return;
  }

  modal.innerHTML = `
    <div class="modal-handle"></div>
    <div class="modal-title">${esc(title)}</div>
    <div class="modal-body">${bodyHtml}</div>
    ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
  `;

  overlay.classList.add('open');
  console.log('[ui.openModal]', { title });
}

// closeModal()
export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('open');
  console.log('[ui.closeModal]');
}

// confirmModal(title, message)
// Promise-based confirmation dialog.
// Returns: Promise<boolean> — true if confirmed, false if cancelled.
export function confirmModal(title, message) {
  return new Promise(resolve => {
    openModal(
      title,
      `<p style="font-size:13px;color:var(--txt2);line-height:1.7">${esc(message)}</p>`,
      `<button class="btn btn-danger" id="modal-confirm-ok">Confirm</button>
       <button class="btn btn-secondary" id="modal-confirm-cancel">Cancel</button>`
    );

    document.getElementById('modal-confirm-ok').addEventListener('click', () => {
      closeModal(); resolve(true);
    });
    document.getElementById('modal-confirm-cancel').addEventListener('click', () => {
      closeModal(); resolve(false);
    });
  });
}


// ════════════════════════════════════════════════════════════════════════
// §9 FORM HELPERS
// Return HTML for common form elements.
// ════════════════════════════════════════════════════════════════════════

// formGroup(label, inputHtml, errorId)
// Wraps an input with a label and optional error message slot.
export function formGroup(label, inputHtml, errorId = '') {
  return `<div class="form-group">
    <label class="label">${esc(label)}</label>
    ${inputHtml}
    ${errorId ? `<div class="form-error hide" id="${esc(errorId)}"></div>` : ''}
  </div>`;
}

// showFormError(errorId, message)
// Shows an inline form validation error.
export function showFormError(errorId, message) {
  const el = document.getElementById(errorId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hide');
}

// hideFormError(errorId)
export function hideFormError(errorId) {
  const el = document.getElementById(errorId);
  if (el) el.classList.add('hide');
}

// clearFormErrors(...errorIds)
export function clearFormErrors(...errorIds) {
  for (const id of errorIds) hideFormError(id);
}
