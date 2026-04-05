// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/scan.js
// AI Scanner: prompt → AI splits name/variant → clean preview cards → confirm
// ════════════════════════════════════════════════════════════════════════

import { render, esc, toast }                               from '../ui.js';
import { loadGroqKey }                                      from '../ai/order-agent.js';
import { loadCache, searchProducts }                        from '../services/products.js';
import { stockIn, stockOut, generateIdempotencyKey, SOURCE_AI }       from '../inventory.js';
import { loadDraft, discardDraft, saveDraft, submitDraft }  from '../services/drafts.js';
import { loadSuppliers, buildSupplierDatalist }             from '../services/suppliers.js';
import { dbAdd, dbSet, dbUpdate, dbNow, paths }             from '../db.js';
import * as Auth from '../auth.js';

let _session = null;
let _items   = [];


// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

export async function renderScan(session) {
  _session = session;
  _items   = [];
  _injectStyles();
  await loadCache(session.businessId);

  const dr = await loadDraft(session.businessId, session.uid);
  if (dr.ok && dr.draft) { _showDraftResume(dr.draft); return; }
  _renderScreen();
}


// ─── DRAFT RESUME ────────────────────────────────────────────────────────────

function _showDraftResume(draft) {
  const count = draft.items?.length || 0;
  const when  = draft.updated_at
    ? new Date(draft.updated_at).toLocaleDateString('en-IN', { day:'numeric', month:'short' })
    : 'recently';
  render(`
    <div class="wrap" style="padding:40px 14px;text-align:center">
      <div style="font-size:36px;margin-bottom:12px">📋</div>
      <div style="font-size:17px;font-weight:600;margin-bottom:8px">Unfinished stock entry</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:28px">
        Draft from ${esc(when)} — ${count} item${count !== 1 ? 's' : ''}.
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary" id="btn-draft-continue" style="justify-content:center;padding:14px">Continue where I left off</button>
        <button class="btn btn-secondary" id="btn-draft-discard" style="justify-content:center;padding:14px">Discard and start fresh</button>
      </div>
    </div>`);
  document.getElementById('btn-draft-continue')?.addEventListener('click', () => {
    _items = (draft.items || []).map(i => ({
      name: i.product_name||'', variant: i.variant_size||'', qty: i.quantity||1,
      direction: i.direction||'in', price: i.price||0, supplier: '', unit: i.unit||'pcs',
      category: i.category||'Plants',
    }));
    _renderScreen();
    setTimeout(() => {
      if (_items.length) {
        _showStatus(`✓ ${_items.length} items restored`, 'ok');
        document.getElementById('scan-preview-section').style.display = 'block';
        _renderPreview();
      }
    }, 50);
  });
  document.getElementById('btn-draft-discard')?.addEventListener('click', async () => {
    await discardDraft(_session.businessId, draft.id);
    _renderScreen();
  });
}


// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────

function _renderScreen() {
  const isStaff = !Auth.isManager();
  render(`
    <div class="wrap" style="padding-bottom:40px">
      <div class="subscreen-title" style="margin-bottom:4px">⚡ AI Scanner</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:18px;line-height:1.7">
        Drop any delivery note, receipt, or invoice. AI reads each item and detects stock IN or OUT.
      </div>
      <div class="drop-zone" id="scan-dz">
        <div class="drop-zone-icon">📄</div>
        <div class="drop-zone-title" id="scan-dz-title">Drop document here</div>
        <div class="drop-zone-sub">delivery note · receipt · invoice · list</div>
      </div>
      <img id="scan-img-preview" style="display:none;max-width:100%;max-height:160px;border-radius:8px;border:1px solid var(--bdr);object-fit:contain;margin-top:12px" alt=""/>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" id="btn-scan-gallery" style="flex:1;justify-content:center">📷 Gallery</button>
        <button class="btn btn-secondary" id="btn-scan-camera" style="flex:1;justify-content:center">Camera</button>
      </div>
      <input type="file" id="scan-gal-input" accept="image/*" style="display:none"/>
      <input type="file" id="scan-cam-input" accept="image/*" capture="environment" style="display:none"/>
      <div class="scan-divider">OR</div>
      <div class="form-group">
        <label class="label">Paste text</label>
        <textarea class="input" id="scan-text-input" rows="4"
          placeholder="Paste delivery list, WhatsApp message, invoice text…"></textarea>
      </div>
      <button class="btn btn-primary" id="btn-scan-analyse" style="width:100%;justify-content:center;margin-top:4px">
        🤖 Analyse
      </button>
      <div id="scan-status" style="margin-top:12px;font-size:13px;display:none"></div>
      <div id="scan-preview-section" style="display:none;margin-top:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:14px;font-weight:600" id="scan-preview-count"></div>
          <button class="btn btn-secondary btn-small" id="btn-scan-clear">✕ Clear</button>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
          Flip ↑/↓ direction · edit price inline · tap ✏ to fix name or variant.
        </p>
        <div id="scan-preview-list"></div>
        <button class="btn btn-primary" id="btn-scan-confirm"
          style="width:100%;justify-content:center;margin-top:14px;padding:13px">
          ${isStaff ? '📤 Submit for Approval' : '✓ Confirm All'}
        </button>
      </div>
    </div>`);
  _wireEvents();
}


