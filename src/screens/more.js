// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/more.js
// PURPOSE: More screen — menu hub for settings, team, activity log,
//          reconciliation, reports, sign out.
//          Settings includes Groq API key management (owner only).
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  MENU SECTIONS
// §5  SUB-SCREENS
//       §5a  Settings  (business name + Groq API key)
//       §5b  Suppliers
//       §5c  Team
//       §5d  Pending
//       §5e  Activity Log
//       §5f  Reconciliation
//       §5g  Reports
// ════════════════════════════════════════════════════════════════════════

import {
  render, renderLoading, esc, initials, toast, roleBadge,
} from '../ui.js';
import * as Auth from '../auth.js';
import * as DB   from '../db.js';
import { renderActivityLog }    from './activity-log.js';
import { renderPending }        from './pending.js';
import { renderTeam }           from './team.js';
import { renderReconciliation } from './reconciliation.js';
import { renderReports }        from './reports.js';

const BOSS_EMAIL = Auth.BOSS_EMAIL;


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session      = null;
let _businessData = null;
let _settingsData = null; // businesses/{bid}/settings/general
let _apiKeysData  = null; // businesses/{bid}/settings/api_keys


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderMore(session) {
  _session = session;
  console.log('[more.renderMore] called', { businessId: session.businessId });

  renderLoading('Loading…');

  try {
    // Load business data + settings in parallel
    const [bizResult, settingsResult, apiKeysResult] = await Promise.all([
      DB.dbGet(DB.COL_BUSINESSES, session.businessId),
      DB.dbGet(`businesses/${session.businessId}/settings`, 'general'),
      DB.dbGet(`businesses/${session.businessId}/settings`, 'api_keys'),
    ]);

    _businessData = bizResult.ok   ? bizResult.data   : null;
    _settingsData = settingsResult.ok ? settingsResult.data : null;
    _apiKeysData  = apiKeysResult.ok  ? apiKeysResult.data  : null;

  } catch(e) {
    console.warn('[more.renderMore] failed to load business data (non-critical)', e?.message);
  }

  _renderMoreMenu();
}


// ════════════════════════════════════════════════════════════════════════
// §4 MENU SECTIONS
// ════════════════════════════════════════════════════════════════════════

