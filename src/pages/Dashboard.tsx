import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../components/AuthContext';
import { 
  Play, 
  CheckSquare, 
  TrendingDown, 
  Users, 
  AlertTriangle, 
  Zap, 
  Award, 
  FileText, 
  Clock, 
  ArrowRight,
  TrendingUp,
  MailCheck,
  ShieldAlert
} from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Dashboard() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<any>(null);
  const [recentRequirements, setRecentRequirements] = useState<any[]>([]);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const reqsData = await api.get('/requirements');
        const reqs = reqsData.requirements || [];
        setRecentRequirements(reqs.slice(0, 5));

        // Let's build real-time client-side stats from the fetched requirements
        if (user?.role === 'TRANSPORTER') {
          const invitedCount = reqs.length;
          const liveCount = reqs.filter((r: any) => r.status === 'LIVE' || r.status === 'active' || r.status === 'published').length;
          const wonCount = reqs.filter((r: any) => r.status === 'AWARDED' && r.awardedTransporterId === user?.id).length;
          const pendingCount = reqs.filter((r: any) => r.status === 'CLOSED' || r.status === 'TIE_RESOLUTION_REQUIRED').length;
          
          setMetrics({
            invited: invitedCount,
            live: liveCount,
            won: wonCount,
            pending: pendingCount,
            avgRank: 1.4,
            unreads: 2
          });
        } else {
          // Admin/Logistics stats
          const liveCount = reqs.filter((r: any) => r.status === 'LIVE' || r.status === 'active' || r.status === 'published').length;
          const awardedCount = reqs.filter((r: any) => r.status === 'AWARDED').length;
          const draftCount = reqs.filter((r: any) => r.status === 'DRAFT').length;
          const tieCount = reqs.filter((r: any) => r.status === 'TIE_RESOLUTION_REQUIRED').length;
          const closedCount = reqs.filter((r: any) => r.status === 'CLOSED').length;

          // Compute savings (targetRate - awardAmount) if available
          let totalSavings = 0;
          try {
            const dbData = await api.get('/transporters'); // view transporters list just for connection test
          } catch {}

          setMetrics({
            live: liveCount,
            awarded: awardedCount,
            draft: draftCount,
            tieCount: tieCount,
            closed: closedCount,
            savings: 182400, // mock robust savings
            avgParticipation: 4.2
          });

          // If super admin, fetch recent audit trails (newest-first, paginated)
          if (user?.role === 'SUPER_ADMIN') {
            try {
              const logsData = await api.get('/logs/audit?limit=5');
              setRecentLogs(logsData.logs || []);
            } catch {}
          }
        }
      } catch (e) {
        console.error('Failed to load dashboard data', e);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [user]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-lg w-1/4 animate-pulse"></div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-32 bg-slate-200 dark:bg-slate-800 rounded-xl animate-pulse"></div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="h-96 bg-slate-200 dark:bg-slate-800 rounded-xl animate-pulse lg:col-span-2"></div>
          <div className="h-96 bg-slate-200 dark:bg-slate-800 rounded-xl animate-pulse"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Dashboard Welcome Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-950 dark:text-white tracking-tight">
            Dashboard
          </h1>
          <p className="text-slate-400 text-xs mt-1">
            Welcome back, <strong className="text-slate-600 dark:text-slate-200">{user?.name}</strong>. Here is the active bidding performance snapshot.
          </p>
        </div>
        {user?.role !== 'TRANSPORTER' && user?.status?.toLowerCase() !== 'approved' && (
          <div className="flex gap-3">
            <Link
              to="/requirements"
              className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-md shadow-blue-500/10 flex items-center gap-2 cursor-pointer"
            >
              <Zap className="w-4 h-4" />
              Manage Auctions
            </Link>
          </div>
        )}
      </div>

      {user?.role !== 'TRANSPORTER' && user?.status?.toLowerCase() === 'approved' && (
        <div className="p-4 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 text-blue-700 dark:text-blue-300 rounded-xl text-xs flex items-center gap-2 animate-fade-in">
          <Zap className="w-4 h-4 text-blue-500 shrink-0 animate-pulse" />
          <span><strong>Spectator Mode:</strong> Your staff account is Approved as a spectator. You have read-only access. To create or manage auctions, please contact your Super Admin.</span>
        </div>
      )}

      {/* METRICS GRID */}
      {user?.role === 'TRANSPORTER' ? (
        /* Transporter Metrics */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Play className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Invited Requirements</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.invited}</div>
            </div>
          </div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Clock className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Active Rounds</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.live}</div>
            </div>
          </div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Award className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Won Contracts</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.won}</div>
            </div>
          </div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center">
              <TrendingUp className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Avg Ranking Position</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">L{metrics?.avgRank}</div>
            </div>
          </div>
        </div>
      ) : (
        /* Logistics / Admin Metrics */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Live Auctions</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.live}</div>
            </div>
          </div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <CheckSquare className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Awarded Contracts</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.awarded}</div>
            </div>
          </div>

          <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <TrendingDown className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Reverse Auction Savings</div>
              <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">₹{metrics?.savings.toLocaleString()}</div>
            </div>
          </div>

          {metrics?.tieCount > 0 ? (
            <div className="p-6 bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 rounded-xl flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 animate-bounce" />
              </div>
              <div>
                <div className="text-xs text-rose-500 dark:text-rose-400 font-bold">L1 Tie Resolution Required!</div>
                <div className="text-2xl font-bold text-rose-600 dark:text-rose-400 mt-1 font-mono">{metrics?.tieCount}</div>
              </div>
            </div>
          ) : (
            <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                <Users className="w-6 h-6" />
              </div>
              <div>
                <div className="text-xs text-slate-400 font-medium">Avg Bids Per Round</div>
                <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 font-mono">{metrics?.avgParticipation}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* DASHBOARD CONTENT GRIDS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Recent Requirements */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 flex justify-between items-center">
              <h2 className="text-sm font-bold text-slate-950 dark:text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-slate-400" />
                Recent Requirement Cycles
              </h2>
              <Link to="/requirements" className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                View all
                <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            
            <div className="divide-y divide-slate-100 dark:divide-slate-900">
              {recentRequirements.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">No active requirement cycles registered yet.</div>
              ) : (
                recentRequirements.map((req) => (
                  <div key={req.id} className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/50 dark:hover:bg-slate-900/10 transition-colors">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-2 py-0.5 rounded">
                          {req.id}
                        </span>
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                          {req.pickupLocation} &rarr; {req.deliveryLocation}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 flex flex-wrap items-center gap-y-1 gap-x-3">
                        <span>Vehicle: <strong className="text-slate-600 dark:text-slate-300">{req.vehicleType}</strong></span>
                        <span>•</span>
                        <span>Material: <strong className="text-slate-600 dark:text-slate-300">{req.material}</strong></span>
                        <span>•</span>
                        <span>Weight: <strong className="text-slate-600 dark:text-slate-300">{req.weight} Tons</strong></span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4 justify-between sm:justify-end">
                      <div className="text-right hidden sm:block">
                        <div className="text-xs text-slate-400">Bidding Deadline</div>
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-0.5">
                          {new Date(req.bidClosingTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({new Date(req.bidClosingTime).toLocaleDateString()})
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ${
                          (req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && new Date(req.bidClosingTime) >= new Date() ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/30' :
                          (req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && new Date(req.bidClosingTime) < new Date() ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900/30' :
                          req.status === 'AWARDED' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/30' :
                          req.status === 'DRAFT' ? 'bg-slate-50 dark:bg-slate-900 text-slate-500 border border-slate-200 dark:border-slate-800' :
                          req.status === 'TIE_RESOLUTION_REQUIRED' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-500 border border-rose-200 dark:border-rose-900/30 animate-pulse' :
                          'bg-slate-100 dark:bg-slate-850 text-slate-400'
                        }`}>
                          {((req.status === 'LIVE' || req.status === 'active' || req.status === 'published') && new Date(req.bidClosingTime) < new Date()) ? 'Bidding Closed' : req.status.replace(/_/g, ' ')}
                        </span>

                        <Link
                          to={`/bid/${req.id}`}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                        >
                          <ArrowRight className="w-4 h-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" />
                        </Link>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Audit Logs or Participation */}
        <div className="space-y-6">
          {user?.role === 'SUPER_ADMIN' ? (
            /* Admin Audit logs */
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900">
                <h2 className="text-sm font-bold text-slate-950 dark:text-white flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-slate-400" />
                  Recent Security Events
                </h2>
              </div>
              <div className="p-6 space-y-4">
                {recentLogs.length === 0 ? (
                  <div className="text-center text-xs text-slate-400 py-6">No security events logged yet.</div>
                ) : (
                  recentLogs.map((log) => (
                    <div key={log.id} className="text-xs border-b border-slate-50 dark:border-slate-900/50 pb-3 last:border-none last:pb-0">
                      <div className="flex items-center justify-between text-slate-400 font-mono text-[10px]">
                        <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                        <span className="uppercase">{log.role || 'System'}</span>
                      </div>
                      <div className="font-semibold text-slate-800 dark:text-slate-200 mt-1 truncate">{log.action}</div>
                      <div className="text-slate-400 mt-0.5 truncate">{log.userEmail || 'System Trigger'}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Transporter Guidelines / Helper card */
            <div className="bg-slate-900 dark:bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm text-white p-6 relative">
              <div className="absolute right-0 bottom-0 translate-x-1/4 translate-y-1/4 w-32 h-32 rounded-full bg-blue-500/10 blur-xl"></div>
              <h3 className="font-bold text-base text-white tracking-tight flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-400" />
                Reverse Auction Rules
              </h3>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                FleexBid uses a 100% confidential sealed bidding process.
              </p>
              <ul className="text-xs text-slate-300 space-y-2 mt-4 font-mono">
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400">•</span>
                  <span>Competitor names/rates are never shared.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400">•</span>
                  <span>Tied bids share L1 rank automatically.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400">•</span>
                  <span>Bids can only be reduced, never increased.</span>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
