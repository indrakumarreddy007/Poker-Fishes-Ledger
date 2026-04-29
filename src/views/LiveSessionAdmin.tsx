import React, { useState, useEffect } from 'react';
import {
  liveApi, LiveUser, LiveSession, LiveSessionPlayer, LiveBuyIn,
} from '../services/liveApi';
import {
  Check, X, Users, Trophy, Plus, DollarSign, AlertTriangle,
  History, ChevronDown, ChevronUp, Clock, ShieldCheck, LogOut,
} from 'lucide-react';

interface Props {
  user: LiveUser;
  sessionCode: string;
  navigate: (path: string) => void;
}

export default function LiveSessionAdmin({ user, sessionCode, navigate }: Props) {
  const [session, setSession]   = useState<LiveSession | null>(null);
  const [players, setPlayers]   = useState<LiveSessionPlayer[]>([]);
  const [buyIns, setBuyIns]     = useState<LiveBuyIn[]>([]);
  const [isEnding, setIsEnding] = useState(false);
  const [isAddingOwn, setIsAddingOwn] = useState(false);
  const [ownAmount, setOwnAmount] = useState('');
  const [finalChipCounts, setFinalChipCounts] = useState<Record<string, string>>({});
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [error, setError]       = useState('');
  const [fetchError, setFetchError] = useState('');

  const refreshData = async () => {
    const data = await liveApi.getSession(sessionCode);
    if (!data) {
      if (!session) setFetchError('Failed to load session. Please check your connection.');
      return;
    }
    if (data.session.createdBy !== user.id) {
      navigate(`player/${sessionCode}`);
      return;
    }
    if (data.session.status === 'closed') {
      navigate(`settlement/${data.session.id}`);
      return;
    }
    setSession(data.session);
    setPlayers(data.players);
    setBuyIns(data.buyIns);
    setFetchError('');
    setFinalChipCounts((prev) => {
      const updated = { ...prev };
      for (const p of data.players) {
        if (p.leftAt && p.finalWinnings != null && !updated[p.userId]) {
          updated[p.userId] = String(p.finalWinnings);
        }
      }
      return updated;
    });
  };

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);
    return () => clearInterval(interval);
  }, [sessionCode]);

  const handleApprove = async (id: string) => {
    await liveApi.updateBuyInStatus(id, 'approved');
    refreshData();
  };

  const handleReject = async (id: string) => {
    await liveApi.updateBuyInStatus(id, 'rejected');
    refreshData();
  };

  const handleAdminBuyIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !ownAmount) return;
    await liveApi.requestBuyIn(session.id, user.id, parseFloat(ownAmount), 'approved');
    setOwnAmount('');
    setIsAddingOwn(false);
    refreshData();
  };

  const getPlayerStats = (userId: string) => {
    const approved = buyIns.filter((b) => b.userId === userId && b.status === 'approved');
    return {
      total: approved.reduce((sum, b) => sum + b.amount, 0),
      history: buyIns.filter((b) => b.userId === userId),
    };
  };

  const finalizeSession = async () => {
    if (!session) return;
    const pool = buyIns
      .filter((b) => b.status === 'approved')
      .reduce((sum, b) => sum + b.amount, 0);
    let totalWinnings = 0;
    for (const p of players) {
      const val = parseFloat(finalChipCounts[p.userId] ?? String(p.finalWinnings ?? 0));
      totalWinnings += val;
      await liveApi.settlePlayer(session.id, p.userId, val);
    }
    if (Math.abs(totalWinnings - pool) > 0.1) {
      setError(`Audit Failed: Chips Out (₹${totalWinnings}) ≠ Pool (₹${pool}).`);
      return;
    }
    await liveApi.updateSessionStatus(session.id, 'closed');
    navigate(`settlement/${session.id}`);
  };

  if (!session) {
    if (fetchError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
          <p className="text-rose-400 font-bold uppercase tracking-widest">{fetchError}</p>
          <button
            onClick={() => navigate('lobby')}
            className="px-6 py-2 bg-slate-800 rounded-full text-xs font-bold hover:bg-slate-700 transition"
          >
            Return to Lobby
          </button>
        </div>
      );
    }
    return (
      <div className="text-center py-20 text-slate-500 animate-pulse font-bold uppercase tracking-widest">
        Loading Secure Table...
      </div>
    );
  }

  const pendingBuyIns = buyIns.filter((b) => b.status === 'pending');
  const pendingLeaveRequests = players.filter((p) => p.leavePending);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="bg-slate-900 p-6 rounded-[2rem] border border-slate-800 shadow-2xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <h1 className="text-3xl font-black text-white flex items-center gap-3">
              {session.name}
              <span className="text-[10px] bg-emerald-500 text-slate-950 px-2.5 py-1 rounded-full uppercase tracking-tighter font-black">
                Host
              </span>
            </h1>
            <div className="flex items-center gap-4">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                Code:
              </span>
              <span className="font-mono text-emerald-400 font-black bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 select-all">
                {session.sessionCode}
              </span>
              <span className="text-xs text-slate-400">Blinds: {session.blindValue}</span>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setIsAddingOwn(!isAddingOwn)}
              className="flex-1 md:flex-none bg-slate-800 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 px-5 py-3 rounded-2xl font-black transition-all flex items-center justify-center gap-2 border border-slate-700"
            >
              <Plus className="w-4 h-4" /> Buy-In
            </button>
            <button
              onClick={() => setIsEnding(true)}
              className="flex-1 md:flex-none bg-rose-500 hover:bg-rose-600 text-white px-6 py-3 rounded-2xl font-black transition-all shadow-xl shadow-rose-500/30 flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" /> End Session
            </button>
          </div>
        </div>
      </div>

      {isAddingOwn && (
        <form
          onSubmit={handleAdminBuyIn}
          className="bg-emerald-500/5 border-2 border-emerald-500/20 p-6 rounded-[2rem] flex items-center gap-4"
        >
          <div className="flex-1 relative">
            <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-500" />
            <input
              type="number"
              autoFocus
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-12 pr-4 py-4 focus:ring-2 focus:ring-emerald-500 outline-none font-black text-xl text-white"
              placeholder="0.00"
              value={ownAmount}
              onChange={(e) => setOwnAmount(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="bg-emerald-500 text-slate-950 px-8 py-4 rounded-xl font-black shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
          >
            Add Stack
          </button>
          <button
            type="button"
            onClick={() => setIsAddingOwn(false)}
            className="p-4 text-slate-500 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </form>
      )}

      {isEnding ? (
        <div className="bg-slate-900 border-2 border-amber-500/50 rounded-[2.5rem] p-8 space-y-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-amber-500" />
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-amber-500/10 rounded-2xl flex items-center justify-center">
              <Trophy className="text-amber-500 w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-white">Final Chip Count</h2>
              <p className="text-sm text-slate-400 font-medium">
                Pool: ₹{buyIns.filter((b) => b.status === 'approved').reduce((s, b) => s + b.amount, 0)}
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {players.map((p) => (
              <div
                key={p.userId}
                className={`flex items-center justify-between p-5 bg-slate-950 rounded-2xl border focus-within:border-amber-500/50 transition-all ${p.leftAt ? 'border-slate-700 opacity-75' : 'border-slate-800'}`}
              >
                <div>
                  <span className="font-black text-slate-200 flex items-center gap-2">
                    {p.name}
                    {p.leftAt && (
                      <span className="text-[9px] font-black uppercase tracking-widest bg-slate-700 text-slate-400 px-2 py-0.5 rounded-full border border-slate-600">
                        Left {new Date(p.leftAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-slate-500 font-bold uppercase">
                    Invested: ₹{getPlayerStats(p.userId).total}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-slate-600 font-bold">₹</span>
                  <input
                    type="number"
                    className="w-32 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-right focus:ring-2 focus:ring-amber-500 outline-none font-black text-white"
                    placeholder="0"
                    value={finalChipCounts[p.userId] || ''}
                    onChange={(e) =>
                      setFinalChipCounts((prev) => ({ ...prev, [p.userId]: e.target.value }))
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          {error && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs font-bold flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" /> {error}
            </div>
          )}
          <div className="flex gap-4 pt-4">
            <button
              onClick={() => setIsEnding(false)}
              className="flex-1 py-5 bg-slate-800 hover:bg-slate-700 rounded-2xl font-black transition-all text-white"
            >
              Cancel
            </button>
            <button
              onClick={finalizeSession}
              className="flex-1 py-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-2xl font-black transition-all shadow-2xl shadow-emerald-500/20"
            >
              Finalize &amp; Settle
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Approval Queue */}
            <section className="space-y-4">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2 px-2">
                <Clock className="w-4 h-4" /> Approval Queue ({pendingBuyIns.length + pendingLeaveRequests.length})
              </h2>
              <div className="space-y-3">
                {pendingBuyIns.length === 0 && pendingLeaveRequests.length === 0 ? (
                  <div className="text-center py-16 bg-slate-900/30 rounded-[2rem] border-2 border-dashed border-slate-800/50 text-slate-600 font-bold italic flex flex-col items-center gap-2">
                    <ShieldCheck className="w-8 h-8 opacity-20" />
                    No pending requests
                  </div>
                ) : (
                  <>
                  {pendingLeaveRequests.map((p) => (
                    <div
                      key={p.userId}
                      className="flex items-center justify-between bg-slate-900 border border-rose-500/20 p-6 rounded-3xl hover:border-rose-500/40 transition-all shadow-xl"
                    >
                      <div>
                        <p className="font-black text-slate-200 text-lg flex items-center gap-2">
                          {p.name}
                          <span className="text-[9px] font-black uppercase tracking-widest bg-rose-500/10 text-rose-400 px-2 py-0.5 rounded-full border border-rose-500/20">
                            Leave
                          </span>
                        </p>
                        <p className="text-rose-400 text-3xl font-black tracking-tighter mt-1">
                          ₹{p.pendingOutChips ?? 0}
                        </p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase mt-1">Out chips</p>
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={async () => { await liveApi.rejectLeave(session!.id, p.userId); refreshData(); }}
                          className="p-4 bg-slate-800 hover:bg-rose-500 text-slate-500 hover:text-white rounded-2xl transition-all active:scale-90"
                        >
                          <X className="w-6 h-6" />
                        </button>
                        <button
                          onClick={async () => { await liveApi.approveLeave(session!.id, p.userId); refreshData(); }}
                          className="p-4 bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white rounded-2xl transition-all active:scale-90"
                        >
                          <Check className="w-6 h-6" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {pendingBuyIns.map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between bg-slate-900 border border-slate-800 p-6 rounded-3xl hover:border-emerald-500/30 transition-all shadow-xl"
                    >
                      <div>
                        <p className="font-black text-slate-200 text-lg">
                          {players.find((p) => p.userId === b.userId)?.name}
                        </p>
                        <p className="text-emerald-400 text-3xl font-black tracking-tighter mt-1">
                          ₹{b.amount}
                        </p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase mt-1">
                          {new Date(b.timestamp).toLocaleTimeString()}
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={() => handleReject(b.id)}
                          className="p-4 bg-slate-800 hover:bg-rose-500 text-slate-500 hover:text-white rounded-2xl transition-all active:scale-90"
                        >
                          <X className="w-6 h-6" />
                        </button>
                        <button
                          onClick={() => handleApprove(b.id)}
                          className="p-4 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 rounded-2xl transition-all active:scale-90"
                        >
                          <Check className="w-6 h-6" />
                        </button>
                      </div>
                    </div>
                  ))
                  }
                  </>
                )}
              </div>
            </section>

            {/* Live Registry */}
            <section className="space-y-4">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2 px-2">
                <Users className="w-4 h-4" /> Live Registry
              </h2>
              <div className="bg-slate-900 rounded-[2rem] border border-slate-800 overflow-hidden shadow-2xl">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-950/50 border-b border-slate-800">
                    <tr>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Player
                      </th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-right">
                        Chips In
                      </th>
                      <th className="w-12" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {players.map((p) => {
                      const stats     = getPlayerStats(p.userId);
                      const isExpanded = expandedPlayer === p.userId;
                      return (
                        <React.Fragment key={p.userId}>
                          <tr
                            onClick={() =>
                              setExpandedPlayer(isExpanded ? null : p.userId)
                            }
                            className={`transition-all cursor-pointer hover:bg-slate-950/50 ${p.leftAt ? 'opacity-50' : ''}`}
                          >
                            <td className="px-6 py-5">
                              <div className="flex items-center gap-4">
                                <div
                                  className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm transition-all ${
                                    isExpanded
                                      ? 'bg-emerald-500 text-slate-950'
                                      : 'bg-slate-800 text-slate-500'
                                  }`}
                                >
                                  {p.name.charAt(0)}
                                </div>
                                <div>
                                  <p className="font-black text-slate-200 flex items-center gap-2">
                                    {p.name}
                                    {p.leftAt && (
                                      <span className="text-[9px] font-black uppercase tracking-widest bg-slate-700 text-slate-400 px-2 py-0.5 rounded-full border border-slate-600">
                                        Left
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-[9px] font-bold text-slate-500 uppercase">
                                    {stats.history.length} Transactions
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-5 text-right font-mono text-emerald-400 font-black text-lg">
                              ₹{stats.total}
                            </td>
                            <td className="px-4 text-slate-700">
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-950/40">
                              <td colSpan={3} className="px-8 py-6 border-b border-slate-800/50">
                                <div className="space-y-3">
                                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                                    <History className="w-3 h-3" /> Transaction Log
                                  </p>
                                  <div className="space-y-2">
                                    {stats.history.length === 0 ? (
                                      <p className="text-xs text-slate-600 italic py-2">
                                        No buy-ins yet
                                      </p>
                                    ) : (
                                      stats.history.map((r) => (
                                        <div
                                          key={r.id}
                                          className="flex items-center justify-between py-2 border-b border-slate-800/50 last:border-0"
                                        >
                                          <div className="flex items-center gap-4">
                                            <div className="text-[10px] font-mono text-slate-600">
                                              {new Date(r.timestamp).toLocaleTimeString([], {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                              })}
                                            </div>
                                            <div className="text-sm font-black text-slate-100">
                                              ₹{r.amount}
                                            </div>
                                          </div>
                                          <div
                                            className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border ${
                                              r.status === 'approved'
                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                : r.status === 'rejected'
                                                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                                : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                            }`}
                                          >
                                            {r.status}
                                          </div>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Global Audit Log */}
          <section className="space-y-4 pt-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                <ShieldCheck className="w-4 h-4" /> Global Table Audit Log
              </h2>
              <span className="text-[9px] font-bold text-slate-600 uppercase">Realtime Feed</span>
            </div>
            <div className="bg-slate-900/50 rounded-[2rem] border border-slate-800 p-2 max-h-80 overflow-y-auto scrollbar-hide shadow-inner">
              {buyIns.length === 0 ? (
                <div className="py-20 text-center text-slate-700 text-[10px] font-black uppercase tracking-widest flex flex-col items-center gap-3">
                  <div className="w-12 h-12 rounded-full border border-slate-800 flex items-center justify-center opacity-20">
                    ♠
                  </div>
                  Feed Ready
                </div>
              ) : (
                buyIns.map((b, idx) => {
                  const player = players.find((p) => p.userId === b.userId);
                  return (
                    <div
                      key={b.id}
                      className={`flex items-center justify-between p-5 rounded-2xl transition-all hover:bg-white/[0.02] ${
                        idx % 2 === 0 ? 'bg-slate-950/20' : ''
                      }`}
                    >
                      <div className="flex items-center gap-5">
                        <div className="font-mono text-[10px] text-slate-600">
                          {new Date(b.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </div>
                        <div>
                          <p className="text-sm font-black text-slate-200">
                            {player?.name || 'Unknown'}
                          </p>
                          <p className="text-[10px] text-slate-500 font-bold uppercase">
                            Attempted{' '}
                            <span className="text-emerald-400">₹{b.amount}</span>
                          </p>
                        </div>
                      </div>
                      <div
                        className={`text-[9px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full border ${
                          b.status === 'approved'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : b.status === 'rejected'
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                            : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                        }`}
                      >
                        {b.status}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
