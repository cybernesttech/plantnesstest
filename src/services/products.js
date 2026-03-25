// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/products.js
// PURPOSE: Product and variant data service.
//          Loads products + variants + inventory_state into a local cache.
//          All order creation reads from this cache — zero network calls
//          during product search (spec: "no spinner, instant results").
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  CONSTANTS
// §2  CACHE STATE
// §3  CACHE LOADER
// §4  SEARCH  (instant, local — no network)
// §5  GETTERS
// §6  INTERNAL ENRICHMENT HELPERS
// ════════════════════════════════════════════════════════════════════════

import { dbList, paths } from '../db.js';

// ════════════════════════════════════════════════════════════════════════
// §1 CONSTANTS
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const CONFIDENCE_LOW_TX_COUNT     = 50;  // transactions since count before confidence drops
const CONFIDENCE_STALE_DAYS       = 30;  // days since count before confidence drops


// ════════════════════════════════════════════════════════════════════════
// §2 CACHE STATE
// In-memory cache — rebuilt from Firestore on loadCache().
// ════════════════════════════════════════════════════════════════════════

let _products          = new Map(); // Map<productId, productDoc>
let _variants          = new Map(); // Map<variantId, variantDoc>
let _inventoryState    = new Map(); // Map<variantId, inventoryStateDoc>
let _variantsByProduct = new Map(); // Map<productId, variantId[]>
let _cacheLoaded       = false;
let _businessId        = null;


// ════════════════════════════════════════════════════════════════════════
// §3 CACHE LOADER
// ════════════════════════════════════════════════════════════════════════

// loadCache(businessId)
// Loads all products, variants, and inventory_state into memory.
// Call on app open and after any stock mutation.
// Returns: { ok, productCount, variantCount }
export async function loadCache(businessId) {
  console.log('[products.loadCache] called', { businessId });
  _businessId = businessId;
  const p = paths(businessId);

  try {
    const [productsResult, variantsResult, stateResult] = await Promise.all([
      dbList(p.products),
      dbList(p.variants),
      dbList(p.inventoryState),
    ]);

    // Rebuild products map
    _products = new Map();
    if (productsResult.ok) {
      for (const doc of productsResult.data) _products.set(doc.id, doc);
    }

    // Rebuild variants map + variantsByProduct index
    _variants          = new Map();
    _variantsByProduct = new Map();
    if (variantsResult.ok) {
      for (const doc of variantsResult.data) {
        _variants.set(doc.id, doc);
        const pid = doc.product_id;
        if (pid) {
          if (!_variantsByProduct.has(pid)) _variantsByProduct.set(pid, []);
          _variantsByProduct.get(pid).push(doc.id);
        }
      }
    }

    // Rebuild inventory state map
    _inventoryState = new Map();
    if (stateResult.ok) {
      for (const doc of stateResult.data) _inventoryState.set(doc.id, doc);
    }

    _cacheLoaded = true;
    console.log('[products.loadCache] success', {
      productCount: _products.size,
      variantCount: _variants.size,
    });
    return { ok: true, productCount: _products.size, variantCount: _variants.size };

  } catch(e) {
    console.error('[products.loadCache] failed', e);
    return { ok: false, error: e.message };
  }
}

export function isCacheLoaded() { return _cacheLoaded; }


// ════════════════════════════════════════════════════════════════════════
// §4 SEARCH  (instant, local — zero network calls)
// ════════════════════════════════════════════════════════════════════════

