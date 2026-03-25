// ════════════════════════════════════════════════════════════════════════
// FILE: src/screens/team.js
// PURPOSE: Team management screen — add/remove staff and managers.
//          Owner-only for role changes. Manager can add/remove staff.
//
// SECTION INDEX
// ─────────────────────────────────────────────────────────────────────
// §1  IMPORTS
// §2  SCREEN STATE
// §3  MAIN RENDER
// §4  MEMBER LIST
// §5  ADD MEMBER
// §6  REMOVE / RESTORE MEMBER
// ════════════════════════════════════════════════════════════════════════

import { render, renderLoading, esc, toast, roleBadge, emptyState } from '../ui.js';
import { dbList, dbAdd, dbUpdate, dbQuery, dbGet, dbSet, dbNow, paths, COL_BUSINESSES } from '../db.js';
import * as Auth from '../auth.js';


// ════════════════════════════════════════════════════════════════════════
// §2 SCREEN STATE
// ════════════════════════════════════════════════════════════════════════

let _session = null;
let _onBack      = null;
let _members = []; // array of user docs for this business


// ════════════════════════════════════════════════════════════════════════
// §3 MAIN RENDER
// ════════════════════════════════════════════════════════════════════════

export async function renderTeam(session, onBack) {
  _onBack = onBack || null;
  _session = session;
  console.log('[team.renderTeam] called', { businessId: session.businessId });

  renderLoading('Loading team…');
  await _loadMembers();
  _render();
}

async function _loadMembers() {
  try {
    // Team members stored at businesses/{businessId}/team_members
    // This path is accessible to all business members per security rules.
    const result = await dbList(`businesses/${_session.businessId}/team_members`);
    _members = result.ok ? result.data : [];
    console.log('[team._loadMembers]', { count: _members.length });
  } catch(e) {
    console.warn('[team._loadMembers] failed', e?.message);
    _members = [];
  }
}


// ════════════════════════════════════════════════════════════════════════
// §4 MEMBER LIST
// ════════════════════════════════════════════════════════════════════════

function _render() {
  const isOwner   = Auth.isOwner();
  const isManager = Auth.isManager();
  const canAdd    = isOwner || isManager;

  const active  = _members.filter(m => m.status !== 'removed' && m.uid !== _session.uid);
  const removed = _members.filter(m => m.status === 'removed');
  const me      = _members.find(m => m.uid === _session.uid);

  render(`
    <div class="wrap" style="padding-bottom:40px">

      <button class="back-btn" id="sub-back-btn">‹ Back</button>
      <div class="subscreen-title" style="margin-bottom:4px">Team Members</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:14px">
        Manage who has access to your business.
      </div>

      <!-- Add member form (owner/manager only) -->
      ${canAdd ? `
      <div class="card" style="margin-bottom:14px">
        <div class="section-title">Add Member</div>
        <div class="form-group">
          <label class="label">Email</label>
          <input class="input" id="team-add-email" type="email" placeholder="staff@example.com"/>
        </div>
        ${isOwner ? `
        <div class="form-group">
          <label class="label">Role</label>
          <select class="input" id="team-add-role">
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
          </select>
        </div>` : ''}
        <button class="btn btn-primary btn-small" id="btn-team-add">Add Member</button>
        <div id="team-add-result" style="font-size:12px;margin-top:8px;display:none"></div>
      </div>` : ''}

      <!-- You -->
      ${me ? `
      <div class="section-title">You</div>
      <div class="team-member-row" style="margin-bottom:14px">
        <div class="team-avatar">${_initials(me.display_name || me.email)}</div>
        <div class="team-info">
          <div class="team-name">${esc(me.display_name || me.email)}</div>
          <div class="team-email">${esc(me.email)}</div>
        </div>
        ${roleBadge(me.role || 'staff')}
        <span style="font-size:10px;color:var(--muted)">(you)</span>
      </div>` : ''}

      <!-- Active members -->
      <div class="section-title">Active (${active.length})</div>
      ${active.length
        ? active.map(m => _renderMemberRow(m, false, isOwner, isManager)).join('')
        : '<div style="font-size:13px;color:var(--muted);margin-bottom:14px">No other members yet.</div>'
      }

      <!-- Removed members (owner only) -->
      ${isOwner && removed.length > 0 ? `
      <div class="section-title" style="margin-top:14px;color:var(--muted)">Removed (${removed.length})</div>
      ${removed.map(m => _renderMemberRow(m, true, isOwner, false)).join('')}` : ''}

    </div>
  `);

  _wireEvents(isOwner, isManager);

  // Back button
  document.getElementById('sub-back-btn')?.addEventListener('click', () =>
    _onBack ? _onBack() : window.switchScreen('more')
  );
}

