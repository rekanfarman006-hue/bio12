// Supabase Edge Function "fib-pay" — student pays with FIB (First Iraqi Bank) and the account becomes paid automatically.
// Secrets (Edge Functions > Secrets):
//   FIB_CLIENT_ID, FIB_CLIENT_SECRET   (from FIB after the Integration Request Form)
//   FIB_PRICE      price in IQD, e.g. 25000
//   FIB_ENV        "stage" for testing (default) or "prod"
// Turn OFF "Verify JWT" for this function (FIB's callback has no login; students are checked inside).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const out = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const BASE = () => env('FIB_ENV') === 'prod' ? 'https://fib.iq' : 'https://fib.stage.fib.iq';
const SB = env('SUPABASE_URL');
const SR = env('SUPABASE_SERVICE_ROLE_KEY');
const db = (path: string, init: RequestInit = {}) => fetch(SB + '/rest/v1/' + path, {
  ...init, headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
});

async function fibToken(): Promise<string> {
  const r = await fetch(BASE() + '/auth/realms/fib-online-shop/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('FIB_CLIENT_ID'), client_secret: env('FIB_CLIENT_SECRET') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('fib auth ' + r.status);
  return j.access_token;
}
async function fibStatus(id: string) {
  const t = await fibToken();
  const r = await fetch(BASE() + '/protected/v1/payments/' + encodeURIComponent(id) + '/status', { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('fib status ' + r.status);
  return j as { status: string; paidAt?: string; amount?: { amount: number } };
}
async function markPaid(id: string) {
  const rows = await (await db('payments?id=eq.' + encodeURIComponent(id) + '&select=user_id,amount,status')).json();
  const p = rows?.[0]; if (!p) return false;
  await db('payments?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: 'PAID', paid_at: new Date().toISOString() }) });
  await db('profiles?id=eq.' + p.user_id, { method: 'PATCH', body: JSON.stringify({ paid: true }) });
  return true;
}
async function check(id: string) {
  const s = await fibStatus(id);
  if (s.status === 'PAID') { await markPaid(id); return 'PAID'; }
  if (s.status === 'DECLINED') await db('payments?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: 'DECLINED' }) });
  return s.status;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  try {
    // FIB calls this when a payment changes; never trust the body, ask FIB itself
    if (url.searchParams.get('cb') === '1') {
      const b = await req.json().catch(() => ({}));
      if (b?.id) await check(String(b.id));
      return out({ ok: true });
    }
    if (!env('FIB_CLIENT_ID') || !env('FIB_CLIENT_SECRET')) return out({ ok: false, err: 'nokey' });
    // who is the student?
    const u = await fetch(SB + '/auth/v1/user', { headers: { apikey: env('SUPABASE_ANON_KEY') || SR, Authorization: req.headers.get('Authorization') ?? '' } });
    const user = await u.json().catch(() => ({}));
    if (!u.ok || !user?.id) return out({ ok: false, err: 'auth' });
    const prof = (await (await db('profiles?id=eq.' + user.id + '&select=paid')).json())?.[0];
    if (prof?.paid) return out({ ok: true, paid: true });
    const body = await req.json().catch(() => ({}));

    if (body.act === 'status') {
      const own = (await (await db('payments?id=eq.' + encodeURIComponent(String(body.id)) + '&user_id=eq.' + user.id + '&select=id')).json())?.[0];
      if (!own) return out({ ok: false, err: 'auth' });
      const st = await check(own.id);
      return out({ ok: true, status: st, paid: st === 'PAID' });
    }

    // create (or re-use a payment that is still valid for 2+ minutes)
    const now = Date.now();
    const open = (await (await db('payments?user_id=eq.' + user.id + '&status=eq.UNPAID&order=created_at.desc&limit=1&select=*')).json())?.[0];
    if (open && new Date(open.valid_until).getTime() - now > 120000) {
      const st = await check(open.id).catch(() => 'UNPAID');
      if (st === 'PAID') return out({ ok: true, paid: true });
      if (st === 'UNPAID') return out({ ok: true, pay: open });
    }
    const price = Math.max(250, parseInt(env('FIB_PRICE') || '0', 10));
    if (!price) return out({ ok: false, err: 'nokey' });
    const t = await fibToken();
    const r = await fetch(BASE() + '/protected/v1/payments', {
      method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ monetaryValue: { amount: String(price), currency: 'IQD' }, statusCallbackUrl: SB + '/functions/v1/fib-pay?cb=1', description: 'Klil Pro' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.paymentId) { console.log('fib create', r.status, JSON.stringify(j).slice(0, 300)); return out({ ok: false, err: 'fib' }); }
    const row = { id: j.paymentId, user_id: user.id, amount: price, status: 'UNPAID', valid_until: j.validUntil, readable: j.readableCode, qr: j.qrCode, link: j.personalAppLink ?? j.businessAppLink ?? null };
    await db('payments', { method: 'POST', body: JSON.stringify(row) });
    return out({ ok: true, pay: row });
  } catch (e) {
    console.log('fib-pay', String(e));
    return out({ ok: false, err: 'fib' });
  }
});
