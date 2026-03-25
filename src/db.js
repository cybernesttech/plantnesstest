// ════════════════════════════════════════════════════════════════════════
// FILE: src/db.js
// PURPOSE: All Firestore read/write primitives. No business logic here.
//          Every other module imports from this file — never touches
//          Firestore directly.
//
//          MULTI-TENANCY MODEL:
//          All data lives under businesses/{businessId}/.
//          businessId = owner's Firebase UID.
//          Every path helper requires a businessId parameter.
//          No cross-business data access is possible by construction.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & FIRESTORE INSTANCE
// §2  COLLECTION PATH HELPERS  (multi-tenant — all require businessId)
// §3  DOCUMENT HELPERS         (get, set, add, update, delete)
// §4  COLLECTION HELPERS       (list, query)
// §5  SUBCOLLECTION HELPERS    (events under variants, items under orders)
// §6  TRANSACTION HELPER
// §7  TIMESTAMP HELPERS
// ════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════
// §1 IMPORTS & FIRESTORE INSTANCE
// ════════════════════════════════════════════════════════════════════════

import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Firestore instance — set once via init(), used by all helpers below
let _db = null;

// init(firestoreInstance)
// Must be called once after Firebase app is initialised (in index.html §7).
export function init(firestoreInstance) {
  _db = firestoreInstance;
  console.log('[db.init] Firestore instance registered');
}

