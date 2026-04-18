import React, { useState } from 'react';
import { liveApi, LiveUser } from '../services/liveApi';
import { LogIn, UserPlus, ShieldCheck } from 'lucide-react';

interface LiveLoginProps {
  onLogin: (user: LiveUser) => void;
}

export default function LiveLogin({ onLogin }: LiveLoginProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const switchMode = (m: 'signin' | 'signup') => {
    setMode(m);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'signup') {
      if (!name.trim() || !username.trim() || !password.trim()) {
        setError('All fields are required');
        return;
      }
      const result = await liveApi.register(name, username, password);
      if (result.success && result.user) {
        onLogin(result.user);
      } else {
        setError(result.error || 'Registration failed');
      }
    } else {
      if (!username.trim() || !password.trim()) {
        setError('Username and password are required');
        return;
      }
      const result = await liveApi.login(username, password);
      if (result.success && result.user) {
        onLogin(result.user);
      } else {
        setError(result.error || 'Authentication failed');
      }
    }
  };

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 animate-slide">
        <div className="text-center">
          <div className="mx-auto w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center text-slate-950 text-4xl font-black mb-4 shadow-xl shadow-emerald-500/20">
            ♠
          </div>
          <h2 className="text-3xl font-black tracking-tight mb-1">Live Play</h2>
          <p className="text-slate-400 text-sm font-semibold tracking-wide uppercase">
            Real-time session management
          </p>
        </div>

        {/* Mode toggle */}
        <div className="glass p-1.5 rounded-2xl flex gap-1">
          <button
            type="button"
            onClick={() => switchMode('signin')}
            className={`flex-1 py-3 rounded-xl text-xs font-bold transition-all ${
              mode === 'signin' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => switchMode('signup')}
            className={`flex-1 py-3 rounded-xl text-xs font-bold transition-all ${
              mode === 'signup' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'signup' && (
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                Full Name
              </label>
              <input
                type="text"
                required
                className="appearance-none block w-full px-4 py-4 border border-slate-800 placeholder:text-slate-600 text-slate-50 rounded-xl bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all text-sm font-bold"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
              Username
            </label>
            <input
              type="text"
              required
              className="appearance-none block w-full px-4 py-4 border border-slate-800 placeholder:text-slate-600 text-slate-50 rounded-xl bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all text-sm font-bold"
              placeholder="poker_pro_123"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
              Password
            </label>
            <input
              type="password"
              required
              className="appearance-none block w-full px-4 py-4 border border-slate-800 placeholder:text-slate-600 text-slate-50 rounded-xl bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all text-sm font-bold"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-rose-500 text-[10px] text-center font-bold uppercase tracking-wider">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full flex justify-center items-center gap-2 py-5 px-4 text-sm font-black rounded-xl text-slate-950 bg-emerald-500 hover:bg-emerald-400 focus:outline-none transition-all active:scale-95 shadow-xl shadow-emerald-500/20"
          >
            {mode === 'signin' ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            {mode === 'signin' ? 'Access Live Play' : 'Create Profile'}
          </button>
        </form>

        <div className="flex items-center justify-center gap-2 pt-2 opacity-30">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            Separate from Fishes Ledger account
          </span>
        </div>
      </div>
    </div>
  );
}
