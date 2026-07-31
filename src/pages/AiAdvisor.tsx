import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sparkles, 
  Bot, 
  User, 
  Send, 
  Compass, 
  Truck, 
  TrendingUp, 
  AlertCircle, 
  RefreshCw, 
  MessageSquare, 
  Check, 
  Copy, 
  ArrowRight, 
  ChevronRight,
  Shield, 
  MapPin, 
  Scale, 
  Activity,
  FileText,
  BadgeAlert
} from 'lucide-react';
import api from '../lib/api';
import { Requirement, Transporter } from '../types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface RatePrediction {
  predictedMinRate: number;
  predictedMaxRate: number;
  recommendedTargetRate: number;
  confidenceScore: number;
  marketFactors: string[];
  routeDifficulty: string;
  strategicAdvice: string;
}

interface TransporterMatch {
  transporterId: string;
  companyName: string;
  matchScore: number;
  matchReasons: string[];
  riskFactors: string[];
  draftOutreachMessage: string;
}

interface NegotiationTemplate {
  transporterId: string;
  companyName: string;
  currentBid: number;
  targetCounterOffer: number;
  strategyDescription: string;
  draftMessage: string;
}

export default function AiAdvisor() {
  const [activeTab, setActiveTab] = useState<'copilot' | 'rate-predictor' | 'carrier-match' | 'negotiator'>('copilot');

  // Copilot States
  const [chatMessages, setChatMessages] = useState<Message[]>([
    { role: 'assistant', content: "Hello! I am LogiBid AI Copilot. Ask me anything about freight requirements, transport routes, active bid rankings, or platform savings analytics!" }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Rate Predictor States
  const [routeInput, setRouteInput] = useState({
    pickup: 'Mumbai, MH',
    delivery: 'Delhi, NCR',
    vehicleType: '32 FT Trailer',
    weight: 18,
    material: 'Steel Coils'
  });
  const [predictionResult, setPredictionResult] = useState<RatePrediction | null>(null);
  const [isPredictLoading, setIsPredictLoading] = useState(false);
  const [predictError, setPredictError] = useState<string | null>(null);

  // Requirement Loader States
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [selectedReqId, setSelectedReqId] = useState('');
  const [selectedReq, setSelectedReq] = useState<Requirement | null>(null);

  // Carrier Matcher States
  const [carrierMatches, setCarrierMatches] = useState<TransporterMatch[]>([]);
  const [isMatchLoading, setIsMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [copiedMatchId, setCopiedMatchId] = useState<string | null>(null);

  // Negotiator States
  const [negotiatorData, setNegotiatorData] = useState<{ tacticalTips: string[]; negotiations: NegotiationTemplate[] } | null>(null);
  const [isNegLoading, setIsNegLoading] = useState(false);
  const [negError, setNegError] = useState<string | null>(null);
  const [copiedNegId, setCopiedNegId] = useState<string | null>(null);

  // Load requirements list for matcher/negotiator
  useEffect(() => {
    async function fetchReqs() {
      try {
        const data = await api.get('/requirements');
        if (data.requirements) {
          setRequirements(data.requirements);
          if (data.requirements.length > 0) {
            setSelectedReqId(data.requirements[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load requirements for advisor', err);
      }
    }
    fetchReqs();
  }, []);

  // Sync details of selected requirement
  useEffect(() => {
    if (selectedReqId) {
      const found = requirements.find(r => r.id === selectedReqId) || null;
      setSelectedReq(found);
      // Reset dependent values when req changes
      setCarrierMatches([]);
      setNegotiatorData(null);
      setMatchError(null);
      setNegError(null);
    }
  }, [selectedReqId, requirements]);

  // Scroll chat to bottom
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isChatLoading]);

  // Handle Copilot Send
  const handleSendChat = async (textToSend?: string) => {
    const text = textToSend || chatInput;
    if (!text.trim() || isChatLoading) return;

    const userMsg: Message = { role: 'user', content: text };
    setChatMessages(prev => [...prev, userMsg]);
    if (!textToSend) setChatInput('');
    setIsChatLoading(true);

    try {
      const data = await api.post('/ai/chat', {
        messages: [...chatMessages, userMsg]
      });
      if (data.text) {
        setChatMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
      }
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `⚠️ AI Unavailable: ${err.message || 'Failed to fetch reply. Please ensure GEMINI_API_KEY is configured.'}` }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Quick Chat Suggestion Chips
  const suggestions = [
    "How can we decrease logistics procurement costs?",
    "Suggest optimal vehicle for 15 Tons of Chemicals from Chennai to Pune",
    "Explain standard competition ranking vs simple L1",
    "Give me active fleet summary of Gati and TCI"
  ];

  // Handle Rate Predictor Submit
  const handlePredictRate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPredictLoading(true);
    setPredictionResult(null);
    setPredictError(null);

    try {
      const data = await api.post('/ai/predict-rate', routeInput);
      setPredictionResult(data);
    } catch (err: any) {
      setPredictError(err.message || 'Rate prediction failed. Please verify AI API configuration.');
    } finally {
      setIsPredictLoading(false);
    }
  };

  // Handle Carrier Smart Match Submit
  const handleSmartMatch = async () => {
    if (!selectedReqId) return;
    setIsMatchLoading(true);
    setCarrierMatches([]);
    setMatchError(null);

    try {
      const data = await api.post('/ai/match-transporters', { requirementId: selectedReqId });
      if (data.matches) {
        setCarrierMatches(data.matches);
      }
    } catch (err: any) {
      setMatchError(err.message || 'Matching process failed.');
    } finally {
      setIsMatchLoading(false);
    }
  };

  // Handle Bids Negotiation Script Generation
  const handleNegotiate = async () => {
    if (!selectedReqId) return;
    setIsNegLoading(true);
    setNegotiatorData(null);
    setNegError(null);

    try {
      const data = await api.post('/ai/negotiator', { requirementId: selectedReqId });
      setNegotiatorData(data);
    } catch (err: any) {
      setNegError(err.message || 'Negotiation compilation failed. Ensure this requirement has active bids.');
    } finally {
      setIsNegLoading(false);
    }
  };

  // Clipboard Copier helper
  const copyToClipboard = (id: string, text: string, type: 'match' | 'neg') => {
    navigator.clipboard.writeText(text);
    if (type === 'match') {
      setCopiedMatchId(id);
      setTimeout(() => setCopiedMatchId(null), 2000);
    } else {
      setCopiedNegId(id);
      setTimeout(() => setCopiedNegId(null), 2000);
    }
  };

  const tabs = [
    { id: 'copilot', label: 'Interactive Copilot', icon: Bot },
    { id: 'rate-predictor', label: 'Market Rate Predictor', icon: TrendingUp },
    { id: 'carrier-match', label: 'Carrier Smart Matcher', icon: Truck },
    { id: 'negotiator', label: 'Supplier Negotiator', icon: Scale },
  ] as const;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">LogiBid AI Advisor</h1>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Automate logistics rate intelligence, supplier profiling, and procurement strategy with Gemini 3.5.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 rounded-full border border-slate-200 dark:border-slate-800">
          <Activity className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
          <span>Model: gemini-3.5-flash</span>
        </div>
      </div>

      {/* Styled Tabs Header */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800 p-1 bg-slate-100/50 dark:bg-slate-900/30 rounded-xl">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive 
                  ? 'bg-white dark:bg-slate-950 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200/50 dark:border-slate-800/80' 
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-blue-500' : 'text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Main Content Areas */}
      <AnimatePresence mode="wait">
        {activeTab === 'copilot' && (
          <motion.div
            key="copilot"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="grid grid-cols-1 lg:grid-cols-4 gap-6"
          >
            {/* Quick Suggestions Sidemenu */}
            <div className="lg:col-span-1 space-y-4">
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-3">
                <div className="flex items-center gap-2 font-semibold text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <Compass className="w-4 h-4 text-blue-500" />
                  <span>Interactive Guide</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Ask LogiBid AI Copilot anything about freight negotiations, carrier coverage, active requirements, or total cost savings.
                </p>
                <div className="pt-2 space-y-2 border-t border-slate-100 dark:border-slate-900">
                  <span className="text-[10px] font-mono text-slate-400 block uppercase">Suggested Prompts</span>
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => handleSendChat(s)}
                      className="w-full text-left text-xs p-2 rounded bg-slate-50 hover:bg-blue-50 dark:bg-slate-900 dark:hover:bg-blue-950/20 text-slate-700 dark:text-slate-300 border border-slate-200/60 dark:border-slate-800/60 transition-colors line-clamp-2"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Chat Box Panel */}
            <div className="lg:col-span-3 flex flex-col h-[520px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm overflow-hidden">
              {/* Chat Title bar */}
              <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-900 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/10">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center text-blue-600 dark:text-blue-400">
                    <Bot className="w-4.5 h-4.5" />
                  </div>
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-white block text-sm">Enterprise Logistics Assistant</span>
                    <span className="text-[10px] text-slate-400 flex items-center gap-1.5 font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      SECURE GPT COGNITIVE AGENT
                    </span>
                  </div>
                </div>
                <button 
                  onClick={() => setChatMessages([{ role: 'assistant', content: "Hello! I am LogiBid AI Copilot. Ask me anything about freight requirements, transport routes, active bid rankings, or platform savings analytics!" }])}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-900 rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 transition-colors"
                  title="Clear conversation"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Chat Message Scroll */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {chatMessages.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex gap-3.5 ${m.role === 'user' ? 'justify-end' : ''}`}
                  >
                    {m.role === 'assistant' && (
                      <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-900 flex items-center justify-center text-blue-500 flex-shrink-0">
                        <Bot className="w-4 h-4" />
                      </div>
                    )}
                    <div className={`p-4 rounded-xl text-sm max-w-[80%] whitespace-pre-wrap leading-relaxed shadow-sm ${
                      m.role === 'user'
                        ? 'bg-blue-600 text-white rounded-br-none'
                        : 'bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-100 dark:border-slate-800 rounded-bl-none'
                    }`}>
                      {m.content}
                    </div>
                    {m.role === 'user' && (
                      <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-blue-600 dark:text-blue-400 flex-shrink-0">
                        <User className="w-4 h-4" />
                      </div>
                    )}
                  </motion.div>
                ))}

                {isChatLoading && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-3.5">
                    <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-900 flex items-center justify-center text-blue-500 flex-shrink-0">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl border border-slate-100 dark:border-slate-800 rounded-bl-none">
                      <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                        <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                        <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                      </div>
                    </div>
                  </motion.div>
                )}
                <div ref={chatBottomRef} />
              </div>

              {/* Chat Input form */}
              <div className="p-4 border-t border-slate-100 dark:border-slate-900 bg-slate-50/20 dark:bg-slate-900/5">
                <form 
                  onSubmit={(e) => { e.preventDefault(); handleSendChat(); }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about rate benchmarking, transporter routes, savings..."
                    className="flex-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                    disabled={isChatLoading}
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isChatLoading}
                    className="px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" />
                    <span>Send</span>
                  </button>
                </form>
              </div>
            </div>
          </motion.div>
        )}

        {activeTab === 'rate-predictor' && (
          <motion.div
            key="rate-predictor"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="grid grid-cols-1 lg:grid-cols-12 gap-6"
          >
            {/* Input Form Column */}
            <form onSubmit={handlePredictRate} className="lg:col-span-4 space-y-4">
              <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-4">
                <div className="flex items-center gap-2 font-semibold text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  <Compass className="w-4 h-4 text-blue-500" />
                  <span>Route Parameters</span>
                </div>

                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
                      Pickup Hub / Origin
                    </label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        required
                        value={routeInput.pickup}
                        onChange={(e) => setRouteInput(prev => ({ ...prev, pickup: e.target.value }))}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-4 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                        placeholder="e.g. Mumbai, MH"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
                      Delivery Destination
                    </label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        required
                        value={routeInput.delivery}
                        onChange={(e) => setRouteInput(prev => ({ ...prev, delivery: e.target.value }))}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-4 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                        placeholder="e.g. Delhi, NCR"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
                      Vehicle Type
                    </label>
                    <div className="relative">
                      <Truck className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <select
                        value={routeInput.vehicleType}
                        onChange={(e) => setRouteInput(prev => ({ ...prev, vehicleType: e.target.value }))}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg pl-9 pr-4 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                      >
                        <option value="32 FT Trailer">32 FT Trailer</option>
                        <option value="20 FT Container">20 FT Container</option>
                        <option value="40 FT Container">40 FT Container</option>
                        <option value="19 FT Open Truck">19 FT Open Truck</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
                        Cargo Weight (Tons)
                      </label>
                      <input
                        type="number"
                        value={routeInput.weight}
                        onChange={(e) => setRouteInput(prev => ({ ...prev, weight: Number(e.target.value) }))}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                        placeholder="Weight"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
                        Material Type
                      </label>
                      <input
                        type="text"
                        value={routeInput.material}
                        onChange={(e) => setRouteInput(prev => ({ ...prev, material: e.target.value }))}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                        placeholder="Material"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isPredictLoading}
                  className="w-full mt-2 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg text-sm transition-all flex items-center justify-center gap-2"
                >
                  {isPredictLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <TrendingUp className="w-4 h-4" />
                      <span>Generate AI Rate Forecast</span>
                    </>
                  )}
                </button>
              </div>
            </form>

            {/* Results Bento Grid Column */}
            <div className="lg:col-span-8">
              {predictError && (
                <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium flex items-center gap-2 mb-4">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{predictError}</span>
                </div>
              )}

              {isPredictLoading && (
                <div className="h-full min-h-[300px] flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl p-8 space-y-4">
                  <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Querying Gemini Neural Models...</p>
                    <p className="text-xs text-slate-400">Synthesizing historic toll charges, seasonal delays, fuel rates, and active bids...</p>
                  </div>
                </div>
              )}

              {!isPredictLoading && !predictionResult && (
                <div className="h-full min-h-[300px] flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 rounded-xl p-8 text-center space-y-3">
                  <TrendingUp className="w-10 h-10 text-slate-300 dark:text-slate-700" />
                  <div className="max-w-sm space-y-1">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">No active rate forecast generated</p>
                    <p className="text-xs text-slate-400">Enter your freight origin, target vehicle specifications, and load parameters to run a complete neural price benchmarking check.</p>
                  </div>
                </div>
              )}

              {predictionResult && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="grid grid-cols-1 md:grid-cols-2 gap-4"
                >
                  {/* Recommended Target Rate Card */}
                  <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-4">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">RECOMMENDED TARGET BIDDING RATE</span>
                    <div className="flex items-baseline gap-1">
                      <span className="text-xs text-slate-400 font-mono font-bold">₹</span>
                      <span className="text-4xl font-extrabold text-blue-600 dark:text-blue-500 font-sans tracking-tight">
                        {predictionResult.recommendedTargetRate.toLocaleString('en-IN')}
                      </span>
                    </div>

                    <div className="space-y-1.5 pt-2 border-t border-slate-100 dark:border-slate-900">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-400">Prediction Confidence</span>
                        <span className="font-mono text-emerald-500 font-bold">{predictionResult.confidenceScore}%</span>
                      </div>
                      <div className="w-full bg-slate-100 dark:bg-slate-900 h-2 rounded-full overflow-hidden">
                        <div 
                          className="bg-emerald-500 h-full rounded-full transition-all duration-500" 
                          style={{ width: `${predictionResult.confidenceScore}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  {/* Predicted Range Card */}
                  <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-4">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">ESTIMATED BID RANGE</span>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <span className="text-slate-400 text-xs block mb-0.5">Predicted Min (L1)</span>
                        <span className="text-lg font-bold text-slate-700 dark:text-slate-300 font-mono">
                          ₹{predictionResult.predictedMinRate.toLocaleString('en-IN')}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 text-xs block mb-0.5">Predicted Max</span>
                        <span className="text-lg font-bold text-slate-700 dark:text-slate-300 font-mono">
                          ₹{predictionResult.predictedMaxRate.toLocaleString('en-IN')}
                        </span>
                      </div>
                    </div>

                    {/* Styled sliding bar */}
                    <div className="pt-4">
                      <div className="relative w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full flex items-center justify-between">
                        <div className="absolute left-[15%] right-[15%] bg-blue-500 h-1.5 rounded-full"></div>
                        <div className="w-3.5 h-3.5 rounded-full bg-slate-400 dark:bg-slate-600 border-2 border-white dark:border-slate-950 absolute left-[15%] -translate-x-1/2"></div>
                        <div className="w-4.5 h-4.5 rounded-full bg-blue-500 border-2 border-white dark:border-slate-950 absolute left-[50%] -translate-x-1/2 shadow" title="Recommended Target"></div>
                        <div className="w-3.5 h-3.5 rounded-full bg-slate-400 dark:bg-slate-600 border-2 border-white dark:border-slate-950 absolute right-[15%] translate-x-1/2"></div>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono pt-2">
                        <span>MIN BID</span>
                        <span>TARGET</span>
                        <span>MAX BID</span>
                      </div>
                    </div>
                  </div>

                  {/* Route & Difficulty */}
                  <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-3 md:col-span-2">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">ROUTE INTELLIGENCE & DIFFICULTY</span>
                    <div className="flex items-start gap-2.5">
                      <div className="p-1 rounded-md bg-yellow-500/10 text-yellow-600">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                      <p className="text-sm text-slate-700 dark:text-slate-300">
                        {predictionResult.routeDifficulty}
                      </p>
                    </div>
                  </div>

                  {/* Market Factors List */}
                  <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-3">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">MARKET SURGE FACTORS</span>
                    <ul className="space-y-2">
                      {predictionResult.marketFactors.map((factor, i) => (
                        <li key={i} className="flex gap-2.5 items-start text-xs text-slate-600 dark:text-slate-400">
                          <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <span>{factor}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Strategic Advice quotation box */}
                  <div className="p-5 rounded-xl border border-blue-200/60 dark:border-blue-900/40 bg-blue-50/20 dark:bg-blue-950/10 shadow-sm space-y-2">
                    <span className="text-[10px] font-mono font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider block">AI STRATEGY DIRECTIVE</span>
                    <p className="text-xs italic text-slate-700 dark:text-slate-300 leading-relaxed font-serif">
                      "{predictionResult.strategicAdvice}"
                    </p>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}

        {activeTab === 'carrier-match' && (
          <motion.div
            key="carrier-match"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* Top Selection Strip */}
            <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1 flex-1 max-w-lg">
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                  Select Active Freight Requirement
                </label>
                <select
                  value={selectedReqId}
                  onChange={(e) => setSelectedReqId(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                >
                  <option value="">-- Choose Requirement --</option>
                  {requirements.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.id} : {r.pickupLocation} → {r.deliveryLocation} ({r.vehicleType})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleSmartMatch}
                  disabled={!selectedReqId || isMatchLoading}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg text-sm transition-all flex items-center gap-2"
                >
                  {isMatchLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Run Profiling Engine</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Requirement Summary card */}
            {selectedReq && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/10 text-xs text-slate-600 dark:text-slate-400">
                <div>
                  <span className="block text-slate-400 mb-0.5">Route & Weight</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">
                    {selectedReq.pickupLocation} → {selectedReq.deliveryLocation} ({selectedReq.weight} Tons)
                  </span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Vehicle & Load</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">
                    {selectedReq.vehicleType} ({selectedReq.material})
                  </span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Target Budget</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">
                    {selectedReq.targetRate ? `₹${selectedReq.targetRate.toLocaleString('en-IN')}` : 'Not Specified'}
                  </span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Auction Status</span>
                  <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    selectedReq.status === 'LIVE' ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                  }`}>
                    {selectedReq.status}
                  </span>
                </div>
              </div>
            )}

            {matchError && (
              <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{matchError}</span>
              </div>
            )}

            {/* Matching Results */}
            {isMatchLoading && (
              <div className="h-64 flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl space-y-4">
                <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Analyzing fleet alignment and operating route states...</p>
              </div>
            )}

            {!isMatchLoading && carrierMatches.length === 0 && (
              <div className="h-64 flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 rounded-xl text-center p-8 space-y-3">
                <Truck className="w-10 h-10 text-slate-300 dark:text-slate-700" />
                <div className="max-w-xs space-y-1">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">No matches profiled yet</p>
                  <p className="text-xs text-slate-400">Click "Run Profiling Engine" to perform cross-reference matching on state coverage, route priority, and fleet type.</p>
                </div>
              </div>
            )}

            {/* Carrier Match Cards */}
            {!isMatchLoading && carrierMatches.length > 0 && (
              <div className="space-y-4">
                <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">Ranked Transporter Alignment</span>
                {carrierMatches.map((match, index) => (
                  <motion.div
                    key={match.transporterId}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 50 }}
                    className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm grid grid-cols-1 lg:grid-cols-12 gap-5 items-center"
                  >
                    {/* Carrier Info */}
                    <div className="lg:col-span-4 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center text-blue-600 dark:text-blue-400">
                          <Truck className="w-5 h-5" />
                        </div>
                        <div>
                          <span className="font-bold text-slate-900 dark:text-white block text-sm">{match.companyName}</span>
                          <span className="text-[10px] font-mono text-slate-400 block uppercase">TRANSPORTER #{match.transporterId.split('_')[1] || match.transporterId}</span>
                        </div>
                      </div>
                    </div>

                    {/* Match Score Indicator */}
                    <div className="lg:col-span-2 flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full border-4 border-slate-100 dark:border-slate-900 flex items-center justify-center relative">
                        {/* Fake circular gauge */}
                        <div 
                          className={`absolute inset-0 rounded-full border-4 ${
                            match.matchScore >= 85 ? 'border-emerald-500' : match.matchScore >= 60 ? 'border-amber-500' : 'border-rose-500'
                          }`}
                          style={{ clipPath: `polygon(50% 50%, -50% -50%, ${match.matchScore}% -50%, ${match.matchScore}% ${match.matchScore}%, -50% ${match.matchScore}%)` }}
                        ></div>
                        <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 z-10">{match.matchScore}%</span>
                      </div>
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wide">Match Score</span>
                    </div>

                    {/* Reasons Accordion/Lists */}
                    <div className="lg:col-span-3 space-y-2.5 border-l border-slate-100 dark:border-slate-900 pl-4">
                      {/* Positive fit */}
                      <div className="space-y-1">
                        <span className="text-[10px] font-mono font-bold text-emerald-500 uppercase block">Strengths</span>
                        {match.matchReasons.map((reason, rIndex) => (
                          <div key={rIndex} className="flex gap-1.5 items-start text-xs text-slate-600 dark:text-slate-400">
                            <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                            <span>{reason}</span>
                          </div>
                        ))}
                      </div>

                      {/* Risks fitting */}
                      {match.riskFactors.length > 0 && (
                        <div className="space-y-1">
                          <span className="text-[10px] font-mono font-bold text-amber-500 uppercase block">Risk Flags</span>
                          {match.riskFactors.map((risk, rIndex) => (
                            <div key={rIndex} className="flex gap-1.5 items-start text-xs text-slate-600 dark:text-slate-400">
                              <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                              <span>{risk}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Copier & Communication block */}
                    <div className="lg:col-span-3 space-y-2 border-l border-slate-100 dark:border-slate-900 pl-4">
                      <span className="text-[10px] font-mono font-bold text-slate-400 uppercase block">OUTREACH TEMPLATE</span>
                      <div className="p-2 bg-slate-50 dark:bg-slate-900 rounded border border-slate-200/60 dark:border-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-400 line-clamp-2 max-h-12 overflow-hidden">
                        {match.draftOutreachMessage}
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(match.transporterId, match.draftOutreachMessage, 'match')}
                        className="w-full py-1.5 px-3 text-xs bg-slate-100 hover:bg-blue-50 text-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/20 rounded font-medium border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-1.5 transition-colors"
                      >
                        {copiedMatchId === match.transporterId ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                            <span className="text-emerald-500">Copied to Clipboard!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy Outreach Message</span>
                          </>
                        )}
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {activeTab === 'negotiator' && (
          <motion.div
            key="negotiator"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
          >
            {/* Selection Strip */}
            <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1 flex-1 max-w-lg">
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                  Select Active Freight Requirement
                </label>
                <select
                  value={selectedReqId}
                  onChange={(e) => setSelectedReqId(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors text-slate-800 dark:text-slate-100"
                >
                  <option value="">-- Choose Requirement --</option>
                  {requirements.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.id} : {r.pickupLocation} → {r.deliveryLocation} ({r.vehicleType})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleNegotiate}
                  disabled={!selectedReqId || isNegLoading}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg text-sm transition-all flex items-center gap-2"
                >
                  {isNegLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Scale className="w-4 h-4" />
                      <span>Compile Negotiation Scripts</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Active requirement context */}
            {selectedReq && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/10 text-xs text-slate-600 dark:text-slate-400">
                <div>
                  <span className="block text-slate-400 mb-0.5">Origin & Destination</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{selectedReq.pickupLocation} → {selectedReq.deliveryLocation}</span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Vehicle Specifications</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{selectedReq.vehicleType}</span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Budget Rate Cap</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">₹{selectedReq.targetRate?.toLocaleString('en-IN') || 'Not Set'}</span>
                </div>
                <div>
                  <span className="block text-slate-400 mb-0.5">Award Type Config</span>
                  <span className="font-bold text-slate-700 dark:text-slate-300">{selectedReq.awardType}</span>
                </div>
              </div>
            )}

            {negError && (
              <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/30 text-rose-600 dark:text-rose-400 text-xs font-medium flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{negError}</span>
              </div>
            )}

            {isNegLoading && (
              <div className="h-64 flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl space-y-4">
                <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Evaluating active transporter quotes and rankings...</p>
              </div>
            )}

            {!isNegLoading && !negotiatorData && (
              <div className="h-64 flex flex-col items-center justify-center border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 rounded-xl text-center p-8 space-y-3">
                <Scale className="w-10 h-10 text-slate-300 dark:text-slate-700" />
                <div className="max-w-sm space-y-1">
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">No active negotiation models loaded</p>
                  <p className="text-xs text-slate-400">Select a freight requirement that has active commercial quotes submitted, then click "Compile Negotiation Scripts".</p>
                </div>
              </div>
            )}

            {/* Negotiation tactical tips and list */}
            {!isNegLoading && negotiatorData && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left tactics column */}
                <div className="lg:col-span-1 space-y-4">
                  <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-3">
                    <div className="flex items-center gap-2 font-semibold text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                      <Shield className="w-4 h-4 text-blue-500" />
                      <span>Negotiation Tactics</span>
                    </div>
                    <ul className="space-y-3">
                      {negotiatorData.tacticalTips.map((tip, idx) => (
                        <li key={idx} className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed flex gap-2 items-start">
                          <ChevronRight className="w-4 h-4 text-blue-500 flex-shrink-0" />
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Right scripts list column */}
                <div className="lg:col-span-2 space-y-4">
                  {negotiatorData.negotiations.map((neg) => (
                    <div
                      key={neg.transporterId}
                      className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm space-y-4"
                    >
                      <div className="flex justify-between items-start gap-4">
                        <div>
                          <span className="font-bold text-slate-900 dark:text-white block text-sm">{neg.companyName}</span>
                          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">STRATEGY: {neg.strategyDescription}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">Submitted Bid</span>
                          <span className="text-sm font-bold text-rose-500 font-mono">₹{neg.currentBid.toLocaleString('en-IN')}</span>
                        </div>
                      </div>

                      {/* Mock counteroffer rate */}
                      <div className="flex justify-between items-center text-xs p-2.5 bg-slate-50 dark:bg-slate-900 rounded border border-slate-100 dark:border-slate-800">
                        <span className="text-slate-500">AI Proposed CounterOffer Target Rate:</span>
                        <span className="font-bold text-emerald-500 font-mono">₹{neg.targetCounterOffer.toLocaleString('en-IN')}</span>
                      </div>

                      {/* Actual script draft */}
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-mono font-bold text-slate-400 uppercase block">Script Draft</span>
                        <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded border border-slate-200/60 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">
                          {neg.draftMessage}
                        </div>
                      </div>

                      {/* Copy Action */}
                      <button
                        type="button"
                        onClick={() => copyToClipboard(neg.transporterId, neg.draftMessage, 'neg')}
                        className="w-full py-2 bg-slate-100 hover:bg-blue-50 text-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-blue-950/20 rounded-lg font-medium text-xs border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-1.5 transition-colors"
                      >
                        {copiedNegId === neg.transporterId ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                            <span className="text-emerald-500 font-bold">Copied Bidding Script!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy Commercial Negotiator Script</span>
                          </>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
