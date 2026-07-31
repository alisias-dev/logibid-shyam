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

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  loginStaff: (email: string, password: string) => Promise<void>;
  loginTransporter: (email: string, password: string) => Promise<void>;
  requestOtp?: (email: string, password: string) => Promise<void>;
  verifyOtp?: (email: string, otp: string) => Promise<void>;
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
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
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
    }
  };

  const loginTransporter = async (email: string, password: string) => {
    const data = await api.post('/auth/login-transporter', { email, password });
    if (data.user) {
      setUser(data.user);
    }
  };

  const requestOtp = async (email: string, password: string) => {
    return await api.post('/auth/request-otp', { email, password });
  };

  const verifyOtp = async (email: string, otp: string) => {
    const data = await api.post('/auth/verify-otp', { email, otp });
    if (data.user) {
      setUser(data.user);
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
      // Clear cookies from browser perspective just in case
      document.cookie = "accessToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      document.cookie = "refreshToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      localStorage.removeItem('logibid_access_token');
      localStorage.removeItem('logibid_refresh_token');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, loginStaff, loginTransporter, requestOtp, verifyOtp, logout, refreshUser }}>
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
