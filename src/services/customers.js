// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/customers.js
// PURPOSE: Customer data service — search by phone, create, update.
//          Phone is the primary key. Search is real-time as seller types.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SEARCH BY PHONE  (real-time as seller types)
// §3  SEARCH BY NAME   (fallback)
// §4  CREATE CUSTOMER
// §5  GET CUSTOMER
// §6  UPDATE CUSTOMER STATS
// ════════════════════════════════════════════════════════════════════════

import { dbQuery, dbAdd, dbGet, dbUpdate, dbNow, paths } from '../db.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SEARCH BY PHONE
// Called as seller types the phone number. Real-time, hits Firestore.
// Returns: { found: true, customer } | { found: false }
// ════════════════════════════════════════════════════════════════════════

// searchByPhone(businessId, phone)
// Phone is the primary search field. Returns first exact match.
// Called by: order creation customer lookup
export async function searchByPhone(businessId, phone) {
  const cleanPhone = (phone || '').trim();
  console.log('[customers.searchByPhone] called', { businessId, phone: cleanPhone });

  if (!cleanPhone || cleanPhone.length < 3) return { found: false };

  const p = paths(businessId);
  try {
    const result = await dbQuery(
      p.customers,
      [{ field: 'phone', op: '==', value: cleanPhone }],
      [],
      1
    );

    if (result.ok && result.data.length > 0) {
      const customer = result.data[0];
      console.log('[customers.searchByPhone] found', { customerId: customer.id, name: customer.name });
      return { found: true, customer };
    }

    console.log('[customers.searchByPhone] not found', { phone: cleanPhone });
    return { found: false };

  } catch(e) {
    console.error('[customers.searchByPhone] failed', e);
    return { found: false, error: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §3 SEARCH BY NAME  (fallback when phone search finds nothing)
// Returns up to 10 matches.
// ════════════════════════════════════════════════════════════════════════

// searchByName(businessId, name)
// Called when phone search returns no results and seller tries name.
export async function searchByName(businessId, name) {
  const cleanName = (name || '').trim().toLowerCase();
  console.log('[customers.searchByName] called', { businessId, name: cleanName });

  if (!cleanName || cleanName.length < 2) return { ok: true, data: [] };

  const p = paths(businessId);
  try {
    // Firestore doesn't support native LIKE queries.
    // We fetch all customers and filter in-memory.
    // For small businesses this is fine — large businesses need a search index.
    const result = await dbQuery(p.customers, [], [{ field: 'name', direction: 'asc' }], 200);

    if (!result.ok) return { ok: true, data: [] };

    const matches = result.data
      .filter(c => (c.name || '').toLowerCase().includes(cleanName))
      .slice(0, 10);

    console.log('[customers.searchByName] found', { count: matches.length });
    return { ok: true, data: matches };

  } catch(e) {
    console.error('[customers.searchByName] failed', e);
    return { ok: true, data: [] };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 CREATE CUSTOMER
// ════════════════════════════════════════════════════════════════════════

// createCustomer(businessId, { name, phone, email, company, notes })
// Called when phone search returns no match and seller enters a name.
// Phone and name are required. All other fields optional.
// Returns: { ok, customerId, customer } | { error, code, message }
export async function createCustomer(businessId, { name, phone, email = '', company = '', notes = '' }) {
  console.log('[customers.createCustomer] called', { businessId, name, phone });

  if (!phone?.trim()) {
    return { error: true, code: 'MISSING_PHONE', message: 'Phone number is required.' };
  }
  if (!name?.trim()) {
    return { error: true, code: 'MISSING_NAME', message: 'Customer name is required.' };
  }

  const p           = paths(businessId);
  const now         = dbNow();
  const customerData = {
    name:            name.trim(),
    phone:           phone.trim(),
    email:           email.trim(),
    company:         company.trim(),
    notes:           notes.trim(),
    total_orders:    0,
    total_value:     0,
    last_order_date: null,
    created_at:      now,
    updated_at:      now,
  };

  try {
    const result = await dbAdd(p.customers, customerData);
    console.log('[customers.createCustomer] success', { customerId: result.id });
    return { ok: true, customerId: result.id, customer: { id: result.id, ...customerData } };
  } catch(e) {
    console.error('[customers.createCustomer] failed', e);
    return { error: true, code: 'CREATE_FAILED', message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 GET CUSTOMER
// ════════════════════════════════════════════════════════════════════════

// getCustomer(businessId, customerId)
// Returns: { ok, data } | { ok: false }
export async function getCustomer(businessId, customerId) {
  const p = paths(businessId);
  return await dbGet(p.customers, customerId);
}

// getLastOrder(businessId, customerId)
// Returns the most recent order for a customer — used for "Repeat last order".
// Returns: { ok, order } | { ok: false }
export async function getLastOrder(businessId, customerId) {
  console.log('[customers.getLastOrder] called', { businessId, customerId });
  const p = paths(businessId);
  try {
    // No orderBy here — avoids a composite index requirement.
    // We fetch all orders for this customer and sort client-side.
    const result = await dbQuery(
      p.orders,
      [{ field: 'customer_id', op: '==', value: customerId }]
    );
    if (result.ok && result.data.length > 0) {
      // Sort newest first client-side
      const sorted = result.data.sort((a, b) =>
        (b.created_at || '') > (a.created_at || '') ? 1 : -1
      );
      return { ok: true, order: sorted[0] };
    }
    return { ok: false };
  } catch(e) {
    console.error('[customers.getLastOrder] failed', e);
    return { ok: false };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 UPDATE CUSTOMER STATS
// Called after an order is confirmed/dispatched to keep stats current.
// Non-critical — failure does not block the order operation.
// ════════════════════════════════════════════════════════════════════════

// updateCustomerStats(businessId, customerId, { orderValue })
// Increments total_orders, adds to total_value, updates last_order_date.
export async function updateCustomerStats(businessId, customerId, { orderValue = 0 }) {
  console.log('[customers.updateCustomerStats] called', { businessId, customerId, orderValue });
  const p = paths(businessId);
  try {
    const result = await dbGet(p.customers, customerId);
    if (!result.ok) return;

    const c = result.data;
    await dbUpdate(p.customers, customerId, {
      total_orders:    (c.total_orders || 0) + 1,
      total_value:     (c.total_value  || 0) + Number(orderValue),
      last_order_date: dbNow(),
      updated_at:      dbNow(),
    });
    console.log('[customers.updateCustomerStats] success');
  } catch(e) {
    console.warn('[customers.updateCustomerStats] failed (non-critical):', e?.message);
  }
}
