import React, { useState } from 'react';
import { Spade, Users, PlusCircle, Check, Copy, AlertCircle, ArrowRight } from 'lucide-react';
import { setTenantCode, normalizeTenantCode } from '../lib/tenantCode';

/**
 * GroupLanding
 * ------------
 * Shown at the app root when no tenant code is stored in
 * localStorage. Lets the user either:
 *   - Join an existing group by code (GET /api/tenants/resolve?code=XXX)
 *   - Create a new group (POST /api/tenants)
 *
 * Mobile-first (375x667 baseline). Reuses the same glass/slate
 * styling as the rest of the app -- no new dependencies.
 */

// ---------------------------------------------------------------------------
// Pure, testable handlers. They live at module scope so unit tests can drive
// them without rendering a full React tree (no DOM testing dep available).
// Both take `opts.fetch` so tests can inject a mock.
// ---------------------------------------------------------------------------

export interface JoinHandlerOpts {
  code: string;
  fetch?: typeof globalThis.fetch;
  reload?: () => void;
  storage?: {
    set: (code: string) => void;
  };
}

export interface JoinResult {
  ok: boolean;
  error?: string;
}

export async function submitJoin(opts: JoinHandlerOpts): Promise<JoinResult> {
  const code = normalizeTenantCode(opts.code);
  if (!code) {
    return { ok: false, error: 'Enter a group code' };
  }
  if (code.length !== 6) {
    return { ok: false, error: 'Code must be 6 characters' };
  }

  const f = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await f(`/api/tenants/resolve?code=${encodeURIComponent(code)}`);
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }

  if (res.status === 404) {
    return { ok: false, error: 'No group with that code' };
  }
  if (!res.ok) {
    return { ok: false, error: 'Could not verify code. Please try again.' };
  }

  (opts.storage ?? { set: setTenantCode }).set(code);
  (opts.reload ?? (() => window.location.reload()))();
  return { ok: true };
}

export interface CreateHandlerOpts {
  groupName: string;
  adminName: string;
  username: string;
  password: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreateResult {
  ok: boolean;
  code?: string;
  error?: string;
}

export async function submitCreate(opts: CreateHandlerOpts): Promise<CreateResult> {
  const name = opts.groupName.trim();
  const adminName = opts.adminName.trim();
  const username = opts.username.trim();
  const password = opts.password;

  if (!name) return { ok: false, error: 'Group name is required' };
  if (!adminName) return { ok: false, error: 'Admin name is required' };
  if (!username) return { ok: false, error: 'Username is required' };
  if (!password) return { ok: false, error: 'Password is required' };

  const f = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await f('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, adminName, username, password }),
    });
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }

  if (res.status !== 201) {
    let message = 'Could not create group. Please try again.';
    try {
      const body = (await res.json()) as { error?: string } | undefined;
      if (body?.error) message = body.error;
    } catch {
      /* ignore parse errors */
    }
    return { ok: false, error: message };
  }

  let code = '';
  try {
    const body = (await res.json()) as { code?: string } | undefined;
    code = normalizeTenantCode(body?.code ?? '');
  } catch {
    return { ok: false, error: 'Group created but response was malformed.' };
  }

  if (!code) {
    return { ok: false, error: 'Group created but no code was returned.' };
  }
  return { ok: true, code };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = 'choose' | 'create';

