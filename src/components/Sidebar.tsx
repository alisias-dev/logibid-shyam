import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { 
  LayoutDashboard, 
  FileText, 
  Truck, 
  LogOut, 
  Sun, 
  Moon,
  Sparkles,
  X,
  Users
} from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  if (!user) return null;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navItems = [
    {
      to: '/',
      label: 'Dashboard',
      icon: LayoutDashboard,
      roles: ['SUPER_ADMIN', 'LOGISTICS', 'TRANSPORTER']
    },
    {
      to: '/requirements',
      label: 'Requirements',
      icon: FileText,
      roles: ['SUPER_ADMIN', 'LOGISTICS', 'TRANSPORTER']
    },
    {
      to: '/transporters',
      label: 'Transporters',
      icon: Truck,
      roles: ['SUPER_ADMIN', 'LOGISTICS']
    },
    {
      to: '/staff',
      label: 'Staff',
      icon: Users,
      roles: ['SUPER_ADMIN']
    },
    {
      to: '/ai-advisor',
      label: 'AI Advisor',
      icon: Sparkles,
      roles: ['SUPER_ADMIN', 'LOGISTICS', 'TRANSPORTER']
    }
  ];

  const allowedNav = navItems.filter(item => item.roles.includes(user.role));

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40 lg:hidden cursor-pointer"
          id="sidebar-overlay"
        />
      )}

      <aside className={`
        w-64 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex flex-col h-screen fixed left-0 top-0 transition-transform duration-300 z-50
        ${isOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
      `}>
        {/* Brand logo & close button */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-slate-100 dark:border-slate-900 gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 dark:bg-blue-500 flex items-center justify-center text-white font-bold text-lg shadow-md shadow-blue-500/20">
              L
            </div>
            <div>
              <span className="font-semibold text-slate-950 dark:text-white tracking-tight">FleexBid</span>
              <span className="text-[10px] font-mono text-slate-400 block -mt-1 uppercase tracking-wider">Enterprise</span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer"
            aria-label="Close sidebar"
            id="close-sidebar-btn"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* User brief */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-900 bg-slate-50/50 dark:bg-slate-900/10">
          <div className="font-medium text-sm text-slate-800 dark:text-slate-200 truncate">{user.name}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full bg-emerald-500`}></span>
            <span className="text-xs font-mono text-slate-400 capitalize">{user.role.replace('_', ' ').toLowerCase()}</span>
          </div>
        </div>

        {/* Nav list */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
          {allowedNav.map(item => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={({ isActive }) => `
                  flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group
                  ${isActive 
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400' 
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100'}
                `}
              >
                <Icon className="w-4 h-4 text-slate-400 group-hover:text-slate-500 dark:group-hover:text-slate-300 transition-colors" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Bottom controls */}
        <div className="p-4 border-t border-slate-100 dark:border-slate-900 space-y-2">
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900 rounded-lg transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3">
              {theme === 'light' ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-blue-400" />}
              <span>{theme === 'light' ? 'Light Mode' : 'Dark Mode'}</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400 border border-slate-200 dark:border-slate-800 rounded px-1 uppercase">
              Tab
            </span>
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-3 py-2 text-sm text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded-lg transition-colors text-left cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Log out</span>
          </button>
        </div>
      </aside>
    </>
  );
}
