// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/orders.js
// PURPOSE: Order read/write operations.
//          Stock mutations (reserve/deduct/release) are in inventory.js.
//          This file handles order documents and order items only.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  CREATE ORDER
// §3  GET / LIST ORDERS
// §4  ORDER ITEMS
// §5  UPDATE ORDER STATUS
// §6  ORDER VALUE HELPERS
// ════════════════════════════════════════════════════════════════════════

import {
  dbAdd, dbGet, dbSet, dbUpdate, dbDelete, dbList, dbQuery,
  dbAddSub, dbListSub,
  dbNow, paths,
} from '../db.js';


// ════════════════════════════════════════════════════════════════════════
// §2 CREATE ORDER
// ════════════════════════════════════════════════════════════════════════

// createOrder(businessId, { customerId, customerName, customerPhone, isWalkIn, createdBy })
// Creates a new DRAFT order document.
// Stock is NOT touched — draft orders have no stock effect (spec).
// Returns: { ok, orderId } | { error, message }
export async function createOrder(businessId, {
  customerId    = null,
  customerName  = '',
  customerPhone = '',
  isWalkIn      = false,
  createdBy     = '',
}) {
  console.log('[orders.createOrder] called', { businessId, customerId, isWalkIn });
  const p   = paths(businessId);
  const now = dbNow();

  const orderData = {
    customer_id:    customerId,
    customer_name:  isWalkIn ? 'Walk-in' : customerName,
    customer_phone: customerPhone || '',
    is_walk_in:     isWalkIn,
    status:        'draft',
    total_value:   0,
    items_count:   0,
    created_by:    createdBy,
    created_at:    now,
    updated_at:    now,
    reserved_at:   null,
    expires_at:    null,
    // idempotency_key set when confirming — not needed for draft creation
    idempotency_key: null,
  };

  try {
    const result = await dbAdd(p.orders, orderData);
    console.log('[orders.createOrder] success', { orderId: result.id });
    return { ok: true, orderId: result.id };
  } catch(e) {
    console.error('[orders.createOrder] failed', e);
    return { error: true, code: 'CREATE_FAILED', message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §3 GET / LIST ORDERS
// ════════════════════════════════════════════════════════════════════════

// getOrder(businessId, orderId)
// Returns: { ok, data } | { ok: false }
export async function getOrder(businessId, orderId) {
  const p = paths(businessId);
  return await dbGet(p.orders, orderId);
}

// listOrders(businessId, options)
// Returns orders sorted by created_at desc.
// options.status: filter by status string (optional)
// options.limit:  max results (default 50)
export async function listOrders(businessId, { status = null, limitCount = 50 } = {}) {
  console.log('[orders.listOrders] called', { businessId, status });
  const p = paths(businessId);

  const conditions = status ? [{ field: 'status', op: '==', value: status }] : [];

  try {
    const result = await dbQuery(
      p.orders,
      conditions,
      [{ field: 'created_at', direction: 'desc' }],
      limitCount
    );
    return result.ok ? { ok: true, data: result.data } : { ok: true, data: [] };
  } catch(e) {
    console.error('[orders.listOrders] failed', e);
    return { ok: true, data: [] };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 ORDER ITEMS
// ════════════════════════════════════════════════════════════════════════

// addOrderItem(businessId, orderId, item)
// Adds a product variant to a draft order.
// Only allowed on DRAFT orders — confirmed orders require inventory ops.
// Returns: { ok, itemId } | { error, message }
export async function addOrderItem(businessId, orderId, {
  productId,
  productName,
  variantId,
  variantSize,
  quantity,
  price,
  unit = 'pcs',
}) {
  console.log('[orders.addOrderItem] called', { businessId, orderId, variantId, quantity });

  const p = paths(businessId);

  // Read current order to verify it's still a draft
  const orderResult = await dbGet(p.orders, orderId);
  if (!orderResult.ok) {
    return { error: true, code: 'ORDER_NOT_FOUND', message: 'Order not found.' };
  }
  if (orderResult.data.status !== 'draft') {
    return { error: true, code: 'NOT_DRAFT', message: 'Can only add items to draft orders.' };
  }

  const itemData = {
    product_id:   productId,
    product_name: productName,
    variant_id:   variantId,
    variant_size: variantSize,
    ordered_qty:  Number(quantity),
    fulfilled_qty: 0,   // set on dispatch
    price:         Number(price),
    unit,
    line_total:    Number(quantity) * Number(price),
    created_at:    dbNow(),
  };

  try {
    const result = await dbAddSub(p.orders, orderId, 'items', itemData);

    // Update order totals
    await _recalcOrderTotal(businessId, orderId);

    console.log('[orders.addOrderItem] success', { itemId: result.id });
    return { ok: true, itemId: result.id };
  } catch(e) {
    console.error('[orders.addOrderItem] failed', e);
    return { error: true, code: 'ADD_ITEM_FAILED', message: e.message };
  }
}

// updateOrderItem(businessId, orderId, itemId, { quantity })
// Updates quantity of an item in a draft order.
export async function updateOrderItem(businessId, orderId, itemId, { quantity }) {
  console.log('[orders.updateOrderItem] called', { businessId, orderId, itemId, quantity });
  const p = paths(businessId);

  try {
    const itemResult = await dbGet(`${p.orders}/${orderId}/items`, itemId);
    if (!itemResult.ok) return { error: true, message: 'Item not found.' };

    const item = itemResult.data;
    await dbUpdate(`${p.orders}/${orderId}/items`, itemId, {
      ordered_qty: Number(quantity),
      line_total:  Number(quantity) * Number(item.price),
    });

    await _recalcOrderTotal(businessId, orderId);
    return { ok: true };
  } catch(e) {
    console.error('[orders.updateOrderItem] failed', e);
    return { error: true, message: e.message };
  }
}

// removeOrderItem(businessId, orderId, itemId)
// Removes an item from a draft order.
export async function removeOrderItem(businessId, orderId, itemId) {
  console.log('[orders.removeOrderItem] called', { businessId, orderId, itemId });
  const p = paths(businessId);
  try {
    const { dbDelete } = await import('../db.js');
    await dbDelete(`${p.orders}/${orderId}/items`, itemId);
    await _recalcOrderTotal(businessId, orderId);
    return { ok: true };
  } catch(e) {
    console.error('[orders.removeOrderItem] failed', e);
    return { error: true, message: e.message };
  }
}

// getOrderItems(businessId, orderId)
// Returns all items for an order.
export async function getOrderItems(businessId, orderId) {
  const p = paths(businessId);
  try {
    const result = await dbListSub(p.orders, orderId, 'items');
    return result.ok ? result.data : [];
  } catch(e) {
    console.error('[orders.getOrderItems] failed', e);
    return [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 UPDATE ORDER STATUS
// Note: status changes that trigger stock mutations must also call
// the appropriate inventory.js function (reserveStock, deductStock, etc.)
// This function only updates the order document status field.
// ════════════════════════════════════════════════════════════════════════

// updateOrderStatus(businessId, orderId, status, extra)
// Updates order status. Called after inventory operation succeeds.
// extra: { reservedAt, expiresAt, idempotencyKey } for confirmed orders
export async function updateOrderStatus(businessId, orderId, status, extra = {}) {
  console.log('[orders.updateOrderStatus] called', { businessId, orderId, status });
  const p = paths(businessId);
  try {
    const updates = {
      status,
      updated_at: dbNow(),
      ...extra,
    };
    await dbUpdate(p.orders, orderId, updates);
    console.log('[orders.updateOrderStatus] success', { orderId, status });
    return { ok: true };
  } catch(e) {
    console.error('[orders.updateOrderStatus] failed', e);
    return { error: true, message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 ORDER VALUE HELPERS
// ════════════════════════════════════════════════════════════════════════

// _recalcOrderTotal(businessId, orderId)
// Internal — recalculates order total_value and items_count from items.
// Called after any item add/update/remove.
async function _recalcOrderTotal(businessId, orderId) {
  console.log('[orders._recalcOrderTotal] called', { orderId });
  const p = paths(businessId);
  try {
    const items      = await getOrderItems(businessId, orderId);
    const totalValue = items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
    const itemsCount = items.length;

    await dbUpdate(p.orders, orderId, {
      total_value: totalValue,
      items_count: itemsCount,
      updated_at:  dbNow(),
    });
    console.log('[orders._recalcOrderTotal] success', { totalValue, itemsCount });
  } catch(e) {
    console.warn('[orders._recalcOrderTotal] failed (non-critical):', e?.message);
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 DELETE ORDER
// ════════════════════════════════════════════════════════════════════════

export async function deleteOrder(businessId, orderId) {
  console.log('[orders.deleteOrder] called', { orderId });
  const p = paths(businessId);
  try {
    const items = await getOrderItems(businessId, orderId);
    for (const item of items) {
      try { await dbDelete(`${p.orders}/${orderId}/items`, item.id); }
      catch(e) { console.warn('[orders.deleteOrder] item delete failed', item.id, e?.message); }
    }
    await dbDelete(p.orders, orderId);
    console.log('[orders.deleteOrder] success', { orderId });
    return { ok: true };
  } catch(e) {
    console.error('[orders.deleteOrder] failed', e);
    return { error: true, message: e.message };
  }
}
