// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/customers.js
// PURPOSE: Customers screen — list, search, manual add (＋ FAB),
//          AI image extractor (🤖 FAB). Both FABs bottom-right like Orders.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  CUSTOMER LIST + SEARCH
// §5  CUSTOMER CARD
// §6  MANUAL ADD MODAL  (＋ FAB)
// §7  AI CUSTOMER EXTRACTOR  (🤖 FAB)
// §8  CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, emptyState } from '../ui.js';
import { createCustomer } from '../services/customers.js';
import { dbList, dbQuery, dbUpdate, dbDelete, dbNow, paths } from '../db.js';
import { loadGroqKey } from '../ai/order-agent.js';
import * as Auth from '../auth.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session     = null;
let _customers      = [];
let _customersTotal = 0;  // total in Firestore (may be > loaded count)
let _customersLimit = 200; // load at most this many
let _searchTimer = null;


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderCustomers(session) {
  _session = session;
  console.log('[customers.renderCustomers] called', { businessId: session.businessId });

  _injectStyles();
  renderLoading('Loading customers…');

  await _loadCustomers();
  _renderScreen();
}


// ════════════════════════════════════════════════════════════════════════
// §4 CUSTOMER LIST + SEARCH
// ════════════════════════════════════════════════════════════════════════

async function _loadCustomers() {
  const p = paths(_session.businessId);
  try {
    const result = await dbQuery(
      p.customers,
      [],
      [{ field: 'created_at', direction: 'desc' }],
      _customersLimit
    );
    _customers = result.ok ? result.data : [];
    // Also get total count (unqueried) so we can show "load more" if needed
    // We detect truncation: if returned count === limit, there may be more
    _customersTotal = _customers.length;
    console.log('[customers._loadCustomers]', { count: _customers.length });
  } catch(e) {
    console.error('[customers._loadCustomers] failed', e);
    _customers = [];
  }
}

