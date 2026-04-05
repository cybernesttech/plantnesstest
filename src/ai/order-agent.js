// ════════════════════════════════════════════════════════════════════════
// FILE: src/ai/order-agent.js
// PURPOSE: AI Order Taker — parses WhatsApp/Instagram messages and
//          extracts customer info + order items using Groq AI.
//          Matches extracted items against the local product cache.
//          Ambiguous matches are flagged for the seller to resolve.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & CONSTANTS
// §2  API KEY LOADER  (reads from businesses/{bid}/settings/api_keys)
// §3  PROMPT BUILDER
// §4  GROQ API CALL
// §5  PRODUCT MATCHER  (matches AI output against local cache)
// §6  MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

import { dbGet, paths } from '../db.js';
import { searchProducts, getVariantsForProduct } from '../services/products.js';


// ════════════════════════════════════════════════════════════════════════
// §1 IMPORTS & CONSTANTS
// ════════════════════════════════════════════════════════════════════════

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';


// ════════════════════════════════════════════════════════════════════════
// §2 API KEY LOADER
// Reads Groq API key from Firestore: businesses/{bid}/settings/api_keys
// Readable by all business members (enforced by security rules).
// Never exposed in logs — only logged as masked value.
// ════════════════════════════════════════════════════════════════════════

