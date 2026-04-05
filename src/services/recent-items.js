// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/recent-items.js
// PURPOSE: Per-user recent items for order creation quick-add.
//          Stored in localStorage — no Firestore, no network.
//          Shows last 10 variant+product combos the user added to orders.
//          This is the feature that competes directly with memory.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  CONSTANTS
// §2  GET RECENT ITEMS
// §3  ADD RECENT ITEM
// §4  CLEAR RECENT ITEMS
// ════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════
// §1 CONSTANTS
// ════════════════════════════════════════════════════════════════════════

const MAX_RECENT_ITEMS = 10;

// Storage key is scoped to businessId + userId so different businesses
// and different users on the same device get separate lists.
function _storageKey(businessId, userId) {
  return `plantness_recent_${businessId}_${userId}`;
}


// ════════════════════════════════════════════════════════════════════════
// §2 GET RECENT ITEMS
// ════════════════════════════════════════════════════════════════════════

// getRecentItems(businessId, userId)
// Returns the last MAX_RECENT_ITEMS items added to orders by this user.
// Each item: { variantId, productId, productName, variantSize, price, addedAt }
// Ordered by most recent first.
export function getRecentItems(businessId, userId) {
  const key = _storageKey(businessId, userId);
  try {
    const raw  = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    console.log('[recentItems.getRecentItems]', { count: list.length });
    return list;
  } catch(e) {
    console.warn('[recentItems.getRecentItems] failed to parse', e?.message);
    return [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §3 ADD RECENT ITEM
// ════════════════════════════════════════════════════════════════════════

// addRecentItem(businessId, userId, item)
// item: { variantId, productId, productName, variantSize, price }
// Adds to front of list. Deduplicates by variantId. Caps at MAX_RECENT_ITEMS.
export function addRecentItem(businessId, userId, item) {
  console.log('[recentItems.addRecentItem]', { variantId: item.variantId });
  const key = _storageKey(businessId, userId);
  try {
    const list = getRecentItems(businessId, userId);

    // Remove existing entry for this variant (dedup)
    const filtered = list.filter(i => i.variantId !== item.variantId);

    // Add to front with timestamp
    filtered.unshift({ ...item, addedAt: new Date().toISOString() });

    // Cap at max
    const trimmed = filtered.slice(0, MAX_RECENT_ITEMS);

    localStorage.setItem(key, JSON.stringify(trimmed));
    console.log('[recentItems.addRecentItem] saved', { newCount: trimmed.length });
  } catch(e) {
    console.warn('[recentItems.addRecentItem] failed (non-critical):', e?.message);
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 CLEAR RECENT ITEMS
// ════════════════════════════════════════════════════════════════════════

// clearRecentItems(businessId, userId)
export function clearRecentItems(businessId, userId) {
  const key = _storageKey(businessId, userId);
  try {
    localStorage.removeItem(key);
    console.log('[recentItems.clearRecentItems] cleared');
  } catch(e) {
    console.warn('[recentItems.clearRecentItems] failed:', e?.message);
  }
}