function _renderScreen(filtered = null) {
  const list = filtered ?? _customers;

  render(`
    <div class="wrap" style="padding-bottom:160px">

      <!-- Search -->
      <div class="search-wrap" style="margin-bottom:14px">
        <span class="search-icon">🔍</span>
        <input class="input search-input" id="cust-search" type="search"
          placeholder="Search by name or phone…"/>
      </div>

      <!-- Stats -->
      <div class="cust-stats-row">
        <div class="stat-box">
          <div class="stat-value">${_customers.length}</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--grn2)">
            ${_customers.filter(c => (c.total_orders || 0) > 0).length}
          </div>
          <div class="stat-label">With Orders</div>
        </div>
        <div class="stat-box">
          <div class="stat-value" style="color:var(--gold)">
            ${_customers.filter(c => (c.total_orders || 0) > 1).length}
          </div>
          <div class="stat-label">Returning</div>
        </div>
      </div>

      <!-- Customer list -->
      <div id="cust-list">
        ${list.length
          ? list.map(_renderCustomerCard).join('')
          : emptyState('👥', 'No customers yet', 'Tap ＋ to add a customer or use the 🤖 to scan a business card.')
        }
      </div>

      ${(!filtered && _customers.length >= _customersLimit) ? `
      <div style="text-align:center;padding:16px 0">
        <button class="btn btn-secondary btn-small" id="btn-load-more-customers"
          style="font-size:12px">Load more customers</button>
      </div>` : ''}

    </div>

    <!-- ＋ Add Customer FAB -->
    <button class="fab fab-primary" id="fab-add-customer" title="Add Customer">＋</button>

    <!-- 🤖 AI Extractor FAB -->
    <button class="fab fab-ai" id="fab-ai-customer" title="AI Customer Extractor">🤖</button>

    <!-- Manual Add Modal -->
    <div class="cust-overlay hide" id="cust-add-overlay">
      <div class="cust-modal">
        <div class="cust-modal-header">
          <div class="cust-modal-title">Add Customer</div>
          <button class="agent-close-btn" id="cust-add-close">✕</button>
        </div>
        <div class="form-group">
          <label class="label">Phone * <span style="font-size:10px;color:var(--muted);font-weight:400">(primary identifier)</span></label>
          <input class="input" id="cust-add-phone" type="tel" placeholder="+91 98765 43210" inputmode="tel"/>
          <div id="cust-add-phone-err" class="form-error hide">Phone is required</div>
        </div>
        <div class="form-group">
          <label class="label">Name *</label>
          <input class="input" id="cust-add-name" placeholder="e.g. Ravi Kumar"/>
          <div id="cust-add-name-err" class="form-error hide">Name is required</div>
        </div>
        <div class="form-group">
          <label class="label">Email <span style="font-size:10px;color:var(--muted);font-weight:400">optional</span></label>
          <input class="input" id="cust-add-email" type="email" placeholder="ravi@example.com"/>
        </div>
        <div class="form-group">
          <label class="label">Company <span style="font-size:10px;color:var(--muted);font-weight:400">optional</span></label>
          <input class="input" id="cust-add-company" placeholder="e.g. Green Events"/>
        </div>
        <div class="form-group">
          <label class="label">Notes <span style="font-size:10px;color:var(--muted);font-weight:400">optional</span></label>
          <textarea class="input" id="cust-add-notes" placeholder="Any notes…" rows="2"></textarea>
        </div>
        <div id="cust-add-result" style="font-size:12px;margin-bottom:10px;display:none"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="btn-cust-add-save" style="flex:1;justify-content:center">Save Customer</button>
          <button class="btn btn-secondary" id="btn-cust-add-cancel">Cancel</button>
        </div>
      </div>
    </div>

    <!-- AI Extractor Modal -->
    <div class="cust-overlay hide" id="cust-ai-overlay">
      <div class="cust-modal">
        <div class="cust-modal-header">
          <div class="cust-modal-title">🤖 AI Customer Extractor</div>
          <button class="agent-close-btn" id="cust-ai-close">✕</button>
        </div>

        <!-- Source tabs: Image vs Text -->
        <div style="display:flex;gap:4px;background:var(--bg2);border:1px solid var(--bdr);border-radius:var(--r);padding:3px;margin-bottom:12px">
          <button class="cust-ai-tab active" id="cust-ai-tab-image" data-ai-tab="image"
            style="flex:1;padding:6px;border-radius:6px;border:none;background:var(--gdim);color:var(--grn2);font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--gbdr)">
            🖼 Image
          </button>
          <button class="cust-ai-tab" id="cust-ai-tab-text" data-ai-tab="text"
            style="flex:1;padding:6px;border-radius:6px;border:none;background:transparent;color:var(--muted);font-size:12px;font-weight:500;cursor:pointer">
            💬 Text
          </button>
        </div>

        <!-- Image input panel -->
        <div id="cust-ai-panel-image">
          <div class="drop-zone" id="cust-ai-dropzone">
            <div class="drop-zone-icon">🖼</div>
            <div class="drop-zone-title">Drop image here</div>
            <div class="drop-zone-sub">business card · screenshot · contact photo</div>
          </div>
          <img id="cust-ai-preview-img" style="display:none;max-width:100%;max-height:120px;border-radius:8px;border:1px solid var(--bdr);object-fit:contain;margin-top:10px" alt=""/>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-primary" id="btn-cust-ai-gallery" style="flex:1;justify-content:center">📷 Gallery</button>
            <button class="btn btn-secondary" id="btn-cust-ai-camera" style="flex:1;justify-content:center">Camera</button>
          </div>
          <input type="file" id="cust-ai-gal-input" accept="image/*" style="display:none"/>
          <input type="file" id="cust-ai-cam-input" accept="image/*" capture="environment" style="display:none"/>
        </div>

        <!-- Text input panel -->
        <div id="cust-ai-panel-text" style="display:none">
          <p style="font-size:12px;color:var(--muted);margin-bottom:8px;line-height:1.7">
            Paste any text — WhatsApp message, email, or typed contact info. AI extracts all contacts.
          </p>
          <textarea class="input" id="cust-ai-text-input" rows="5"
            placeholder="e.g. Hey, this is Priya Menon +91 98765 43210 priya@greenevents.com from Green Events"></textarea>
          <button class="btn btn-primary" id="btn-cust-ai-analyse"
            style="width:100%;justify-content:center;margin-top:8px">
            🤖 Extract Contacts
          </button>
        </div>

        <div id="cust-ai-status" style="margin-top:10px;font-size:12px;color:var(--muted);display:none"></div>

        <!-- Preview — shown after extraction (supports multiple contacts) -->
        <div id="cust-ai-result" class="hide" style="margin-top:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.7px;text-transform:uppercase">
              Extracted — review before saving
            </div>
            <button class="btn btn-secondary" id="btn-cust-ai-rescan"
              style="font-size:10px;padding:3px 9px">↺ Rescan</button>
          </div>

          <!-- Single contact fields (image mode or single text result) -->
          <div id="cust-ai-single-fields">
            <div class="form-group">
              <label class="label">Phone *</label>
              <input class="input" id="cust-ai-phone" type="tel"/>
            </div>
            <div class="form-group">
              <label class="label">Name *</label>
              <input class="input" id="cust-ai-name"/>
            </div>
            <div class="form-group">
              <label class="label">Email</label>
              <input class="input" id="cust-ai-email" type="email"/>
            </div>
            <div class="form-group">
              <label class="label">Company</label>
              <input class="input" id="cust-ai-company"/>
            </div>
            <div id="cust-ai-dup-warning" style="display:none;font-size:12px;color:var(--gold);background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.2);border-radius:6px;padding:8px 10px;margin-bottom:8px"></div>
            <div id="cust-ai-save-result" style="font-size:12px;margin-bottom:8px;display:none"></div>
            <button class="btn btn-primary" id="btn-cust-ai-save" style="width:100%;justify-content:center">✓ Save Customer</button>
          </div>

          <!-- Multi-contact list (text mode with multiple contacts) -->
          <div id="cust-ai-multi-list" style="display:none"></div>

        </div>

      </div>
    </div>
  `);

  _wireEvents();
}


