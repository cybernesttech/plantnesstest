// ════════════════════════════════════════════════════════════════════════
// FILE: src/auth.js
// PURPOSE: Google Sign-In, Firebase Auth session management,
//          role resolution, and business context setup.
//
//          MULTI-TENANCY:
//          On first sign-in, owner gets a business document created at
//          businesses/{uid}. businessId = owner's Firebase UID.
//          All subsequent data reads/writes use session.businessId.
//          Staff and managers resolve their businessId from the
//          team_members subcollection they were added to.
//
//          WHITELIST ENFORCEMENT:
//          - New owners must be whitelisted in whitelist/allowed
//          - Staff/managers must be added to a business team_members list
//          - On every sign-in, owner's whitelist status is re-checked
//          - If owner is removed from whitelist, ALL members of that
//            business are denied access. Data is never deleted.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & CONSTANTS
// §2  AUTH STATE
// §3  SIGN IN / SIGN OUT
// §4  BUSINESS SETUP
// §5  ROLE & BUSINESS RESOLUTION
// §6  SESSION HELPERS
// §7  AUTH CHANGE LISTENER
// ════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════
// §1 IMPORTS & CONSTANTS
// ════════════════════════════════════════════════════════════════════════

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import {
  collectionGroup,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import {
  dbGet,
  dbSet,
  dbUpdate,
  dbNow,
  COL_USERS,
  COL_BUSINESSES,
} from './db.js';

// ── Role constants ────────────────────────────────────────────────────
export const ROLE_OWNER   = 'owner';
export const ROLE_MANAGER = 'manager';
export const ROLE_STAFF   = 'staff';

const ROLE_LEVEL = { staff: 1, manager: 2, owner: 3 };

// ── Session storage key ───────────────────────────────────────────────
const SESSION_KEY = 'plantness_session_v2';

// ── Boss email — this account manages the whitelist ───────────────────
export const BOSS_EMAIL = 'konami.pes.0813@gmail.com';

// ── Auth + DB instances ───────────────────────────────────────────────
let _auth = null;
let _db   = null; // raw Firestore instance — set by initDb()


// ════════════════════════════════════════════════════════════════════════
// §2 AUTH STATE
// ════════════════════════════════════════════════════════════════════════

let _session = null;
const _onSessionChangeCallbacks = [];


// ════════════════════════════════════════════════════════════════════════
// §3 SIGN IN / SIGN OUT
// ════════════════════════════════════════════════════════════════════════

// init(authInstance)
export function init(authInstance) {
  _auth = authInstance;
  console.log('[auth.init] Auth instance registered');
  _startAuthListener();
}

// initDb(dbInstance) — called from index.html after Firestore is ready
// Needed so auth.js can do collection group queries for team_members lookup
export function initDb(dbInstance) {
  _db = dbInstance;
  console.log('[auth.initDb] Firestore instance registered');
}

export async function signIn() {
  console.log('[auth.signIn] called');
  if (!_auth) {
    return { error: true, code: 'AUTH_NOT_INITIALISED', message: 'auth.init() must be called first.' };
  }
  try {
    const provider = new GoogleAuthProvider();
    const result   = await signInWithPopup(_auth, provider);
    console.log('[auth.signIn] popup success', { uid: result.user.uid, email: result.user.email });
    return { ok: true };
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user') {
      return { error: true, code: 'POPUP_CLOSED', message: 'Sign-in cancelled.' };
    }
    return { error: true, code: e.code || 'SIGN_IN_FAILED', message: e.message };
  }
}