function _renderMoreMenu() {
  const businessName = _businessData?.business_name || _session.businessName || 'My Business';
  const isManager    = Auth.isManager();
  const isOwner      = Auth.isOwner();
  const isBoss       = (_session.email || '').toLowerCase() === BOSS_EMAIL.toLowerCase();

  render(`
    <div class="wrap">

      <!-- Profile -->
      <div class="more-profile">
        <div class="more-avatar">${initials(_session.displayName)}</div>
        <div class="more-profile-info">
          <div class="more-profile-name">${esc(_session.displayName)}</div>
          <div class="more-profile-email">${esc(_session.email)}</div>
          <div style="margin-top:5px">${roleBadge(_session.role)}</div>
        </div>
      </div>

      <!-- Business -->
      <div class="card" style="margin-bottom:10px">
        <div class="section-title">Business</div>
        <div class="more-biz-name">${esc(businessName)}</div>
        <div class="more-biz-id">ID: ${esc(_session.businessId)}</div>
      </div>

      <!-- Inventory -->
      <div class="card" style="margin-bottom:10px">
        <div class="section-title">Inventory</div>
        <div class="more-menu">
          <button class="more-menu-item" data-screen="activity-log">
            <span class="more-menu-icon">📋</span>
            <span class="more-menu-label">Activity Log</span>
            <span class="more-menu-arrow">›</span>
          </button>
          <button class="more-menu-item" data-screen="reconciliation">
            <span class="more-menu-icon">🔍</span>
            <span class="more-menu-label">Reconciliation</span>
            <span class="more-menu-arrow">›</span>
          </button>
          ${isManager ? `
          <button class="more-menu-item" data-screen="reports">
            <span class="more-menu-icon">📊</span>
            <span class="more-menu-label">Reports</span>
            <span class="more-menu-arrow">›</span>
          </button>` : ''}
        </div>
      </div>

      <!-- Team (manager/owner) -->
      ${isManager ? `
      <div class="card" style="margin-bottom:10px">
        <div class="section-title">Team</div>
        <div class="more-menu">
          <button class="more-menu-item" data-screen="team">
            <span class="more-menu-icon">👥</span>
            <span class="more-menu-label">Team Members</span>
            <span class="more-menu-arrow">›</span>
          </button>
          <button class="more-menu-item" data-screen="pending">
            <span class="more-menu-icon">⏳</span>
            <span class="more-menu-label">Pending Submissions</span>
            <span class="more-menu-arrow">›</span>
          </button>
        </div>
      </div>` : ''}

      <!-- Settings (owner only) -->
      ${isOwner ? `
      <div class="card" style="margin-bottom:10px">
        <div class="section-title">Settings</div>
        <div class="more-menu">
          <button class="more-menu-item" data-screen="settings">
            <span class="more-menu-icon">⚙️</span>
            <span class="more-menu-label">Business Settings</span>
            <span class="more-menu-arrow">›</span>
          </button>
          <button class="more-menu-item" data-screen="suppliers">
            <span class="more-menu-icon">🌿</span>
            <span class="more-menu-label">Suppliers</span>
            <span class="more-menu-arrow">›</span>
          </button>
        </div>
      </div>` : ''}

      <!-- Boss Panel (konami.pes.0813@gmail.com only) -->
      ${isBoss ? `
      <div class="card" style="margin-bottom:10px;border-color:var(--gold);background:rgba(201,168,76,.04)">
        <div class="section-title" style="color:var(--gold)">👑 Boss Panel</div>
        <div class="more-menu">
          <button class="more-menu-item" data-screen="boss-panel">
            <span class="more-menu-icon">🔐</span>
            <span class="more-menu-label">Manage Business Whitelist</span>
            <span class="more-menu-arrow">›</span>
          </button>
        </div>
      </div>` : ''}

      <button class="btn btn-secondary" id="btn-more-signout"
        style="width:100%;justify-content:center;margin-top:6px">
        Sign out
      </button>

    </div>
  `);

  document.querySelectorAll('.more-menu-item[data-screen]').forEach(btn =>
    btn.addEventListener('click', () => _navigateTo(btn.dataset.screen))
  );

  document.getElementById('btn-more-signout')?.addEventListener('click', async () => {
    const result = await Auth.signOut();
    if (result.error) toast('Sign-out failed: ' + result.message, 'err');
  });
}

