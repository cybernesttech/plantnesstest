// ════════════════════════════════════════════════════════════════════════
// FILE: src/auth.js
// PURPOSE: Google Sign-In, Firebase Auth session management,
//          role resolution, and business context setup.
//
//          MULTI-TENANCY:
//          On first sign-in, owner gets a business document created at
//          businesses/{uid}. businessId = owner's Firebase UID.
//          All subsequent data reads/writes use session.businessId.
//          Staff and managers resolve their businessId from the owner's
//          business document stored on their user profile.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS & CONSTANTS
// §2  AUTH STATE
// §3  SIGN IN / SIGN OUT
// §4  BUSINESS SETUP  (first-time owner flow)
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
  dbGet,
  dbSet,
  dbUpdate,
  dbNow,
  COL_USERS,
  COL_BUSINESSES,
} from './db.js';

// ── Role constants ────────────────────────────────────────────────────
// These must match what is stored in Firestore users/{uid}.role
export const ROLE_OWNER   = 'owner';
export const ROLE_MANAGER = 'manager';
export const ROLE_STAFF   = 'staff';

// ── Role hierarchy values (for comparison) ────────────────────────────
const ROLE_LEVEL = { staff: 1, manager: 2, owner: 3 };

// ── Session storage key ───────────────────────────────────────────────
const SESSION_KEY = 'plantness_session_v2';

// ── Boss email — only this account can manage the whitelist ───────────
export const BOSS_EMAIL = 'konami.pes.0813@gmail.com';

// ── Auth instance ─────────────────────────────────────────────────────
let _auth = null;


// ════════════════════════════════════════════════════════════════════════
// §2 AUTH STATE
// Runtime state — only mutated by functions in this file.
// Read everywhere via getSession().
// ════════════════════════════════════════════════════════════════════════

// _session shape:
// {
//   uid:          string  — Firebase UID
//   email:        string
//   displayName:  string
//   photoURL:     string | null
//   role:         'owner' | 'manager' | 'staff'
//   businessId:   string  — owner's Firebase UID (all data scoped to this)
//   businessName: string  — display name of the business
// }
let _session = null;

// Registered callbacks — called whenever auth state changes
const _onSessionChangeCallbacks = [];


// ════════════════════════════════════════════════════════════════════════
// §3 SIGN IN / SIGN OUT
// ════════════════════════════════════════════════════════════════════════

// init(authInstance)
// Must be called once from index.html §7 after Firebase is initialised.
export function init(authInstance) {
  _auth = authInstance;
  console.log('[auth.init] Auth instance registered');
  _startAuthListener();
}

// signIn()
// Opens Google Sign-In popup.
// Returns: { ok } | { error, code, message }
export async function signIn() {
  console.log('[auth.signIn] called');
  if (!_auth) {
    const err = { code: 'AUTH_NOT_INITIALISED', message: 'auth.init() must be called first.' };
    console.error('[auth.signIn] not initialised', err);
    return { error: true, ...err };
  }
  try {
    const provider = new GoogleAuthProvider();
    const result   = await signInWithPopup(_auth, provider);
    console.log('[auth.signIn] popup success', { uid: result.user.uid, email: result.user.email });
    return { ok: true };
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user') {
      console.log('[auth.signIn] popup closed by user');
      return { error: true, code: 'POPUP_CLOSED', message: 'Sign-in cancelled.' };
    }
    const err = { code: e.code || 'SIGN_IN_FAILED', message: e.message };
    console.error('[auth.signIn] failed', err);
    return { error: true, ...err };
  }
}