// ════════════════════════════════════════════════════════════════════════
// §5 CUSTOMER CARD
// ════════════════════════════════════════════════════════════════════════

function _renderCustomerCard(c) {
  const initials  = (c.name || '?').trim().split(' ')
    .map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const canEdit   = Auth.isManager();
  const canDelete = Auth.isOwner();

  return `
    <div class="cust-card" data-cust-id="${esc(c.id)}">
      <div class="cust-avatar">${esc(initials)}</div>
      <div class="cust-info">
        <div class="cust-name">${esc(c.name || 'Unknown')}</div>
        <div class="cust-meta">
          ${c.phone   ? `📞 ${esc(c.phone)}` : ''}
          ${c.company ? ` · 🏢 ${esc(c.company)}` : ''}
        </div>
        ${c.total_orders > 0
          ? `<div class="cust-orders">${c.total_orders} order${c.total_orders !== 1 ? 's' : ''}${c.total_value ? ' · ₹' + Number(c.total_value).toLocaleString('en-IN') : ''}</div>`
          : ''}
      </div>
      ${canEdit || canDelete ? `
      <div style="display:flex;gap:5px;flex-shrink:0">
        ${canEdit   ? `<button class="btn btn-secondary btn-small" data-edit-cust="${esc(c.id)}" onclick="event.stopPropagation()">✎</button>` : ''}
        ${canDelete ? `<button class="btn btn-danger btn-small" data-del-cust="${esc(c.id)}" onclick="event.stopPropagation()">🗑</button>` : ''}
      </div>` : ''}
    </div>`;
}


// ════════════════════════════════════════════════════════════════════════
// §6 MANUAL ADD MODAL
// ════════════════════════════════════════════════════════════════════════

function _openAddModal() {
  // Clear fields
  ['cust-add-phone','cust-add-name','cust-add-email','cust-add-company','cust-add-notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['cust-add-phone-err','cust-add-name-err'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.add('hide');
  });
  const res = document.getElementById('cust-add-result');
  if (res) res.style.display = 'none';
  document.getElementById('cust-add-overlay')?.classList.remove('hide');
  document.getElementById('cust-add-phone')?.focus();
}

function _closeAddModal() {
  document.getElementById('cust-add-overlay')?.classList.add('hide');
}