function _navigateTo(screenId) {
  console.log('[more._navigateTo]', { screenId });
  switch (screenId) {
    case 'settings':      _renderSettings();       break;
    case 'suppliers':     _renderSuppliers();      break;
    case 'team':          _renderTeam();           break;
    case 'pending':       _renderPending();        break;
    case 'activity-log':  _renderActivityLog();    break;
    case 'reconciliation':_renderReconciliation(); break;
    case 'reports':       _renderReports();        break;
    case 'boss-panel':    _renderBossPanel();      break;
    default: toast('Coming soon', 'warn');
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 SUB-SCREENS
// ════════════════════════════════════════════════════════════════════════

function _backButton() {
  return `<button class="back-btn" id="btn-more-back">‹ Back</button>`;
}

function _wireBackButton() {
  document.getElementById('btn-more-back')?.addEventListener('click', _renderMoreMenu);
}


// ── §5a Settings ──────────────────────────────────────────────────────

function _renderSettings() {
  const businessName = _businessData?.business_name || '';
  const hasGroqKey   = !!_apiKeysData?.groq_api_key;
  const maskedKey    = hasGroqKey
    ? _apiKeysData.groq_api_key.slice(0, 7) + '••••••••'
    : '';

  render(`
    <div class="wrap">
      ${_backButton()}
      <div class="subscreen-title">Business Settings</div>

      <!-- Business name -->
      <div class="card" style="margin-top:14px">
        <div class="section-title">Business Name</div>
        <input class="input" id="settings-biz-name" value="${esc(businessName)}"
          placeholder="e.g. Green Leaf Nursery" style="margin-bottom:10px"/>
        <button class="btn btn-primary btn-small" id="btn-save-biz-name">Save Name</button>
        <div id="settings-biz-result" style="font-size:12px;margin-top:7px;display:none"></div>
      </div>

      <!-- Groq API Key -->
      <div class="card">
        <div class="section-title">AI Features — Groq API Key</div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.7">
          Required for AI Order Taker and AI Scanner. All staff use this key automatically.
          Get yours free at <strong style="color:var(--txt2)">console.groq.com</strong>.
        </p>

        ${hasGroqKey ? `
        <div style="background:var(--gdim);border:1px solid var(--gbdr);border-radius:7px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-size:11px;color:var(--grn2);font-weight:600;margin-bottom:2px">✓ API key saved</div>
            <div style="font-size:12px;font-family:monospace;color:var(--muted)" id="groq-key-display">${esc(maskedKey)}</div>
          </div>
          <button class="btn btn-secondary btn-small" id="btn-reveal-key">Reveal</button>
        </div>` : `
        <div style="background:var(--godim);border:1px solid var(--gobdr);border-radius:7px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:var(--gold)">
          ⚠ No API key set — AI features are disabled for your team.
        </div>`}

        <div class="form-group">
          <label class="label">${hasGroqKey ? 'Replace Key' : 'Enter Key'}</label>
          <input class="input" id="settings-groq-key" type="password"
            placeholder="gsk_…" autocomplete="off"/>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-small" id="btn-save-groq-key">Save Key</button>
          <button class="btn btn-secondary btn-small" id="btn-toggle-groq-visibility">Show</button>
        </div>
        <div id="settings-groq-result" style="font-size:12px;margin-top:8px;display:none"></div>
      </div>

    </div>
  `);

  _wireBackButton();

  // Save business name
  document.getElementById('btn-save-biz-name')?.addEventListener('click', async () => {
    const name    = document.getElementById('settings-biz-name')?.value.trim();
    const resultEl = document.getElementById('settings-biz-result');
    if (!name) { _showResult(resultEl, 'Business name cannot be empty.', 'err'); return; }

    const btn = document.getElementById('btn-save-biz-name');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      await DB.dbSet(DB.COL_BUSINESSES, _session.businessId, {
        ...(_businessData || {}), business_name: name,
      });
      _businessData = { ...(_businessData || {}), business_name: name };

      // Update topbar
      const topbarBrand = document.getElementById('topbar-brand');
      if (topbarBrand) topbarBrand.textContent = name;

      _showResult(resultEl, '✓ Business name saved', 'ok');
      toast('✓ Saved');
    } catch(e) {
      _showResult(resultEl, 'Save failed: ' + e.message, 'err');
    }

    btn.disabled = false; btn.textContent = 'Save Name';
  });

  // Reveal/hide existing key
  document.getElementById('btn-reveal-key')?.addEventListener('click', () => {
    const display = document.getElementById('groq-key-display');
    const btn     = document.getElementById('btn-reveal-key');
    if (!display || !_apiKeysData?.groq_api_key) return;
    const isHidden = display.textContent.includes('••');
    display.textContent = isHidden ? _apiKeysData.groq_api_key : maskedKey;
    btn.textContent     = isHidden ? 'Hide' : 'Reveal';
  });

  // Toggle new key visibility
  document.getElementById('btn-toggle-groq-visibility')?.addEventListener('click', () => {
    const inp = document.getElementById('settings-groq-key');
    const btn = document.getElementById('btn-toggle-groq-visibility');
    if (!inp) return;
    const showing = inp.type === 'text';
    inp.type     = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });

  // Save Groq key
  document.getElementById('btn-save-groq-key')?.addEventListener('click', async () => {
    const key     = document.getElementById('settings-groq-key')?.value.trim();
    const resultEl = document.getElementById('settings-groq-result');

    if (!key) { _showResult(resultEl, 'Enter the API key first.', 'err'); return; }
    if (!key.startsWith('gsk_')) { _showResult(resultEl, 'Groq keys start with gsk_', 'warn'); return; }

    const btn = document.getElementById('btn-save-groq-key');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const now = DB.dbNow();
      const apiKeyDoc = {
        groq_api_key:        key,
        groq_key_added_at:   now,
        groq_key_added_by:   _session.email,
      };

      await DB.dbSet(`businesses/${_session.businessId}/settings`, 'api_keys', apiKeyDoc);
      _apiKeysData = { ...apiKeyDoc, id: 'api_keys' };

      document.getElementById('settings-groq-key').value = '';
      _showResult(resultEl, '✓ Groq API key saved — AI features now enabled for your team.', 'ok');
      toast('✓ API key saved');

    } catch(e) {
      _showResult(resultEl, 'Save failed: ' + e.message, 'err');
    }

    btn.disabled = false; btn.textContent = 'Save Key';
  });
}

