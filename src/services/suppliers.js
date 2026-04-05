// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/suppliers.js
// PURPOSE: Load and cache the managed supplier list.
//          Stored at businesses/{bid}/settings/suppliers → { list: [{name,contact,notes}] }
//          Falls back to unique supplier_name values from product docs if empty.
// ════════════════════════════════════════════════════════════════════════

import { dbGet, dbList, paths } from '../db.js';

// In-memory cache — lives for the session, refresh by calling loadSuppliers() again.
let _supplierNames = []; // sorted string array for datalist
let _loaded        = false;

// loadSuppliers(businessId) → string[]
// Returns sorted array of supplier name strings.
// Merges managed list + names found in products.
// Cached after first call — call again to refresh.
export async function loadSuppliers(businessId) {
  try {
    const names = new Set();

    // 1. Managed list
    const settingsResult = await dbGet(
      `businesses/${businessId}/settings`, 'suppliers'
    );
    if (settingsResult.ok && settingsResult.data?.list) {
      settingsResult.data.list.forEach(s => {
        if (s.name) names.add(s.name.trim());
      });
    }

    // 2. Names from product docs (fallback / enrichment)
    const p           = paths(businessId);
    const prodsResult = await dbList(p.products);
    if (prodsResult.ok) {
      prodsResult.data.forEach(prod => {
        if (prod.supplier_name) names.add(prod.supplier_name.trim());
      });
    }

    _supplierNames = [...names].sort((a, b) => a.localeCompare(b));
    _loaded        = true;
    return _supplierNames;
  } catch (e) {
    console.warn('[suppliers.loadSuppliers] failed (non-critical):', e?.message);
    return _supplierNames; // return stale cache rather than empty
  }
}

// getSupplierNames() → string[]
// Returns cached names synchronously. Returns [] if loadSuppliers() not yet called.
export function getSupplierNames() {
  return _supplierNames;
}

// buildSupplierDatalist(inputId) → string
// Returns an HTML <datalist> element string linked to `inputId`.
// Call loadSuppliers() first — or use the cached result.
export function buildSupplierDatalist(listId) {
  return `<datalist id="${listId}">${
    _supplierNames.map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('')
  }</datalist>`;
}
