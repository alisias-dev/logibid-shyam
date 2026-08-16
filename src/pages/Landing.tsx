import React, { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Gavel, ShieldCheck, Sparkles, TrendingUp, ArrowRight, Radio } from 'lucide-react';

// Three.js stack is code-split: the ~450KB (gzip) 3D chunk only downloads
// when someone actually visits the landing page, never for authed dashboard users.
const HeroScene = React.lazy(() => import('../components/three/HeroScene'));

/** Branded CSS loader shown while the WebGL scene initializes. */
function BrandLoader() {
  return (
    <div className="fixed inset-0 z-0 flex flex-col items-center justify-center bg-slate-950">
      <div className="relative w-14 h-14">
        <div className="absolute inset-0 rounded-full border-2 border-sky-400/15" />
        <div className="absolute inset-0 rounded-full border-2 border-t-sky-400 animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center text-sky-300/80">
          <Radio className="w-5 h-5" />
        </div>
      </div>
      <p className="mt-5 font-mono text-[11px] tracking-[0.35em] text-sky-300/60 uppercase">
        Initializing FleexBid Network
      </p>
    </div>
  );
}

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, delay: 0.12 * i, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

const FEATURES = [
  {
    icon: Gavel,
    title: 'Live Reverse Auctions',
    body: 'Post a freight requirement and watch verified transporters drive the price down in real time — every bid updates ranks instantly.',
  },
  {
    icon: ShieldCheck,
    title: 'Sealed & Secure Bidding',
    body: 'Bids are hashed and confidential. Competitors never see your pricing, and every submission is authenticated and rate-limited.',
  },
  {
    icon: Sparkles,
    title: 'AI Negotiation Assistant',
    body: 'FleexBid’s Gemini-powered advisor reads live bid dynamics and suggests the optimal moment to close, extend, or re-negotiate.',
  },
  {
    icon: TrendingUp,
    title: 'Transparent Rankings',
    body: 'Auto-recomputed rank tables, deterministic auction closure, and a full audit trail — no favours, no hidden moves.',
  },
];

const STEPS = [
  { n: '01', title: 'Post Your Requirement', body: 'Route, tonnage, vehicle type, and your target price — published to your verified carrier network.' },
  { n: '02', title: 'Carriers Bid Blind', body: 'Transporters submit sealed bids. Everyone sees their own live rank, nobody sees the competition’s number.' },
  { n: '03', title: 'Auto-Award & Ship', body: 'The auction closes on schedule and the winning bid is awarded instantly — then track and rate the performance.' },
];

