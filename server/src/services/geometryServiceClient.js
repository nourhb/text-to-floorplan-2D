const DEFAULT_TIMEOUT_MS = 20_000;

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function geometryLayout({ url, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const u = String(url || '').replace(/\/$/, '');
  if (!u) throw new Error('GEOMETRY_SERVICE_URL missing');

  const { signal, cleanup } = withTimeout(null, timeoutMs);
  try {
    const res = await fetch(`${u}/layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`geometry_service_http_${res.status}:${txt.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    cleanup();
  }
}

