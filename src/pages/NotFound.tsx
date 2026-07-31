import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center space-y-4">
      <ShieldAlert className="w-16 h-16 text-slate-300 dark:text-slate-700 animate-pulse" />
      <h2 className="text-xl font-bold text-slate-950 dark:text-white tracking-tight">404 - Page Not Found</h2>
      <p className="text-xs text-slate-400 max-w-sm">
        The workspace path you are attempting to locate is either private, restricted, or does not exist.
      </p>
      <Link 
        to="/"
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow transition-all cursor-pointer"
      >
        Return to Dashboard
      </Link>
    </div>
  );
}