// _showResult(el, msg, type) — shows inline result message
function _showResult(el, msg, type) {
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = type === 'ok' ? 'var(--grn2)' : type === 'warn' ? 'var(--gold)' : 'var(--red)';
  el.textContent   = msg;
}


// ── §5b Suppliers ─────────────────────────────────────────────────────
// Shows all unique supplier names from product docs.
// Owner can maintain a canonical supplier list stored at
// businesses/{id}/settings/suppliers  → { list: [{name, contact, notes}] }
// The list drives autocomplete in inventory + scan.

async function _renderSuppliers() {
  render(`<div class="wrap"><div class="subscreen-title">Suppliers</div><div style="font-size:13px;color:var(--muted)">Loading…</div></div>`);

  // Load managed supplier list from settings
  let managed = [];
  try {
    const r = await DB.dbGet(`businesses/${_session.businessId}/settings`, 'suppliers');
    managed  = r.ok ? (r.data.list || []) : [];
  } catch(e) { managed = []; }

  // Extract supplier names mentioned in products (for "Used in inventory" context)
  let usedNames = new Set();
  try {
    const r = await DB.dbList(DB.paths(_session.businessId).products);
    if (r.ok) {
      r.data.forEach(p => { if (p.supplier_name) usedNames.add(p.supplier_name.trim()); });
    }
  } catch(e) {}

  // Merge: managed list + any used names not yet in managed list (shown greyed)
  const managedNames = new Set(managed.map(s => s.name.toLowerCase()));
  const unmanaged    = [...usedNames].filter(n => !managedNames.has(n.toLowerCase()));

  _renderSuppliersView(managed, unmanaged, usedNames);
}

