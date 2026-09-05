const SEED_VERSION = 'a.txt-v2';
const TOKEN_LIFETIME = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_STATE = {
  players: [],
  queue: [],
  pending: null,
  matches: [],
  settings: { k: 40, startElo: 1000 }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0'
    }
  });
}

function secret(env) {
  return env.ADMIN_SECRET || env.ADMIN_PASSWORD || '';
}

async function sign(value, env) {
  const configured = secret(env);
  if (!configured) throw new Error('Brak ADMIN_SECRET lub ADMIN_PASSWORD.');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(configured),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createToken(env) {
  const expires = String(Date.now() + TOKEN_LIFETIME);
  return `${expires}.${await sign(expires, env)}`;
}

async function isAdmin(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return signature === await sign(expires, env);
}

function isEmptyState(value) {
  return value.players.length === 0 && value.matches.length === 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.STATE;

  if (!store) return json({ error: 'Brak bazy KV STATE.' }, 500);

  try {
    if (request.method === 'POST') {
      const body = await request.json();
      if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
        return json({ error: 'Nieprawidłowe hasło.' }, 401);
      }
      return json({ token: await createToken(env) });
    }

    if (request.method === 'GET') {
      let state = await store.get('state', { type: 'json' });
      const seeded = await store.get('seeded');

      if (seeded !== SEED_VERSION && (!state || isEmptyState(state))) {
        const seedResponse = await fetch(new URL('/a.txt', request.url));
        state = seedResponse.ok ? await seedResponse.json() : { ...DEFAULT_STATE };
        await store.put('state', JSON.stringify(state));
        await store.put('seeded', SEED_VERSION);
      }

      return json({ state: state || { ...DEFAULT_STATE } });
    }

    if (request.method === 'PUT') {
      if (!await isAdmin(request, env)) {
        return json({ error: 'Wymagane uprawnienia administratora.' }, 401);
      }
      await store.put('state', JSON.stringify(await request.json()));
      return json({ ok: true });
    }

    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, POST, PUT' }
    });
  } catch (error) {
    console.error(error);
    return json({ error: 'Błąd serwera.' }, 500);
  }
}