// ─── AI PROMPT ───────────────────────────────────────────────────────────────

function _buildPrompt() {
  const products = searchProducts('');
  const knownLines = products
    .flatMap(p => p.variants.length > 0
      ? p.variants.map(v => `${p.name}${v.size ? ' | variant: ' + v.size : ''}`)
      : [`${p.name} | (no variants)`])
    .join('\n');
  return [
    'You are a stock assistant for a plant shop.',
    'Extract every product and quantity from the content provided.',
    '',
    'DIRECTION RULES:',
    '  IN = received/delivered/purchased. OUT = sold/dispatched/used.',
    '  Default IN for delivery notes. Default OUT for sales receipts.',
    '',
    'VARIANT EXTRACTION — CRITICAL:',
    '  "name" = BASE product name only. No size, colour, or descriptor.',
    '  "variant" = size, colour, pot size, or any physical descriptor.',
    '  Examples:',
    '    "Rose Plant Small"    → name:"Rose Plant",  variant:"Small"',
    '    "Basil Plant Medium"  → name:"Basil Plant", variant:"Medium"',
    '    "Plastic Pot 8 inch"  → name:"Plastic Pot", variant:"8 inch"',
    '    "Monstera Deliciosa"  → name:"Monstera Deliciosa", variant:""',
    '  Descriptors that ALWAYS go in variant: Small, Medium, Large, Mini, XL,',
    '  any colour (Red, White, Pink…), any pot size (4", 6", 8"…), Hanging.',
    '  If the known product list has a matching base name, use that exact name.',
    '',
    'KNOWN PRODUCTS (name | variant):',
    knownLines || '(none yet)',
    '',
    'Reply ONLY with a raw JSON array — no markdown.',
    'Valid categories: Plants, Seeds & Bulbs, Soil & Fertilizer, Pots & Planters, Tools & Accessories, Cut Flowers.',
    'Schema: [{ "name":string, "variant":string, "qty":number, "unit":string,',
    '  "direction":"in"|"out", "price":number, "supplier":string, "category":string }]',
    '"variant" is "" if no descriptor. "price" is 0 if unknown. "category" defaults to "Plants".',
  ].join('\n');
}


// ─── RUN SCAN ────────────────────────────────────────────────────────────────

