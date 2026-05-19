import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type AnyRow = Record<string, any>;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store'
};

const randomNicks = ['冷静玩家', '反诈同学', '清醒挑战者', '稳住选手', '认真核验员', '谨慎观察员'];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function getClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function readBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function routeFromUrl(req: Request) {
  const url = new URL(req.url);
  const apiIndex = url.pathname.indexOf('/api/');
  if (apiIndex >= 0) return url.pathname.slice(apiIndex).replace(/\/$/, '');
  return url.pathname.replace(/^\/functions\/v1\/fraud-game-api/, '').replace(/^\/fraud-game-api/, '').replace(/\/$/, '') || '/';
}

function newSessionId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'sx_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeNick(input: unknown) {
  const s = typeof input === 'string' ? input.trim().slice(0, 20) : '';
  if (s) return s;
  return randomNicks[Math.floor(Math.random() * randomNicks.length)] + Math.floor(Math.random() * 99);
}

function sanitizeVisitorId(input: unknown) {
  const s = typeof input === 'string' ? input.trim().slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (s) return s;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'v_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function asInt(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function getSession(supabase: ReturnType<typeof createClient>, sessionId: string) {
  const { data, error } = await supabase.from('sessions').select('*').eq('session_id', sessionId).maybeSingle();
  if (error) throw error;
  return data as AnyRow | null;
}

async function touchVisitor(supabase: ReturnType<typeof createClient>, visitorId: string) {
  const { error } = await supabase
    .from('active_visitors')
    .upsert({ visitor_id: visitorId, last_seen_at: new Date().toISOString() }, { onConflict: 'visitor_id' });
  if (error) throw error;
}

