// ============================================================================
//  上当模拟器 · 后端服务
//  Express + SQLite，无登录系统，匿名 sessionId 标识用户
//  所有金额均为模拟资金，不涉及任何真实支付
// ============================================================================

const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'game.db');

// ---------- 启动 SQLite ----------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[DB] 打开失败:', err);
    process.exit(1);
  }
  console.log('[DB] 已连接到', DB_PATH);
});

// 简易 Promise 包装
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    })
  );
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (e, row) => (e ? reject(e) : resolve(row))));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));

// ---------- 初始化数据表 ----------
async function initSchema() {
  await dbRun(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    balance INTEGER DEFAULT 10000,
    debt INTEGER DEFAULT 0,
    completed_count INTEGER DEFAULT 0,
    scam_count INTEGER DEFAULT 0,
    recovery_used_count INTEGER DEFAULT 0,
    total_recovered INTEGER DEFAULT 0,
    total_earned INTEGER DEFAULT 0,
    total_lost INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS level_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    level_id INTEGER NOT NULL,
    start_balance INTEGER,
    end_balance INTEGER,
    delta INTEGER,
    is_scammed INTEGER DEFAULT 0,
    trap_count INTEGER DEFAULT 0,
    main_tactic TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    level_id TEXT,
    event_type TEXT,
    trap_code TEXT,
    trap_name TEXT,
    tactic TEXT,
    amount_change INTEGER DEFAULT 0,
    balance_after INTEGER DEFAULT 0,
    debt_after INTEGER DEFAULT 0,
    severity INTEGER DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    level_id TEXT,
    amount INTEGER NOT NULL,
    reason TEXT,
    balance_after INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS system_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    visited_at TEXT DEFAULT CURRENT_TIMESTAMP,
    visit_date TEXT DEFAULT (date('now', 'localtime'))
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS active_visitors (
    visitor_id TEXT PRIMARY KEY,
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS level_plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT,
    session_id TEXT,
    level_id INTEGER NOT NULL,
    played_at TEXT DEFAULT CURRENT_TIMESTAMP,
    play_date TEXT DEFAULT (date('now', 'localtime'))
  )`);

  // 索引（简单加速）
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_level_session ON level_results(session_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_tx_session ON transactions(session_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_active_last_seen ON active_visitors(last_seen_at)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_level_plays_level ON level_plays(level_id)`);
  console.log('[DB] 数据表初始化完成');
}

// ---------- 工具 ----------
const newSessionId = () => 'sx_' + crypto.randomBytes(8).toString('hex');

const RANDOM_NICKS = [
  '上头的松鼠', '冷静的刺猬', '想回本的熊猫', '差点暴富的狐狸', '反诈小树苗',
  '一把梭哈的鸽子', '提现失败的浣熊', '热度挑战者', '最后一把玩家', '复活三次的海豹',
  '不信邪的橘猫', '热血蜂鸟', '佛系考拉', '熬夜的小鹿', '清醒的章鱼',
  '点错按钮的山猫', '看广告的兔子', '抽不中的柴犬', '等翻倍的羊驼', '想躺平的水豚'
];
const randNick = () => RANDOM_NICKS[Math.floor(Math.random() * RANDOM_NICKS.length)] +
  (Math.random() < 0.4 ? Math.floor(Math.random() * 99) : '');

const sanitizeNick = (s) => {
  if (!s || typeof s !== 'string') return randNick();
  s = s.trim().slice(0, 20);
  if (!s) return randNick();
  return s;
};

const sanitizeVisitorId = (s) => {
  if (!s || typeof s !== 'string') return 'v_' + crypto.randomBytes(8).toString('hex');
  s = s.trim().slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  return s || ('v_' + crypto.randomBytes(8).toString('hex'));
};