async function _runScan(source, type) {
  const isImage = type === 'image';
  const dzTitle = document.getElementById('scan-dz-title');
  if (dzTitle) dzTitle.textContent = 'Analysing…';
  _showStatus('Reading with AI…', 'loading');

  const keyResult = await loadGroqKey(_session.businessId);
  if (keyResult.error) {
    _showStatus('✕ ' + keyResult.message, 'err');
    if (dzTitle) dzTitle.textContent = 'Drop document here';
    return;
  }

  try {
    const prompt = _buildPrompt();
    const model  = isImage ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
    let messages;
    if (isImage) {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(source);
      });
      messages = [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${source.type};base64,${base64}` } },
        { type: 'text', text: prompt + '\n\nExtract products from the image above.' },
      ]}];
    } else {
      messages = [
        { role: 'system', content: prompt },
        { role: 'user',   content: 'Extract products from this text:\n\n' + source },
      ];
    }

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keyResult.key },
      body: JSON.stringify({ model, max_tokens: 2000, temperature: 0.1, messages }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.error?.message || 'Groq API error ' + resp.status);
    }

    const data    = await resp.json();
    const content = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const start   = content.indexOf('[');
    const end     = content.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('No valid list in AI response.');

    let parsed;
    try { parsed = JSON.parse(content.slice(start, end + 1)); }
    catch(_) {
      const fixed = content.slice(start, end + 1)
        .replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
      parsed = JSON.parse(fixed);
    }

    if (!parsed.length) {
      _showStatus('⚠ No items detected. Try clearer text or image.', 'warn');
      if (dzTitle) dzTitle.textContent = 'Drop document here';
      return;
    }

    _items = parsed.map(p => ({
      name:      (p.name     || '').trim(),
      variant:   (p.variant  || '').trim(),
      qty:       Math.max(1, Number(p.qty) || 1),
      direction: p.direction === 'out' ? 'out' : 'in',
      price:     Number(p.price || 0),
      supplier:  (p.supplier || '').trim(),
      unit:      (p.unit     || 'pcs').trim(),
      category:  (p.category || 'Plants').trim(),
    }));

    const inC  = _items.filter(i => i.direction === 'in').length;
    const outC = _items.filter(i => i.direction === 'out').length;
    _showStatus(`✓ ${_items.length} item${_items.length !== 1 ? 's' : ''} — ${inC} IN, ${outC} OUT`, 'ok');
    document.getElementById('scan-preview-section').style.display = 'block';
    // Load supplier list for autocomplete in edit modals (non-blocking)
    loadSuppliers(_session.businessId).then(() => _renderPreview()).catch(() => _renderPreview());
    if (dzTitle) dzTitle.textContent = 'Drop another document';

  } catch(e) {
    console.error('[scan._runScan]', e);
    _showStatus('✕ ' + e.message, 'err');
    if (dzTitle) dzTitle.textContent = 'Drop document here';
  }
}


// ─── PREVIEW CARDS ───────────────────────────────────────────────────────────
// Price is always visible as an inline field on the card.
// For new products/variants: red border + "⚠ Price required *" label.
// For existing: shows current price from AI, editable.

function _renderPreview() {
  const listEl  = document.getElementById('scan-preview-list');
  const countEl = document.getElementById('scan-preview-count');
  if (!listEl) return;

  countEl.textContent = `${_items.length} item${_items.length !== 1 ? 's' : ''} detected`;
  const products = searchProducts('');

  listEl.innerHTML = _items.map((item, i) => {
    const isIn    = item.direction === 'in';
    const product = products.find(p => (p.name||'').toLowerCase() === (item.name||'').toLowerCase());
    const variant = product?.variants.find(v => (v.size||'').toLowerCase() === (item.variant||'').toLowerCase());
    const isNew    = !product;
    const isNewVar = product && !variant;
    const current  = variant?.available || 0;
    const after    = isIn ? current + item.qty : Math.max(0, current - item.qty);
    const isInsuf  = !isIn && variant && current < item.qty;

    const afterColor = isInsuf ? 'var(--red)' : after === 0 && !isIn ? 'var(--gold)' : 'var(--grn2)';
    const afterText  = isNew
      ? (isIn ? `✦ New product — starts at ${item.qty} ${item.unit}` : `⚠ Not in inventory`)
      : isNewVar
        ? (isIn ? `✦ New variant of "${product.name}" — starts at ${item.qty} ${item.unit}` : `⚠ Variant not found`)
        : isInsuf
          ? `⚠ Only ${current} available`
          : `After: ${after} ${variant?.unit || item.unit}`;

    // Price required for new product/variant creation
    const needsPrice   = (isNew || isNewVar) && isIn;
    const missingPrice = needsPrice && !item.price;

    const CATEGORIES = ['Plants','Seeds & Bulbs','Soil & Fertilizer','Pots & Planters','Tools & Accessories','Cut Flowers'];
    const catOptions  = CATEGORIES.map(c =>
      `<option value="${esc(c)}" ${(item.category||'Plants')===c?'selected':''}>${esc(c)}</option>`
    ).join('');

    return `<div class="scan-item-card" id="scan-card-${i}" style="${missingPrice ? 'border-color:var(--rbdr);' : ''}">
      <div class="scan-item-top">
        <div style="flex:1;min-width:0">
          <div class="scan-item-name">${esc(item.name)}</div>
          ${item.supplier ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">🌿 ${esc(item.supplier)}</div>` : ''}
          ${product && variant ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">Current: ${esc(variant.stockLabel)}</div>` : ''}
          <div style="font-size:11px;font-weight:600;color:${afterColor};margin-top:3px">${afterText}</div>
        </div>
        <div class="scan-item-right">
          <button class="scan-dir-btn ${isIn ? 'in' : 'out'}" data-idx="${i}">${isIn ? '↑ IN' : '↓ OUT'}</button>
          <input type="number" min="1" value="${item.qty}" class="scan-qty-input" data-idx="${i}"
            style="width:54px;text-align:center;padding:5px 6px;background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;color:var(--txt)"/>
          <button class="scan-remove-btn" data-idx="${i}">✕</button>
        </div>
      </div>

      <!-- Variant — always on card as editable input -->
      <div style="display:flex;align-items:center;gap:9px;margin-top:9px">
        <label style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;min-width:80px;color:var(--muted)">
          Variant
        </label>
        <input type="text" class="input scan-variant-input" data-idx="${i}"
          value="${esc(item.variant)}" placeholder="e.g. Medium, Red, 6 inch…"
          style="flex:1;font-size:12px;padding:6px 9px;${item.variant ? 'border-color:var(--gbdr);' : ''}"/>
      </div>

      <!-- Price — always on card, required + highlighted for new products/variants -->
      <div style="display:flex;align-items:center;gap:9px;margin-top:7px">
        <label id="scan-price-lbl-${i}" style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;min-width:80px;color:${missingPrice ? 'var(--red)' : 'var(--muted)'}">
          ${missingPrice ? '⚠ Price req. *' : 'Price ₹'}
        </label>
        <div style="position:relative;width:120px">
          <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--muted);pointer-events:none">₹</span>
          <input type="number" min="0" step="0.01" class="input scan-price-input" data-idx="${i}"
            value="${item.price || ''}" placeholder="0.00"
            style="padding-left:22px;font-weight:600;${missingPrice ? 'border-color:var(--red);' : item.price ? 'color:var(--gold);border-color:var(--gbdr);' : ''}"/>
        </div>
        <span style="font-size:11px;color:var(--muted)">/ ${esc(item.unit)}</span>
      </div>

      <!-- Edit modal: name / category / supplier -->
      <button class="scan-edit-toggle" data-idx="${i}"
        style="font-size:10px;margin-top:7px;padding:3px 9px;border-radius:5px;border:1px solid var(--bdr2);background:transparent;color:var(--muted);cursor:pointer">
        ✏ Edit details
      </button>
      <div id="scan-edit-${i}" style="display:none;margin-top:8px;background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px">
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Product Name</div>
            <input class="input" id="sed-name-${i}" value="${esc(item.name)}" style="font-size:12px;padding:6px 9px"/>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Variant / Size</div>
            <input class="input" id="sed-variant-${i}" value="${esc(item.variant)}" placeholder="e.g. Small, Red…" style="font-size:12px;padding:6px 9px"/>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px">
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Category</div>
            <select class="input" id="sed-category-${i}" style="font-size:12px;padding:6px 9px">
              ${catOptions}
            </select>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Supplier</div>
            <input class="input" id="sed-supplier-${i}" value="${esc(item.supplier)}" placeholder="optional" style="font-size:12px;padding:6px 9px" list="sed-sup-list-${i}" autocomplete="off"/>
            ${buildSupplierDatalist(`sed-sup-list-${i}`)}
          </div>
        </div>
        <div style="display:flex;gap:7px;margin-top:8px">
          <button class="btn btn-primary btn-small sed-apply" data-idx="${i}">✓ Apply</button>
          <button class="btn btn-secondary btn-small sed-cancel" data-idx="${i}">Cancel</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Direction
  listEl.querySelectorAll('.scan-dir-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _items[parseInt(btn.dataset.idx)].direction =
        _items[parseInt(btn.dataset.idx)].direction === 'in' ? 'out' : 'in';
      _renderPreview();
    })
  );

  // Qty
  listEl.querySelectorAll('.scan-qty-input').forEach(inp =>
    inp.addEventListener('change', () => {
      _items[parseInt(inp.dataset.idx)].qty = Math.max(1, Number(inp.value) || 1);
    })
  );

  // Variant — live update, re-check price requirement (new/existing may change)
  listEl.querySelectorAll('.scan-variant-input').forEach(inp =>
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.idx);
      _items[i].variant = inp.value.trim();
      inp.style.borderColor = _items[i].variant ? 'var(--gbdr)' : '';
      // Re-render so afterText and price requirement update
      _renderPreview();
    })
  );

  // Price — live update without re-render; update red state in place
  listEl.querySelectorAll('.scan-price-input').forEach(inp =>
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.idx);
      _items[i].price = Number(inp.value) || 0;

      const products2 = searchProducts('');
      const prod2 = products2.find(p => (p.name||'').toLowerCase() === (_items[i].name||'').toLowerCase());
      const var2  = prod2?.variants.find(v => (v.size||'').toLowerCase() === (_items[i].variant||'').toLowerCase());
      const needsP = (!prod2 || !var2) && _items[i].direction === 'in';
      if (!needsP) return;

      const missing = !_items[i].price;
      const card  = document.getElementById(`scan-card-${i}`);
      const lbl   = document.getElementById(`scan-price-lbl-${i}`);
      if (card) card.style.borderColor  = missing ? 'var(--rbdr)' : '';
      if (lbl)  { lbl.textContent = missing ? '⚠ Price req. *' : 'Price ₹'; lbl.style.color = missing ? 'var(--red)' : 'var(--muted)'; }
      inp.style.borderColor = missing ? 'var(--red)'  : 'var(--gbdr)';
      inp.style.color       = missing ? ''            : 'var(--gold)';
    })
  );

  // Remove
  listEl.querySelectorAll('.scan-remove-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _items.splice(parseInt(btn.dataset.idx), 1);
      if (!_items.length) document.getElementById('scan-preview-section').style.display = 'none';
      else _renderPreview();
    })
  );

  // Edit toggle
  listEl.querySelectorAll('.scan-edit-toggle').forEach(btn =>
    btn.addEventListener('click', () => {
      const f = document.getElementById(`scan-edit-${btn.dataset.idx}`);
      if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
    })
  );

  // Apply edit (name/variant/category/supplier)
  listEl.querySelectorAll('.sed-apply').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      _items[i].name     = document.getElementById(`sed-name-${i}`)?.value.trim()     || _items[i].name;
      _items[i].variant  = document.getElementById(`sed-variant-${i}`)?.value.trim()  ?? _items[i].variant;
      _items[i].category = document.getElementById(`sed-category-${i}`)?.value        || _items[i].category;
      _items[i].supplier = document.getElementById(`sed-supplier-${i}`)?.value.trim() || '';
      _renderPreview();
    })
  );

  // Cancel edit
  listEl.querySelectorAll('.sed-cancel').forEach(btn =>
    btn.addEventListener('click', () => {
      const f = document.getElementById(`scan-edit-${btn.dataset.idx}`);
      if (f) f.style.display = 'none';
    })
  );
}


