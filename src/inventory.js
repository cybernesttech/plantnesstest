// ════════════════════════════════════════════════════════════════════════
// FILE: src/inventory.js
// PURPOSE: All stock mutation functions. The ONLY file allowed to
//          change inventory_state or write event documents.
//
//          MULTI-TENANCY:
//          Every function requires a businessId parameter.
//          All Firestore paths are built via paths(businessId) from db.js.
//          No cross-business data access is possible by construction.
//
//          SWITCH-READY ARCHITECTURE:
//          To move any function to a Cloud Function, replace its body
//          with a fetch() call. All callers stay identical.
//          See §1 SWITCH NOTE per function.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & CONSTANTS
// §2  IDEMPOTENCY HELPERS
// §3  EVENT WRITER  (internal — writes event + updates inventory_state)
// §4  STOCK IN      (manual or AI scan → STOCK_IN event)
// §5  RESERVE STOCK (order confirmed → RESERVE event)
// §6  DEDUCT STOCK  (order dispatched → STOCK_OUT + release)
// §7  RELEASE STOCK (order cancelled → RELEASE event)
// §8  ADJUST STOCK  (reconciliation / correction → ADJUSTMENT event)
// ════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════
// §1 IMPORTS & CONSTANTS
// ════════════════════════════════════════════════════════════════════════

import {
  dbTransaction,
  dbDocRef,
  dbNewSubDocRef,
  dbServerTimestamp,
  dbNow,
  paths,
  SUBCOL_EVENTS,
} from './db.js';

// ── Event type constants ──────────────────────────────────────────────
// Must match the spec exactly. Never use raw strings in code.
export const EVENT_STOCK_IN       = 'STOCK_IN';
export const EVENT_STOCK_OUT      = 'STOCK_OUT';
export const EVENT_RESERVE        = 'RESERVE';
export const EVENT_RELEASE        = 'RELEASE';
export const EVENT_RETURN         = 'RETURN';
export const EVENT_ADJUSTMENT     = 'ADJUSTMENT';
export const EVENT_RECONCILIATION = 'RECONCILIATION';
export const EVENT_VOID           = 'VOID';

// ── Source constants ──────────────────────────────────────────────────
export const SOURCE_MANUAL         = 'manual';
export const SOURCE_AI             = 'ai';
export const SOURCE_CSV            = 'csv';
export const SOURCE_ORDER          = 'order';
export const SOURCE_RECONCILIATION = 'reconciliation';

// ── Adjustment type constants ─────────────────────────────────────────
export const ADJ_RECONCILIATION = 'reconciliation';
export const ADJ_CORRECTION     = 'correction';
export const ADJ_OVERRIDE       = 'override';

// ── Stock floor ───────────────────────────────────────────────────────
// Stock cannot go below this unless is_override = true (owner only)
const STOCK_FLOOR = 0;


// ════════════════════════════════════════════════════════════════════════
// §2 IDEMPOTENCY HELPERS
// Every mutation checks idempotency_key before writing.
// Duplicate key = return early, no double write.
// Protects against Firestore retries on network failure.
// ════════════════════════════════════════════════════════════════════════

// generateIdempotencyKey(prefix)
// Creates a unique key for a single operation attempt.
// Store this on the client BEFORE calling any mutation.
// On retry, pass the SAME key — duplicate will be detected.
//
// Example:
//   const key = generateIdempotencyKey('reserve');
//   await reserveStock({ businessId, orderId, items, idempotencyKey: key });
export function generateIdempotencyKey(prefix = 'op') {
  const ts     = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const key    = `${prefix}_${ts}_${random}`;
  console.log('[inventory.generateIdempotencyKey]', { key });
  return key;
}

