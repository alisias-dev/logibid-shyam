import React, { createContext, useContext, useEffect, useState } from 'react';
import api, { getDeviceId } from '../lib/api';
import { UserRole } from '../types';

interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  status?: string;
}

/**
 * Non-authoritative hint that this browser may hold a session.
 *
 * Tokens live ONLY in HttpOnly cookies, so JS cannot inspect them. `api.ts`
 * consults this marker to decide whether a silent token refresh is worth
 * attempting on a 401: without it, every anonymous page load paid two extra
 * round-trips (`/auth/me` 401 followed by an inevitable `/auth/refresh` 400).
 * It is a UX optimisation only - the server always re-validates the session, so
 * a stale or forged marker grants nothing.
 */
const SESSION_HINT_KEY = 'fleexbid_user';

function markSessionHint(user: unknown) {
  try {
    localStorage.setItem(SESSION_HINT_KEY, JSON.stringify(user));
  } catch {
    // Storage can be unavailable (private mode / quota) - refresh just falls
    // back to being attempted, which is the safe direction.
  }
}

function clearSessionHint() {
  try {
    localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // ignore
  }
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  loginStaff: (email: string, password: string) => Promise<void>;
  loginTransporter: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const data = await api.get('/auth/me');
      if (data.user) {
        setUser(data.user);
        markSessionHint(data.user);
      } else {
        setUser(null);
        clearSessionHint();
      }
    } catch {
      setUser(null);
      clearSessionHint();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const loginStaff = async (email: string, password: string) => {
    const data = await api.post('/auth/login-staff', { email, password });
    if (data.user) {
      setUser(data.user);
      markSessionHint(data.user);
    }
  };

  const loginTransporter = async (email: string, password: string) => {
    const data = await api.post('/auth/login-transporter', { email, password });
    if (data.user) {
      setUser(data.user);
      markSessionHint(data.user);
    }
  };

  const logout = async () => {
    try {
      const deviceId = getDeviceId();
      await api.post('/auth/logout', { deviceId });
    } catch (e) {
      console.error('Logout request failed', e);
    } finally {
      setUser(null);
      // Tokens live in HttpOnly cookies which the SERVER clears on logout
      // (JS cannot read or delete HttpOnly cookies). Only the local session
      // hint is cleared here.
      clearSessionHint();
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, loginStaff, loginTransporter, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