function _renderMemberRow(member, isRemoved, isOwner, isManager) {
  const initials = _initials(member.display_name || member.email);
  const canRemove = !isRemoved && (isOwner || (isManager && member.role === 'staff'));
  const canRestore = isRemoved && isOwner;
  const canChangeRole = !isRemoved && isOwner && member.id !== _session?.uid;

  return `
    <div class="team-member-row ${isRemoved ? 'removed' : ''}">
      <div class="team-avatar">${esc(initials)}</div>
      <div class="team-info">
        <div class="team-name">${esc(member.display_name || member.email)}</div>
        <div class="team-email">${esc(member.email)}</div>
      </div>
      ${canChangeRole
        ? `<select class="input team-role-select" data-uid="${esc(member.id)}"
            style="font-size:11px;padding:4px 7px;width:90px">
            <option value="staff" ${member.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="manager" ${member.role === 'manager' ? 'selected' : ''}>Manager</option>
          </select>`
        : roleBadge(member.role || 'staff')
      }
      ${canRemove   ? `<button class="btn btn-danger btn-small" data-remove="${esc(member.id)}">Remove</button>` : ''}
      ${canRestore  ? `<button class="btn btn-secondary btn-small" data-restore="${esc(member.id)}">Restore</button>` : ''}
    </div>
  `;
}


// ════════════════════════════════════════════════════════════════════════
// §5 ADD MEMBER
// ════════════════════════════════════════════════════════════════════════

function _wireEvents(isOwner, isManager) {
  // Add member
  document.getElementById('btn-team-add')?.addEventListener('click', async () => {
    const email  = document.getElementById('team-add-email')?.value.trim().toLowerCase();
    const role   = isOwner ? (document.getElementById('team-add-role')?.value || 'staff') : 'staff';
    const resEl  = document.getElementById('team-add-result');

    if (!email) { _showResult(resEl, 'Email is required.', 'err'); return; }

    const btn = document.getElementById('btn-team-add');
    btn.disabled = true; btn.textContent = 'Adding…';

    try {
      const teamPath = `businesses/${_session.businessId}/team_members`;

      // Check if already a member
      const existing = _members.find(m => (m.email || '').toLowerCase() === email);
      if (existing && existing.status !== 'removed') {
        _showResult(resEl, `${email} is already a member.`, 'warn');
        btn.disabled = false; btn.textContent = 'Add Member';
        return;
      }

      if (existing) {
        // Re-activate removed member
        await dbUpdate(teamPath, existing.id, {
          role, status: 'active', updated_at: dbNow(),
        });
      } else {
        // Add new member
        await dbAdd(teamPath, {
          email,
          role,
          status:      'invited',
          display_name:'',
          added_by:    _session.uid,
          created_at:  dbNow(),
          updated_at:  dbNow(),
        });
      }

      document.getElementById('team-add-email').value = '';
      _showResult(resEl, `✓ ${email} added as ${role}`, 'ok');
      toast(`✓ ${email} added`);
      await _loadMembers();
      _render();

    } catch(e) {
      _showResult(resEl, 'Failed: ' + e.message, 'err');
    }

    btn.disabled = false; btn.textContent = 'Add Member';
  });

  // Role change
  document.querySelectorAll('.team-role-select').forEach(sel =>
    sel.addEventListener('change', async () => {
      const uid     = sel.dataset.uid;
      const newRole = sel.value;
      if (!confirm(`Change this member's role to ${newRole}?`)) {
        const member = _members.find(m => m.id === uid);
        sel.value = member?.role || 'staff';
        return;
      }
      try {
        await dbUpdate(`businesses/${_session.businessId}/team_members`, uid, { role: newRole, updated_at: dbNow() });
        toast(`✓ Role updated to ${newRole}`);
        await _loadMembers(); _render();
      } catch(e) { toast('Failed: ' + e.message, 'err'); }
    })
  );

  // Remove member
  document.querySelectorAll('[data-remove]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id     = btn.dataset.remove;
      const member = _members.find(m => m.id === id);
      if (!member || !confirm(`Remove ${member.display_name || member.email}?`)) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await dbUpdate(`businesses/${_session.businessId}/team_members`, id, { status: 'removed', updated_at: dbNow() });
        toast(`${member.display_name || member.email} removed`, 'warn');
        await _loadMembers(); _render();
      } catch(e) {
        toast('Failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = 'Remove';
      }
    })
  );

  // Restore member
  document.querySelectorAll('[data-restore]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id     = btn.dataset.restore;
      const member = _members.find(m => m.id === id);
      if (!member) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await dbUpdate(`businesses/${_session.businessId}/team_members`, id, { status: 'active', updated_at: dbNow() });
        toast(`✓ ${member.display_name || member.email} restored`);
        await _loadMembers(); _render();
      } catch(e) {
        toast('Failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = 'Restore';
      }
    })
  );
}


// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function _initials(name) {
  return (name || '?').trim().split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function _showResult(el, msg, type) {
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = type === 'ok' ? 'var(--grn2)' : type === 'warn' ? 'var(--gold)' : 'var(--red)';
  el.textContent   = msg;
}


// ════════════════════════════════════════════════════════════════════════
// CSS
// ════════════════════════════════════════════════════════════════════════

(function injectTeamStyles() {
  if (document.getElementById('team-styles')) return;
  const s = document.createElement('style');
  s.id = 'team-styles';
  s.textContent = `
.team-member-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--sur);border:1px solid var(--bdr);border-radius:var(--r);margin-bottom:7px}
.team-member-row.removed{opacity:.5}
.team-avatar{width:36px;height:36px;border-radius:50%;background:var(--gdim);border:1px solid var(--gbdr);color:var(--grn2);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.team-info{flex:1;min-width:0}
.team-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.team-email{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
  document.head.appendChild(s);
})();
