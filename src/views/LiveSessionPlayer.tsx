import React, { useState, useEffect, useMemo } from 'react';
import {
  liveApi, LiveUser, LiveSession, LiveSessionPlayer as LiveSessionPlayerType, LiveBuyIn,
} from '../services/liveApi';
import { aggregateTableBuyIns, tablePot as computeTablePot, potShare } from '../lib/buyIns';
import {
  Clock, Wallet, CheckCircle, AlertCircle, Plus, Zap, History, DollarSign, ShieldCheck, Users,
} from 'lucide-react';

interface Props {
  user: LiveUser;
  sessionCode: string;
  navigate: (path: string) => void;
}

export default function LiveSessionPlayer({ user, sessionCode, navigate }: Props) {
  const [session, setSession]   = useState<LiveSession | null>(null);
  const [players, setPlayers]   = useState<LiveSessionPlayerType[]>([]);
  const [buyIns, setBuyIns]     = useState<LiveBuyIn[]>([]);
  const [allBuyIns, setAllBuyIns] = useState<LiveBuyIn[]>([]);
  const [amount, setAmount]     = useState('');
  const [isRequesting, setIsRequesting] = useState(false);

  const refreshData = async () => {
    const data = await liveApi.getSession(sessionCode);
    if (!data) return;
    if (data.session.status === 'closed') {
      navigate(`settlement/${data.session.id}`);
      return;
    }
    setSession(data.session);
    setPlayers(data.players);
    setAllBuyIns(data.buyIns);
    setBuyIns(
      data.buyIns
        .filter((b) => b.userId === user.id)
        .sort((a, b) => b.timestamp - a.timestamp)
    );
  };

  const tableBuyIns = useMemo(
    () => aggregateTableBuyIns(allBuyIns, players, user.id),
    [allBuyIns, players, user.id]
  );

  const tablePot = computeTablePot(tableBuyIns);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 3000);
    return () => clearInterval(interval);
  }, [sessionCode]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !amount || parseFloat(amount) <= 0) return;
    await liveApi.requestBuyIn(session.id, user.id, parseFloat(amount));
    setAmount('');
    setIsRequesting(false);
    refreshData();
  };

  if (!session) {
    return (
      <div className="text-center py-20 text-slate-500 animate-pulse font-black">
        Connecting to Table...
      </div>
    );
  }

  const isAdmin    = session.createdBy === user.id;
  const totalApproved = buyIns
    .filter((b) => b.status === 'approved')
    .reduce((sum, b) => sum + b.amount, 0);

  return (
    <div className="space-y-6 pb-12">
      <div className="text-center space-y-4">
        <h1 className="text-5xl font-black tracking-tighter text-white drop-shadow-2xl">
          {session.name}
        </h1>
        <div className="inline-flex items-center gap-3 px-6 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[10px] font-black text-emerald-400 uppercase tracking-widest">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live Session • {session.blindValue} Blinds
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-900 p-8 rounded-[2rem] border border-slate-800 shadow-2xl text-center hover:border-emerald-500/40 transition-all">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Total Buy-In
          </p>
          <p className="text-4xl font-black text-emerald-400">₹{totalApproved}</p>
        </div>
        <div className="bg-slate-900 p-8 rounded-[2rem] border border-slate-800 shadow-2xl text-center flex flex-col items-center justify-center">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Seat Role
          </p>
          <p className="text-xl font-black text-white uppercase tracking-tighter">
            {isAdmin ? 'Session Host' : 'Player'}
          </p>
        </div>
      </div>

      <section className="bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 shadow-2xl space-y-8">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center">
              <Plus className="w-5 h-5 text-emerald-500" />
            </div>
            Top Up
          </h2>
          {!isRequesting && (
            <button
              onClick={() => setIsRequesting(true)}
              className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-2xl transition-all shadow-xl shadow-emerald-500/30 active:scale-95 flex items-center gap-2"
            >
              Add Chips
            </button>
          )}
        </div>

        {isRequesting && (
          <form
            onSubmit={handleRequest}
            className="p-6 bg-slate-950 border-2 border-emerald-500/30 rounded-3xl space-y-5"
          >
            <div className="space-y-3">
              <div className="flex justify-between items-center px-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  Amount to Request
                </label>
                {isAdmin && (
                  <span className="text-[9px] font-black text-emerald-400 uppercase flex items-center gap-1.5">
                    <Zap className="w-3 h-3 fill-current" /> Instant Approval
                  </span>
                )}
              </div>
              <div className="relative">
                <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-emerald-500" />
                <input
                  type="number"
                  autoFocus
                  className="w-full bg-slate-900 border border-slate-800 rounded-2xl pl-12 pr-4 py-5 focus:ring-2 focus:ring-emerald-500 outline-none text-3xl font-black text-white"
                  placeholder="500"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsRequesting(false)}
                className="flex-1 py-4 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-black text-slate-400 uppercase"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 py-4 bg-emerald-500 text-slate-950 rounded-xl text-xs font-black uppercase shadow-xl shadow-emerald-500/20 active:scale-95 transition-all"
              >
                {isAdmin ? 'Confirm Buy-In' : 'Request Chips'}
              </button>
            </div>
          </form>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1">
            <History className="w-4 h-4 text-slate-600" />
            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
              Transaction Statement
            </h3>
          </div>
          {buyIns.length === 0 ? (
            <div className="text-center py-20 bg-slate-950/50 rounded-3xl border border-slate-800/50">
              <p className="text-slate-600 font-bold italic text-sm">No chip history found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {buyIns.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between bg-slate-950 p-6 rounded-3xl border border-slate-800 hover:border-slate-700 transition-all"
                >
                  <div>
                    <p className="text-2xl font-black text-white">₹{b.amount}</p>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">
                      {new Date(b.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <div>
                    {b.status === 'pending' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-amber-500 bg-amber-500/10 px-5 py-2.5 rounded-full border border-amber-500/20 animate-pulse">
                        <Clock className="w-4 h-4" /> Awaiting Admin
                      </span>
                    )}
                    {b.status === 'approved' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-emerald-400 bg-emerald-400/10 px-5 py-2.5 rounded-full border border-emerald-400/20">
                        <CheckCircle className="w-4 h-4" /> Processed
                      </span>
                    )}
                    {b.status === 'rejected' && (
                      <span className="flex items-center gap-2 text-[10px] font-black uppercase text-rose-400 bg-rose-400/10 px-5 py-2.5 rounded-full border border-rose-400/20">
                        <AlertCircle className="w-4 h-4" /> Rejected
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="bg-slate-900 p-8 rounded-[2.5rem] border border-slate-800 shadow-2xl space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black flex items-center gap-3">
            <div className="w-10 h-10 bg-sky-500/10 rounded-xl flex items-center justify-center">
              <Users className="w-5 h-5 text-sky-400" />
            </div>
            Table Buy-Ins
          </h2>
          <div className="text-right">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Table Pot</p>
            <p className="text-xl font-black text-sky-400 tabular-nums">₹{tablePot.toLocaleString()}</p>
          </div>
        </div>

        {tableBuyIns.length === 0 ? (
          <div className="text-center py-12 bg-slate-950/50 rounded-3xl border border-slate-800/50">
            <p className="text-slate-600 font-bold italic text-sm">No approved buy-ins at the table yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tableBuyIns.map((row, idx) => {
              const share = potShare(row.total, tablePot);
              return (
                <div
                  key={row.userId}
                  className={`relative bg-slate-950 p-4 rounded-2xl border ${row.isSelf ? 'border-emerald-500/40' : 'border-slate-800'} overflow-hidden`}
                >
                  <div
                    className={`absolute inset-y-0 left-0 ${row.isSelf ? 'bg-emerald-500/10' : 'bg-sky-500/5'}`}
                    style={{ width: `${share}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black ${row.isSelf ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {idx + 1}
                      </div>
                      <div>
                        <p className="text-sm font-black text-white">
                          {row.name}
                          {row.isSelf && <span className="ml-2 text-[9px] font-black text-emerald-400 uppercase tracking-widest">You</span>}
                        </p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">{share.toFixed(0)}% of pot</p>
                      </div>
                    </div>
                    <p className="text-lg font-black text-white tabular-nums">₹{row.total.toLocaleString()}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="text-center py-8 space-y-4 opacity-40">
        <ShieldCheck className="w-10 h-10 mx-auto text-slate-700" />
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
          Audit-Ready Environment
        </p>
        <p className="text-[9px] text-slate-600 max-w-[200px] mx-auto leading-relaxed">
          All requests are timestamped and recorded in the table's global ledger.
        </p>
      </div>
    </div>
  );
}
