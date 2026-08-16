import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeContext';
import { AuthProvider, useAuth } from './components/AuthContext';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import RequirementsList from './pages/RequirementsList';
import RequirementDetail from './pages/RequirementDetail';
import OnboardTransporters from './pages/OnboardTransporters';
import StaffManagement from './pages/StaffManagement';
import AiAdvisor from './pages/AiAdvisor';
import NotFound from './pages/NotFound';

import { Menu, X } from 'lucide-react';

function Layout({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-200">
      {/* Sidebar - responsive container */}
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      
      {/* Main content wrapper */}
      <div className="flex-1 lg:pl-64 flex flex-col min-h-screen">
        {/* Mobile Header Bar */}
        <header className="lg:hidden h-16 flex items-center justify-between px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 -ml-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              aria-label="Open sidebar"
              id="mobile-menu-btn"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-2">
              <img
                src="/favicon.png"
                alt="FleexBid"
                className="w-7 h-7 rounded-lg shadow-md"
              />
              <span className="font-semibold text-sm text-slate-950 dark:text-white">FleexBid</span>
            </div>
          </div>
        </header>

        <main className="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="space-y-4 text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-xs text-slate-400 font-mono">Authenticating session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    // Public marketing landing — sign-in happens at /login
    return <Landing />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/requirements" element={<RequirementsList />} />
        <Route path="/bid/:id" element={<RequirementDetail />} />
        <Route path="/ai-advisor" element={<AiAdvisor />} />
        
        {/* Only Logistics & Super Admins can access Transporters */}
        {user.role !== 'TRANSPORTER' ? (
          <Route path="/transporters" element={<OnboardTransporters />} />
        ) : (
          <Route path="/transporters" element={<Navigate to="/" replace />} />
        )}

        {/* Only Super Admins can access Staff Management */}
        {user.role === 'SUPER_ADMIN' ? (
          <Route path="/staff" element={<StaffManagement />} />
        ) : (
          <Route path="/staff" element={<Navigate to="/" replace />} />
        )}

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public routes (no auth gate) */}
            <Route path="/login" element={<Login />} />
            {/* Everything else: authenticated app shell, or Landing when logged out */}
            <Route path="/*" element={<AuthenticatedApp />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