// ---------- Express 服务 ----------
const app = express();
app.use(bodyParser.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

// 默认页：游戏入口
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// 大屏页：复用同一 HTML，前端根据 path 切换
app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ============================================================================
//  API: POST /api/start —— 创建匿名玩家
// ============================================================================
app.post('/api/start', async (req, res) => {
  try {
    const nickname = sanitizeNick(req.body && req.body.nickname);
    const sessionId = newSessionId();
    await dbRun(
      `INSERT INTO sessions (session_id, nickname, balance, debt) VALUES (?, ?, ?, ?)`,
      [sessionId, nickname, 10000, 0]
    );
    res.json({ ok: true, sessionId, nickname, balance: 10000, debt: 0 });
  } catch (e) {
    console.error('[start]', e);
    res.status(500).json({ ok: false, error: 'start_failed' });
  }
});

// ============================================================================
//  API: GET /api/state/:sessionId
// ============================================================================
app.get('/api/state/:sessionId', async (req, res) => {
  try {
    const row = await dbGet(`SELECT * FROM sessions WHERE session_id = ?`, [req.params.sessionId]);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    const levels = await dbAll(
      `SELECT level_id, start_balance, end_balance, delta, is_scammed, trap_count, main_tactic
       FROM level_results WHERE session_id = ? ORDER BY level_id ASC`,
      [req.params.sessionId]
    );
    const events = await dbAll(
      `SELECT level_id, event_type, trap_code, trap_name, tactic, amount_change, severity, note, created_at
       FROM events WHERE session_id = ? ORDER BY id ASC LIMIT 500`,
      [req.params.sessionId]
    );
    res.json({ ok: true, session: row, levels, events });
  } catch (e) {
    console.error('[state]', e);
    res.status(500).json({ ok: false, error: 'state_failed' });
  }
});

// ============================================================================
//  API: POST /api/event —— 记录事件 / 陷阱 / 金额变化
// ============================================================================
app.post('/api/event', async (req, res) => {
  try {
    const {
      sessionId, levelId = null, eventType = 'generic',
      trapCode = null, trapName = null, tactic = null,
      amountChange = 0, severity = 1, note = null
    } = req.body || {};

    if (!sessionId) return res.status(400).json({ ok: false, error: 'missing_session' });

    const session = await dbGet(`SELECT * FROM sessions WHERE session_id = ?`, [sessionId]);
    if (!session) return res.status(404).json({ ok: false, error: 'no_session' });

    const newBalance = session.balance + Number(amountChange || 0);
    let totalEarned = session.total_earned;
    let totalLost = session.total_lost;
    if (amountChange > 0) totalEarned += amountChange;
    if (amountChange < 0) totalLost += -amountChange;

    await dbRun(
      `UPDATE sessions
        SET balance = ?, total_earned = ?, total_lost = ?,
            scam_count = scam_count + ?, updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`,
      [newBalance, totalEarned, totalLost, trapCode ? 1 : 0, sessionId]
    );

    await dbRun(
      `INSERT INTO events (session_id, level_id, event_type, trap_code, trap_name, tactic, amount_change, balance_after, debt_after, severity, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, levelId ? String(levelId) : null, eventType, trapCode, trapName, tactic,
        amountChange | 0, newBalance | 0, session.debt | 0, severity | 0, note]
    );

    if (amountChange !== 0) {
      await dbRun(
        `INSERT INTO transactions (session_id, level_id, amount, reason, balance_after)
         VALUES (?, ?, ?, ?, ?)`,
        [sessionId, levelId ? String(levelId) : null, amountChange | 0, note || trapName || eventType, newBalance | 0]
      );
    }

    res.json({ ok: true, balance: newBalance, debt: session.debt });
  } catch (e) {
    console.error('[event]', e);
    res.status(500).json({ ok: false, error: 'event_failed' });
  }
});

// ============================================================================
//  API: POST /api/balance —— 直接设置余额/负债（用于回血、签到、借款）
// ============================================================================
app.post('/api/balance', async (req, res) => {
  try {
    const { sessionId, balance, debt, recoveryDelta = 0, recoveredAmount = 0 } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: 'missing_session' });
    const session = await dbGet(`SELECT * FROM sessions WHERE session_id = ?`, [sessionId]);
    if (!session) return res.status(404).json({ ok: false, error: 'no_session' });

    await dbRun(
      `UPDATE sessions
        SET balance = ?, debt = ?,
            recovery_used_count = recovery_used_count + ?,
            total_recovered = total_recovered + ?,
            updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`,
      [
        Number.isFinite(balance) ? balance : session.balance,
        Number.isFinite(debt) ? debt : session.debt,
        recoveryDelta | 0,
        recoveredAmount | 0,
        sessionId
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[balance]', e);
    res.status(500).json({ ok: false, error: 'balance_failed' });
  }
});

// ============================================================================
//  API: POST /api/complete-level —— 关卡完成
// ============================================================================
app.post('/api/complete-level', async (req, res) => {
  try {
    const {
      sessionId, levelId, startBalance = 0, endBalance = 0,
      isScammed = 0, trapCount = 0, mainTactic = null
    } = req.body || {};
    if (!sessionId || !levelId) return res.status(400).json({ ok: false, error: 'missing_params' });
    const delta = Number(endBalance) - Number(startBalance);

    await dbRun(
      `INSERT INTO level_results (session_id, level_id, start_balance, end_balance, delta, is_scammed, trap_count, main_tactic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, levelId | 0, startBalance | 0, endBalance | 0, delta | 0, isScammed ? 1 : 0, trapCount | 0, mainTactic]
    );
    await dbRun(
      `UPDATE sessions SET completed_count = completed_count + 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?`,
      [sessionId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[complete-level]', e);
    res.status(500).json({ ok: false, error: 'complete_failed' });
  }
});

async function buildStats() {
  const online = await dbGet(
    `SELECT COUNT(*) AS n
       FROM active_visitors
      WHERE last_seen_at >= datetime('now', '-5 minutes')`
  );
  const totalVisits = await dbGet(`SELECT COUNT(*) AS n FROM visits`);
  const todayVisits = await dbGet(
    `SELECT COUNT(*) AS n FROM visits WHERE visit_date = date('now', 'localtime')`
  );
  const levels = await dbAll(
    `SELECT level_id, COUNT(*) AS participants
       FROM level_plays
      GROUP BY level_id
      ORDER BY level_id ASC`
  );
  return {
    ok: true,
    online: online ? online.n : 0,
    totalVisits: totalVisits ? totalVisits.n : 0,
    todayVisits: todayVisits ? todayVisits.n : 0,
    levels: levels || []
  };
}

// ============================================================================
//  API: POST /api/visit —— 页面访问与在线心跳
// ============================================================================
app.post('/api/visit', async (req, res) => {
  try {
    const visitorId = sanitizeVisitorId(req.body && req.body.visitorId);
    const eventType = req.body && req.body.eventType === 'heartbeat' ? 'heartbeat' : 'pageview';

    if (eventType === 'pageview') {
      await dbRun(`INSERT INTO visits (visitor_id) VALUES (?)`, [visitorId]);
    }
    await dbRun(
      `INSERT INTO active_visitors (visitor_id, last_seen_at)
       VALUES (?, CURRENT_TIMESTAMP)
       ON CONFLICT(visitor_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`,
      [visitorId]
    );
    res.json(await buildStats());
  } catch (e) {
    console.error('[visit]', e);
    res.status(500).json({ ok: false, error: 'visit_failed' });
  }
});

// ============================================================================
//  API: POST /api/level-play —— 进入关卡即记录一次游玩
// ============================================================================
app.post('/api/level-play', async (req, res) => {
  try {
    const { levelId, sessionId = null } = req.body || {};
    const id = Number(levelId);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_level' });
    const visitorId = sanitizeVisitorId(req.body && req.body.visitorId);

    await dbRun(
      `INSERT INTO active_visitors (visitor_id, last_seen_at)
       VALUES (?, CURRENT_TIMESTAMP)
       ON CONFLICT(visitor_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`,
      [visitorId]
    );
    await dbRun(
      `INSERT INTO level_plays (visitor_id, session_id, level_id) VALUES (?, ?, ?)`,
      [visitorId, sessionId ? String(sessionId).slice(0, 80) : null, id]
    );
    res.json(await buildStats());
  } catch (e) {
    console.error('[level-play]', e);
    res.status(500).json({ ok: false, error: 'level_play_failed' });
  }
});

// ============================================================================
//  API: GET /api/stats —— 在线、访问量、各关游玩人次
// ============================================================================
app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await buildStats());
  } catch (e) {
    console.error('[stats]', e);
    res.status(500).json({ ok: false, error: 'stats_failed' });
  }
});

