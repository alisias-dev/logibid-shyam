// Minimal cookie-jar helper for verifying the cookie-based auth flow from the
// CLI (Node has no built-in cookie jar). Captures Set-Cookie headers, handles
// clearCookie (epoch Expires), and replays the Cookie header on later calls.
export function makeJar() {
  const cookies = new Map();
  return {
    capture(res) {
      let setCookies = [];
      if (typeof res.headers.getSetCookie === 'function') {
        setCookies = res.headers.getSetCookie();
      } else if (res.headers.get('set-cookie')) {
        setCookies = [res.headers.get('set-cookie')];
      }
      for (const raw of setCookies) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (/expires=thu, 01 jan 1970/i.test(raw)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    has(name) {
      return cookies.has(name);
    },
    names() {
      return [...cookies.keys()];
    }
  };
}

// fetch wrapper that attaches the jar's Cookie header and captures Set-Cookie.
export function makeCall(BASE) {
  return (path, method = 'GET', body, jar) =>
    fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(jar ? { Cookie: jar.header() } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    }).then((r) => {
      if (jar) jar.capture(r);
      return r;
    });
}