function _renderSuppliersView(managed, unmanaged, usedNames) {
  const canEdit = Auth.isOwner();

  render(`
    <div class="wrap" style="padding-bottom:80px">
      ${_backButton()}
      <div class="subscreen-title" style="margin-bottom:4px">Suppliers</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.7">
        Manage your supplier list. Names here appear as autocomplete when adding stock.
      </div>

      ${canEdit ? `
      <!-- Add supplier -->
      <div class="card" style="margin-bottom:14px">
        <div class="section-title">Add Supplier</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <input class="input" id="sup-name" placeholder="Supplier name *" style="flex:2;min-width:140px"/>
          <input class="input" id="sup-contact" placeholder="Phone / email (optional)" style="flex:2;min-width:140px"/>
        </div>
        <input class="input" id="sup-notes" placeholder="Notes (optional)" style="margin-bottom:8px"/>
        <button class="btn btn-primary btn-small" id="btn-sup-add">＋ Add Supplier</button>
        <div id="sup-add-result" style="font-size:12px;margin-top:7px;display:none"></div>
      </div>` : ''}

      <!-- Managed suppliers -->
      <div class="card" style="margin-bottom:14px">
        <div class="section-title">
          Suppliers (${managed.length})
        </div>
        ${managed.length ? managed.map((s, i) => `
          <div class="sup-row" id="sup-row-${i}">
            <div class="sup-info">
              <div class="sup-name">${esc(s.name)}</div>
              ${s.contact ? `<div class="sup-meta">📞 ${esc(s.contact)}</div>` : ''}
              ${s.notes   ? `<div class="sup-meta">${esc(s.notes)}</div>` : ''}
              ${usedNames.has(s.name) ? `<div class="sup-meta" style="color:var(--grn2)">✓ Used in inventory</div>` : ''}
            </div>
            ${canEdit ? `<button class="btn btn-danger btn-small sup-del-btn" data-idx="${i}">Remove</button>` : ''}
          </div>`).join('')
        : `<div style="font-size:13px;color:var(--muted)">No suppliers added yet.</div>`}
      </div>

      ${unmanaged.length ? `
      <!-- Unmanaged (used in products but not in list) -->
      <div class="card">
        <div class="section-title" style="color:var(--muted)">Found in Inventory (${unmanaged.length})</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.7">
          These supplier names are used in your products but not in your managed list.
        </div>
        ${unmanaged.map(name => `
          <div class="sup-row">
            <div class="sup-info">
              <div class="sup-name">${esc(name)}</div>
              <div class="sup-meta" style="color:var(--muted)">Used in inventory</div>
            </div>
            ${canEdit ? `<button class="btn btn-secondary btn-small sup-import-btn" data-name="${esc(name)}">＋ Add to list</button>` : ''}
          </div>`).join('')}
      </div>` : ''}
    </div>
  `);

  _wireBackButton();

  if (!canEdit) return;

  // Add supplier
  document.getElementById('btn-sup-add')?.addEventListener('click', async () => {
    const name    = document.getElementById('sup-name')?.value.trim();
    const contact = document.getElementById('sup-contact')?.value.trim() || '';
    const notes   = document.getElementById('sup-notes')?.value.trim()   || '';
    const resEl   = document.getElementById('sup-add-result');

    if (!name) { _showResult(resEl, 'Name is required.', 'err'); return; }
    if (managed.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      _showResult(resEl, `"${name}" is already in your list.`, 'warn'); return;
    }

    const btn = document.getElementById('btn-sup-add');
    btn.disabled = true; btn.textContent = 'Adding…';

    try {
      managed.push({ name, contact, notes });
      await DB.dbSet(`businesses/${_session.businessId}/settings`, 'suppliers', { list: managed });
      document.getElementById('sup-name').value    = '';
      document.getElementById('sup-contact').value = '';
      document.getElementById('sup-notes').value   = '';
      _showResult(resEl, `✓ ${name} added`, 'ok');
      toast('✓ Supplier added');
      _renderSuppliersView(managed, unmanaged, usedNames);
    } catch(e) {
      _showResult(resEl, 'Save failed: ' + e.message, 'err');
    }
    btn.disabled = false; btn.textContent = '＋ Add Supplier';
  });

  // Remove supplier
  document.querySelectorAll('.sup-del-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const sup = managed[idx];
      if (!sup || !confirm(`Remove "${sup.name}" from your supplier list?`)) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        managed.splice(idx, 1);
        await DB.dbSet(`businesses/${_session.businessId}/settings`, 'suppliers', { list: managed });
        toast(`${sup.name} removed`, 'warn');
        _renderSuppliersView(managed, unmanaged, usedNames);
      } catch(e) {
        toast('Remove failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = 'Remove';
      }
    })
  );

  // Import unmanaged name into list
  document.querySelectorAll('.sup-import-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (managed.some(s => s.name.toLowerCase() === name.toLowerCase())) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        managed.push({ name, contact: '', notes: '' });
        await DB.dbSet(`businesses/${_session.businessId}/settings`, 'suppliers', { list: managed });
        const newUnmanaged = unmanaged.filter(n => n !== name);
        toast(`✓ ${name} added to list`);
        _renderSuppliersView(managed, newUnmanaged, usedNames);
      } catch(e) {
        toast('Failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = '＋ Add to list';
      }
    })
  );
}


// ── §5c Team ──────────────────────────────────────────────────────────

async function _renderTeam() {
  await renderTeam(_session, () => _renderMoreMenu());
}


// ── §5d Pending ───────────────────────────────────────────────────────

async function _renderPending() {
  await renderPending(_session, () => _renderMoreMenu());
}