export default function Landing() {
  return (
    <div className="relative min-h-screen bg-slate-950 text-white overflow-x-hidden">
      {/* 3D cinematic backdrop */}
      <Suspense fallback={<BrandLoader />}>
        <HeroScene />
      </Suspense>

      {/* Cinematic vignette + legibility gradients */}
      <div
        className="pointer-events-none fixed inset-0 z-[5]"
        style={{ background: 'radial-gradient(ellipse at center, transparent 52%, rgba(2,6,23,0.82) 100%)' }}
      />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[5] h-40 bg-gradient-to-b from-slate-950/70 to-transparent" />

      {/* UI overlay — content is click-through except interactive elements, so the canvas keeps mouse events for parallax */}
      <div className="relative z-10 pointer-events-none">
        {/* Glassmorphism navigation */}
        <motion.header
          initial={{ opacity: 0, y: -18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="fixed top-0 inset-x-0 z-20 backdrop-blur-xl bg-white/[0.04] border-b border-white/10"
        >
          <nav className="mx-auto max-w-7xl px-6 lg:px-8 h-16 flex items-center justify-between pointer-events-auto">
            <Link to="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-white font-extrabold text-sm shadow-lg shadow-sky-500/30">
                F
              </div>
              <span className="font-bold tracking-tight text-lg">FleexBid</span>
            </Link>

            <div className="hidden md:flex items-center gap-8 text-sm text-slate-300">
              <a href="#features" className="hover:text-white transition-colors">Platform</a>
              <a href="#how" className="hover:text-white transition-colors">How It Works</a>
              <a href="#security" className="hover:text-white transition-colors">Security</a>
            </div>

            <div className="flex items-center gap-3">
              <Link
                to="/login"
                className="text-sm text-slate-200 hover:text-white px-4 py-2 rounded-lg hover:bg-white/10 transition-colors"
              >
                Sign In
              </Link>
              <Link
                to="/login"
                className="text-sm font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 px-4 py-2 rounded-lg shadow-[0_0_24px_rgba(56,189,248,0.45)] transition-all"
              >
                Enter Dashboard
              </Link>
            </div>
          </nav>
        </motion.header>

        {/* Hero */}
        <main className="mx-auto max-w-7xl px-6 lg:px-8 pt-40 pb-20 flex flex-col items-center text-center">
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={0}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/[0.06] border border-white/10 backdrop-blur-md font-mono text-[11px] tracking-[0.25em] text-sky-300/90 uppercase"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Sealed Reverse Auction Marketplace
          </motion.div>

          <motion.h1
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={1}
            className="mt-7 text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.05] max-w-4xl"
          >
            The Future of{' '}
            <span className="bg-gradient-to-r from-sky-300 via-cyan-200 to-indigo-300 bg-clip-text text-transparent">
              Logistics Bidding
            </span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={2}
            className="mt-6 max-w-2xl text-base md:text-lg text-slate-300/90 leading-relaxed"
          >
            FleexBid runs transparent, real-time reverse auctions where verified
            transporters compete for your freight — live ranks, sealed bids, and
            deterministic auto-award the moment the clock hits zero.
          </motion.p>

          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={3}
            className="mt-10 flex flex-col sm:flex-row items-center gap-4 pointer-events-auto"
          >
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.96 }}>
              <Link
                to="/login"
                className="inline-flex items-center gap-2.5 px-8 py-4 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-bold text-base shadow-[0_0_45px_rgba(56,189,248,0.5)] transition-shadow"
              >
                Start Bidding
                <ArrowRight className="w-5 h-5" />
              </Link>
            </motion.div>
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.96 }}>
              <a
                href="#features"
                className="inline-flex items-center gap-2.5 px-8 py-4 rounded-xl bg-white/[0.06] border border-white/15 backdrop-blur-md text-white font-semibold hover:bg-white/10 transition-colors"
              >
                Explore the Platform
              </a>
            </motion.div>
          </motion.div>

          {/* Trust attributes */}
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="show"
            custom={4}
            className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 w-full max-w-3xl"
          >
            {[
              ['10s', 'Auction auto-close'],
              ['100%', 'Sealed & hashed bids'],
              ['24/7', 'Live rank engine'],
              ['AI', 'Negotiation assistant'],
            ].map(([value, label]) => (
              <div
                key={label}
                className="px-4 py-5 rounded-2xl bg-white/[0.05] border border-white/10 backdrop-blur-md"
              >
                <div className="text-2xl md:text-3xl font-extrabold bg-gradient-to-br from-sky-300 to-indigo-300 bg-clip-text text-transparent">
                  {value}
                </div>
                <div className="mt-1 text-[11px] text-slate-400 uppercase tracking-wider">{label}</div>
              </div>
            ))}
          </motion.div>
        </main>

        {/* Features */}
        <section id="features" className="relative mx-auto max-w-7xl px-6 lg:px-8 py-24">
          <motion.h2
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            custom={0}
            className="text-center text-3xl md:text-5xl font-extrabold tracking-tight"
          >
            Built for the <span className="text-sky-300">bidding floor</span>
          </motion.h2>
          <motion.p
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            custom={1}
            className="mt-4 text-center text-slate-400 max-w-xl mx-auto"
          >
            Every layer of the marketplace is engineered for speed, fairness, and confidentiality.
          </motion.p>

          <div className="mt-14 grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                variants={fadeUp}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-60px' }}
                custom={i}
                className="p-6 rounded-2xl bg-white/[0.05] border border-white/10 backdrop-blur-md hover:bg-white/[0.08] hover:border-sky-400/30 transition-colors"
              >
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-400/20 to-indigo-500/20 border border-sky-400/20 flex items-center justify-center">
                  <f.icon className="w-5 h-5 text-sky-300" />
                </div>
                <h3 className="mt-5 font-bold text-lg">{f.title}</h3>
                <p className="mt-2 text-sm text-slate-400 leading-relaxed">{f.body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="relative mx-auto max-w-7xl px-6 lg:px-8 py-24">
          <motion.h2
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            custom={0}
            className="text-center text-3xl md:text-5xl font-extrabold tracking-tight"
          >
            Three steps to <span className="text-sky-300">market rate</span>
          </motion.h2>

          <div className="mt-14 grid md:grid-cols-3 gap-5">
            {STEPS.map((s, i) => (
              <motion.div
                key={s.n}
                variants={fadeUp}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-60px' }}
                custom={i}
                className="relative p-7 rounded-2xl bg-white/[0.05] border border-white/10 backdrop-blur-md"
              >
                <div className="font-mono text-4xl font-extrabold bg-gradient-to-br from-sky-400/40 to-indigo-400/40 bg-clip-text text-transparent">
                  {s.n}
                </div>
                <h3 className="mt-4 font-bold text-lg">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-400 leading-relaxed">{s.body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Security band */}
        <section id="security" className="relative mx-auto max-w-5xl px-6 lg:px-8 py-24">
          <motion.div
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            custom={0}
            className="p-8 md:p-12 rounded-3xl bg-gradient-to-br from-sky-500/15 via-white/[0.05] to-indigo-500/15 border border-white/10 backdrop-blur-xl"
          >
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
              <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Security you can audit</h2>
            </div>
            <p className="mt-4 text-slate-300/90 max-w-3xl leading-relaxed">
              JWT sessions with rotation and revocation, strict role-based access
              control across every route, rate-limited endpoints, hashed credentials,
              and a complete audit trail on every action. Competitor data is masked
              by design — you see your rank, never their price.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5 pointer-events-auto">
              {['RBAC enforced', 'Session rotation', 'Audit trail', 'Rate limited', 'Masked bids'].map((t) => (
                <span
                  key={t}
                  className="px-3.5 py-1.5 rounded-full bg-emerald-400/10 border border-emerald-400/25 text-emerald-300 text-xs font-semibold"
                >
                  {t}
                </span>
              ))}
            </div>
          </motion.div>
        </section>

        {/* Final CTA */}
        <section className="relative mx-auto max-w-5xl px-6 lg:px-8 py-20 text-center">
          <motion.h2
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-60px' }}
            custom={0}
            className="text-3xl md:text-5xl font-extrabold tracking-tight"
          >
            Ready to move freight at <span className="text-sky-300">market speed?</span>
          </motion.h2>
          <motion.div
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-60px' }}
            custom={1}
            className="mt-9 inline-flex pointer-events-auto"
          >
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.96 }}>
              <Link
                to="/login"
                className="inline-flex items-center gap-2.5 px-9 py-4 rounded-xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-bold text-base shadow-[0_0_45px_rgba(56,189,248,0.5)] transition-shadow"
              >
                Enter Dashboard
                <ArrowRight className="w-5 h-5" />
              </Link>
            </motion.div>
          </motion.div>
        </section>

        {/* Footer */}
        <footer className="relative border-t border-white/10 bg-slate-950/60 backdrop-blur-xl">
          <div className="mx-auto max-w-7xl px-6 lg:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-white font-extrabold text-xs shadow-lg shadow-sky-500/30">
                F
              </div>
              <span className="font-bold tracking-tight">FleexBid</span>
            </div>
            <div className="flex items-center gap-6 text-xs text-slate-400 font-mono">
              <Link to="/login" className="hover:text-white transition-colors">Sign In</Link>
              <a href="#features" className="hover:text-white transition-colors">Platform</a>
              <a href="#security" className="hover:text-white transition-colors">Security</a>
            </div>
            <p className="text-[11px] text-slate-500 font-mono">
              © 2026 FLEEXBID SYSTEMS • SECURE BIDDING NETWORKS
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
