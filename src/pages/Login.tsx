import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { Truck, Mail, Key, Phone, ArrowRight, ShieldAlert, CheckCircle2, Sparkles, ShieldCheck, UserCheck } from 'lucide-react';

export default function Login() {
  const { loginStaff, loginTransporter, user } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'staff' | 'transporter'>('transporter');
  
  // Staff credentials state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Transporter state
  const [transporterEmail, setTransporterEmail] = useState('');
  const [transporterPassword, setTransporterPassword] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);

  // Status message states
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // If already logged in, redirect
  React.useEffect(() => {
    if (user) {
      navigate('/dashboard');
    }
  }, [user, navigate]);

  const handleStaffLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please provide corporate email and password');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await loginStaff(email, password);
      setSuccess('Logged in successfully! Loading your workspace...');
      setTimeout(() => navigate('/dashboard'), 800);
    } catch (err: any) {
      setError(err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  const handleTransporterLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transporterEmail || !transporterPassword) {
      setError('Registered email address and secure password are required');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await loginTransporter(transporterEmail.trim().toLowerCase(), transporterPassword);
      setSuccess('Logged in successfully! Loading your carrier workspace...');
      setTimeout(() => navigate('/dashboard'), 800);
    } catch (err: any) {
      setError(err.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-6 md:p-12 transition-colors duration-200">
      
      {/* Main Login Card */}
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        {/* Top brand header */}
        <div className="px-8 pt-8 pb-6 bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-900 flex flex-col items-center">
          <div className="w-12 h-12 rounded-xl bg-blue-600 dark:bg-blue-500 flex items-center justify-center text-white font-extrabold text-2xl shadow-lg shadow-blue-500/25 mb-4">
            L
          </div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">FleexBid Secure Gateway</h2>
          <p className="text-xs text-slate-400 mt-1 font-mono text-center">
            ROBUST SEALED REVERSE AUCTIONS FOR LOGISTICS
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex p-1 bg-slate-100 dark:bg-slate-950 mx-8 mt-6 rounded-lg border border-slate-200/50 dark:border-slate-800/50">
          <button
            onClick={() => {
              setActiveTab('transporter');
              setError(null);
              setSuccess(null);
            }}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-all ${
              activeTab === 'transporter'
                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Transporter Login
          </button>
          <button
            onClick={() => {
              setActiveTab('staff');
              setError(null);
              setSuccess(null);
            }}
            className={`flex-1 py-2 text-xs font-semibold rounded-md transition-all ${
              activeTab === 'staff'
                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Staff Login
          </button>
        </div>

        {/* Error / Success Banners */}
        <div className="px-8 mt-6">
          {error && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{success}</span>
            </div>
          )}
        </div>

        {/* Login Forms */}
        <div className="p-8">
          {activeTab === 'staff' ? (
            /* Staff form */
            <form onSubmit={handleStaffLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                  Corporate Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:text-white transition-all placeholder-slate-400"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Password
                  </label>
                  {/* Self-service password reset is intentionally not offered:
                      staff passwords are reset by the Super Admin (Staff page);
                      transporter passwords are reset by staff (Transporters page). */}
                </div>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:text-white transition-all placeholder-slate-400"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg text-sm shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {loading ? 'Authenticating...' : 'Sign In To Console'}
                {!loading && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>
          ) : (
            /* Transporter form */
            <form onSubmit={handleTransporterLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                  Registered Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="email"
                    value={transporterEmail}
                    onChange={(e) => setTransporterEmail(e.target.value)}
                    placeholder="transporter@company.com"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:text-white transition-all placeholder-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="password"
                    value={transporterPassword}
                    onChange={(e) => setTransporterPassword(e.target.value)}
                    placeholder="••••••••••••"
                    disabled={loading}
                    className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:text-white transition-all placeholder-slate-400"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Enter your authorized registered email address and secure password to sign into your Transporter account.
              </p>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-sm shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {loading ? 'Authenticating...' : 'Sign In To Console'}
                {!loading && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>
          )}
        </div>

        {/* Footer help */}
        <div className="px-8 pb-8 text-center text-[11px] text-slate-400/80 border-t border-slate-100 dark:border-slate-900 pt-4 font-mono">
          © 2026 FLEEXBID SYSTEMS • SECURE BIDDING NETWORKS
        </div>
      </div>

    </div>
  );
}