// _checkIdempotency(txn, inventoryStatePath, variantId, idempotencyKey)
// Internal — called inside a transaction before any write.
// Checks last_idempotency_key on inventory_state for O(1) duplicate detection.
// Returns: { isDuplicate: true } | { isDuplicate: false }
async function _checkIdempotency(txn, inventoryStatePath, variantId, idempotencyKey) {
  console.log('[inventory._checkIdempotency] checking', { variantId, idempotencyKey });

  const stateRef  = dbDocRef(inventoryStatePath, variantId);
  const stateSnap = await txn.get(stateRef);

  if (!stateSnap.exists()) {
    console.log('[inventory._checkIdempotency] no state doc — not a duplicate');
    return { isDuplicate: false };
  }

  const state = stateSnap.data();
  if (state.last_idempotency_key === idempotencyKey) {
    console.warn('[inventory._checkIdempotency] DUPLICATE detected', { variantId, idempotencyKey });
    return { isDuplicate: true, existingEventId: state.last_event_id };
  }

  console.log('[inventory._checkIdempotency] not a duplicate');
  return { isDuplicate: false };
}


// ════════════════════════════════════════════════════════════════════════
// §3 EVENT WRITER (internal)
//
// The single internal function that writes an event document AND updates
// inventory_state — always in the same transaction.
//
// Per spec Law 5: inventory_state ONLY mutated inside the same
// transaction that writes the event. Never separately.
//
// Called by: stockIn (§4), reserveStock (§5), deductStock (§6),
//            releaseStock (§7), adjustStock (§8)
// ════════════════════════════════════════════════════════════════════════