// searchProducts(query)
// Searches products by name from local cache. Returns enriched results.
// Empty query returns all products (used for recent items display).
//
// Result shape per product:
// {
//   productId, name, category,
//   hasAvailable,
//   variants: [{
//     variantId, productId, size, price,
//     available, total, reserved,
//     isOutOfStock, isLowStock, isLowConfidence,
//     stockLabel   ← "8 available" | "~8 available" | "Out of stock"
//   }]
// }
//
// Sorted: products with available variants first, out-of-stock last.
export function searchProducts(query) {
  if (!_cacheLoaded) { console.warn('[products.searchProducts] cache not loaded'); return []; }

  const q       = (query || '').toLowerCase().trim();
  const results = [];

  for (const [productId, product] of _products) {
    if (q && !(product.name || '').toLowerCase().includes(q)) continue;

    const variantIds = _variantsByProduct.get(productId) || [];
    const variants   = variantIds
      .map(vid => _enrichVariant(vid))
      .filter(Boolean)
      .sort((a, b) => {
        // Available variants first, out-of-stock last
        if (a.isOutOfStock && !b.isOutOfStock) return 1;
        if (!a.isOutOfStock && b.isOutOfStock) return -1;
        return 0;
      });

    if (variants.length === 0 && q) continue;

    const hasAvailable = variants.some(v => !v.isOutOfStock);
    results.push({ productId, name: product.name || '', category: product.category || '', variants, hasAvailable });
  }

  // Products with stock first, out-of-stock products last
  results.sort((a, b) => {
    if (a.hasAvailable && !b.hasAvailable) return -1;
    if (!a.hasAvailable && b.hasAvailable) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  console.log('[products.searchProducts]', { query: q, resultCount: results.length });
  return results;
}


// ════════════════════════════════════════════════════════════════════════
// §5 GETTERS
// ════════════════════════════════════════════════════════════════════════

export function getProduct(productId)          { return _products.get(productId) || null; }
export function getVariant(variantId)           { return _enrichVariant(variantId); }
export function getVariantsForProduct(productId){ return (_variantsByProduct.get(productId) || []).map(vid => _enrichVariant(vid)).filter(Boolean); }
export function getAllProducts()                 { return searchProducts(''); }

// getAvailableQty(variantId) — quick availability check from cache
export function getAvailableQty(variantId) {
  const state = _inventoryState.get(variantId) || {};
  return Math.max(0, Number(state.total_quantity || 0) - Number(state.reserved_quantity || 0));
}


// ════════════════════════════════════════════════════════════════════════
// §6 INTERNAL ENRICHMENT HELPERS
// ════════════════════════════════════════════════════════════════════════

// _enrichVariant(variantId) — adds inventory state to a variant doc
function _enrichVariant(variantId) {
  const variant = _variants.get(variantId);
  if (!variant) return null;

  const state        = _inventoryState.get(variantId) || {};
  const total        = Number(state.total_quantity    || 0);
  const reserved     = Number(state.reserved_quantity || 0);
  const available    = Math.max(0, total - reserved);
  const threshold    = Number(variant.low_stock_threshold || DEFAULT_LOW_STOCK_THRESHOLD);
  const isOutOfStock = available <= 0;
  const isLowStock   = !isOutOfStock && available <= threshold;
  const isLowConfidence = _computeLowConfidence(variant);

  let stockLabel;
  if (isOutOfStock) {
    stockLabel = 'Out of stock';
  } else {
    stockLabel = `${isLowConfidence ? '~' : ''}${available} available`;
  }

  return {
    variantId,
    productId:        variant.product_id || '',
    size:             variant.size       || '',
    price:            Number(variant.price || 0),
    available,
    total,
    reserved,
    isOutOfStock,
    isLowStock,
    isLowConfidence,
    stockLabel,
    threshold,
  };
}

// _computeLowConfidence(variant)
// Confidence is a pure function of inputs — never stored, never manually set.
function _computeLowConfidence(variant) {
  const txCount = Number(variant.transactionCountSinceCount || 0);
  if (txCount >= CONFIDENCE_LOW_TX_COUNT) return true;

  const lastCount = variant.lastPhysicalCountAt;
  if (lastCount) {
    const daysSince = (Date.now() - new Date(lastCount).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= CONFIDENCE_STALE_DAYS) return true;
  } else {
    if (txCount > 0) return true; // never counted but has transactions
  }
  return false;
}
