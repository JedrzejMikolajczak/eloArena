import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const store = getStore('elo-arena-state');
const seedVersion = 'a.txt-v2';
const tokenLifetime = 1000 * 60 * 60 * 24 * 30;
const defaultState = {
  players: [],
  queue: [],
  pending: null,
  matches: [],
  settings: { k: 40, startElo: 1000 }
};

function envValue(name){
  if(typeof Netlify !== 'undefined' && Netlify.env?.get){
    const netlifyValue = Netlify.env.get(name);
    if(netlifyValue) return netlifyValue;
  }
  return process.env[name] || '';
}

function sign(value){
  const secret = envValue('ADMIN_SECRET') || envValue('ADMIN_PASSWORD');
  if(!secret) throw new Error('Brak ADMIN_SECRET lub ADMIN_PASSWORD.');
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function createToken(){
  const expires = String(Date.now() + tokenLifetime);
  return `${expires}.${sign(expires)}`;
}

function isCorrectPassword(password){
  if(!password) return false;
  const configured = envValue('ADMIN_PASSWORD');
  return Boolean(configured) && password === configured;
}

function isAdmin(request){
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [expires, signature] = token.split('.');
  if(!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = sign(expires);
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export default async function handler(request) {
  if(request.method === 'POST'){
    const { password } = await request.json();
    if(!isCorrectPassword(password)){
      return Response.json({ error: 'Nieprawidłowe hasło.' }, { status: 401 });
    }
    return Response.json({ token: createToken() });
  }

  if(request.method === 'GET'){
    let state = await store.get('state', { type: 'json' });
    const seeded = await store.get('seeded', { type: 'json' });

    if(seeded !== seedVersion && (!state || (state.players.length === 0 && state.matches.length === 0))){
      const seedResponse = await fetch(new URL('/a.txt', request.url));
      state = seedResponse.ok ? await seedResponse.json() : defaultState;
      await store.setJSON('state', state);
      await store.setJSON('seeded', seedVersion);
    }

    if(!state) state = defaultState;

    return Response.json({ state }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' }
    });
  }

  if(request.method === 'PUT'){
    if(!isAdmin(request)){
      return Response.json({ error: 'Wymagane uprawnienia administratora.' }, { status: 401 });
    }
    const state = await request.json();
    await store.setJSON('state', state);
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', {
    status: 405,
    headers: { Allow: 'GET, PUT' }
  });
}