export async function signOut() {
  console.log('[auth.signOut] called');
  try {
    await fbSignOut(_auth);
    _clearSession();
    return { ok: true };
  } catch (e) {
    return { error: true, code: e.code || 'SIGN_OUT_FAILED', message: e.message };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 BUSINESS SETUP
// ════════════════════════════════════════════════════════════════════════

async function _createBusiness(uid, ownerEmail, ownerDisplayName) {
  console.log('[auth._createBusiness] called', { uid, ownerEmail });
  const businessName = ownerDisplayName || ownerEmail;
  const businessData = {
    business_id:   uid,
    owner_uid:     uid,
    owner_email:   ownerEmail,
    business_name: businessName,
    created_at:    dbNow(),
    plan:          'free',
  };
  await dbSet(COL_BUSINESSES, uid, businessData);
  console.log('[auth._createBusiness] business created', { uid, businessName });
  return { businessId: uid, businessName };
}


// ════════════════════════════════════════════════════════════════════════
// §5 ROLE & BUSINESS RESOLUTION
//
// Resolution flow:
//
//   A) EXISTING USER (users/{uid} doc exists):
//      1. Load their user doc → get role + businessId
//      2. Check owner of their business is still whitelisted
//      3. If owner removed from whitelist → block ALL members of that business
//      4. Otherwise → return session normally
//
//   B) NEW USER (no users/{uid} doc):
//      1. Search all team_members collection group for this email
//      2. If found as staff/manager in a business:
//         a. Check owner of that business is still whitelisted
//         b. Create users/{uid} doc linked to that businessId
//         c. Update team_members record with uid + display_name
//         d. Return session as staff/manager role
//      3. If NOT found in any team_members:
//         a. Check whitelist — only whitelisted emails can create a business
//         b. Boss email always allowed regardless of whitelist
//         c. If not whitelisted → block with message
//         d. If whitelisted → create business + user doc as owner
//            Also add owner to their own team_members list
//
// ════════════════════════════════════════════════════════════════════════

async function _resolveRoleAndBusiness(firebaseUser) {
  const { uid, email, displayName, photoURL } = firebaseUser;
  console.log('[auth._resolveRoleAndBusiness] called', { uid, email });

  // ── A) EXISTING USER ──────────────────────────────────────────────────
  const userResult = await dbGet(COL_USERS, uid);

  if (userResult.ok) {
    const userData   = userResult.data;
    const businessId = userData.business_id || uid;
    const role       = userData.role || ROLE_STAFF;

    console.log('[auth._resolveRoleAndBusiness] existing user', { uid, role, businessId });

    // Re-check owner whitelist on every sign-in
    if (email.toLowerCase() !== BOSS_EMAIL.toLowerCase()) {
      const blockMessage = await _isOwnerBlocked(businessId, email, role);
      if (blockMessage) {
        await fbSignOut(_auth);
        throw { code: 'OWNER_NOT_WHITELISTED', message: blockMessage };
      }
    }

    return {
      uid,
      email,
      displayName:  displayName || email,
      photoURL:     photoURL    || null,
      role,
      businessId,
      businessName: userData.business_name || '',
    };
  }

  // ── B) NEW USER ───────────────────────────────────────────────────────
  console.log('[auth._resolveRoleAndBusiness] new user — searching team_members', { email });

  // B1: Search all businesses' team_members for this email
  const teamMemberRecord = await _findTeamMemberByEmail(email);

  if (teamMemberRecord) {
    const { businessId, role, memberId } = teamMemberRecord;
    console.log('[auth._resolveRoleAndBusiness] found in team_members', { businessId, role });

    // Check owner of that business is still whitelisted
    if (email.toLowerCase() !== BOSS_EMAIL.toLowerCase()) {
      const blockMessage = await _isOwnerBlocked(businessId, email, role);
      if (blockMessage) {
        await fbSignOut(_auth);
        throw { code: 'OWNER_NOT_WHITELISTED', message: blockMessage };
      }
    }

    // Load business name
    let businessName = '';
    try {
      const bizResult = await dbGet(COL_BUSINESSES, businessId);
      businessName = bizResult.ok ? (bizResult.data.business_name || '') : '';
    } catch(e) {}

    // Create users/{uid} doc linked to this business
    const newUserData = {
      uid,
      email,
      display_name:  displayName || email,
      photo_url:     photoURL    || null,
      role,
      business_id:   businessId,
      business_name: businessName,
      created_at:    dbNow(),
      last_sign_in:  dbNow(),
    };
    await dbSet(COL_USERS, uid, newUserData);

    // Update team_members record with uid and display_name
    try {
      await dbUpdate(
        `businesses/${businessId}/team_members`,
        memberId,
        { uid, display_name: displayName || email, status: 'active', updated_at: dbNow() }
      );
    } catch(e) {
      console.warn('[auth._resolveRoleAndBusiness] team_members update non-critical', e?.message);
    }

    console.log('[auth._resolveRoleAndBusiness] staff/manager linked', { uid, businessId, role });

    return { uid, email, displayName: displayName || email, photoURL: photoURL || null, role, businessId, businessName };
  }

  // B2: Not in any team — check whitelist to allow new business creation
  console.log('[auth._resolveRoleAndBusiness] not in team_members — checking whitelist', { email });

  if (email.toLowerCase() !== BOSS_EMAIL.toLowerCase()) {
    const isWhitelisted = await _checkWhitelist(email);
    if (!isWhitelisted) {
      await fbSignOut(_auth);
      throw {
        code:    'NOT_WHITELISTED',
        message: `Access denied. Your email (${email}) is not authorised to create a business on Plantness. Please contact the administrator.`,
      };
    }
  }

  // Whitelisted — create new business + owner user doc
  console.log('[auth._resolveRoleAndBusiness] whitelisted — creating owner', { uid, email });

  const { businessId, businessName } = await _createBusiness(uid, email, displayName || email);

  const newUserData = {
    uid,
    email,
    display_name:  displayName || email,
    photo_url:     photoURL    || null,
    role:          ROLE_OWNER,
    business_id:   businessId,
    business_name: businessName,
    created_at:    dbNow(),
    last_sign_in:  dbNow(),
  };
  await dbSet(COL_USERS, uid, newUserData);

  // Add owner to their own team_members so they appear in the team list
  try {
    await dbSet(`businesses/${businessId}/team_members`, uid, {
      uid,
      email,
      display_name: displayName || email,
      role:         ROLE_OWNER,
      status:       'active',
      added_by:     uid,
      created_at:   dbNow(),
      updated_at:   dbNow(),
    });
  } catch(e) {
    console.warn('[auth._resolveRoleAndBusiness] owner team_members entry non-critical', e?.message);
  }

  console.log('[auth._resolveRoleAndBusiness] owner created', { uid, businessId });

  return { uid, email, displayName: displayName || email, photoURL: photoURL || null, role: ROLE_OWNER, businessId, businessName };
}


// ════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ════════════════════════════════════════════════════════════════════════

// _checkWhitelist(email)
// Returns true if email is in whitelist/allowed doc
async function _checkWhitelist(email) {
  try {
    const result = await dbGet('whitelist', 'allowed');
    if (!result.ok) return false;
    const emails = (result.data.emails || []).map(e => e.toLowerCase());
    return emails.includes(email.toLowerCase());
  } catch(e) {
    console.warn('[auth._checkWhitelist] failed', e?.message);
    return false;
  }
}

// _findTeamMemberByEmail(email)
// Uses Firestore collection group query on 'team_members' across all businesses.
// Returns { businessId, role, memberId } or null.
async function _findTeamMemberByEmail(email) {
  if (!_db) {
    console.warn('[auth._findTeamMemberByEmail] no db instance');
    return null;
  }
  try {
    const q    = query(collectionGroup(_db, 'team_members'), where('email', '==', email.toLowerCase()));
    const snap = await getDocs(q);

    if (snap.empty) {
      console.log('[auth._findTeamMemberByEmail] not found', { email });
      return null;
    }

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (data.status === 'removed') continue;

      // Path: businesses/{businessId}/team_members/{memberId}
      const pathParts  = docSnap.ref.path.split('/');
      const businessId = pathParts[1];
      const memberId   = docSnap.id;
      const role       = data.role || ROLE_STAFF;

      console.log('[auth._findTeamMemberByEmail] found', { email, businessId, role });
      return { businessId, role, memberId };
    }

    return null;
  } catch(e) {
    console.error('[auth._findTeamMemberByEmail] failed', e?.message);
    return null;
  }
}

// _isOwnerBlocked(businessId, memberEmail, memberRole)
// Checks if the owner of the business is still whitelisted.
// Returns an error message string if blocked, null if OK.
async function _isOwnerBlocked(businessId, memberEmail, memberRole) {
  try {
    const bizResult = await dbGet(COL_BUSINESSES, businessId);
    if (!bizResult.ok) return null; // can't determine — allow through

    const ownerEmail = (bizResult.data.owner_email || '').toLowerCase();

    // Boss is never blocked
    if (ownerEmail === BOSS_EMAIL.toLowerCase()) return null;

    // For owner role — check their own email
    // For staff/manager — check their owner's email
    const emailToCheck = memberRole === ROLE_OWNER ? memberEmail.toLowerCase() : ownerEmail;

    const isWhitelisted = await _checkWhitelist(emailToCheck);
    if (!isWhitelisted) {
      if (memberRole === ROLE_OWNER) {
        return `Access denied. Your account (${memberEmail}) has been removed from the authorised list. Contact the administrator.`;
      } else {
        return `Access denied. The business owner's account has been deactivated. Contact the administrator.`;
      }
    }

    return null; // not blocked
  } catch(e) {
    console.warn('[auth._isOwnerBlocked] check failed — allowing through', e?.message);
    return null;
  }
}


// ════════════════════════════════════════════════════════════════════════
// §6 SESSION HELPERS
// ════════════════════════════════════════════════════════════════════════

export function getSession()    { return _session; }
export function getRole()       { return _session ? _session.role : null; }
export function getBusinessId() { return _session ? _session.businessId : null; }

export function hasRole(requiredRole) {
  if (!_session) return false;
  return (ROLE_LEVEL[_session.role] || 0) >= (ROLE_LEVEL[requiredRole] || 0);
}

export const isOwner   = () => hasRole(ROLE_OWNER);
export const isManager = () => hasRole(ROLE_MANAGER);
export const isStaff   = () => !!_session;

function _saveSession(sessionData) {
  _session = sessionData;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    console.log('[auth._saveSession] saved', { uid: sessionData.uid, role: sessionData.role, businessId: sessionData.businessId });
  } catch (e) {
    console.warn('[auth._saveSession] localStorage unavailable');
  }
}