// _writeEvent(txn, p, params)
// Internal — do not call from UI code.
// txn: Firestore transaction object
// p:   paths object from paths(businessId) — already resolved by caller
// params: {
//   variantId        string
//   productId        string
//   eventType        string   — one of EVENT_* constants
//   quantity         number   — always positive
//   reason           string   — mandatory, non-empty (Law 3)
//   source           string   — one of SOURCE_* constants
//   idempotencyKey   string   — checked before write (Law 11)
//   linkedOrderId    string?
//   linkedEventId    string?
//   adjustmentType   string?  — for ADJUSTMENT events only
//   isOverride       boolean? — true only for negative-stock overrides (Law 9)
//   locationId       string?  — nullable, future use
//   deltaTotal       number   — change to total_quantity (signed)
//   deltaReserved    number   — change to reserved_quantity (signed)
// }
// Returns: { eventId, newState }
async function _writeEvent(txn, p, params) {
  const {
    variantId,
    productId      = null,
    eventType,
    quantity,
    reason,
    source,
    idempotencyKey,
    linkedOrderId  = null,
    linkedEventId  = null,
    adjustmentType = null,
    isOverride     = false,
    locationId     = null,
    deltaTotal,
    deltaReserved,
  } = params;

  console.log('[inventory._writeEvent] called', {
    variantId, eventType, quantity, deltaTotal, deltaReserved,
  });

  // ── Law 3: reason is mandatory ────────────────────────────────────────
  if (!reason || reason.trim() === '') {
    const err = {
      code:    'MISSING_REASON',
      message: 'Every stock event requires a non-empty reason field (System Law 3).',
      context: { variantId, eventType },
    };
    console.error('[inventory._writeEvent] missing reason', err);
    throw err;
  }

  // ── Read current inventory_state ─────────────────────────────────────
  const stateRef  = dbDocRef(p.inventoryState, variantId);
  const stateSnap = await txn.get(stateRef);

  const currentState = stateSnap.exists()
    ? stateSnap.data()
    : { total_quantity: 0, reserved_quantity: 0, available_quantity: 0, last_event_id: null };

  console.log('[inventory._writeEvent] current state', currentState);

  // ── Compute new state ─────────────────────────────────────────────────
  const newTotal     = (currentState.total_quantity    || 0) + deltaTotal;
  const newReserved  = (currentState.reserved_quantity || 0) + deltaReserved;
  const newAvailable = newTotal - newReserved;

  console.log('[inventory._writeEvent] new state computed', {
    newTotal, newReserved, newAvailable,
  });

  // ── Law 9: stock floor check ──────────────────────────────────────────
  if (newTotal < STOCK_FLOOR && !isOverride) {
    const err = {
      code:    'BELOW_STOCK_FLOOR',
      message: `Stock cannot go below ${STOCK_FLOOR}. Use owner override for negative stock (System Law 9).`,
      context: { variantId, currentTotal: currentState.total_quantity, deltaTotal, newTotal },
    };
    console.error('[inventory._writeEvent] stock floor violation', err);
    throw err;
  }

  // ── Guard: reserved cannot exceed total ───────────────────────────────
  if (newReserved > newTotal) {
    const err = {
      code:    'RESERVED_EXCEEDS_TOTAL',
      message: 'Reserved quantity cannot exceed total quantity.',
      context: { variantId, newTotal, newReserved },
    };
    console.error('[inventory._writeEvent] reserved > total', err);
    throw err;
  }

  // ── Guard: reserved cannot go below 0 ────────────────────────────────
  if (newReserved < 0) {
    const err = {
      code:    'RESERVED_BELOW_ZERO',
      message: 'Reserved quantity cannot go below 0.',
      context: { variantId, currentReserved: currentState.reserved_quantity, deltaReserved },
    };
    console.error('[inventory._writeEvent] reserved below zero', err);
    throw err;
  }

  // ── Write event document ──────────────────────────────────────────────
  // Event lives at: businesses/{bid}/variants/{vid}/events/{eid}
  const eventRef  = dbNewSubDocRef(p.variants, variantId, SUBCOL_EVENTS);
  const eventData = {
    event_id:        eventRef.id,
    type:            eventType,
    product_id:      productId,
    variant_id:      variantId,
    quantity,
    reason:          reason.trim(),
    source,
    idempotency_key: idempotencyKey,
    linked_event_id: linkedEventId,
    linked_order_id: linkedOrderId,
    adjustment_type: adjustmentType,
    is_override:     isOverride,
    location_id:     locationId,
    is_voided:       false,
    delta_total:     deltaTotal,    // signed — positive = stock up, negative = stock down
    // Snapshot of state AFTER this event — useful for audit trail
    state_after: {
      total_quantity:     newTotal,
      reserved_quantity:  newReserved,
      available_quantity: newAvailable,
    },
    created_at:   dbNow(),              // client time per spec
    committed_at: dbServerTimestamp(),  // server time per spec
  };

  txn.set(eventRef, eventData);
  console.log('[inventory._writeEvent] event queued', { eventId: eventRef.id, eventType });

  // ── Update inventory_state in same transaction (Law 5) ────────────────
  const newState = {
    total_quantity:       newTotal,
    reserved_quantity:    newReserved,
    available_quantity:   newAvailable,  // derived — stored for read performance
    last_event_id:        eventRef.id,
    last_idempotency_key: idempotencyKey,
    updated_at:           dbServerTimestamp(),
  };

  txn.set(stateRef, newState);
  console.log('[inventory._writeEvent] inventory_state queued', newState);

  return { eventId: eventRef.id, newState };
}


// ════════════════════════════════════════════════════════════════════════
// §4 STOCK IN
// Called when: manual entry, AI scan, or CSV import adds new stock.
// Effect: total_quantity increases, reserved unchanged.
// Event written: STOCK_IN
//
// SWITCH NOTE: To move to Cloud Function, replace function body with:
//   return await _callCloudFunction('stockIn', {
//     businessId, variantId, productId, quantity, reason, source, idempotencyKey
//   });
// ════════════════════════════════════════════════════════════════════════