// signOut()
// Signs out and clears session.
// Returns: { ok } | { error, code, message }
export async function signOut() {
  console.log('[auth.signOut] called');
  try {
    await fbSignOut(_auth);
    _clearSession();
    console.log('[auth.signOut] success');
    return { ok: true };
  } catch (e) {
    const err = { code: e.code || 'SIGN_OUT_FAILED', message: e.message };
    console.error('[auth.signOut] failed', err);
    return { error: true, ...err };
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 BUSINESS SETUP
// Called on first sign-in for a new owner.
// Creates the business document at businesses/{uid}.
// businessId = owner's UID — this is the root for all their data.
// ════════════════════════════════════════════════════════════════════════

// _createBusiness(uid, ownerEmail, ownerDisplayName)
// Internal — called by _resolveRoleAndBusiness when no business doc exists.
// Returns: { businessId, businessName }
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
// Reads the user's role and businessId from Firestore.
// Called once after sign-in, result cached in _session.
//
// Resolution flow:
//   1. Read users/{uid} document
//   2. If not found → first sign-in → create user + business documents
//   3. If found → read role and businessId from user document
//   4. businessId is always stored on the user document
//      (owner's businessId = their own UID)
//      (staff/manager's businessId = their owner's UID)
// ════════════════════════════════════════════════════════════════════════

// _resolveRoleAndBusiness(firebaseUser)
// Internal — called by _startAuthListener after sign-in.
// Returns full session object.
async function _resolveRoleAndBusiness(firebaseUser) {
  const { uid, email, displayName, photoURL } = firebaseUser;
  console.log('[auth._resolveRoleAndBusiness] called', { uid, email });

  // ── Read existing user document ───────────────────────────────────────
  const userResult = await dbGet(COL_USERS, uid);

  if (userResult.ok) {
    const userData = userResult.data;
    console.log('[auth._resolveRoleAndBusiness] existing user found', {
      uid,
      role:       userData.role,
      businessId: userData.business_id,
    });

    return {
      uid,
      email,
      displayName:  displayName || email,
      photoURL:     photoURL    || null,
      role:         userData.role        || ROLE_STAFF,
      businessId:   userData.business_id || uid,
      businessName: userData.business_name || '',
    };
  }

  // ── First sign-in — check whitelist before creating business ─────────
  // Only whitelisted emails (or the boss) can create a new business.
  // Staff are added by owners via Team Management — they already have
  // a user document created for them before they first sign in.
  console.log('[auth._resolveRoleAndBusiness] first sign-in — checking whitelist', { uid, email });

  // Boss email is always allowed
  if (email !== BOSS_EMAIL) {
    try {
      const whitelistResult = await dbGet('whitelist', 'allowed');
      const allowedEmails   = whitelistResult.ok ? (whitelistResult.data.emails || []) : [];
      const isAllowed       = allowedEmails.map(e => e.toLowerCase()).includes(email.toLowerCase());
      if (!isAllowed) {
        console.warn('[auth._resolveRoleAndBusiness] email not whitelisted — blocking', { email });
        await fbSignOut(_auth);
        throw {
          code:    'NOT_WHITELISTED',
          message: `Access denied. Your email (${email}) is not authorised to create a business on Plantness. Please contact the administrator.`,
        };
      }
    } catch(e) {
      if (e.code === 'NOT_WHITELISTED') throw e;
      // If whitelist doc doesn't exist yet, only boss can proceed
      console.warn('[auth._resolveRoleAndBusiness] whitelist check failed', e?.message);
      await fbSignOut(_auth);
      throw {
        code:    'NOT_WHITELISTED',
        message: `Access denied. No whitelist found. Contact the administrator to get access.`,
      };
    }
  }

  console.log('[auth._resolveRoleAndBusiness] whitelist check passed — creating owner', { uid, email });

  // Create the business
  const { businessId, businessName } = await _createBusiness(uid, email, displayName || email);

  // Create the user document
  const newUserData = {
    uid,
    email,
    display_name:  displayName || email,
    photo_url:     photoURL    || null,
    role:          ROLE_OWNER,   // first sign-in = owner of their own business
    business_id:   businessId,   // = their own UID
    business_name: businessName,
    created_at:    dbNow(),
    last_sign_in:  dbNow(),
  };

  await dbSet(COL_USERS, uid, newUserData);
  console.log('[auth._resolveRoleAndBusiness] owner created', { uid, businessId });

  return {
    uid,
    email,
    displayName:  displayName || email,
    photoURL:     photoURL    || null,
    role:         ROLE_OWNER,
    businessId,
    businessName,
  };
}


// ════════════════════════════════════════════════════════════════════════
// §6 SESSION HELPERS
// ════════════════════════════════════════════════════════════════════════

// getSession()
// Returns the current session or null if not signed in.
// Use this everywhere instead of accessing _session directly.
export function getSession() {
  return _session;
}

// getRole() — returns current role string or null
export function getRole() {
  return _session ? _session.role : null;
}

// getBusinessId() — returns current businessId or null
// Use this whenever constructing Firestore paths.
export function getBusinessId() {
  return _session ? _session.businessId : null;
}

// hasRole(requiredRole) — checks if current user meets or exceeds required role
export function hasRole(requiredRole) {
  if (!_session) return false;
  return (ROLE_LEVEL[_session.role] || 0) >= (ROLE_LEVEL[requiredRole] || 0);
}

// Convenience role checks
export const isOwner   = () => hasRole(ROLE_OWNER);
export const isManager = () => hasRole(ROLE_MANAGER);
export const isStaff   = () => !!_session;

// _saveSession(sessionData)
function _saveSession(sessionData) {
  _session = sessionData;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    console.log('[auth._saveSession] saved', {
      uid:        sessionData.uid,
      role:       sessionData.role,
      businessId: sessionData.businessId,
    });
  } catch (e) {
    console.warn('[auth._saveSession] localStorage unavailable — session in memory only');
  }
}

// _loadSessionFromStorage()
function _loadSessionFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    console.log('[auth._loadSessionFromStorage] restored', {
      uid:        data.uid,
      role:       data.role,
      businessId: data.businessId,
    });
    return data;
  } catch (e) {
    console.warn('[auth._loadSessionFromStorage] failed to parse stored session');
    return null;
  }
}