function _loadSessionFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    console.log('[auth._loadSessionFromStorage] restored', { uid: data.uid, role: data.role, businessId: data.businessId });
    return data;
  } catch (e) {
    return null;
  }
}

function _clearSession() {
  _session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
  console.log('[auth._clearSession] session cleared');
}


// ════════════════════════════════════════════════════════════════════════
// §7 AUTH CHANGE LISTENER
// ════════════════════════════════════════════════════════════════════════

export function onSessionChange(callback) {
  _onSessionChangeCallbacks.push(callback);
  console.log('[auth.onSessionChange] listener registered', { total: _onSessionChangeCallbacks.length });
}

function _notifyListeners(session) {
  console.log('[auth._notifyListeners] firing', { listenerCount: _onSessionChangeCallbacks.length, hasSession: !!session });
  for (const cb of _onSessionChangeCallbacks) {
    try { cb(session); }
    catch (e) { console.error('[auth._notifyListeners] callback threw', e); }
  }
}

function _startAuthListener() {
  console.log('[auth._startAuthListener] starting');

  const storedSession = _loadSessionFromStorage();
  if (storedSession) {
    _session = storedSession;
    console.log('[auth._startAuthListener] optimistic session restored', {
      uid: storedSession.uid, businessId: storedSession.businessId,
    });
  }

  onAuthStateChanged(_auth, async (firebaseUser) => {
    console.log('[auth._startAuthListener] state changed', {
      signedIn: !!firebaseUser, uid: firebaseUser?.uid,
    });

    if (firebaseUser) {
      try {
        const session = await _resolveRoleAndBusiness(firebaseUser);

        // Update last_sign_in — non-blocking, non-critical
        dbUpdate(COL_USERS, firebaseUser.uid, {
          last_sign_in: dbNow(),
        }).catch(e => console.warn('[auth] last_sign_in update failed:', e?.message));

        _saveSession(session);
        _notifyListeners(session);

      } catch (e) {
        console.error('[auth._startAuthListener] resolution failed', e);

        // Whitelist blocked or owner deactivated
        if (e.code === 'NOT_WHITELISTED' || e.code === 'OWNER_NOT_WHITELISTED') {
          _clearSession();
          _notifyListeners({ blocked: true, message: e.message });
          return;
        }

        // Unexpected error — fallback session as staff
        const fallbackSession = {
          uid:          firebaseUser.uid,
          email:        firebaseUser.email,
          displayName:  firebaseUser.displayName || firebaseUser.email,
          photoURL:     firebaseUser.photoURL    || null,
          role:         ROLE_STAFF,
          businessId:   firebaseUser.uid,
          businessName: '',
        };
        _saveSession(fallbackSession);
        _notifyListeners(fallbackSession);
      }

    } else {
      _clearSession();
      _notifyListeners(null);
    }
  });
}