// loadGroqKey(businessId)
// Returns: { ok, key } | { error, message }
export async function loadGroqKey(businessId) {
  console.log('[orderAgent.loadGroqKey] called', { businessId });
  try {
    const result = await dbGet(`businesses/${businessId}/settings`, 'api_keys');
    if (!result.ok || !result.data.groq_api_key) {
      console.warn('[orderAgent.loadGroqKey] no key found');
      return { error: true, code: 'NO_KEY', message: 'Groq API key not set. Ask the owner to add it in Settings.' };
    }
    const key = result.data.groq_api_key;
    console.log('[orderAgent.loadGroqKey] key loaded', { masked: key.slice(0, 7) + '••••••••' });
    return { ok: true, key };
  } catch(e) {
    console.error('[orderAgent.loadGroqKey] failed', e);
    return { error: true, code: 'LOAD_FAILED', message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §3 PROMPT BUILDER
// Builds the system prompt with all known products for matching.
// ════════════════════════════════════════════════════════════════════════

// _buildPrompt()
// Builds system prompt from local product cache.
// Called just before the Groq API call so the product list is fresh.
function _buildPrompt() {
  // Build compact product list from local cache
  const allProducts = searchProducts('');
  const productLines = allProducts.flatMap(product =>
    product.variants.map(v =>
      `${product.productId}|${product.name}|${v.variantId}|${v.size || 'default'}|₹${v.price}|${v.stockLabel}`
    )
  ).join('\n');

  return [
    'You are an order intake agent for a plant business.',
    'Extract the customer info and order items from the message below.',
    '',
    'CUSTOMER EXTRACTION:',
    '  - Extract name and phone number if present.',
    '  - Phone: include country code if visible.',
    '  - If no name found, use empty string.',
    '  - If no phone found, use empty string.',
    '',
    'PRODUCT MATCHING RULES:',
    '  - Match each ordered item to the exact productId AND variantId from the list below.',
    '  - If the customer names a product clearly and only one variant exists → match directly.',
    '  - If the customer names a product and multiple variants exist but they specified size → match the correct variant.',
    '  - If the customer names a product but multiple variants exist and no size specified → set matched: false, reason: "ambiguous_variant".',
    '  - If no product matches at all → set matched: false, reason: "not_found".',
    '  - NEVER guess or pick a variant when confused. Flag it for the seller.',
    '',
    'AVAILABLE PRODUCTS (productId|name|variantId|size|price|stock):',
    productLines || '(no products in inventory yet)',
    '',
    'REPLY WITH ONLY a raw JSON object — no markdown, no explanation:',
    '{',
    '  "customer": { "name": "", "phone": "" },',
    '  "items": [',
    '    {',
    '      "matched": true,',
    '      "productId": "",',
    '      "productName": "",',
    '      "variantId": "",',
    '      "variantSize": "",',
    '      "qty": 1,',
    '      "price": 0,',
    '      "rawText": "",',
    '      "reason": ""',
    '    }',
    '  ],',
    '  "notes": ""',
    '}',
    '',
    'matched: true = confident match found.',
    'matched: false = ambiguous or not found — reason explains why.',
    'rawText: the exact text from the message for this item.',
    'reason: "ambiguous_variant" | "not_found" | "" (empty if matched).',
  ].join('\n');
}


// ════════════════════════════════════════════════════════════════════════
// §4 GROQ API CALL
// ════════════════════════════════════════════════════════════════════════

// _callGroq(apiKey, message, source)
// Calls Groq API and returns parsed JSON result.
// source: 'whatsapp' | 'instagram' | 'manual'
// Returns: { ok, data } | { error, message }
async function _callGroq(apiKey, message, source) {
  console.log('[orderAgent._callGroq] called', { source, messageLength: message.length });

  const systemPrompt = _buildPrompt();

  try {
    const resp = await fetch(GROQ_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        max_tokens:  1000,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: `Source: ${source}\n\nMessage:\n${message}` },
        ],
      }),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg  = errData.error?.message || `Groq API error ${resp.status}`;
      console.error('[orderAgent._callGroq] API error', { status: resp.status, errMsg });
      return { error: true, code: 'API_ERROR', message: errMsg };
    }

    const data    = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse JSON — strip markdown fences, attempt light repair on failure
    const cleaned = content.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch(_) {
      // Light repair: trailing commas, single quotes, unquoted keys
      const fixed = cleaned
        .replace(/'/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
      try {
        parsed = JSON.parse(fixed);
      } catch(e2) {
        throw new Error('Could not parse AI response. Try rephrasing the message. Raw: ' + cleaned.slice(0, 100));
      }
    }

    console.log('[orderAgent._callGroq] success', {
      customerName: parsed.customer?.name,
      itemCount:    parsed.items?.length,
    });
    return { ok: true, data: parsed };

  } catch(e) {
    console.error('[orderAgent._callGroq] failed', e);
    return { error: true, code: 'PARSE_FAILED', message: 'Could not parse AI response: ' + e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §5 PRODUCT MATCHER
// Validates AI matches against local cache and enriches with live stock.
// ════════════════════════════════════════════════════════════════════════

// _matchItems(aiItems)
// Takes the AI's item list and validates/enriches each one.
// For ambiguous items: attaches variant options for the seller to pick.
//
// Returns enriched items:
// [{
//   matched:       boolean
//   productId, productName, variantId, variantSize
//   qty, price
//   rawText       ← the original text from the message
//   reason        ← 'ambiguous_variant' | 'not_found' | ''
//   variantOptions ← [{variantId, size, price, stockLabel}] when ambiguous
//   available     ← live available qty from cache
// }]
function _matchItems(aiItems) {
  return (aiItems || []).map(item => {
    // Case 1: AI says not matched — return as-is with options if ambiguous
    if (!item.matched) {
      if (item.reason === 'ambiguous_variant' && item.productId) {
        // Get all variants for this product so seller can pick
        const variants = getVariantsForProduct(item.productId);
        return {
          ...item,
          variantOptions: variants.map(v => ({
            variantId:  v.variantId,
            size:       v.size,
            price:      v.price,
            stockLabel: v.stockLabel,
            available:  v.available,
          })),
        };
      }
      return { ...item, variantOptions: [] };
    }

    // Case 2: AI says matched — validate against cache
    const allProducts = searchProducts('');
    const product     = allProducts.find(p => p.productId === item.productId);
    if (!product) {
      // Product no longer in cache (deleted/archived)
      return { ...item, matched: false, reason: 'not_found', variantOptions: [] };
    }

    const variant = product.variants.find(v => v.variantId === item.variantId);
    if (!variant) {
      // Variant not found — flag as ambiguous so seller can pick
      return {
        ...item,
        matched:        false,
        reason:         'ambiguous_variant',
        variantOptions: product.variants.map(v => ({
          variantId:  v.variantId,
          size:       v.size,
          price:      v.price,
          stockLabel: v.stockLabel,
          available:  v.available,
        })),
      };
    }

    // Valid match — enrich with live stock from cache
    return {
      ...item,
      productName:    product.name,
      variantSize:    variant.size,
      price:          variant.price,
      available:      variant.available,
      isOutOfStock:   variant.isOutOfStock,
      isLowStock:     variant.isLowStock,
      isLowConfidence: variant.isLowConfidence,
      stockLabel:     variant.stockLabel,
      variantOptions: [],
    };
  });
}


// ════════════════════════════════════════════════════════════════════════
// §6 MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

// analyseMessage(businessId, message, source)
// Main entry point — called when seller taps "Analyse" in AI order taker.
//
// Returns:
// {
//   ok: true,
//   customer: { name, phone },
//   items: [...enriched items],
//   notes: string,
//   hasAmbiguous: boolean,  ← true if any item needs seller resolution
//   hasUnmatched: boolean,  ← true if any item not found in inventory
// }
// | { error, code, message }
export async function analyseMessage(businessId, message, source = 'whatsapp') {
  console.log('[orderAgent.analyseMessage] called', { businessId, source, messageLength: message?.length });

  if (!message?.trim()) {
    return { error: true, code: 'EMPTY_MESSAGE', message: 'Paste a message first.' };
  }

  // Load API key
  const keyResult = await loadGroqKey(businessId);
  if (keyResult.error) return keyResult;

  // Call Groq
  const aiResult = await _callGroq(keyResult.key, message, source);
  if (aiResult.error) return aiResult;

  // Match items against local cache
  const enrichedItems = _matchItems(aiResult.data.items);
  const hasAmbiguous  = enrichedItems.some(i => !i.matched && i.reason === 'ambiguous_variant');
  const hasUnmatched  = enrichedItems.some(i => !i.matched && i.reason === 'not_found');

  console.log('[orderAgent.analyseMessage] complete', {
    customer:     aiResult.data.customer?.name,
    itemCount:    enrichedItems.length,
    hasAmbiguous,
    hasUnmatched,
  });

  return {
    ok:           true,
    customer:     aiResult.data.customer || { name: '', phone: '' },
    items:        enrichedItems,
    notes:        aiResult.data.notes   || '',
    hasAmbiguous,
    hasUnmatched,
  };
}