async function buildStats(supabase: ReturnType<typeof createClient>) {
  const onlineSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const today = shanghaiDate();
  const [
    { count: online, error: onlineError },
    { count: totalVisits, error: totalError },
    { count: todayVisits, error: todayError },
    { data: plays, error: playsError }
  ] = await Promise.all([
    supabase.from('active_visitors').select('visitor_id', { count: 'exact', head: true }).gte('last_seen_at', onlineSince),
    supabase.from('visits').select('id', { count: 'exact', head: true }),
    supabase.from('visits').select('id', { count: 'exact', head: true }).eq('visit_date', today),
    supabase.from('level_plays').select('level_id').limit(10000)
  ]);

  if (onlineError) throw onlineError;
  if (totalError) throw totalError;
  if (todayError) throw todayError;
  if (playsError) throw playsError;

  const byLevel = new Map<number, number>();
  for (const row of plays || []) {
    const id = asInt(row.level_id);
    if (id > 0) byLevel.set(id, (byLevel.get(id) || 0) + 1);
  }

  return {
    ok: true,
    online: online || 0,
    totalVisits: totalVisits || 0,
    todayVisits: todayVisits || 0,
    levels: Array.from(byLevel.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([level_id, participants]) => ({ level_id, participants }))
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = getClient();
    const route = routeFromUrl(req);

    if (req.method === 'POST' && route === '/api/visit') {
      const body = await readBody(req);
      const visitorId = sanitizeVisitorId(body.visitorId);
      await touchVisitor(supabase, visitorId);
      if (body.eventType !== 'heartbeat') {
        const { error } = await supabase.from('visits').insert({ visitor_id: visitorId, visit_date: shanghaiDate() });
        if (error) throw error;
      }
      return json(await buildStats(supabase));
    }

    if (req.method === 'POST' && route === '/api/level-play') {
      const body = await readBody(req);
      const visitorId = sanitizeVisitorId(body.visitorId);
      const levelId = asInt(body.levelId);
      if (levelId < 1) return json({ ok: false, error: 'invalid_level' }, 400);
      await touchVisitor(supabase, visitorId);
      const { error } = await supabase.from('level_plays').insert({
        visitor_id: visitorId,
        session_id: body.sessionId ? String(body.sessionId).slice(0, 80) : null,
        level_id: levelId,
        play_date: shanghaiDate()
      });
      if (error) throw error;
      return json(await buildStats(supabase));
    }

    if (req.method === 'POST' && route === '/api/start') {
      const body = await readBody(req);
      const sessionId = newSessionId();
      const nickname = sanitizeNick(body.nickname);
      const { error } = await supabase
        .from('sessions')
        .insert({ session_id: sessionId, nickname, balance: 10000, debt: 0 });
      if (error) throw error;
      return json({ ok: true, sessionId, nickname, balance: 10000, debt: 0 });
    }

    if (req.method === 'GET' && route.startsWith('/api/state/')) {
      const sessionId = decodeURIComponent(route.split('/').pop() || '');
      const session = await getSession(supabase, sessionId);
      if (!session) return json({ ok: false, error: 'not_found' }, 404);

      const [{ data: levels, error: levelsError }, { data: events, error: eventsError }] = await Promise.all([
        supabase
          .from('level_results')
          .select('level_id,start_balance,end_balance,delta,is_scammed,trap_count,main_tactic')
          .eq('session_id', sessionId)
          .order('level_id', { ascending: true }),
        supabase
          .from('events')
          .select('level_id,event_type,trap_code,trap_name,tactic,amount_change,severity,note,created_at')
          .eq('session_id', sessionId)
          .order('id', { ascending: true })
          .limit(500)
      ]);
      if (levelsError) throw levelsError;
      if (eventsError) throw eventsError;
      return json({ ok: true, session, levels: levels || [], events: events || [] });
    }

    if (req.method === 'POST' && route === '/api/event') {
      const body = await readBody(req);
      if (!body.sessionId) return json({ ok: false, error: 'missing_session' }, 400);
      const session = await getSession(supabase, body.sessionId);
      if (!session) return json({ ok: false, error: 'no_session' }, 404);

      const amountChange = asInt(body.amountChange);
      const newBalance = asInt(session.balance) + amountChange;
      const totalEarned = asInt(session.total_earned) + (amountChange > 0 ? amountChange : 0);
      const totalLost = asInt(session.total_lost) + (amountChange < 0 ? -amountChange : 0);
      const scamCount = asInt(session.scam_count) + (body.trapCode ? 1 : 0);

      const [{ error: sessionError }, { error: eventError }] = await Promise.all([
        supabase
          .from('sessions')
          .update({
            balance: newBalance,
            total_earned: totalEarned,
            total_lost: totalLost,
            scam_count: scamCount,
            updated_at: new Date().toISOString()
          })
          .eq('session_id', body.sessionId),
        supabase.from('events').insert({
          session_id: body.sessionId,
          level_id: body.levelId == null ? null : String(body.levelId),
          event_type: body.eventType || 'generic',
          trap_code: body.trapCode || null,
          trap_name: body.trapName || null,
          tactic: body.tactic || null,
          amount_change: amountChange,
          balance_after: newBalance,
          debt_after: asInt(session.debt),
          severity: asInt(body.severity, 1),
          note: body.note || null
        })
      ]);
      if (sessionError) throw sessionError;
      if (eventError) throw eventError;

      if (amountChange !== 0) {
        const { error } = await supabase.from('transactions').insert({
          session_id: body.sessionId,
          level_id: body.levelId == null ? null : String(body.levelId),
          amount: amountChange,
          reason: body.note || body.trapName || body.eventType || null,
          balance_after: newBalance
        });
        if (error) throw error;
      }

      return json({ ok: true, balance: newBalance, debt: asInt(session.debt) });
    }

    if (req.method === 'POST' && route === '/api/balance') {
      const body = await readBody(req);
      if (!body.sessionId) return json({ ok: false, error: 'missing_session' }, 400);
      const session = await getSession(supabase, body.sessionId);
      if (!session) return json({ ok: false, error: 'no_session' }, 404);

      const { error } = await supabase
        .from('sessions')
        .update({
          balance: Number.isFinite(body.balance) ? asInt(body.balance) : asInt(session.balance),
          debt: Number.isFinite(body.debt) ? asInt(body.debt) : asInt(session.debt),
          recovery_used_count: asInt(session.recovery_used_count) + asInt(body.recoveryDelta),
          total_recovered: asInt(session.total_recovered) + asInt(body.recoveredAmount),
          updated_at: new Date().toISOString()
        })
        .eq('session_id', body.sessionId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (req.method === 'POST' && route === '/api/complete-level') {
      const body = await readBody(req);
      if (!body.sessionId || !body.levelId) return json({ ok: false, error: 'missing_params' }, 400);
      const session = await getSession(supabase, body.sessionId);
      if (!session) return json({ ok: false, error: 'no_session' }, 404);

      const startBalance = asInt(body.startBalance);
      const endBalance = asInt(body.endBalance);
      const [{ error: insertError }, { error: updateError }] = await Promise.all([
        supabase.from('level_results').insert({
          session_id: body.sessionId,
          level_id: asInt(body.levelId),
          start_balance: startBalance,
          end_balance: endBalance,
          delta: endBalance - startBalance,
          is_scammed: body.isScammed ? 1 : 0,
          trap_count: asInt(body.trapCount),
          main_tactic: body.mainTactic || null
        }),
        supabase
          .from('sessions')
          .update({ completed_count: asInt(session.completed_count) + 1, updated_at: new Date().toISOString() })
          .eq('session_id', body.sessionId)
      ]);
      if (insertError) throw insertError;
      if (updateError) throw updateError;
      return json({ ok: true });
    }

    if (req.method === 'GET' && (route === '/api/stats' || route === '/api/screen')) {
      return json(await buildStats(supabase));
    }

    if (req.method === 'POST' && route === '/api/reset') {
      const body = await readBody(req);
      if (body.confirm !== 'YES_RESET') return json({ ok: false, error: 'need_confirm' }, 400);
      const deletes = await Promise.all([
        supabase.from('events').delete().neq('id', 0),
        supabase.from('transactions').delete().neq('id', 0),
        supabase.from('level_results').delete().neq('id', 0),
        supabase.from('level_plays').delete().neq('id', 0),
        supabase.from('visits').delete().neq('id', 0),
        supabase.from('active_visitors').delete().neq('visitor_id', ''),
        supabase.from('sessions').delete().neq('id', 0)
      ]);
      const failed = deletes.find((r) => r.error);
      if (failed && failed.error) throw failed.error;
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: 'supabase_function_error', message: error.message || String(error) }, 500);
  }
});
