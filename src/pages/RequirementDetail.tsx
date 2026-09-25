import React, { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useAuth } from '../components/AuthContext';
import { 
  ArrowLeft, 
  Clock, 
  MapPin, 
  Truck, 
  Layers, 
  FileText, 
  Info, 
  ShieldAlert, 
  CheckCircle2, 
  Trophy, 
  DollarSign, 
  Users, 
  AlertTriangle,
  ChevronRight,
  TrendingDown,
  Timer,
  Send
} from 'lucide-react';
import ExportAwardPdfButton from '../components/OfficialAwardPdf';
import { parseAsIst, formatIstLabel } from '../lib/istTime';

// Same base the API client uses, so the stream URL follows any deployment that
// points the frontend at a separate API origin.
const API_BASE = ((import.meta.env.VITE_API_URL as string) || '/api').replace(/\/$/, '');
// Only used when the event stream is unavailable (see the realtime effect below).
const POLL_FALLBACK_MS = 5000;

export default function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [requirement, setRequirement] = useState<any>(null);
  const [ranks, setRanks] = useState<any[]>([]);
  const [invitedTransporters, setInvitedTransporters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [bidAmount, setBidAmount] = useState('');
  
  // Status feedback states
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awardingId, setAwardingId] = useState<string | null>(null);
  const [tieBreakLog, setTieBreakLog] = useState('');

  // Custom modal confirmation states
  const [confirmAwardId, setConfirmAwardId] = useState<string | null>(null);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);

  // Countdown state
  const [timeLeft, setTimeLeft] = useState('');
  const [isExpired, setIsExpired] = useState(false);

  // Initial load. Live updates are handled by the realtime effect below.
  useEffect(() => {
    loadRequirementAndRanks();
  }, [id]);

  // Realtime transport: Server-Sent Events, with polling as the safety net.
  //
  // WHY NOT SOCKET.IO: vercel.json rewrites every path to /index.html, so the
  // /socket.io/ handshake is answered with HTML and can never connect - and the
  // serverless runtime has no process to hold a websocket anyway. SSE needs no
  // upgrade handshake, so it survives that rewrite and works on the deployed
  // host. Previously ranks loaded ONCE on mount and then never changed: a bidder
  // could sit on a bidding screen indefinitely without seeing a competitor's
  // new bid, a rank change, or an award.
  //
  // The server deliberately ends each stream after ~25s and the browser
  // reconnects on its own, which keeps a connection inside the host's function
  // duration budget. If the stream cannot be established (or an intermediary
  // buffers it into uselessness) the failure counter hands over to the polling
  // loop, so freshness is never worse than it was before this change. Runs only
  // while the auction is OPEN - the round reaching a terminal state is itself a
  // change, so there is nothing left to watch after that.
  useEffect(() => {
    if (!requirement) return;
    const isOpen =
      requirement.status === 'LIVE' ||
      requirement.status === 'active' ||
      requirement.status === 'published';
    if (!isOpen) return;

    let disposed = false;
    let source: EventSource | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let streamFailures = 0;

    const startPolling = () => {
      if (disposed || pollInterval !== null) return;
      // Silent refetch: no spinner, so it can never cause a layout shift.
      pollInterval = setInterval(() => {
        if (!disposed) loadRequirementAndRanks(true);
      }, POLL_FALLBACK_MS);
    };

    const stopPolling = () => {
      if (pollInterval === null) return;
      clearInterval(pollInterval);
      pollInterval = null;
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      source = new EventSource(`${API_BASE}/requirements/${id}/stream`, { withCredentials: true });

      source.addEventListener('ready', () => {
        // A healthy stream beats polling: an auction change is pushed the moment
        // it happens, instead of being discovered on the next tick.
        streamFailures = 0;
        stopPolling();
      });

      source.addEventListener('update', () => {
        if (!disposed) loadRequirementAndRanks(true);
      });

      source.onerror = () => {
        // EventSource retries on its own. Two consecutive failures mean the
        // stream is unusable here, so fall back to polling rather than leave the
        // page stale.
        streamFailures += 1;
        if (streamFailures >= 2) {
          source?.close();
          source = null;
          startPolling();
        }
      };
    }

    return () => {
      disposed = true;
      stopPolling();
      source?.close();
    };
  }, [requirement?.status, id]);

  async function loadRequirementAndRanks(silent = false) {
    if (!silent) setLoading(true);
    try {
      const reqData = await api.get(`/requirements/${id}`);
      setRequirement(reqData.requirement);
      setInvitedTransporters(reqData.invitedTransporters || []);
      
      const ranksData = await api.get(`/requirements/${id}/ranks`);
      setRanks(ranksData.ranks || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load requirement details');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadRanks() {
    try {
      const ranksData = await api.get(`/requirements/${id}/ranks`);
      setRanks(ranksData.ranks || []);
    } catch (e) {
      console.error('Ranks reload failed', e);
    }
  }

  // Countdown timer calculation
  useEffect(() => {
    if (!requirement) return;

    const status = requirement.status;
    const isTerminal = status === 'AWARDED' || status === 'CLOSED' || status === 'CANCELLED' || status === 'TIE_RESOLUTION_REQUIRED' || status === 'DRAFT';
    
    if (isTerminal) {
      if (status === 'AWARDED') {
        setTimeLeft('Requirement Awarded');
      } else if (status === 'CLOSED') {
        setTimeLeft('Bidding Closed');
      } else if (status === 'CANCELLED') {
        setTimeLeft('Bidding Cancelled');
      } else if (status === 'TIE_RESOLUTION_REQUIRED') {
        setTimeLeft('Tie Resolution Required');
      } else {
        setTimeLeft('Draft Mode');
      }
      setIsExpired(true);
      return;
    }

    const interval = setInterval(() => {
      const now = new Date().getTime();
      // Closing times are entered in IST; parseAsIst normalizes both legacy
      // naive strings and proper ISO instants to the correct UTC moment.
      const end = parseAsIst(requirement.bidClosingTime).getTime();
      const diff = end - now;

      if (diff <= 0) {
        setTimeLeft('Bidding Closed');
        setIsExpired(true);
        clearInterval(interval);
      } else {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);
        
        const pad = (num: number) => String(num).padStart(2, '0');
        setTimeLeft(`${pad(hours)}h : ${pad(mins)}m : ${pad(secs)}s`);
        setIsExpired(false);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [requirement]);

  // Handle Bid Submission
  const handleBidSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bidAmount || isNaN(Number(bidAmount)) || Number(bidAmount) <= 0) {
      setError('Please provide a valid positive bid quotation.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await api.post(`/requirements/${id}/bid`, { amount: Number(bidAmount) });
      setSuccess('Your quotation was submitted successfully!');
      setBidAmount('');
      loadRequirementAndRanks();
    } catch (err: any) {
      setError(err.message || 'Bid submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Manual Award — staff may award to ANY quoted transporter on the
  // board (any rank, tied or untied). The resolution note is optional.
  const handleAward = (transporterId: string) => {
    setConfirmAwardId(transporterId);
  };

  const executeAward = async (transporterId: string) => {
    setConfirmAwardId(null);
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await api.post(`/requirements/${id}/award`, {
        transporterId,
        tieBreakLog: tieBreakLog.trim() || 'Manual discretionary award'
      });
      setSuccess('Contract awarded successfully! Participating transporters have been notified.');
      setTieBreakLog('');
      loadRequirementAndRanks(true);
    } catch (err: any) {
      setError(err.message || 'Award process failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePublish = () => {
    setShowPublishConfirm(true);
  };

  const executePublish = async () => {
    setShowPublishConfirm(false);
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      await api.put(`/requirements/${id}/publish`);
      setSuccess('Requirement published successfully!');
      loadRequirementAndRanks(true);
    } catch (err: any) {
      setError(err.message || 'Publish failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-6 bg-slate-200 dark:bg-slate-800 rounded w-1/4 animate-pulse"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="h-64 bg-slate-200 dark:bg-slate-800 rounded-xl md:col-span-2 animate-pulse"></div>
          <div className="h-64 bg-slate-200 dark:bg-slate-800 rounded-xl animate-pulse"></div>
        </div>
      </div>
    );
  }

  if (!requirement) {
    return (
      <div className="p-8 text-center bg-white dark:bg-slate-900 border rounded-xl space-y-4">
        <ShieldAlert className="w-12 h-12 text-rose-500 mx-auto" />
        <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">Unable to load auction workspace</h3>
        <p className="text-xs text-slate-400 max-w-sm mx-auto">{error || 'This auction is either restricted or does not exist.'}</p>
        <Link to="/requirements" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition-colors inline-block">
          Go back to lists
        </Link>
      </div>
    );
  }

  // Check tie conditions
  const l1Bids = ranks.filter(r => r.isL1 && r.amount !== null);
  const isL1Tie = l1Bids.length > 1;
  const ownRank = ranks.find(r => r.transporterId === user?.id);

  return (
    <div className="space-y-8">
      {/* Breadcrumb Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
          <Link to="/requirements" className="hover:text-blue-600 transition-colors">Requirements</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="font-mono">{requirement.id}</span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-900 pb-4">
          <div className="flex items-center gap-3">
            <Link to="/requirements" className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-500 transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="text-xl font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
                {requirement.pickupLocation} &rarr; {requirement.deliveryLocation}
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">Sealed Reverse Auction Workspace</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 self-start sm:self-auto">
            {requirement.status === 'AWARDED' && (
              <ExportAwardPdfButton requirement={requirement} />
            )}
            <span className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border ${
              requirement.status === 'LIVE' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/30' :
              requirement.status === 'AWARDED' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/30' :
              requirement.status === 'DRAFT' ? 'bg-slate-50 dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-800' :
              requirement.status === 'TIE_RESOLUTION_REQUIRED' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-500 border-rose-200 dark:border-rose-900/30 animate-pulse' :
              'bg-slate-100 dark:bg-slate-800 text-slate-400'
            }`}>
              {requirement.status.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
      </div>

      {/* FEEDBACK NOTIFICATION AREA */}
      {(error || success) && (
        <div className="space-y-2">
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
      )}

      {/* AWARDED STATUS BANNER FOR TRANSPORTERS */}
      {user?.role === 'TRANSPORTER' && requirement.status === 'AWARDED' && (
        requirement.awardedTransporterId === user?.id ? (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30 text-emerald-800 dark:text-emerald-300">
            <Trophy className="w-8 h-8 text-emerald-500 shrink-0 animate-bounce" />
            <div>
              <h3 className="text-sm font-bold">Contract Awarded!</h3>
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
                Congratulations! Your bid of ₹{requirement.awardedAmount?.toLocaleString() || 'N/A'} was selected. Our logistics team will contact you shortly with dispatch details.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
            <Info className="w-8 h-8 text-slate-400 shrink-0" />
            <div>
              <h3 className="text-sm font-bold">Contract Concluded</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                This contract has been awarded to another transporter. Thank you for your competitive proposal and we look forward to bidding with you on future cycles.
              </p>
            </div>
          </div>
        )
      )}

      {/* THREE BOX BENTO GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* LEFT COLUMN: REQUIREMENT CARD */}
        <div className="lg:col-span-2 space-y-8">
          
          {/* Detailed Specifications */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
            <h3 className="text-sm font-bold text-slate-950 dark:text-white uppercase tracking-wider border-b border-slate-100 dark:border-slate-900 pb-3">
              Technical Specifications
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <Truck className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Vehicle Requested</div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{requirement.vehicleType}</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Material / Weight</div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{requirement.material} ({requirement.weight} Tons)</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Required Placement Date</div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{new Date(requirement.pickupDate).toLocaleDateString()}</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                  <DollarSign className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Award Policy Rule</div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5 capitalize">{requirement.awardType.toLowerCase()} Awarding</div>
                </div>
              </div>
            </div>

            {requirement.vehicleSpecs && (
              <div className="p-4 rounded-xl border space-y-1.5 bg-amber-50/70 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/30">
                <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Vehicle Specifications / Remarks</div>
                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed font-mono whitespace-pre-wrap">{requirement.vehicleSpecs}</p>
              </div>
            )}

            {requirement.specialInstructions && (
              <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Special Instructions</div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-mono">{requirement.specialInstructions}</p>
              </div>
            )}
          </div>

          {/* ACTIVE BIDDING / RANKINGS PANEL */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/50">
              <h3 className="text-sm font-bold text-slate-950 dark:text-white uppercase tracking-wider">
                {user?.role === 'TRANSPORTER' ? 'My Confidential Bidding Status' : 'Real-Time Bid Board'}
              </h3>
              
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Users className="w-4 h-4" />
                <span>{ranks.filter(r => r.amount !== null).length} bids submitted</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-900 text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50/20 dark:bg-slate-900/20">
                    <th className="px-6 py-3">Rank</th>
                    {user?.role !== 'TRANSPORTER' && <th className="px-6 py-3">Carrier / Transporter</th>}
                    <th className="px-6 py-3">My Bid Amount</th>
                    <th className="px-6 py-3">Last Active Timestamp</th>
                    {user?.role !== 'TRANSPORTER' && <th className="px-6 py-3">Award Selection</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-900">
                  {ranks.length === 0 ? (
                    <tr>
                      <td colSpan={user?.role === 'TRANSPORTER' ? 3 : 5} className="p-8 text-center text-xs text-slate-400">
                        No invitations processed yet.
                      </td>
                    </tr>
                  ) : (
                    ranks.map((row) => {
                      const isOwn = row.transporterId === user?.id;
                      const hasBid = row.amount !== null;

                      return (
                        <tr 
                          key={row.transporterId}
                          className={`text-xs transition-colors ${
                            isOwn 
                              ? 'bg-blue-50/30 dark:bg-blue-950/25 font-semibold' 
                              : 'hover:bg-slate-50/50 dark:hover:bg-slate-900/10'
                          }`}
                        >
                          <td className="px-6 py-4">
                            {row.rank ? (
                              <span className={`px-2 py-0.5 rounded-full font-bold font-mono ${
                                row.isL1 
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' 
                                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                              }`}>
                                L{row.rank}
                              </span>
                            ) : (
                              <span className="text-slate-300 dark:text-slate-700 font-mono">—</span>
                            )}
                          </td>

                          {user?.role !== 'TRANSPORTER' && (
                            <td className="px-6 py-4 font-semibold text-slate-800 dark:text-slate-200">
                              {row.companyName}
                            </td>
                          )}

                          <td className="px-6 py-4 font-mono text-sm font-semibold text-slate-900 dark:text-white">
                            {hasBid ? `₹${row.amount.toLocaleString()}` : <span className="text-slate-400 font-normal">Pending Quote</span>}
                          </td>

                          <td className="px-6 py-4 text-slate-400 font-mono text-[10px]">
                            {row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : 'N/A'}
                          </td>

                          {user?.role !== 'TRANSPORTER' && user?.status?.toLowerCase() !== 'approved' && (
                            <td className="px-6 py-4">
                              {hasBid && (requirement.status === 'CLOSED' || requirement.status === 'TIE_RESOLUTION_REQUIRED' || requirement.status === 'LIVE') && (
                                <button
                                  onClick={() => handleAward(row.transporterId)}
                                  disabled={submitting}
                                  className={`px-3 py-1 text-[11px] font-bold rounded transition-colors cursor-pointer ${
                                    row.isL1 
                                      ? 'bg-emerald-600 hover:bg-emerald-700 text-white' 
                                      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
                                  }`}
                                >
                                  Award Contract
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: ACTION PANEL & CONTROLS */}
        <div className="space-y-8">
          
          {/* TIMER CARD */}
          <div className={`rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col items-center text-center transition-all duration-300 ${
            requirement.status === 'AWARDED'
              ? 'bg-emerald-950 border border-emerald-500/30 text-emerald-100'
              : requirement.status === 'CLOSED'
              ? 'bg-amber-950 border border-amber-500/30 text-amber-100'
              : requirement.status === 'CANCELLED'
              ? 'bg-rose-950 border border-rose-500/30 text-rose-100'
              : 'bg-slate-950 text-white'
          }`}>
            <div className="absolute right-0 top-0 translate-x-1/4 -translate-y-1/4 w-32 h-32 rounded-full bg-blue-500/10 blur-xl"></div>
            
            <Timer className={`w-8 h-8 mb-3 ${
              requirement.status === 'AWARDED' ? 'text-emerald-400' :
              requirement.status === 'CLOSED' ? 'text-amber-400' :
              requirement.status === 'CANCELLED' ? 'text-rose-400' :
              'text-blue-400 animate-pulse'
            }`} />
            
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest font-mono">
              {requirement.status === 'AWARDED' || requirement.status === 'CLOSED' || requirement.status === 'CANCELLED'
                ? 'Bidding Round Status'
                : 'Bidding Timer Remaining'
              }
            </div>

            {requirement.status === 'LIVE' && requirement.bidClosingTime && (
              <div className="text-[10px] font-mono text-slate-400 mt-1">
                Closes: {formatIstLabel(requirement.bidClosingTime)}
              </div>
            )}

            <div className={`text-2xl font-bold font-mono tracking-widest mt-2 py-1 select-none ${
              requirement.status === 'AWARDED' ? 'text-emerald-400 animate-bounce' :
              requirement.status === 'CLOSED' ? 'text-amber-400' :
              requirement.status === 'CANCELLED' ? 'text-rose-400' :
              'text-white'
            }`}>
              {timeLeft || 'Calculating...'}
            </div>

            {requirement.targetRate && user?.role !== 'TRANSPORTER' && (
              <div className="mt-4 pt-4 border-t border-slate-900 w-full flex justify-between text-xs font-mono text-slate-400">
                <span>Target Rate:</span>
                <span className="font-bold text-white">₹{requirement.targetRate.toLocaleString()}</span>
              </div>
            )}
          </div>

          {/* STAFF DRAFT ACTION WORKSPACE */}
          {user?.role !== 'TRANSPORTER' && requirement.status === 'DRAFT' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-900 pb-3">
                <Send className="w-5 h-5 text-emerald-500 shrink-0" />
                <h3 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                  Draft Bidding Cycle
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                This transport requirement is currently a Draft. Transporters cannot see it or submit bids until it is published.
              </p>
              {user?.status?.toLowerCase() === 'approved' ? (
                <div className="p-3 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 text-blue-700 dark:text-blue-300 rounded-lg text-xs font-medium leading-normal">
                  <strong>Spectator Mode:</strong> You cannot publish bidding rounds.
                </div>
              ) : (
                <button
                  onClick={handlePublish}
                  disabled={submitting}
                  className="w-full py-2.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                  {submitting ? 'Publishing...' : 'Publish Bidding Round'}
                </button>
              )}
            </div>
          )}

          {/* ACTIVE TRANSPORTER INTERACTION WORKSPACE */}
          {user?.role === 'TRANSPORTER' && requirement.status === 'LIVE' && !isExpired && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-900 pb-3">
                <TrendingDown className="w-5 h-5 text-emerald-500 shrink-0" />
                <h3 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                  Submit Bid Quotation
                </h3>
              </div>

              <form onSubmit={handleBidSubmit} className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                    Your Freight Rate Proposal (INR)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold font-mono text-xs">₹</span>
                    <input
                      type="number"
                      required
                      min={1}
                      placeholder="e.g. 42000"
                      value={bidAmount}
                      onChange={(e) => setBidAmount(e.target.value)}
                      disabled={submitting}
                      className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-transparent text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-xs shadow-lg shadow-blue-500/10 transition-colors cursor-pointer"
                >
                  {submitting ? 'Registering Quotation...' : 'Confirm & Place Quotation'}
                </button>
              </form>

              {ownRank?.amount && (
                <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-800 space-y-1 text-center font-mono">
                  <div className="text-[10px] text-slate-400">Current active quote:</div>
                  <div className="text-base font-bold text-slate-800 dark:text-slate-200">₹{ownRank.amount.toLocaleString()}</div>
                </div>
              )}
            </div>
          )}

          {/* TIE BREAK EXPLANATION CARD (Staff only) — also shown while the
              auction is LIVE so staff can attach a discretionary note when
              awarding early from a tied or non-L1 bidder. */}
          {user?.role !== 'TRANSPORTER' && isL1Tie && (requirement.status === 'CLOSED' || requirement.status === 'TIE_RESOLUTION_REQUIRED' || requirement.status === 'LIVE') && (
            <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
                <AlertTriangle className="w-5 h-5 shrink-0 animate-bounce" />
                <h3 className="text-xs font-bold uppercase tracking-wider">
                  L1 Tie-Break Warning Box
                </h3>
              </div>

              <p className="text-xs text-rose-600 dark:text-rose-400 leading-relaxed">
                Multiple carriers have tied at the lowest freight quotation. You may award to any carrier you choose — the explanation below is optional and defaults to a discretionary award note.
              </p>

              <div>
                <label className="block text-[10px] font-bold text-rose-500 uppercase tracking-wider mb-1.5">
                  Resolution Decision Note (Optional)
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. Selected Gati Transport due to excellent historic on-time rating and vehicle availability verified over WhatsApp."
                  value={tieBreakLog}
                  onChange={(e) => setTieBreakLog(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-rose-200 dark:border-rose-900/30 bg-transparent text-rose-800 dark:text-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-500/20 placeholder-rose-400 font-mono"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CUSTOM CONFIRM PUBLISH MODAL */}
      {showPublishConfirm && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-emerald-500">
              <AlertTriangle className="w-8 h-8 shrink-0" />
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Publish Bidding Cycle</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Are you sure you want to publish this requirement? All invited transporters will receive SMS, WhatsApp, and Email alerts immediately.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowPublishConfirm(false)}
                className="px-4 py-2 text-xs font-semibold bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={executePublish}
                className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                Confirm & Publish
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM CONFIRM AWARD MODAL */}
      {confirmAwardId && (
        <div className="fixed inset-0 bg-black/60 dark:bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-blue-600 dark:text-blue-400">
              <Info className="w-8 h-8 shrink-0" />
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Award Transport Contract</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Are you sure you want to award the contract to this transporter? All carriers will be notified.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setConfirmAwardId(null)}
                className="px-4 py-2 text-xs font-semibold bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => executeAward(confirmAwardId)}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                Confirm & Award
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