// _clearSession()
function _clearSession() {
  _session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
    console.log('[auth._clearSession] session cleared');
  } catch (e) {
    console.warn('[auth._clearSession] localStorage unavailable');
  }
}


// ════════════════════════════════════════════════════════════════════════
// §7 AUTH CHANGE LISTENER
// Watches Firebase Auth state. Resolves role + businessId on sign-in.
// ════════════════════════════════════════════════════════════════════════

// onSessionChange(callback)
// Register a callback called whenever auth state changes.
// callback(session) — session is null on sign-out.
export function onSessionChange(callback) {
  _onSessionChangeCallbacks.push(callback);
  console.log('[auth.onSessionChange] listener registered', {
    total: _onSessionChangeCallbacks.length,
  });
}

// _notifyListeners(session)
function _notifyListeners(session) {
  console.log('[auth._notifyListeners] firing', {
    listenerCount: _onSessionChangeCallbacks.length,
    hasSession:    !!session,
  });
  for (const cb of _onSessionChangeCallbacks) {
    try { cb(session); }
    catch (e) { console.error('[auth._notifyListeners] callback threw', e); }
  }
}

// _startAuthListener()
// Called once from init(). Listens to Firebase Auth.
function _startAuthListener() {
  console.log('[auth._startAuthListener] starting');

  // Optimistically restore session from storage while Firebase confirms
  const storedSession = _loadSessionFromStorage();
  if (storedSession) {
    _session = storedSession;
    console.log('[auth._startAuthListener] optimistic session restored', {
      uid:        storedSession.uid,
      businessId: storedSession.businessId,
    });
  }

  onAuthStateChanged(_auth, async (firebaseUser) => {
    console.log('[auth._startAuthListener] state changed', {
      signedIn: !!firebaseUser,
      uid:      firebaseUser?.uid,
    });

    if (firebaseUser) {
      // ── User is signed in ────────────────────────────────────────────
      try {
        const session = await _resolveRoleAndBusiness(firebaseUser);

        // Update last_sign_in timestamp — non-blocking, non-critical
        dbUpdate(COL_USERS, firebaseUser.uid, {
          last_sign_in: dbNow(),
        }).catch(e => console.warn('[auth] last_sign_in update failed (non-critical):', e?.message));

        _saveSession(session);
        _notifyListeners(session);

      } catch (e) {
        console.error('[auth._startAuthListener] role resolution failed', e);

        // ── Whitelist blocked — show error on auth screen, do not create session
        if (e.code === 'NOT_WHITELISTED') {
          _clearSession();
          _notifyListeners({ blocked: true, message: e.message });
          return;
        }

        // Fallback session — role defaults to staff, businessId = own UID
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
      // ── User signed out ──────────────────────────────────────────────
      _clearSession();
      _notifyListeners(null);
    }
  });
}