// stockIn(params)
// Called by: manual entry UI, AI scanner, CSV import
// Returns: { ok, eventId, newState } | { error, code, message }
//
// params: {
//   businessId      string  — from session.businessId
//   variantId       string
//   productId       string
//   quantity        number
//   reason          string
//   source          string  — SOURCE_MANUAL | SOURCE_AI | SOURCE_CSV
//   idempotencyKey  string  — from generateIdempotencyKey('stockin')
// }
export async function stockIn({
  businessId,
  variantId,
  productId,
  quantity,
  reason,
  source = SOURCE_MANUAL,
  idempotencyKey,
}) {
  console.log('[inventory.stockIn] called', { businessId, variantId, quantity, source });

  const p = paths(businessId);

  try {
    const result = await dbTransaction(`stockIn:${variantId}`, async (txn) => {

      // ── Idempotency check ────────────────────────────────────────────
      const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
      if (dupCheck.isDuplicate) {
        console.warn('[inventory.stockIn] duplicate — returning early', { variantId });
        return { isDuplicate: true };
      }

      // ── Write event + update state ───────────────────────────────────
      return await _writeEvent(txn, p, {
        variantId,
        productId,
        eventType:      EVENT_STOCK_IN,
        quantity,
        reason,
        source,
        idempotencyKey,
        deltaTotal:     quantity, // total increases
        deltaReserved:  0,        // reserved unchanged
      });
    });

    if (result.isDuplicate) {
      return { ok: true, isDuplicate: true };
    }

    console.log('[inventory.stockIn] success', { variantId, result });
    return { ok: true, eventId: result.eventId, newState: result.newState };

  } catch (e) {
    console.error('[inventory.stockIn] failed', { businessId, variantId, error: e });
    return { error: true, code: e.code || 'STOCK_IN_FAILED', message: e.message, context: e.context };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4b STOCK OUT (direct — no reservation)
// Called when: AI Scanner OUT items confirmed, manual stock-out.
// Does NOT touch reservations. Use deductStock for order dispatches.
// Effect: total_quantity decreases. Floors at 0 unless isOverride.
// ════════════════════════════════════════════════════════════════════════

export async function stockOut({
  businessId,
  variantId,
  productId,
  quantity,
  reason,
  source = SOURCE_MANUAL,
  isOverride = false,
  idempotencyKey,
}) {
  console.log('[inventory.stockOut] called', { businessId, variantId, quantity, source });

  const p = paths(businessId);

  try {
    const result = await dbTransaction(`stockOut:${variantId}`, async (txn) => {

      // ── Idempotency check ────────────────────────────────────────────
      const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
      if (dupCheck.isDuplicate) {
        console.warn('[inventory.stockOut] duplicate — returning early', { variantId });
        return { isDuplicate: true };
      }

      // ── Read current state to guard against going negative ───────────
      const stateRef  = dbDocRef(p.inventoryState, variantId);
      const stateSnap = await txn.get(stateRef);
      const state     = stateSnap.exists()
        ? stateSnap.data()
        : { total_quantity: 0, reserved_quantity: 0 };

      const currentTotal = state.total_quantity || 0;
      const actualDeduct = isOverride
        ? quantity
        : Math.min(quantity, currentTotal); // never go below 0 without override

      if (actualDeduct <= 0 && !isOverride) {
        return { blocked: true, currentTotal };
      }

      return await _writeEvent(txn, p, {
        variantId,
        productId,
        eventType:      EVENT_STOCK_OUT,
        quantity:       actualDeduct,
        reason,
        source,
        idempotencyKey,
        deltaTotal:     -actualDeduct,
        deltaReserved:  0,
      });
    });

    if (result.isDuplicate) return { ok: true, isDuplicate: true };
    if (result.blocked)     return { ok: true, blocked: true, currentTotal: result.currentTotal };

    console.log('[inventory.stockOut] success', { variantId, result });
    return { ok: true, eventId: result.eventId, newState: result.newState };

  } catch (e) {
    console.error('[inventory.stockOut] failed', { businessId, variantId, error: e });
    return { error: true, code: e.code || 'STOCK_OUT_FAILED', message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 RESERVE STOCK
// Called when: order status changes draft → confirmed.
// Effect: reserved_quantity increases, total_quantity unchanged.
// Event written: RESERVE
//
// SWITCH NOTE: Replace body with _callCloudFunction('reserveStock', params)
// ════════════════════════════════════════════════════════════════════════

// reserveStock(params)
// Called by: order confirmation flow
// Returns: { ok, reservedItems, eventIds } | { error, code, message }
//
// params: {
//   businessId      string
//   orderId         string
//   items           [{ variantId, productId, quantity }]
//   idempotencyKey  string  — from generateIdempotencyKey('reserve')
//   reason          string?
// }
export async function reserveStock({ businessId, orderId, items, idempotencyKey, reason }) {
  console.log('[inventory.reserveStock] called', { businessId, orderId, itemCount: items.length });

  const p              = paths(businessId);
  const resolvedReason = reason || `Reserved for order ${orderId}`;
  const reservedItems  = [];
  const eventIds       = [];

  try {
    for (const item of items) {
      const { variantId, productId, quantity } = item;
      console.log('[inventory.reserveStock] processing item', { variantId, quantity });

      const result = await dbTransaction(`reserveStock:${variantId}`, async (txn) => {

        // ── Idempotency check ──────────────────────────────────────────
        const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
        if (dupCheck.isDuplicate) {
          console.warn('[inventory.reserveStock] duplicate', { variantId });
          return { isDuplicate: true };
        }

        // ── Availability check ─────────────────────────────────────────
        const stateRef  = dbDocRef(p.inventoryState, variantId);
        const stateSnap = await txn.get(stateRef);
        const state     = stateSnap.exists()
          ? stateSnap.data()
          : { total_quantity: 0, reserved_quantity: 0 };

        const available = (state.total_quantity || 0) - (state.reserved_quantity || 0);
        console.log('[inventory.reserveStock] availability', { variantId, available, requested: quantity });

        if (quantity > available) {
          const err = {
            code:    'INSUFFICIENT_STOCK',
            message: `Insufficient stock for variant ${variantId}. Available: ${available}, requested: ${quantity}.`,
            context: { variantId, available, requested: quantity, orderId },
          };
          console.error('[inventory.reserveStock] insufficient stock', err);
          throw err;
        }

        // ── Write event + update state ─────────────────────────────────
        return await _writeEvent(txn, p, {
          variantId,
          productId,
          eventType:      EVENT_RESERVE,
          quantity,
          reason:         resolvedReason,
          source:         SOURCE_ORDER,
          idempotencyKey,
          linkedOrderId:  orderId,
          deltaTotal:     0,        // total unchanged on reserve
          deltaReserved:  quantity, // reserved increases
        });
      });

      if (!result.isDuplicate) {
        reservedItems.push({ variantId, quantity });
        eventIds.push(result.eventId);
      }
    }

    console.log('[inventory.reserveStock] success', { orderId, reservedItems });
    return { ok: true, reservedItems, eventIds };

  } catch (e) {
    console.error('[inventory.reserveStock] failed', { businessId, orderId, error: e });
    return { error: true, code: e.code || 'RESERVE_FAILED', message: e.message, context: e.context };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 DEDUCT STOCK
// Called when: order status changes confirmed → dispatched.
// Effect: total_quantity decreases, reserved_quantity decreases.
// Handles partial fulfillment: fulfilledQty ≤ orderedQty.
// The remaining reservation (orderedQty - fulfilledQty) is released.
// Event written: STOCK_OUT
//
// SWITCH NOTE: Replace body with _callCloudFunction('deductStock', params)
// ════════════════════════════════════════════════════════════════════════

// deductStock(params)
// Called by: order dispatch flow
// Returns: { ok, deductedItems, eventIds } | { error, code, message }
//
// params: {
//   businessId      string
//   orderId         string
//   items           [{ variantId, productId, orderedQty, fulfilledQty }]
//   idempotencyKey  string  — from generateIdempotencyKey('deduct')
//   reason          string?
// }
export async function deductStock({ businessId, orderId, items, idempotencyKey, reason }) {
  console.log('[inventory.deductStock] called', { businessId, orderId, itemCount: items.length });

  const p              = paths(businessId);
  const resolvedReason = reason || `Dispatched for order ${orderId}`;
  const deductedItems  = [];
  const eventIds       = [];

  try {
    for (const item of items) {
      const { variantId, productId, orderedQty, fulfilledQty } = item;
      console.log('[inventory.deductStock] processing item', {
        variantId, orderedQty, fulfilledQty,
      });

      const result = await dbTransaction(`deductStock:${variantId}`, async (txn) => {

        // ── Idempotency check ──────────────────────────────────────────
        const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
        if (dupCheck.isDuplicate) {
          console.warn('[inventory.deductStock] duplicate', { variantId });
          return { isDuplicate: true };
        }

        // ── Write event ────────────────────────────────────────────────
        // deltaTotal    = -fulfilledQty  (physical stock leaves)
        // deltaReserved = -orderedQty    (entire reservation released atomically)
        return await _writeEvent(txn, p, {
          variantId,
          productId,
          eventType:      EVENT_STOCK_OUT,
          quantity:       fulfilledQty,
          reason:         resolvedReason,
          source:         SOURCE_ORDER,
          idempotencyKey,
          linkedOrderId:  orderId,
          deltaTotal:     -fulfilledQty,
          deltaReserved:  -orderedQty,   // release full reservation
        });
      });

      if (!result.isDuplicate) {
        deductedItems.push({ variantId, fulfilledQty, releasedReservation: orderedQty - fulfilledQty });
        eventIds.push(result.eventId);
      }
    }

    console.log('[inventory.deductStock] success', { orderId, deductedItems });
    return { ok: true, deductedItems, eventIds };

  } catch (e) {
    console.error('[inventory.deductStock] failed', { businessId, orderId, error: e });
    return { error: true, code: e.code || 'DEDUCT_FAILED', message: e.message, context: e.context };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 RELEASE STOCK
// Called when: order is cancelled (confirmed → cancelled).
// Effect: reserved_quantity decreases, total_quantity unchanged.
// Event written: RELEASE
//
// SWITCH NOTE: Replace body with _callCloudFunction('releaseStock', params)
// ════════════════════════════════════════════════════════════════════════

// releaseStock(params)
// Called by: order cancellation flow
// Returns: { ok, releasedItems, eventIds } | { error, code, message }
//
// params: {
//   businessId      string
//   orderId         string
//   items           [{ variantId, productId, quantity }]
//   idempotencyKey  string  — from generateIdempotencyKey('release')
//   reason          string?
// }
export async function releaseStock({ businessId, orderId, items, idempotencyKey, reason }) {
  console.log('[inventory.releaseStock] called', { businessId, orderId, itemCount: items.length });

  const p              = paths(businessId);
  const resolvedReason = reason || `Cancelled order ${orderId} — reservation released`;
  const releasedItems  = [];
  const eventIds       = [];

  try {
    for (const item of items) {
      const { variantId, productId, quantity } = item;
      console.log('[inventory.releaseStock] processing item', { variantId, quantity });

      const result = await dbTransaction(`releaseStock:${variantId}`, async (txn) => {

        // ── Idempotency check ──────────────────────────────────────────
        const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
        if (dupCheck.isDuplicate) {
          console.warn('[inventory.releaseStock] duplicate', { variantId });
          return { isDuplicate: true };
        }

        // ── Write event ────────────────────────────────────────────────
        return await _writeEvent(txn, p, {
          variantId,
          productId,
          eventType:      EVENT_RELEASE,
          quantity,
          reason:         resolvedReason,
          source:         SOURCE_ORDER,
          idempotencyKey,
          linkedOrderId:  orderId,
          deltaTotal:     0,         // total unchanged on release
          deltaReserved:  -quantity, // reserved decreases
        });
      });

      if (!result.isDuplicate) {
        releasedItems.push({ variantId, quantity });
        eventIds.push(result.eventId);
      }
    }

    console.log('[inventory.releaseStock] success', { orderId, releasedItems });
    return { ok: true, releasedItems, eventIds };

  } catch (e) {
    console.error('[inventory.releaseStock] failed', { businessId, orderId, error: e });
    return { error: true, code: e.code || 'RELEASE_FAILED', message: e.message, context: e.context };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §8 ADJUST STOCK
// Called for: reconciliation, correction, or owner override.
// Effect: total_quantity changes by delta (positive or negative).
// Event written: ADJUSTMENT or RECONCILIATION
//
// This is the ONLY path to correct stock without an order.
// Requires a non-empty reason. Owner override allows negative stock.
//
// SWITCH NOTE: Replace body with _callCloudFunction('adjustStock', params)
// ════════════════════════════════════════════════════════════════════════

// adjustStock(params)
// Called by: reconciliation UI, admin correction flow
// Returns: { ok, eventId, newState } | { error, code, message }
//
// params: {
//   businessId       string
//   variantId        string
//   productId        string
//   actualQuantity   number  — what the physical count shows (new total)
//   reason           string  — mandatory
//   source           string  — SOURCE_MANUAL | SOURCE_RECONCILIATION
//   adjustmentType   string  — ADJ_RECONCILIATION | ADJ_CORRECTION | ADJ_OVERRIDE
//   isOverride       boolean — true only if owner allows negative stock
//   idempotencyKey   string  — from generateIdempotencyKey('adjust')
// }
export async function adjustStock({
  businessId,
  variantId,
  productId,
  actualQuantity,
  reason,
  source         = SOURCE_MANUAL,
  adjustmentType = ADJ_CORRECTION,
  isOverride     = false,
  idempotencyKey,
}) {
  console.log('[inventory.adjustStock] called', {
    businessId, variantId, actualQuantity, adjustmentType, isOverride,
  });

  const p = paths(businessId);

  try {
    const result = await dbTransaction(`adjustStock:${variantId}`, async (txn) => {

      // ── Idempotency check ────────────────────────────────────────────
      const dupCheck = await _checkIdempotency(txn, p.inventoryState, variantId, idempotencyKey);
      if (dupCheck.isDuplicate) {
        console.warn('[inventory.adjustStock] duplicate', { variantId });
        return { isDuplicate: true };
      }

      // ── Read current state to compute delta ──────────────────────────
      const stateRef  = dbDocRef(p.inventoryState, variantId);
      const stateSnap = await txn.get(stateRef);
      const state     = stateSnap.exists()
        ? stateSnap.data()
        : { total_quantity: 0, reserved_quantity: 0 };

      const currentTotal = state.total_quantity || 0;
      const delta        = actualQuantity - currentTotal;

      console.log('[inventory.adjustStock] delta computed', {
        currentTotal, actualQuantity, delta,
      });

      // ── Write event ──────────────────────────────────────────────────
      const eventType = adjustmentType === ADJ_RECONCILIATION
        ? EVENT_RECONCILIATION
        : EVENT_ADJUSTMENT;

      return await _writeEvent(txn, p, {
        variantId,
        productId,
        eventType,
        quantity:       Math.abs(delta), // quantity always positive in event
        reason,
        source,
        idempotencyKey,
        adjustmentType,
        isOverride,
        deltaTotal:     delta, // signed — positive = up, negative = down
        deltaReserved:  0,     // adjustments don't touch reservations
      });
    });

    if (result.isDuplicate) {
      return { ok: true, isDuplicate: true };
    }

    console.log('[inventory.adjustStock] success', { variantId });
    return { ok: true, eventId: result.eventId, newState: result.newState };

  } catch (e) {
    console.error('[inventory.adjustStock] failed', { businessId, variantId, error: e });
    return { error: true, code: e.code || 'ADJUST_FAILED', message: e.message, context: e.context };
  }
}
