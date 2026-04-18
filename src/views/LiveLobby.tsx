import React, { useState, useEffect } from 'react';
import { liveApi, LiveUser, LiveSession, LivePlayerStats } from '../services/liveApi';
import {
  PlusCircle, Key, History, TrendingUp, LayoutDashboard,
  ChevronRight, Activity, Zap, LogOut,
} from 'lucide-react';

interface LiveLobbyProps {
  user: LiveUser;
  onLogout: () => void;
  navigate: (path: string) => void;
  initialCode?: string;
}

export default function LiveLobby({ user, onLogout, navigate, initialCode }: LiveLobbyProps) {
  const [activeTab, setActiveTab] = useState<'dash' | 'create' | 'join'>(
    initialCode ? 'join' : 'dash'
  );
  const [sessionName, setSessionName] = useState('');
  const [blindValue, setBlindValue] = useState('10/20');
  const [joinCode, setJoinCode] = useState(initialCode || '');
  const [joinError, setJoinError] = useState('');
  const [createError, setCreateError] = useState('');
  const [history, setHistory] = useState<LiveSession[]>([]);
  const [stats, setStats] = useState<LivePlayerStats>({
    weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0,
  });

  useEffect(() => {
    const load = async () => {
      const [sessions, s] = await Promise.all([
        liveApi.getSessions(user.id),
        liveApi.getUserStats(user.id),
      ]);
      setHistory(sessions);
      setStats(s);
    };
    load();
  }, [user.id]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionName) return;
    setCreateError('');
    const result = await liveApi.createSession(sessionName, blindValue, user.id);
    if (result.success && result.session) {
      navigate(`admin/${result.session.sessionCode}`);
    } else {
      setCreateError(result.error || 'Failed to create session.');
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError('');
    const result = await liveApi.joinSession(joinCode, user.id);
    if (result.success && result.sessionId) {
      const sessionData = await liveApi.getSession(result.sessionId);
      if (sessionData && sessionData.session.createdBy === user.id) {
        navigate(`admin/${sessionData.session.sessionCode}`);
      } else if (sessionData) {
        navigate(`player/${sessionData.session.sessionCode}`);
      }
    } else {
      setJoinError(result.error || 'Failed to join table.');
    }
  };

  const StatCard = ({
    title, val, color,
  }: { title: string; val: number; color: string }) => (
    <div
      className={`glass p-4 rounded-2xl border-l-4 ${color} transition-all hover:-translate-y-0.5 hover:shadow-2xl`}
    >
      <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-[0.15em] mb-1">
        {title}
      </p>
      <p className={`text-2xl font-black tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {val >= 0 ? '+' : ''}₹{Math.abs(val).toLocaleString()}
      </p>
    </div>
  );

  return (
    <div className="space-y-8 max-w-2xl mx-auto px-2">
      {/* User bar */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-emerald-500/20 text-emerald-400 rounded-lg flex items-center justify-center font-black text-sm">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <span className="text-sm font-bold text-slate-300">Hi, {user.name}</span>
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-rose-400 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" /> Sign out
        </button>
      </div>

      {/* P/L stats */}
      <section className="animate-slide">
        <div className="flex items-center justify-between mb-4 px-1">
          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <Activity className="w-3 h-3" /> Performance Insights
          </h2>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
            <span className="text-[9px] font-bold text-emerald-500/80 uppercase">Live Sync</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <StatCard title="Week"     val={stats.weeklyPL}  color="border-emerald-500" />
          <StatCard title="Month"    val={stats.monthlyPL} color="border-sky-500" />
          <StatCard title="Year"     val={stats.yearlyPL}  color="border-amber-500" />
          <StatCard title="Lifetime" val={stats.totalPL}   color="border-purple-500" />
        </div>
      </section>

      {/* Tabs */}
      <div className="glass p-1.5 rounded-2xl flex gap-1">
        {[
          { id: 'dash',   label: 'Lobby',  icon: LayoutDashboard, color: 'text-emerald-400' },
          { id: 'create', label: 'Host',   icon: PlusCircle,      color: 'text-sky-400' },
          { id: 'join',   label: 'Join',   icon: Key,             color: 'text-amber-400' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex-1 py-3.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2.5 transition-all duration-300 ${
              activeTab === tab.id
                ? 'bg-white/10 shadow-inner'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <tab.icon
              className={`w-4 h-4 ${activeTab === tab.id ? tab.color : 'opacity-40'}`}
            />
            <span className={activeTab === tab.id ? 'text-white' : ''}>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="min-h-[300px]">
        {/* ── Lobby ─────────────────────────────────────────────────────── */}
        {activeTab === 'dash' && (
          <div className="space-y-4 animate-slide">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                <History className="w-3 h-3" /> Table History
              </h2>
            </div>
            {history.length === 0 ? (
              <div className="glass rounded-3xl py-16 text-center">
                <p className="text-slate-500 font-bold mb-4">No tables found.</p>
                <button
                  onClick={() => setActiveTab('create')}
                  className="px-6 py-2 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-black border border-emerald-500/20 hover:bg-emerald-500 hover:text-slate-950 transition-all"
                >
                  Start a Game
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (s.status === 'closed') navigate(`settlement/${s.id}`);
                      else if (s.createdBy === user.id) navigate(`admin/${s.sessionCode}`);
                      else navigate(`player/${s.sessionCode}`);
                    }}
                    className="glass group p-4 rounded-2xl flex items-center justify-between cursor-pointer transition-all hover:bg-white/[0.03] active:scale-[0.98] border border-white/[0.02] hover:border-emerald-500/30"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-black ${
                          s.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {s.name.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-100 group-hover:text-emerald-400 transition-colors">
                          {s.name}
                        </h3>
                        <p className="text-[10px] text-slate-500 font-mono flex items-center gap-2">
                          {s.sessionCode}{' '}
                          <span className="opacity-30">•</span>{' '}
                          {new Date(s.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div
                        className={`px-2 py-1 rounded-md text-[8px] font-black uppercase tracking-tighter ${
                          s.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-slate-800 text-slate-500 border border-slate-700'
                        }`}
                      >
                        {s.status}
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-emerald-400" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Host ──────────────────────────────────────────────────────── */}
        {activeTab === 'create' && (
          <div className="glass p-8 rounded-3xl animate-slide">
            <h2 className="text-xl font-black mb-6 text-emerald-400">Initialize Table</h2>
            <form onSubmit={handleCreate} className="space-y-6">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-1">
                  Room Name
                </label>
                <input
                  type="text"
                  className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all placeholder:text-slate-700 font-bold text-white"
                  placeholder="The VIP Lounge"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] ml-1">
                  Table Blinds
                </label>
                <input
                  type="text"
                  className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all font-mono text-white"
                  placeholder="10 / 20"
                  value={blindValue}
                  onChange={(e) => setBlindValue(e.target.value)}
                />
              </div>
              {createError && (
                <p className="text-rose-400 text-[10px] font-black uppercase tracking-widest">
                  {createError}
                </p>
              )}
              <button
                type="submit"
                disabled={!sessionName}
                className="w-full py-5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-slate-950 font-black rounded-2xl transition-all shadow-xl shadow-emerald-500/20 active:scale-95 flex items-center justify-center gap-2"
              >
                <Zap className="w-4 h-4 fill-current" /> Open Table
              </button>
            </form>
          </div>
        )}

        {/* ── Join ──────────────────────────────────────────────────────── */}
        {activeTab === 'join' && (
          <div className="glass p-8 rounded-3xl animate-slide text-center">
            <h2 className="text-xl font-black mb-2 text-amber-400">Find Table</h2>
            <p className="text-slate-500 text-xs mb-8 font-medium italic">
              Enter the 6-character access code from the host.
            </p>
            <form onSubmit={handleJoin} className="space-y-6">
              <input
                type="text"
                className="w-full bg-black/40 border-2 border-white/5 rounded-3xl px-6 py-8 focus:border-amber-500/50 outline-none transition-all uppercase font-mono tracking-[0.6em] text-4xl text-center text-amber-400 placeholder:text-slate-900"
                placeholder="••••••"
                maxLength={6}
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value.toUpperCase());
                  setJoinError('');
                }}
              />
              {joinError && (
                <p className="text-rose-400 text-[10px] font-black uppercase tracking-widest">
                  {joinError}
                </p>
              )}
              <button
                type="submit"
                disabled={joinCode.length < 4}
                className="w-full py-5 bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-slate-950 font-black rounded-2xl transition-all shadow-xl shadow-amber-500/20 active:scale-95"
              >
                Sit In
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
