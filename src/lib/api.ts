import { UserRole } from '../types';

// Generate or get unique device identifier. This is a device fingerprint, NOT a
// credential - it only tells the server WHICH device a session belongs to.
export function getDeviceId(): string {
  let id = localStorage.getItem('fleexbid_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('fleexbid_device_id', id);
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

    // Auth is handled entirely by HttpOnly cookies (accessToken + refreshToken)
    // which the browser attaches automatically. NO tokens are ever stored in
    // localStorage, so an XSS attack cannot read or replay the session.
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

    // If unauthorized, attempt a silent cookie-based token refresh once
    if (response.status === 401 && path !== '/auth/refresh' && path !== '/auth/login-staff' && path !== '/auth/verify-otp') {
      const refreshed = await this.silentRefresh();
      if (refreshed) {
        // Retry the original request - the refreshed cookies are attached
        // automatically, no header manipulation needed.
        try {
          response = await fetch(url, config);
        } catch (retryErr: any) {
          throw new Error('Unable to connect to the backend server. Please check your network connection.');
        }
      } else {
        // Clear locally stored user state (tokens live only in HttpOnly cookies,
        // which the server clears on logout / failed refresh).
        localStorage.removeItem('fleexbid_user');
        // The public landing page handles the unauthenticated state itself;
        // only hard-redirect when a signed-in user's request was rejected.
        if (path !== '/auth/me' && window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
    }

    const data = await response.json().catch(() => ({}));

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
        // The refresh endpoint reads the HttpOnly refreshToken cookie and
        // rotates the session, setting fresh cookies in the response.
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ deviceId: getDeviceId() }),
          credentials: 'include'
        });
        return res.ok;
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