// _requireDb()
// Internal guard — throws if db.init() was never called.
function _requireDb() {
  if (!_db) {
    const err = {
      code:    'DB_NOT_INITIALISED',
      message: 'db.init() must be called before any db operation.',
      context: {},
    };
    console.error('[db._requireDb] Firestore not initialised', err);
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════════
// §2 COLLECTION PATH HELPERS
//
// MULTI-TENANCY DESIGN:
//   Root: businesses/{businessId}/
//   Everything else lives under this root.
//   businessId = owner's Firebase UID (set at first sign-in).
//
//   Global collections (not business-scoped):
//     users/{uid}         — user profiles and roles
//     businesses/{bid}    — business metadata
//
//   Business-scoped collections (all under businesses/{businessId}/):
//     products, variants, inventory_state, orders,
//     customers, suppliers, pending_submissions
//
//   Subcollections:
//     variants/{vid}/events/{eid}
//     orders/{oid}/items/{iid}
//
// Usage:
//   const p = paths(session.businessId);
//   await dbGet(p.products, productId);
//   await dbList(p.variants);
//   await dbListSub(p.variants, variantId, 'events');
// ════════════════════════════════════════════════════════════════════════

// Global collection names — not business-scoped
export const COL_USERS      = 'users';
export const COL_BUSINESSES = 'businesses';

// Subcollection name constants
export const SUBCOL_EVENTS      = 'events';
export const SUBCOL_ORDER_ITEMS = 'items';

// paths(businessId)
// Returns an object of all business-scoped collection paths.
// Always use this — never hardcode Firestore paths anywhere else.
//
// Example:
//   const p = paths(session.businessId);
//   const result = await dbGet(p.products, productId);
export function paths(businessId) {
  if (!businessId) {
    const err = {
      code:    'MISSING_BUSINESS_ID',
      message: 'paths() called without a businessId. All data must be business-scoped.',
      context: {},
    };
    console.error('[db.paths] missing businessId', err);
    throw err;
  }

  const root = `${COL_BUSINESSES}/${businessId}`;

  return {
    // Business root — read/write business metadata document
    root,

    // Core inventory
    products:       `${root}/products`,
    variants:       `${root}/variants`,
    inventoryState: `${root}/inventory_state`,

    // Orders and customers
    orders:         `${root}/orders`,
    customers:      `${root}/customers`,

    // Reference data
    suppliers:      `${root}/suppliers`,

    // Staff submission queue
    pending:        `${root}/pending_submissions`,

    // Subcollection path builders — call as functions with parent ID
    // Example: p.events('variant_abc') → full path string
    events:     (variantId) => `${root}/variants/${variantId}/events`,
    orderItems: (orderId)   => `${root}/orders/${orderId}/items`,
  };
}


// ════════════════════════════════════════════════════════════════════════
// §3 DOCUMENT HELPERS
// get, set, add, update, delete.
// All return structured results — never throw raw Firestore errors.
// ════════════════════════════════════════════════════════════════════════

// dbGet(collectionPath, docId)
// Fetch a single document by ID.
// Returns: { ok: true, data } | { ok: false, code, message }
// data always includes the Firestore doc id as data.id
export async function dbGet(collectionPath, docId) {
  _requireDb();
  console.log('[db.dbGet] called', { collectionPath, docId });
  try {
    const ref  = doc(_db, collectionPath, docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      console.log('[db.dbGet] not found', { collectionPath, docId });
      return { ok: false, code: 'NOT_FOUND', message: `Not found: ${collectionPath}/${docId}` };
    }
    const data = { id: snap.id, ...snap.data() };
    console.log('[db.dbGet] success', { collectionPath, docId });
    return { ok: true, data };
  } catch (e) {
    const err = { code: 'DB_GET_FAILED', message: e.message, context: { collectionPath, docId } };
    console.error('[db.dbGet] failed', err);
    throw err;
  }
}

// dbSet(collectionPath, docId, data)
// Create or overwrite a document at a known ID.
// Returns: { ok: true } | throws structured error
export async function dbSet(collectionPath, docId, data) {
  _requireDb();
  console.log('[db.dbSet] called', { collectionPath, docId });
  try {
    const ref = doc(_db, collectionPath, docId);
    await setDoc(ref, data);
    console.log('[db.dbSet] success', { collectionPath, docId });
    return { ok: true };
  } catch (e) {
    const err = { code: 'DB_SET_FAILED', message: e.message, context: { collectionPath, docId } };
    console.error('[db.dbSet] failed', err);
    throw err;
  }
}

// dbAdd(collectionPath, data)
// Add a new document with auto-generated ID.
// Returns: { ok: true, id } | throws structured error
export async function dbAdd(collectionPath, data) {
  _requireDb();
  console.log('[db.dbAdd] called', { collectionPath });
  try {
    const ref    = collection(_db, collectionPath);
    const result = await addDoc(ref, data);
    console.log('[db.dbAdd] success', { collectionPath, id: result.id });
    return { ok: true, id: result.id };
  } catch (e) {
    const err = { code: 'DB_ADD_FAILED', message: e.message, context: { collectionPath } };
    console.error('[db.dbAdd] failed', err);
    throw err;
  }
}

// dbUpdate(collectionPath, docId, fields)
// Partial update — only provided fields are changed.
// Returns: { ok: true } | throws structured error
export async function dbUpdate(collectionPath, docId, fields) {
  _requireDb();
  console.log('[db.dbUpdate] called', { collectionPath, docId, fields });
  try {
    const ref = doc(_db, collectionPath, docId);
    await updateDoc(ref, fields);
    console.log('[db.dbUpdate] success', { collectionPath, docId });
    return { ok: true };
  } catch (e) {
    const err = { code: 'DB_UPDATE_FAILED', message: e.message, context: { collectionPath, docId } };
    console.error('[db.dbUpdate] failed', err);
    throw err;
  }
}

// dbDelete(collectionPath, docId)
// Hard delete a document. Use sparingly — orders are never deleted per spec.
// Returns: { ok: true } | throws structured error
export async function dbDelete(collectionPath, docId) {
  _requireDb();
  console.log('[db.dbDelete] called', { collectionPath, docId });
  try {
    const ref = doc(_db, collectionPath, docId);
    await deleteDoc(ref);
    console.log('[db.dbDelete] success', { collectionPath, docId });
    return { ok: true };
  } catch (e) {
    const err = { code: 'DB_DELETE_FAILED', message: e.message, context: { collectionPath, docId } };
    console.error('[db.dbDelete] failed', err);
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 COLLECTION HELPERS
// List and query multiple documents.
// All results include doc.id merged into each data object.
// ════════════════════════════════════════════════════════════════════════

// dbList(collectionPath)
// Fetch all documents in a collection.
// Returns: { ok: true, data: [] } | throws structured error
export async function dbList(collectionPath) {
  _requireDb();
  console.log('[db.dbList] called', { collectionPath });
  try {
    const ref  = collection(_db, collectionPath);
    const snap = await getDocs(ref);
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[db.dbList] success', { collectionPath, count: data.length });
    return { ok: true, data };
  } catch (e) {
    const err = { code: 'DB_LIST_FAILED', message: e.message, context: { collectionPath } };
    console.error('[db.dbList] failed', err);
    throw err;
  }
}

// dbQuery(collectionPath, conditions, ordering, limitCount)
// Flexible query builder.
// conditions: [{ field, op, value }] — maps to Firestore where()
// ordering:   [{ field, direction }] — maps to Firestore orderBy()
// limitCount: number | null
// Returns: { ok: true, data: [] } | throws structured error
//
// Example:
//   dbQuery(p.variants, [{ field: 'product_id', op: '==', value: pid }])
export async function dbQuery(collectionPath, conditions = [], ordering = [], limitCount = null) {
  _requireDb();
  console.log('[db.dbQuery] called', { collectionPath, conditions, ordering, limitCount });
  try {
    const ref         = collection(_db, collectionPath);
    const constraints = [];

    for (const c of conditions) {
      constraints.push(where(c.field, c.op, c.value));
    }
    for (const o of ordering) {
      constraints.push(orderBy(o.field, o.direction || 'asc'));
    }
    if (limitCount !== null) {
      constraints.push(limit(limitCount));
    }

    const q    = query(ref, ...constraints);
    const snap = await getDocs(q);
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[db.dbQuery] success', { collectionPath, count: data.length });
    return { ok: true, data };
  } catch (e) {
    const err = { code: 'DB_QUERY_FAILED', message: e.message, context: { collectionPath, conditions } };
    console.error('[db.dbQuery] failed', err);
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 SUBCOLLECTION HELPERS
// For events (under variants) and order items (under orders).
// These live two levels deep: businesses/{bid}/variants/{vid}/events/{eid}
// ════════════════════════════════════════════════════════════════════════

// dbListSub(parentCollectionPath, parentId, subcollectionName)
// Fetch all documents from a subcollection.
// Example: dbListSub(p.variants, variantId, 'events')
// Returns: { ok: true, data: [] } | throws structured error
export async function dbListSub(parentCollectionPath, parentId, subcollectionName) {
  _requireDb();
  const fullPath = `${parentCollectionPath}/${parentId}/${subcollectionName}`;
  console.log('[db.dbListSub] called', { fullPath });
  try {
    const ref  = collection(_db, parentCollectionPath, parentId, subcollectionName);
    const snap = await getDocs(ref);
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[db.dbListSub] success', { fullPath, count: data.length });
    return { ok: true, data };
  } catch (e) {
    const err = { code: 'DB_LISTSUB_FAILED', message: e.message, context: { fullPath } };
    console.error('[db.dbListSub] failed', err);
    throw err;
  }
}

// dbAddSub(parentCollectionPath, parentId, subcollectionName, data)
// Add a document to a subcollection with auto-generated ID.
// Example: dbAddSub(p.variants, variantId, 'events', eventData)
// Returns: { ok: true, id } | throws structured error
export async function dbAddSub(parentCollectionPath, parentId, subcollectionName, data) {
  _requireDb();
  const fullPath = `${parentCollectionPath}/${parentId}/${subcollectionName}`;
  console.log('[db.dbAddSub] called', { fullPath });
  try {
    const ref    = collection(_db, parentCollectionPath, parentId, subcollectionName);
    const result = await addDoc(ref, data);
    console.log('[db.dbAddSub] success', { fullPath, id: result.id });
    return { ok: true, id: result.id };
  } catch (e) {
    const err = { code: 'DB_ADDSUB_FAILED', message: e.message, context: { fullPath } };
    console.error('[db.dbAddSub] failed', err);
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 TRANSACTION HELPER
// Wraps Firestore runTransaction with logging and structured errors.
// All stock mutations in inventory.js go through this.
//
// Switch note: when moving to Cloud Functions, inventory.js replaces
// its dbTransaction calls with fetch() calls to the function endpoint.
// This helper stays for other transactional operations.
// ════════════════════════════════════════════════════════════════════════

// dbTransaction(label, fn)
// label: string — used in logs to identify which transaction ran
// fn:    async (transaction) => result
//        Use transaction.get(ref) and transaction.set/update inside fn.
// Returns: whatever fn returns | throws structured error
export async function dbTransaction(label, fn) {
  _requireDb();
  console.log(`[db.dbTransaction:${label}] starting`);
  try {
    const result = await runTransaction(_db, fn);
    console.log(`[db.dbTransaction:${label}] committed`);
    return result;
  } catch (e) {
    const err = {
      code:    e.code    || 'TRANSACTION_FAILED',
      message: e.message || 'Transaction failed',
      context: { label },
    };
    console.error(`[db.dbTransaction:${label}] failed`, err);
    throw err;
  }
}

// dbDocRef(collectionPath, docId)
// Returns a raw Firestore DocumentReference.
// Only use inside dbTransaction fn callbacks — not for direct reads/writes.
export function dbDocRef(collectionPath, docId) {
  _requireDb();
  return doc(_db, collectionPath, docId);
}

// dbSubDocRef(parentCollectionPath, parentId, subcollectionName, docId)
// Returns a DocumentReference for a subcollection document.
// Use inside transaction callbacks only.
export function dbSubDocRef(parentCollectionPath, parentId, subcollectionName, docId) {
  _requireDb();
  return doc(_db, parentCollectionPath, parentId, subcollectionName, docId);
}

// dbNewSubDocRef(parentCollectionPath, parentId, subcollectionName)
// Returns a new auto-ID DocumentReference for a subcollection.
// Useful inside transactions where you need the ID before committing.
export function dbNewSubDocRef(parentCollectionPath, parentId, subcollectionName) {
  _requireDb();
  return doc(collection(_db, parentCollectionPath, parentId, subcollectionName));
}


// ════════════════════════════════════════════════════════════════════════
// §7 TIMESTAMP HELPERS
// Per spec: created_at = client ISO string, committed_at = server timestamp.
// ════════════════════════════════════════════════════════════════════════

// dbServerTimestamp() — use for committed_at fields
export function dbServerTimestamp() {
  return serverTimestamp();
}

// dbNow() — use for created_at fields (client time, ISO string)
export function dbNow() {
  return new Date().toISOString();
}

// dbTimestampToDate(timestamp) — convert Firestore Timestamp to JS Date
export function dbTimestampToDate(timestamp) {
  if (!timestamp) return null;
  if (timestamp instanceof Timestamp) return timestamp.toDate();
  if (timestamp instanceof Date) return timestamp;
  if (timestamp.seconds !== undefined) {
    return new Timestamp(timestamp.seconds, timestamp.nanoseconds || 0).toDate();
  }
  return null;
}