// ── §5e Activity Log ──────────────────────────────────────────────────

async function _renderActivityLog() {
  await renderActivityLog(_session, () => _renderMoreMenu());
}


// ── §5f Reconciliation ────────────────────────────────────────────────

async function _renderReconciliation() {
  await renderReconciliation(_session, () => _renderMoreMenu());
}


// ── §5g Reports ───────────────────────────────────────────────────────

async function _renderReports() {
  await renderReports(_session, () => _renderMoreMenu());
}


// ── §5h Boss Panel ────────────────────────────────────────────────────

async function _renderBossPanel() {
  // Security check — only boss can access this
  if ((_session.email || '').toLowerCase() !== BOSS_EMAIL.toLowerCase()) {
    toast('Access denied.', 'err');
    return;
  }

  render(`<div class="wrap"><div class="subscreen-title">👑 Boss Panel</div><div style="font-size:13px;color:var(--muted)">Loading whitelist…</div></div>`);

  let whitelist = [];
  try {
    const r = await DB.dbGet('whitelist', 'allowed');
    whitelist = r.ok ? (r.data.emails || []) : [];
  } catch(e) { whitelist = []; }

  _renderBossPanelView(whitelist);
}

function _renderBossPanelView(whitelist) {
  render(`
    <div class="wrap" style="padding-bottom:80px">
      ${_backButton()}
      <div class="subscreen-title" style="margin-bottom:4px">👑 Boss Panel</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.7">
        Only emails on this list can create a new business by signing in.
        Staff added via Team Management are not affected.
      </div>

      <!-- Add email -->
      <div class="card" style="margin-bottom:14px;border-color:var(--gold)">
        <div class="section-title" style="color:var(--gold)">Add to Whitelist</div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input class="input" id="boss-add-email" type="email"
            placeholder="email@example.com" style="flex:1"/>
          <button class="btn btn-primary btn-small" id="btn-boss-add">＋ Add</button>
        </div>
        <div id="boss-add-result" style="font-size:12px;display:none"></div>
      </div>

      <!-- Current whitelist -->
      <div class="card">
        <div class="section-title">Whitelisted Emails (${whitelist.length})</div>
        ${whitelist.length
          ? whitelist.map((email, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--bdr);gap:10px">
              <span style="font-size:13px;font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis">${esc(email)}</span>
              <button class="btn btn-danger btn-small boss-remove-btn" data-idx="${i}">Remove</button>
            </div>`).join('')
          : `<div style="font-size:13px;color:var(--muted)">No emails whitelisted yet. Add one above.</div>`
        }
      </div>
    </div>
  `);

  _wireBackButton();

  // Add email
  document.getElementById('btn-boss-add')?.addEventListener('click', async () => {
    const email  = (document.getElementById('boss-add-email')?.value || '').trim().toLowerCase();
    const resEl  = document.getElementById('boss-add-result');
    if (!email) { _showResult(resEl, 'Enter an email address.', 'err'); return; }
    if (whitelist.map(e => e.toLowerCase()).includes(email)) {
      _showResult(resEl, `${email} is already whitelisted.`, 'warn'); return;
    }
    const btn = document.getElementById('btn-boss-add');
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      whitelist.push(email);
      await DB.dbSet('whitelist', 'allowed', { emails: whitelist });
      toast(`✓ ${email} added to whitelist`);
      _renderBossPanelView(whitelist);
    } catch(e) {
      _showResult(resEl, 'Failed: ' + e.message, 'err');
      btn.disabled = false; btn.textContent = '＋ Add';
    }
  });

  // Remove email
  document.querySelectorAll('.boss-remove-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const idx   = parseInt(btn.dataset.idx);
      const email = whitelist[idx];
      if (!email || !confirm(`Remove ${email} from whitelist?`)) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        whitelist.splice(idx, 1);
        await DB.dbSet('whitelist', 'allowed', { emails: whitelist });
        toast(`${email} removed`, 'warn');
        _renderBossPanelView(whitelist);
      } catch(e) {
        toast('Failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = 'Remove';
      }
    })
  );
}
