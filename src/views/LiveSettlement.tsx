import React, { useState, useEffect, useMemo } from 'react';
import { liveApi, LiveUser, LiveSettlementTx } from '../services/liveApi';
import { computePlayerResults, computeSettlements } from '../lib/settlement';
import { ArrowRight, Trophy, Coins, CheckCircle2, Upload, Check } from 'lucide-react';

interface Props {
  user: LiveUser;
  sessionId: string;
  navigate: (path: string) => void;
}

export default function LiveSettlement({ user, sessionId, navigate }: Props) {
  const [data, setData] = useState<{
    session: any;
    players: any[];
    buyIns: any[];
  }>({ session: null, players: [], buyIns: [] });
  const [publishState, setPublishState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await liveApi.getSession(sessionId);
      if (result) {
        setData({
          session: result.session,
          players: result.players,
          buyIns: result.buyIns.filter((b) => b.status === 'approved'),
        });
        if (result.session.publishedToLedger) setPublishState('done');
      }
    };
    load();
  }, [sessionId]);

  const handlePublish = async () => {
    if (!data.session) return;
    setPublishError(null);
    setPublishState('loading');
    const result = await liveApi.publishToLedger(data.session.id);
    if (result.success) {
      setPublishState('done');
      setData((d) => ({
        ...d,
        session: d.session
          ? { ...d.session, publishedToLedger: true, publishedSessionId: result.fishesSessionId }
          : d.session,
      }));
    } else {
      setPublishError(result.error);
      setPublishState('idle');
    }
  };

  const results = useMemo(
    () => computePlayerResults(data.players, data.buyIns),
    [data]
  );

  const settlements = useMemo<LiveSettlementTx[]>(
    () => computeSettlements(results),
    [results]
  );

  if (!data.session) {
    return (
      <div className="text-center py-20 text-slate-500">
        Session data unavailable.{' '}
        <button onClick={() => navigate('lobby')} className="text-emerald-500 font-bold">
          Return to Lobby
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-12">
      <div className="text-center space-y-2">
        <Trophy className="w-12 h-12 text-amber-500 mx-auto" />
        <h1 className="text-3xl font-black text-white">{data.session.name} — Final</h1>
        <p className="text-slate-500">Results and settlement instructions</p>
      </div>

      {/* Performance Ledger */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="bg-slate-950 px-6 py-4 border-b border-slate-800">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
            <Coins className="w-4 h-4" /> Performance Ledger
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-950/50">
              <tr>
                <th className="px-6 py-4 text-xs font-bold text-slate-500">Player</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 text-right">In</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 text-right">Out</th>
                <th className="px-6 py-4 text-xs font-bold text-slate-500 text-right">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {results.map((r) => (
                <tr
                  key={r.userId}
                  className={r.userId === user.id ? 'bg-emerald-500/5' : ''}
                >
                  <td className="px-6 py-4 font-bold text-white">
                    {r.name}
                    {r.userId === user.id && (
                      <span className="text-[10px] text-emerald-400 font-normal"> (You)</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right font-mono text-slate-400">₹{r.buyIn}</td>
                  <td className="px-6 py-4 text-right font-mono text-slate-200">₹{r.winnings}</td>
                  <td
                    className={`px-6 py-4 text-right font-mono font-bold ${
                      r.net >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {r.net >= 0 ? `+₹${r.net}` : `-₹${Math.abs(r.net)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Who pays whom */}
      <section className="bg-emerald-500 rounded-3xl p-6 shadow-xl shadow-emerald-500/10 text-slate-950">
        <h2 className="text-xl font-black mb-6 flex items-center gap-2">
          <CheckCircle2 className="w-6 h-6" /> Settlements — Who Pays Whom
        </h2>
        <div className="space-y-3">
          {settlements.length === 0 ? (
            <p className="text-center font-bold py-4">No payments needed. Everyone broke even!</p>
          ) : (
            settlements.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-white/20 backdrop-blur-sm p-4 rounded-2xl border border-white/30"
              >
                <span className="font-bold flex-1">{s.from}</span>
                <div className="flex flex-col items-center px-4">
                  <span className="text-lg font-black leading-tight">₹{s.amount}</span>
                  <ArrowRight className="w-4 h-4" />
                </div>
                <span className="font-bold flex-1 text-right">{s.to}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Publish to Leaderboard — host only */}
      {data.session.createdBy === user.id && (
        <section className="flex flex-col items-center gap-2 pt-2">
          {publishState === 'done' ? (
            <>
              <button
                type="button"
                disabled
                className="px-8 py-4 bg-slate-800 border border-slate-700 rounded-2xl font-bold text-slate-400 cursor-not-allowed flex items-center gap-2"
              >
                <Check className="w-4 h-4" /> Already Published
              </button>
              {data.session.publishedSessionId != null && (
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                  Fishes session #{data.session.publishedSessionId}
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={handlePublish}
              disabled={publishState === 'loading'}
              className="px-8 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-wait text-slate-950 font-black rounded-2xl transition-all shadow-xl shadow-emerald-500/20 active:scale-95 flex items-center gap-2"
            >
              {publishState === 'loading' ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-slate-950/40 border-t-slate-950 rounded-full animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Publish to Leaderboard
                </>
              )}
            </button>
          )}
          {publishError && (
            <p className="text-rose-400 text-xs font-bold uppercase tracking-wider text-center max-w-md">
              {publishError}
            </p>
          )}
        </section>
      )}

      <div className="flex justify-center pt-4">
        <button
          onClick={() => navigate('lobby')}
          className="px-8 py-4 bg-slate-900 border border-slate-800 rounded-2xl font-bold hover:bg-slate-800 transition-all shadow-xl active:scale-95 text-white"
        >
          Back to Lobby
        </button>
      </div>
    </div>
  );
}