// ─── CONFIRM (manager/owner) ──────────────────────────────────────────────────

async function _confirmAll() {
  if (!Auth.isManager()) { await _submitForApproval(); return; }
  if (!_items.length)    { toast('No items to confirm', 'warn'); return; }

  // Block if any new product/variant is missing a price
  const products = searchProducts('');
  const missingPrice = _items.filter(item => {
    if (item.direction !== 'in') return false;
    const prod = products.find(p => (p.name||'').toLowerCase() === (item.name||'').toLowerCase());
    const vari = prod?.variants.find(v => (v.size||'').toLowerCase() === (item.variant||'').toLowerCase());
    return (!prod || !vari) && !item.price;
  });
  if (missingPrice.length) {
    toast(
      `Price required: ${missingPrice.map(i => i.name + (i.variant ? ' (' + i.variant + ')' : '')).join(', ')}`,
      'warn'
    );
    return;
  }

  const btn = document.getElementById('btn-scan-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const p   = paths(_session.businessId);
  const now = dbNow();
  let success = 0, created = 0, failed = 0;

  for (const item of _items) {
    if (!item.name) { failed++; continue; }
    try {
      // Find or create product
      await loadCache(_session.businessId);
      let prods = searchProducts('');
      let prod  = prods.find(p => (p.name||'').toLowerCase() === item.name.toLowerCase());
      let fpid; // firestore product doc id

      if (!prod) {
        const r = await dbAdd(p.products, { name: item.name, category: item.category || 'Plants', created_at: now, updated_at: now });
        fpid = r.id;
        await dbUpdate(p.products, fpid, { productId: fpid });
        created++;
        await loadCache(_session.businessId);
        prods = searchProducts('');
        prod  = prods.find(p => (p.name||'').toLowerCase() === item.name.toLowerCase());
      } else {
        fpid = prod.productId || prod.id;
      }

      // Find or create variant
      let vari = prod?.variants.find(v => (v.size||'').toLowerCase() === item.variant.toLowerCase());
      let fvid;

      if (!vari) {
        const vr = await dbAdd(p.variants, {
          product_id: fpid, size: item.variant || '', price: Number(item.price || 0),
          low_stock_threshold: 5, lastPhysicalCountAt: null, transactionCountSinceCount: 0,
          created_at: now, updated_at: now,
        });
        fvid = vr.id;
        await dbSet(p.inventoryState, fvid, {
          total_quantity: 0, reserved_quantity: 0, available_quantity: 0,
          last_event_id: null, last_idempotency_key: null, updated_at: now,
        });
        created++;
        await loadCache(_session.businessId);
      } else {
        fvid = vari.variantId;
      }

      // Stock IN or OUT
      if (item.direction === 'in') {
        const result = await stockIn({
          businessId: _session.businessId, variantId: fvid, productId: fpid,
          quantity: item.qty,
          reason: item.supplier ? `Delivery from ${item.supplier}` : 'AI Scanner',
          source: SOURCE_AI,
          idempotencyKey: generateIdempotencyKey('scan_in'),
        });
        if (result.error) { failed++; console.warn('[scan] stockIn failed', result); }
        else success++;
      } else {
        // OUT — direct stock deduction (no reservation involved)
        const result = await stockOut({
          businessId: _session.businessId, variantId: fvid, productId: fpid,
          quantity: item.qty,
          reason: item.supplier ? `Dispatched to ${item.supplier}` : 'AI Scanner (stock out)',
          source: SOURCE_AI,
          idempotencyKey: generateIdempotencyKey('scan_out'),
        });
        if (result.error)   { failed++; console.warn('[scan] stockOut failed', result); }
        else if (result.blocked) {
          toast(`⚠ ${item.name}${item.variant ? ' (' + item.variant + ')' : ''}: out of stock — skipped`, 'warn');
          failed++;
        }
        else success++;
      }
    } catch(e) {
      console.error('[scan] confirm item failed', item.name, e?.message);
      failed++;
    }
  }

  await loadCache(_session.businessId);

  const msg = [
    success > 0 && `✓ ${success} item${success !== 1 ? 's' : ''} processed`,
    created > 0 && `${created} new created`,
    failed  > 0 && `${failed} failed`,
  ].filter(Boolean).join(' · ');

  toast(msg, failed > 0 && success === 0 ? 'err' : 'ok');
  _items = [];
  document.getElementById('scan-preview-section').style.display = 'none';
  document.getElementById('scan-status').style.display = 'none';
  const imgEl  = document.getElementById('scan-img-preview');
  const textEl = document.getElementById('scan-text-input');
  if (imgEl)  { imgEl.style.display = 'none'; imgEl.src = ''; }
  if (textEl) textEl.value = '';
  if (btn) { btn.disabled = false; btn.textContent = '✓ Confirm All'; }
}


// ─── STAFF: SUBMIT FOR APPROVAL ───────────────────────────────────────────────

async function _submitForApproval() {
  if (!_items.length) { toast('No items to submit', 'warn'); return; }
  const btn = document.getElementById('btn-scan-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  try {
    const dr = await saveDraft(_session.businessId, _session.uid, {
      items: _items.map(i => ({
        product_id: '', variant_id: '', product_name: i.name, variant_size: i.variant,
        quantity: i.qty, direction: i.direction, price: i.price, unit: i.unit || 'pcs',
        category: i.category || 'Plants',
      })),
      source: 'ai_scan',
      rawInput: document.getElementById('scan-text-input')?.value || '',
    });
    if (dr.error) { toast('Save failed: ' + dr.message, 'err'); return; }

    const sr = await submitDraft(_session.businessId, dr.draftId, {
      userId: _session.uid, displayName: _session.displayName || '', email: _session.email || '',
    });
    if (sr.error) { toast('Submit failed: ' + sr.message, 'err'); return; }

    toast(`✓ ${_items.length} items submitted for manager approval`);
    if (window.refreshPendingBadge) window.refreshPendingBadge();
    _items = [];
    document.getElementById('scan-preview-section').style.display = 'none';
    document.getElementById('scan-status').style.display = 'none';
    const textEl = document.getElementById('scan-text-input');
    if (textEl) textEl.value = '';
  } catch(e) { toast('Failed: ' + e.message, 'err'); }

  if (btn) { btn.disabled = false; btn.textContent = '📤 Submit for Approval'; }
}


// ─── EVENT WIRING ────────────────────────────────────────────────────────────

function _wireEvents() {
  document.getElementById('btn-scan-gallery')?.addEventListener('click', () =>
    document.getElementById('scan-gal-input')?.click());
  document.getElementById('btn-scan-camera')?.addEventListener('click', () =>
    document.getElementById('scan-cam-input')?.click());

  document.getElementById('scan-gal-input')?.addEventListener('change', async function () {
    if (this.files[0]) {
      const img = document.getElementById('scan-img-preview');
      if (img) { img.src = URL.createObjectURL(this.files[0]); img.style.display = 'block'; }
      await _runScan(this.files[0], 'image');
    }
    this.value = '';
  });
  document.getElementById('scan-cam-input')?.addEventListener('change', async function () {
    if (this.files[0]) {
      const img = document.getElementById('scan-img-preview');
      if (img) { img.src = URL.createObjectURL(this.files[0]); img.style.display = 'block'; }
      await _runScan(this.files[0], 'image');
    }
    this.value = '';
  });

  const dz = document.getElementById('scan-dz');
  dz?.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz?.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz?.addEventListener('drop', async e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) {
      const img = document.getElementById('scan-img-preview');
      if (img) { img.src = URL.createObjectURL(e.dataTransfer.files[0]); img.style.display = 'block'; }
      await _runScan(e.dataTransfer.files[0], 'image');
    }
  });
  dz?.addEventListener('click', () => document.getElementById('scan-gal-input')?.click());

  document.getElementById('btn-scan-analyse')?.addEventListener('click', async () => {
    const text = document.getElementById('scan-text-input')?.value.trim() || '';
    if (!text) { toast('Paste some text first', 'warn'); return; }
    await _runScan(text, 'text');
  });

  document.getElementById('btn-scan-clear')?.addEventListener('click', () => {
    _items = [];
    document.getElementById('scan-preview-section').style.display = 'none';
    document.getElementById('scan-status').style.display = 'none';
  });

  document.getElementById('btn-scan-confirm')?.addEventListener('click', _confirmAll);
}


// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _showStatus(msg, type) {
  const el = document.getElementById('scan-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = type === 'ok' ? 'var(--grn2)' : type === 'warn' ? 'var(--gold)' : type === 'err' ? 'var(--red)' : 'var(--muted)';
  el.textContent   = msg;
}

function _injectStyles() {
  if (document.getElementById('scan-styles')) return;
  const s = document.createElement('style');
  s.id = 'scan-styles';
  s.textContent = `
.scan-divider{display:flex;align-items:center;gap:10px;margin:18px 0;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.7px}
.scan-divider::before,.scan-divider::after{content:'';flex:1;height:1px;background:var(--bdr)}
.scan-item-card{background:var(--sur);border:1px solid var(--bdr);border-radius:var(--r);padding:12px;margin-bottom:8px}
.scan-item-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.scan-item-name{font-size:13px;font-weight:600;margin-bottom:2px}
.scan-item-right{display:flex;align-items:center;gap:7px;flex-shrink:0}
.scan-dir-btn{padding:4px 9px;border-radius:99px;border:none;font-size:11px;font-weight:700;cursor:pointer}
.scan-dir-btn.in{background:var(--gdim);color:var(--grn2);border:1px solid var(--gbdr)}
.scan-dir-btn.out{background:var(--rdim);color:var(--red);border:1px solid var(--rbdr)}
.scan-remove-btn{background:none;border:none;color:var(--muted);font-size:15px;cursor:pointer;padding:2px}
.scan-remove-btn:hover{color:var(--red)}
`;
  document.head.appendChild(s);
}
