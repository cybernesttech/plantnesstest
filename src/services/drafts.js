// ════════════════════════════════════════════════════════════════════════
// FILE: src/services/drafts.js
// PURPOSE: Staff draft stock submissions.
//          Drafts are saved to Firestore immediately — survive device switch,
//          app reinstall, browser clear. Deleted when submitted or discarded.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & PATH HELPER
// §2  SAVE DRAFT
// §3  LOAD DRAFT  (staff sees their own unsubmitted draft on app open)
// §4  DISCARD DRAFT
// §5  SUBMIT DRAFT → PENDING
// §6  LIST PENDING  (manager/owner)
// §7  APPROVE / REJECT PENDING
// ════════════════════════════════════════════════════════════════════════

import {
  dbAdd, dbGet, dbSet, dbUpdate, dbDelete, dbList, dbQuery,
  dbNow, paths,
} from '../db.js';
import {
  stockIn, stockOut, adjustStock,
  generateIdempotencyKey,
  SOURCE_MANUAL, SOURCE_AI, SOURCE_RECONCILIATION,
  ADJ_RECONCILIATION,
} from '../inventory.js';
import { loadCache } from './products.js';


// ════════════════════════════════════════════════════════════════════════
// §1 IMPORTS & PATH HELPER
// ════════════════════════════════════════════════════════════════════════

// draftsPath(businessId) — collection path for drafts
function draftsPath(businessId) {
  return `businesses/${businessId}/drafts`;
}

// pendingPath(businessId) — collection path for pending submissions
function pendingPath(businessId) {
  return `businesses/${businessId}/pending_submissions`;
}


// ════════════════════════════════════════════════════════════════════════
// §2 SAVE DRAFT
// Called when staff navigates away from preview or taps "Save Draft".
// If a draft already exists for this user, it is overwritten.
// Returns: { ok, draftId } | { error, message }
// ════════════════════════════════════════════════════════════════════════