async function _saveManualCustomer() {
  const phone   = document.getElementById('cust-add-phone')?.value.trim() || '';
  const name    = document.getElementById('cust-add-name')?.value.trim()  || '';
  const email   = document.getElementById('cust-add-email')?.value.trim() || '';
  const company = document.getElementById('cust-add-company')?.value.trim() || '';
  const notes   = document.getElementById('cust-add-notes')?.value.trim() || '';
  const resultEl = document.getElementById('cust-add-result');

  let valid = true;
  if (!phone) { document.getElementById('cust-add-phone-err')?.classList.remove('hide'); valid = false; }
  else          document.getElementById('cust-add-phone-err')?.classList.add('hide');
  if (!name)  { document.getElementById('cust-add-name-err')?.classList.remove('hide'); valid = false; }
  else          document.getElementById('cust-add-name-err')?.classList.add('hide');
  if (!valid) return;

  // Duplicate check
  const existing = _customers.find(c => (c.phone || '').trim() === phone);
  if (existing) {
    _showResult(resultEl, `⚠ ${existing.name} already has this phone number.`, 'warn');
    return;
  }

  const btn = document.getElementById('btn-cust-add-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const result = await createCustomer(_session.businessId, { name, phone, email, company, notes });

  if (result.error) {
    _showResult(resultEl, 'Save failed: ' + result.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Customer'; }
    return;
  }

  toast(`✓ ${name} added`);
  _closeAddModal();

  // Reload and re-render
  await _loadCustomers();
  _renderScreen();
}


// ════════════════════════════════════════════════════════════════════════
// §7 AI CUSTOMER EXTRACTOR
// Image mode: Groq vision extracts contact from photo/business card.
// Text mode:  Groq text model extracts one or multiple contacts from pasted text.
// Both modes show editable preview with duplicate detection before saving.
// ════════════════════════════════════════════════════════════════════════

let _aiTab = 'image'; // 'image' | 'text'

function _openAiModal() {
  document.getElementById('cust-ai-overlay')?.classList.remove('hide');
  _setAiStatus('', '');
  document.getElementById('cust-ai-result')?.classList.add('hide');
  const imgEl = document.getElementById('cust-ai-preview-img');
  if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
}

function _closeAiModal() {
  document.getElementById('cust-ai-overlay')?.classList.add('hide');
}

function _setAiStatus(msg, type) {
  const el = document.getElementById('cust-ai-status');
  if (!el) return;
  el.textContent  = msg;
  el.style.display = msg ? 'block' : 'none';
  el.style.color  = type === 'ok' ? 'var(--grn2)' : type === 'err' ? 'var(--red)' : type === 'warn' ? 'var(--gold)' : 'var(--muted)';
}

function _switchAiTab(tab) {
  _aiTab = tab;
  const imgPanel  = document.getElementById('cust-ai-panel-image');
  const txtPanel  = document.getElementById('cust-ai-panel-text');
  const imgTabBtn = document.getElementById('cust-ai-tab-image');
  const txtTabBtn = document.getElementById('cust-ai-tab-text');
  if (imgPanel) imgPanel.style.display = tab === 'image' ? 'block' : 'none';
  if (txtPanel) txtPanel.style.display = tab === 'text'  ? 'block' : 'none';
  if (imgTabBtn) {
    imgTabBtn.style.background   = tab === 'image' ? 'var(--gdim)'   : 'transparent';
    imgTabBtn.style.color        = tab === 'image' ? 'var(--grn2)'   : 'var(--muted)';
    imgTabBtn.style.border       = tab === 'image' ? '1px solid var(--gbdr)' : 'none';
    imgTabBtn.style.fontWeight   = tab === 'image' ? '600' : '500';
  }
  if (txtTabBtn) {
    txtTabBtn.style.background   = tab === 'text' ? 'var(--gdim)'   : 'transparent';
    txtTabBtn.style.color        = tab === 'text' ? 'var(--grn2)'   : 'var(--muted)';
    txtTabBtn.style.border       = tab === 'text' ? '1px solid var(--gbdr)' : 'none';
    txtTabBtn.style.fontWeight   = tab === 'text' ? '600' : '500';
  }
  // Reset result on tab switch
  document.getElementById('cust-ai-result')?.classList.add('hide');
  _setAiStatus('', '');
}

// _callGroqVision — image → single contact object
async function _callGroqVision(file, apiKey) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 500, temperature: 0.1,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${file.type};base64,${base64}` } },
        { type: 'text', text: 'Extract ALL contact info from this image. Reply ONLY with a raw JSON array — no markdown:\n[{"name":"","phone":"","email":"","company":""}]\nInclude country code in phone if visible. Use empty string if not found. If only one contact, still return an array with one object.' },
      ]}],
    }),
  });
  if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || 'Groq API error ' + resp.status); }
  const data    = await resp.json();
  const content = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
  // Accept both array and single object
  const parsed  = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// _callGroqText — text → array of contact objects
async function _callGroqText(text, apiKey) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000, temperature: 0.1,
      messages: [
        { role: 'system', content: [
          'Extract all contacts from the text. Return ONLY a raw JSON array — no markdown:',
          '[{"name":"","phone":"","email":"","company":""}]',
          'Include country code in phone if visible. Use empty string if not found.',
          'If multiple contacts are mentioned, include all of them.',
          'Never invent details not present in the text.',
        ].join('\n') },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || 'Groq API error ' + resp.status); }
  const data    = await resp.json();
  const content = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
  const parsed  = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// _showExtractedContacts — renders preview for one or multiple contacts
function _showExtractedContacts(contacts) {
  const resultEl  = document.getElementById('cust-ai-result');
  const singleEl  = document.getElementById('cust-ai-single-fields');
  const multiEl   = document.getElementById('cust-ai-multi-list');
  const dupWarnEl = document.getElementById('cust-ai-dup-warning');
  const saveResEl = document.getElementById('cust-ai-save-result');

  if (!contacts.length) { _setAiStatus('⚠ No contacts found. Try a clearer image or text.', 'warn'); return; }

  resultEl?.classList.remove('hide');

  if (contacts.length === 1) {
    // Single contact — show editable fields
    const c = contacts[0];
    if (singleEl) singleEl.style.display = 'block';
    if (multiEl)  multiEl.style.display  = 'none';
    const sv = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    sv('cust-ai-phone',   c.phone);
    sv('cust-ai-name',    c.name);
    sv('cust-ai-email',   c.email);
    sv('cust-ai-company', c.company);
    if (saveResEl)  saveResEl.style.display  = 'none';

    // Duplicate warning
    const dup = c.phone ? _customers.find(x => (x.phone||'').trim() === (c.phone||'').trim()) : null;
    if (dupWarnEl) {
      if (dup) {
        dupWarnEl.style.display = 'block';
        dupWarnEl.textContent   = `⚠ ${dup.name} already has this phone number.`;
      } else {
        dupWarnEl.style.display = 'none';
      }
    }
    _setAiStatus('✓ Contact extracted — review and save', 'ok');

  } else {
    // Multiple contacts — show list with individual save buttons
    if (singleEl) singleEl.style.display = 'none';
    if (multiEl)  multiEl.style.display  = 'block';

    multiEl.innerHTML = contacts.map((c, i) => {
      const dup = c.phone ? _customers.find(x => (x.phone||'').trim() === (c.phone||'').trim()) : null;
      return `<div class="cust-ai-multi-card" id="cust-ai-multi-${i}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:5px">
              <input class="input" id="cust-ai-m-phone-${i}" value="${esc(c.phone||'')}" placeholder="Phone" type="tel" style="font-size:12px;padding:6px 9px"/>
              <input class="input" id="cust-ai-m-name-${i}"  value="${esc(c.name||'')}"  placeholder="Name"  style="font-size:12px;padding:6px 9px"/>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
              <input class="input" id="cust-ai-m-email-${i}"   value="${esc(c.email||'')}"   placeholder="Email"   type="email" style="font-size:12px;padding:6px 9px"/>
              <input class="input" id="cust-ai-m-company-${i}" value="${esc(c.company||'')}" placeholder="Company" style="font-size:12px;padding:6px 9px"/>
            </div>
            ${dup ? `<div style="font-size:10px;color:var(--gold);margin-top:4px">⚠ ${esc(dup.name)} already has this number</div>` : ''}
          </div>
          <button class="btn btn-primary btn-small cust-ai-multi-save" data-idx="${i}"
            style="flex-shrink:0;font-size:11px;padding:5px 10px"${dup ? ' disabled' : ''}>
            ${dup ? '✓ Exists' : '＋ Save'}
          </button>
        </div>
      </div>`;
    }).join('');

    // Wire individual save buttons
    multiEl.querySelectorAll('.cust-ai-multi-save').forEach(btn =>
      btn.addEventListener('click', async () => {
        const i       = parseInt(btn.dataset.idx);
        const phone   = document.getElementById(`cust-ai-m-phone-${i}`)?.value.trim()   || '';
        const name    = document.getElementById(`cust-ai-m-name-${i}`)?.value.trim()    || '';
        const email   = document.getElementById(`cust-ai-m-email-${i}`)?.value.trim()   || '';
        const company = document.getElementById(`cust-ai-m-company-${i}`)?.value.trim() || '';
        if (!phone) { toast('Phone is required', 'warn'); return; }
        if (!name)  { toast('Name is required',  'warn'); return; }
        const dup2 = _customers.find(c => (c.phone||'').trim() === phone);
        if (dup2) { toast(`${dup2.name} already has this number`, 'warn'); return; }
        btn.disabled = true; btn.textContent = 'Saving…';
        const res = await createCustomer(_session.businessId, { name, phone, email, company });
        if (res.error) { toast(res.message, 'err'); btn.disabled = false; btn.textContent = '＋ Save'; return; }
        btn.textContent = '✓ Saved';
        btn.style.background = 'var(--sur2)';
        await _loadCustomers();
        toast(`✓ ${name} saved`);
      })
    );

    _setAiStatus(`✓ ${contacts.length} contacts extracted — save individually`, 'ok');
  }
}

async function _scanImage(file) {
  const imgEl = document.getElementById('cust-ai-preview-img');
  if (imgEl) { imgEl.src = URL.createObjectURL(file); imgEl.style.display = 'block'; }
  document.getElementById('cust-ai-result')?.classList.add('hide');
  _setAiStatus('Reading image with AI…', 'muted');

  const keyResult = await loadGroqKey(_session.businessId);
  if (keyResult.error) { _setAiStatus('✕ ' + keyResult.message, 'err'); return; }

  try {
    const contacts = await _callGroqVision(file, keyResult.key);
    _showExtractedContacts(contacts);
  } catch(e) {
    console.error('[customers._scanImage] failed', e);
    _setAiStatus('✕ ' + e.message, 'err');
  }
}

async function _analyseText() {
  const text = document.getElementById('cust-ai-text-input')?.value.trim() || '';
  if (!text) { toast('Paste some text first', 'warn'); return; }
  const btn = document.getElementById('btn-cust-ai-analyse');
  if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }
  document.getElementById('cust-ai-result')?.classList.add('hide');
  _setAiStatus('Reading with AI…', 'muted');

  const keyResult = await loadGroqKey(_session.businessId);
  if (keyResult.error) {
    _setAiStatus('✕ ' + keyResult.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Extract Contacts'; }
    return;
  }

  try {
    const contacts = await _callGroqText(text, keyResult.key);
    _showExtractedContacts(contacts);
  } catch(e) {
    console.error('[customers._analyseText] failed', e);
    _setAiStatus('✕ ' + e.message, 'err');
  }
  if (btn) { btn.disabled = false; btn.textContent = '🤖 Extract Contacts'; }
}

async function _saveAiCustomer() {
  const phone   = document.getElementById('cust-ai-phone')?.value.trim()   || '';
  const name    = document.getElementById('cust-ai-name')?.value.trim()    || '';
  const email   = document.getElementById('cust-ai-email')?.value.trim()   || '';
  const company = document.getElementById('cust-ai-company')?.value.trim() || '';
  const resultEl = document.getElementById('cust-ai-save-result');

  if (!phone) { _showResult(resultEl, 'Phone number is required.', 'err'); return; }
  if (!name)  { _showResult(resultEl, 'Name is required.', 'err');  return; }

  // Duplicate check
  const existing = _customers.find(c => (c.phone || '').trim() === phone);
  if (existing) {
    _showResult(resultEl, `⚠ ${existing.name} already has this phone number.`, 'warn');
    return;
  }

  const btn = document.getElementById('btn-cust-ai-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const result = await createCustomer(_session.businessId, { name, phone, email, company });

  if (result.error) {
    _showResult(resultEl, 'Save failed: ' + result.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '✓ Save Customer'; }
    return;
  }

  toast(`✓ ${name} saved`);
  _closeAiModal();
  await _loadCustomers();
  _renderScreen();
}


// ════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ════════════════════════════════════════════════════════════════════════

function _wireEvents() {
  // Search
  document.getElementById('cust-search')?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      const q = (document.getElementById('cust-search')?.value || '').toLowerCase().trim();
      if (!q) { _renderScreen(_customers); return; }
      const filtered = _customers.filter(c =>
        (c.name    || '').toLowerCase().includes(q) ||
        (c.phone   || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q)
      );
      // Re-render list only (not full screen) to preserve search focus
      const listEl = document.getElementById('cust-list');
      if (listEl) listEl.innerHTML = filtered.length
        ? filtered.map(_renderCustomerCard).join('')
        : `<div style="font-size:13px;color:var(--muted);padding:20px 0;text-align:center">No results</div>`;
    }, 200);
  });

  // FABs
  document.getElementById('fab-add-customer')?.addEventListener('click', _openAddModal);

  // Load more customers
  document.getElementById('btn-load-more-customers')?.addEventListener('click', async () => {
    _customersLimit += 200;
    await _loadCustomers();
    _renderScreen();
  });
  document.getElementById('fab-ai-customer')?.addEventListener('click', _openAiModal);

  // Manual add modal
  document.getElementById('cust-add-close')?.addEventListener('click', _closeAddModal);
  document.getElementById('btn-cust-add-cancel')?.addEventListener('click', _closeAddModal);
  document.getElementById('btn-cust-add-save')?.addEventListener('click', _saveManualCustomer);
  document.getElementById('cust-add-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'cust-add-overlay') _closeAddModal();
  });

  // AI modal
  document.getElementById('cust-ai-close')?.addEventListener('click', _closeAiModal);
  document.getElementById('cust-ai-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'cust-ai-overlay') _closeAiModal();
  });

  // Source tabs
  document.querySelectorAll('.cust-ai-tab').forEach(btn =>
    btn.addEventListener('click', () => _switchAiTab(btn.dataset.aiTab))
  );

  // Gallery / Camera
  document.getElementById('btn-cust-ai-gallery')?.addEventListener('click', () =>
    document.getElementById('cust-ai-gal-input')?.click()
  );
  document.getElementById('btn-cust-ai-camera')?.addEventListener('click', () =>
    document.getElementById('cust-ai-cam-input')?.click()
  );
  document.getElementById('cust-ai-gal-input')?.addEventListener('change', function () {
    if (this.files[0]) _scanImage(this.files[0]);
    this.value = '';
  });
  document.getElementById('cust-ai-cam-input')?.addEventListener('change', function () {
    if (this.files[0]) _scanImage(this.files[0]);
    this.value = '';
  });

  // Drop zone
  const dz = document.getElementById('cust-ai-dropzone');
  dz?.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz?.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz?.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) _scanImage(e.dataTransfer.files[0]);
  });
  dz?.addEventListener('click', () => document.getElementById('cust-ai-gal-input')?.click());

  // Text analyse
  document.getElementById('btn-cust-ai-analyse')?.addEventListener('click', _analyseText);

  // Rescan — reset result + image
  document.getElementById('btn-cust-ai-rescan')?.addEventListener('click', () => {
    document.getElementById('cust-ai-result')?.classList.add('hide');
    _setAiStatus('', '');
    const imgEl = document.getElementById('cust-ai-preview-img');
    if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
    if (_aiTab === 'text') {
      const txtEl = document.getElementById('cust-ai-text-input');
      if (txtEl) txtEl.value = '';
    }
  });

  // Save single contact from AI
  document.getElementById('btn-cust-ai-save')?.addEventListener('click', _saveAiCustomer);

  // Edit customer buttons (manager+)
  document.querySelectorAll('[data-edit-cust]').forEach(btn =>
    btn.addEventListener('click', () => {
      const cust = _customers.find(c => c.id === btn.dataset.editCust);
      if (cust) _openEditModal(cust);
    })
  );

  // Delete customer buttons (owner only)
  document.querySelectorAll('[data-del-cust]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const cust = _customers.find(c => c.id === btn.dataset.delCust);
      if (!cust) return;
      if (!confirm(`Delete ${cust.name || 'this customer'}? Their orders will not be deleted.`)) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        const p = paths(_session.businessId);
        await dbDelete(p.customers, cust.id);
        _customers = _customers.filter(c => c.id !== cust.id);
        toast(`${cust.name || 'Customer'} deleted`, 'warn');
        _renderScreen(_customers);
      } catch(e) {
        toast('Delete failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = '🗑';
      }
    })
  );
}


// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function _showResult(el, msg, type) {
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = type === 'ok' ? 'var(--grn2)' : type === 'warn' ? 'var(--gold)' : 'var(--red)';
  el.textContent   = msg;
}


// ════════════════════════════════════════════════════════════════════════
// §6b EDIT CUSTOMER MODAL
// ════════════════════════════════════════════════════════════════════════

function _openEditModal(cust) {
  // Remove existing modal if any
  document.getElementById('cust-edit-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'cust-edit-overlay';
  overlay.className = 'cust-overlay';
  overlay.innerHTML = `
    <div class="cust-modal">
      <div class="cust-modal-header">
        <div class="cust-modal-title">Edit Customer</div>
        <button class="agent-close-btn" id="cust-edit-close">✕</button>
      </div>
      <div class="form-group">
        <label class="label">Name *</label>
        <input class="input" id="cust-edit-name" value="${esc(cust.name || '')}"/>
        <div class="form-error hide" id="cust-edit-name-err">Name is required</div>
      </div>
      <div class="form-group">
        <label class="label">Phone *</label>
        <input class="input" id="cust-edit-phone" type="tel" value="${esc(cust.phone || '')}"/>
        <div class="form-error hide" id="cust-edit-phone-err">Phone is required</div>
      </div>
      <div class="form-group">
        <label class="label">Email</label>
        <input class="input" id="cust-edit-email" type="email" value="${esc(cust.email || '')}"/>
      </div>
      <div class="form-group">
        <label class="label">Company</label>
        <input class="input" id="cust-edit-company" value="${esc(cust.company || '')}"/>
      </div>
      <div class="form-group">
        <label class="label">Notes</label>
        <textarea class="input" id="cust-edit-notes" rows="2">${esc(cust.notes || '')}</textarea>
      </div>
      <div id="cust-edit-result" style="font-size:12px;margin-bottom:8px;display:none"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="btn-cust-edit-save" style="flex:1;justify-content:center">Save Changes</button>
        <button class="btn btn-secondary" id="btn-cust-edit-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('cust-edit-close')?.addEventListener('click',  () => overlay.remove());
  document.getElementById('btn-cust-edit-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('btn-cust-edit-save')?.addEventListener('click', async () => {
    const name    = document.getElementById('cust-edit-name')?.value.trim()    || '';
    const phone   = document.getElementById('cust-edit-phone')?.value.trim()   || '';
    const email   = document.getElementById('cust-edit-email')?.value.trim()   || '';
    const company = document.getElementById('cust-edit-company')?.value.trim() || '';
    const notes   = document.getElementById('cust-edit-notes')?.value.trim()   || '';
    const resEl   = document.getElementById('cust-edit-result');

    let valid = true;
    if (!name)  { document.getElementById('cust-edit-name-err')?.classList.remove('hide');  valid = false; }
    else          document.getElementById('cust-edit-name-err')?.classList.add('hide');
    if (!phone) { document.getElementById('cust-edit-phone-err')?.classList.remove('hide'); valid = false; }
    else          document.getElementById('cust-edit-phone-err')?.classList.add('hide');
    if (!valid) return;

    // Duplicate phone check (excluding this customer)
    const duplicate = _customers.find(c => c.id !== cust.id && (c.phone || '') === phone);
    if (duplicate) {
      _showResult(resEl, `Phone already used by ${duplicate.name || 'another customer'}`, 'err');
      return;
    }

    const btn = document.getElementById('btn-cust-edit-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      const p = paths(_session.businessId);
      await dbUpdate(p.customers, cust.id, {
        name, phone, email, company, notes,
        updated_at: dbNow(),
      });

      // Update in-memory cache
      const idx = _customers.findIndex(c => c.id === cust.id);
      if (idx >= 0) _customers[idx] = { ..._customers[idx], name, phone, email, company, notes };

      toast('✓ Customer updated');
      overlay.remove();
      _renderScreen(_customers);
    } catch(e) {
      _showResult(resEl, 'Save failed: ' + e.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
  });
}


// ════════════════════════════════════════════════════════════════════════
// §8 CSS INJECTION
// ════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('customers-styles')) return;
  const s = document.createElement('style');
  s.id = 'customers-styles';
  s.textContent = `
.cust-stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.cust-card{display:flex;align-items:center;gap:12px;background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rl);padding:13px 14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}
.cust-card:hover{border-color:var(--bdr2)}
.cust-avatar{width:40px;height:40px;border-radius:50%;background:var(--gdim);border:1px solid var(--gbdr);color:var(--grn2);font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cust-info{flex:1;min-width:0}
.cust-name{font-size:14px;font-weight:600;margin-bottom:2px}
.cust-meta{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cust-orders{font-size:11px;color:var(--grn2);margin-top:2px;font-weight:500}
.cust-ai-multi-card{background:var(--bg2);border:1px solid var(--bdr);border-radius:var(--r);padding:10px;margin-bottom:8px}
.cust-ai-multi-card:last-child{margin-bottom:0}
.cust-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:flex-end;justify-content:center}
.cust-modal{background:var(--sur);border:1px solid var(--bdr2);border-radius:var(--rl) var(--rl) 0 0;padding:22px;width:100%;max-height:90vh;overflow-y:auto}
@media(min-width:560px){.cust-overlay{align-items:center;padding:16px}.cust-modal{border-radius:var(--rl);max-width:440px}}
.cust-modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.cust-modal-title{font-size:17px;font-weight:600}
`;
  document.head.appendChild(s);
}