export default function GroupLanding() {
  const [mode, setMode] = useState<Mode>('choose');

  // Join state
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);

  // Create state
  const [groupName, setGroupName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joinBusy) return;
    setJoinError(null);
    setJoinBusy(true);
    const res = await submitJoin({ code: joinCode });
    if (!res.ok) {
      setJoinError(res.error ?? 'Could not join group.');
      setJoinBusy(false);
    }
    // On success, submitJoin triggered reload(); we stay busy to prevent
    // double submits during the brief window before the page refreshes.
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createBusy) return;
    setCreateError(null);
    setCreateBusy(true);
    const res = await submitCreate({ groupName, adminName, username, password });
    setCreateBusy(false);
    if (!res.ok) {
      setCreateError(res.error ?? 'Could not create group.');
      return;
    }
    setCreatedCode(res.code ?? null);
  };

  const copyCode = async () => {
    if (!createdCode) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(createdCode);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // best-effort; ignore
    }
  };

  const continueAfterCreate = () => {
    if (!createdCode) return;
    setTenantCode(createdCode);
    window.location.reload();
  };

  // ------------------------------------------------------------------
  // Success screen: group was just created, show the code.
  // ------------------------------------------------------------------
  if (createdCode) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-zinc-100 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md glass rounded-3xl border border-white/10 p-8 shadow-2xl">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mb-4">
              <Check size={28} className="text-emerald-400" />
            </div>
            <h1 className="text-2xl font-black tracking-tight mb-1">Group created</h1>
            <p className="text-slate-400 text-sm">
              Share this code with members so they can join.
            </p>
          </div>

          <div className="mt-7 rounded-2xl bg-black/40 border border-white/10 p-5 text-center">
            <div className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 mb-2">
              Group Code
            </div>
            <div
              data-testid="group-code"
              className="text-4xl md:text-5xl font-black tracking-[0.3em] text-white select-all"
            >
              {createdCode}
            </div>
            <button
              type="button"
              onClick={copyCode}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 text-xs font-bold uppercase tracking-widest transition-all"
              aria-label="Copy group code"
            >
              {copied ? (
                <>
                  <Check size={14} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={14} />
                  Copy
                </>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={continueAfterCreate}
            className="mt-7 w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-black uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] active:scale-[0.98]"
          >
            Continue
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Main landing (choose or create).
  // ------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-zinc-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-xl shadow-indigo-500/20 mb-4">
            <Spade size={30} className="text-white" />
          </div>
          <h1 className="text-3xl font-black tracking-tight">Poker Fishes Ledger</h1>
          <p className="mt-1 text-slate-400 text-xs font-bold tracking-[0.25em] uppercase">
            Join or create a group
          </p>
        </div>

        {/* Join */}
        <section
          aria-labelledby="join-heading"
          className="glass rounded-3xl border border-white/10 p-6 shadow-2xl"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Users size={18} className="text-emerald-400" />
            </div>
            <div>
              <h2 id="join-heading" className="text-lg font-black tracking-tight">
                Join a Group
              </h2>
              <p className="text-slate-500 text-[11px] font-bold tracking-widest uppercase">
                Enter your 6-character code
              </p>
            </div>
          </div>

          <form onSubmit={handleJoin} className="space-y-3" noValidate>
            <label htmlFor="group-code-input" className="sr-only">
              Group code
            </label>
            <input
              id="group-code-input"
              data-testid="join-code-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={6}
              value={joinCode}
              onChange={(e) => {
                // Always uppercase + strip whitespace as user types.
                const v = e.target.value.replace(/\s+/g, '').toUpperCase();
                setJoinCode(v);
                if (joinError) setJoinError(null);
              }}
              placeholder="ABC123"
              aria-invalid={joinError ? true : undefined}
              aria-describedby={joinError ? 'join-error' : undefined}
              className="block w-full px-4 py-4 rounded-xl bg-slate-900 border border-slate-800 text-center text-2xl font-black tracking-[0.4em] text-white placeholder:text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-all"
            />

            {joinError && (
              <div
                id="join-error"
                data-testid="join-error"
                role="alert"
                className="flex items-start gap-2 text-xs font-bold text-rose-400"
              >
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{joinError}</span>
              </div>
            )}

            <button
              type="submit"
              data-testid="join-submit"
              disabled={joinBusy}
              className="w-full py-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 text-sm font-black uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(16,185,129,0.25)] active:scale-[0.98]"
            >
              {joinBusy ? 'Joining...' : 'Join'}
            </button>
          </form>
        </section>

        {/* Create */}
        <section
          aria-labelledby="create-heading"
          className="glass rounded-3xl border border-white/10 p-6 shadow-2xl"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <PlusCircle size={18} className="text-indigo-400" />
            </div>
            <div>
              <h2 id="create-heading" className="text-lg font-black tracking-tight">
                Create a New Group
              </h2>
              <p className="text-slate-500 text-[11px] font-bold tracking-widest uppercase">
                You become the admin
              </p>
            </div>
          </div>

          {mode === 'choose' && (
            <button
              type="button"
              onClick={() => setMode('create')}
              className="w-full py-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-black uppercase tracking-widest transition-all active:scale-[0.98]"
            >
              Create Group
            </button>
          )}

          {mode === 'create' && (
            <form onSubmit={handleCreate} className="space-y-3" noValidate>
              <div className="space-y-1.5">
                <label
                  htmlFor="group-name"
                  className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1"
                >
                  Group Name
                </label>
                <input
                  id="group-name"
                  type="text"
                  autoComplete="off"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Friday Night Cards"
                  className="block w-full px-4 py-3.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-50 placeholder:text-slate-600 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-name"
                  className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1"
                >
                  Admin Name
                </label>
                <input
                  id="admin-name"
                  type="text"
                  autoComplete="name"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Your name"
                  className="block w-full px-4 py-3.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-50 placeholder:text-slate-600 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-username"
                  className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1"
                >
                  Username
                </label>
                <input
                  id="admin-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="yourhandle"
                  className="block w-full px-4 py-3.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-50 placeholder:text-slate-600 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-password"
                  className="block text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1"
                >
                  Password
                </label>
                <input
                  id="admin-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="********"
                  className="block w-full px-4 py-3.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-50 placeholder:text-slate-600 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                />
              </div>

              {createError && (
                <div
                  role="alert"
                  data-testid="create-error"
                  className="flex items-start gap-2 text-xs font-bold text-rose-400"
                >
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{createError}</span>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setMode('choose');
                    setCreateError(null);
                  }}
                  className="flex-1 py-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-sm font-black uppercase tracking-widest transition-all active:scale-[0.98]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBusy}
                  className="flex-[2] py-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-black uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(79,70,229,0.25)] active:scale-[0.98]"
                >
                  {createBusy ? 'Creating...' : 'Create Group'}
                </button>
              </div>
            </form>
          )}
        </section>

        <p className="text-center text-[10px] text-slate-600 font-bold tracking-[0.25em] uppercase">
          Your group, your ledger.
        </p>
      </div>
    </div>
  );
}