// saveDraft(businessId, userId, { items, source, rawInput })
// items: [{ productId, variantId, productName, variantSize, quantity, direction, price, unit }]
// source: 'manual' | 'ai_scan'
// rawInput: original text or image description (for reference)
export async function saveDraft(businessId, userId, { items, source = 'manual', rawInput = '' }) {
  console.log('[drafts.saveDraft] called', { businessId, userId, itemCount: items.length });

  try {
    // Delete any existing draft for this user first (one draft per user)
    await _deleteExistingDraft(businessId, userId);

    const draftData = {
      created_by:  userId,
      created_at:  dbNow(),
      updated_at:  dbNow(),
      source,
      raw_input:   rawInput,
      status:      'draft',
      items:       items.map(i => ({
        product_id:   i.productId   || '',
        variant_id:   i.variantId   || '',
        product_name: i.productName || '',
        variant_size: i.variantSize || '',
        quantity:     Number(i.quantity) || 0,
        direction:    i.direction === 'out' ? 'out' : 'in',
        price:        Number(i.price || 0),
        unit:         i.unit || 'pcs',
      })),
    };

    const result = await dbAdd(draftsPath(businessId), draftData);
    console.log('[drafts.saveDraft] success', { draftId: result.id });
    return { ok: true, draftId: result.id };

  } catch(e) {
    console.error('[drafts.saveDraft] failed', e);
    return { error: true, message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §3 LOAD DRAFT
// Called on app open / scan screen open to check for unsubmitted draft.
// Returns: { ok, draft } | { ok: false } (no draft found)
// ════════════════════════════════════════════════════════════════════════

export async function loadDraft(businessId, userId) {
  console.log('[drafts.loadDraft] called', { businessId, userId });
  try {
    const result = await dbQuery(
      draftsPath(businessId),
      [
        { field: 'created_by', op: '==', value: userId },
        { field: 'status',     op: '==', value: 'draft' },
      ],
      [{ field: 'updated_at', direction: 'desc' }],
      1
    );

    if (result.ok && result.data.length > 0) {
      const draft = result.data[0];
      console.log('[drafts.loadDraft] found', { draftId: draft.id, itemCount: draft.items?.length });
      return { ok: true, draft };
    }

    console.log('[drafts.loadDraft] no draft found');
    return { ok: false };
  } catch(e) {
    console.warn('[drafts.loadDraft] failed (non-critical)', e?.message);
    return { ok: false };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 DISCARD DRAFT
// Staff explicitly discards — deleted from Firestore permanently.
// ════════════════════════════════════════════════════════════════════════

export async function discardDraft(businessId, draftId) {
  console.log('[drafts.discardDraft] called', { draftId });
  try {
    await dbDelete(draftsPath(businessId), draftId);
    console.log('[drafts.discardDraft] success');
    return { ok: true };
  } catch(e) {
    console.error('[drafts.discardDraft] failed', e);
    return { error: true, message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 SUBMIT DRAFT → PENDING
// Staff explicitly submits — draft is deleted, pending submission created.
// Returns: { ok, pendingId } | { error, message }
// ════════════════════════════════════════════════════════════════════════

// submitDraft(businessId, draftId, { userId, displayName, email, notes })
export async function submitDraft(businessId, draftId, {
  userId,
  displayName,
  email,
  notes = '',
}) {
  console.log('[drafts.submitDraft] called', { businessId, draftId });

  try {
    // Read draft
    const draftResult = await dbGet(draftsPath(businessId), draftId);
    if (!draftResult.ok) {
      return { error: true, message: 'Draft not found.' };
    }
    const draft = draftResult.data;

    // Create pending submission
    const pendingData = {
      submitted_by:       userId,
      submitted_by_name:  displayName,
      submitted_by_email: email,
      submitted_at:       dbNow(),
      source:             draft.source || 'manual',
      raw_input:          draft.raw_input || '',
      notes,
      status:             'pending',
      items:              draft.items || [],
    };

    const pendingResult = await dbAdd(pendingPath(businessId), pendingData);
    console.log('[drafts.submitDraft] pending created', { pendingId: pendingResult.id });

    // Delete the draft
    await dbDelete(draftsPath(businessId), draftId);
    console.log('[drafts.submitDraft] draft deleted');

    return { ok: true, pendingId: pendingResult.id };

  } catch(e) {
    console.error('[drafts.submitDraft] failed', e);
    return { error: true, message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 LIST PENDING  (manager/owner)
// ════════════════════════════════════════════════════════════════════════

// listPending(businessId)
// Returns all pending submissions, newest first.
export async function listPending(businessId) {
  console.log('[drafts.listPending] called', { businessId });
  try {
    // No ordering to avoid composite index requirement —
    // sort client-side after fetch instead.
    const result = await dbQuery(
      pendingPath(businessId),
      [{ field: 'status', op: '==', value: 'pending' }],
      [], // no server-side ordering
      200
    );
    if (!result.ok) return [];
    // Sort client-side: oldest first
    return result.data.sort((a, b) =>
      (a.submitted_at || '') > (b.submitted_at || '') ? 1 : -1
    );
  } catch(e) {
    console.error('[drafts.listPending] failed', e);
    return [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 APPROVE / REJECT PENDING
// ════════════════════════════════════════════════════════════════════════

// approvePending(businessId, pendingId, { reviewedBy })
// Applies all items: IN → stockIn, OUT → stockOut, reconciliation → adjustStock.
// Deletes the pending doc on success.
// Returns: { ok, applied, skipped } | { error, message }
export async function approvePending(businessId, pendingId, { reviewedBy = '' } = {}) {
  console.log('[drafts.approvePending] called', { pendingId });

  try {
    const result = await dbGet(pendingPath(businessId), pendingId);
    if (!result.ok) return { error: true, message: 'Pending submission not found.' };

    const submission = result.data;
    const items      = submission.items || [];
    const isRecon    = submission.source === 'reconciliation';
    let   applied    = 0;
    let   skipped    = 0;

    for (const item of items) {
      // ── Reconciliation items ─────────────────────────────────────────
      if (isRecon || item.direction === 'reconciliation') {
        if (!item.variant_id && !item.variantId) { skipped++; continue; }
        const idempotencyKey = generateIdempotencyKey('pending_recon');
        const r = await adjustStock({
          businessId,
          variantId:      item.variant_id || item.variantId,
          productId:      item.product_id || item.productId,
          actualQuantity: Number(item.quantity),
          reason:         `Reconciliation approved — submitted by ${submission.submitted_by_name || 'staff'}`,
          source:         SOURCE_RECONCILIATION,
          adjustmentType: ADJ_RECONCILIATION,
          idempotencyKey,
        });
        r.error ? skipped++ : applied++;
        continue;
      }

      // ── OUT items ────────────────────────────────────────────────────
      if (item.direction === 'out') {
        if (!item.variant_id) { skipped++; continue; }
        const idempotencyKey = generateIdempotencyKey('pending_out');
        // Scanner/manual OUT items have no reservation — use direct stockOut
        const r = await stockOut({
          businessId,
          variantId:  item.variant_id,
          productId:  item.product_id,
          quantity:   Number(item.quantity) || 0,
          reason:     `Approved OUT from ${submission.submitted_by_name || 'staff'}`,
          source:     submission.source === 'ai_scan' ? SOURCE_AI : SOURCE_MANUAL,
          idempotencyKey,
        });
        r.error ? skipped++ : applied++;
        continue;
      }

      // ── IN items (default) ───────────────────────────────────────────
      if (!item.variant_id) { skipped++; continue; }

      const idempotencyKey = generateIdempotencyKey('pending_approve');
      const stockResult = await stockIn({
        businessId,
        variantId:      item.variant_id,
        productId:      item.product_id,
        quantity:       Number(item.quantity) || 0,
        reason:         `Approved submission from ${submission.submitted_by_name || 'staff'}`,
        source:         submission.source === 'ai_scan' ? SOURCE_AI : SOURCE_MANUAL,
        idempotencyKey,
      });

      stockResult.error ? skipped++ : applied++;
    }

    // Delete pending doc
    await dbDelete(pendingPath(businessId), pendingId);

    // Refresh cache
    await loadCache(businessId);

    console.log('[drafts.approvePending] success', { applied, skipped });
    return { ok: true, applied, skipped };

  } catch(e) {
    console.error('[drafts.approvePending] failed', e);
    return { error: true, message: e.message };
  }
}

// rejectPending(businessId, pendingId)
// Deletes the pending doc — no stock changes.
export async function rejectPending(businessId, pendingId) {
  console.log('[drafts.rejectPending] called', { pendingId });
  try {
    await dbDelete(pendingPath(businessId), pendingId);
    return { ok: true };
  } catch(e) {
    console.error('[drafts.rejectPending] failed', e);
    return { error: true, message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ════════════════════════════════════════════════════════════════════════

// _deleteExistingDraft — removes any existing draft for this user
async function _deleteExistingDraft(businessId, userId) {
  try {
    const existing = await dbQuery(
      draftsPath(businessId),
      [{ field: 'created_by', op: '==', value: userId }],
      [], 5
    );
    if (existing.ok) {
      for (const d of existing.data) {
        await dbDelete(draftsPath(businessId), d.id);
      }
    }
  } catch(e) {
    console.warn('[drafts._deleteExistingDraft] non-critical:', e?.message);
  }
}