app.get('/api/screen', async (_req, res) => {
  try {
    res.json(await buildStats());
  } catch (e) {
    console.error('[screen]', e);
    res.status(500).json({ ok: false, error: 'screen_failed' });
  }
});

// ============================================================================
//  API: POST /api/reset —— 仅本地清空数据，需带 confirm: 'YES_RESET'
// ============================================================================
app.post('/api/reset', async (req, res) => {
  if (!req.body || req.body.confirm !== 'YES_RESET') {
    return res.status(400).json({ ok: false, error: 'need_confirm' });
  }
  try {
    await dbRun(`DELETE FROM events`);
    await dbRun(`DELETE FROM transactions`);
    await dbRun(`DELETE FROM level_results`);
    await dbRun(`DELETE FROM level_plays`);
    await dbRun(`DELETE FROM visits`);
    await dbRun(`DELETE FROM active_visitors`);
    await dbRun(`DELETE FROM sessions`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[reset]', e);
    res.status(500).json({ ok: false, error: 'reset_failed' });
  }
});

// ---------- 启动 ----------
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  ╔═══════════════════════════════════════╗`);
      console.log(`  ║  上当模拟器 已启动                     ║`);
      console.log(`  ║  http://localhost:${PORT}                ║`);
      console.log(`  ║  大屏: http://localhost:${PORT}/screen   ║`);
      console.log(`  ║  扫码进指定关: ?level=1 ... ?level=10  ║`);
      console.log(`  ╚═══════════════════════════════════════╝\n`);
    });
  })
  .catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
