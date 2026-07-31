import { UserRole } from '../types';

// Generate or get unique device identifier
export function getDeviceId(): string {
  let id = localStorage.getItem('logibid_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('logibid_device_id', id);
  }
  return id;
}

interface RequestOptions extends RequestInit {
  json?: any;
}

class ApiClient {
  private baseUrl: string = (import.meta.env.VITE_API_URL as string || '/api').replace(/\/$/, '');

  private async request(path: string, options: RequestOptions = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const deviceId = getDeviceId();

    // Default headers
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');

    // Add Authorization header if token exists
    const accessToken = localStorage.getItem('logibid_access_token');
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }

    const config: RequestInit = {
      ...options,
      headers,
      credentials: 'include'
    };

    if (options.json) {
      config.body = JSON.stringify({ ...options.json, deviceId });
    } else if (config.method === 'POST' || config.method === 'PUT' || config.method === 'DELETE') {
      // Always append deviceId on state modifying operations
      config.body = JSON.stringify({ deviceId });
    }

    let response: Response;
    try {
      response = await fetch(url, config);
    } catch (networkError: any) {
      console.error(`API Fetch Error [${config.method || 'GET'} ${url}]:`, networkError);
      throw new Error(
        'Unable to connect to the backend server. Please check your network connection or API configuration.'
      );
    }

    // If unauthorized, attempt a silent token refresh once
    if (response.status === 401 && path !== '/auth/refresh' && path !== '/auth/login-staff' && path !== '/auth/verify-otp') {
      const refreshed = await this.silentRefresh();
      if (refreshed) {
        // Retry the original request with new token
        const newAccessToken = localStorage.getItem('logibid_access_token');
        if (newAccessToken) {
          const retriedHeaders = new Headers(config.headers || {});
          retriedHeaders.set('Authorization', `Bearer ${newAccessToken}`);
          config.headers = retriedHeaders;
        }
        try {
          response = await fetch(url, config);
        } catch (retryErr: any) {
          throw new Error('Unable to connect to the backend server. Please check your network connection.');
        }
      } else {
        // Clear locally stored user state, redirect to login
        localStorage.removeItem('logibid_user');
        localStorage.removeItem('logibid_access_token');
        localStorage.removeItem('logibid_refresh_token');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
    }

    const data = await response.json().catch(() => ({}));

    // If response contains tokens, store them
    if (data.accessToken) {
      localStorage.setItem('logibid_access_token', data.accessToken);
    }
    if (data.refreshToken) {
      localStorage.setItem('logibid_refresh_token', data.refreshToken);
    }

    if (!response.ok) {
      throw new Error(data.error || data.details || 'Something went wrong with the request');
    }

    return data;
  }

  private refreshPromise: Promise<boolean> | null = null;

  private async silentRefresh(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const deviceId = getDeviceId();
        const storedRefreshToken = localStorage.getItem('logibid_refresh_token');
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-refresh-token': storedRefreshToken || ''
          },
          body: JSON.stringify({ deviceId, refreshToken: storedRefreshToken }),
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.accessToken) {
            localStorage.setItem('logibid_access_token', data.accessToken);
          }
          if (data.refreshToken) {
            localStorage.setItem('logibid_refresh_token', data.refreshToken);
          }
          return true;
        }
        return false;
      } catch {
        return false;
      }
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  get(path: string, options?: RequestOptions) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path: string, json?: any, options?: RequestOptions) {
    return this.request(path, { ...options, method: 'POST', json });
  }

  put(path: string, json?: any, options?: RequestOptions) {
    return this.request(path, { ...options, method: 'PUT', json });
  }

  delete(path: string, options?: RequestOptions) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}

export const api = new ApiClient();
export default api;
