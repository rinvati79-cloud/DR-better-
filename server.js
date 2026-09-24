import express from 'express';
import fs from 'node:fs/promises';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const app = express();

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN?.split(',').map(s => s.trim()) || true
}));

app.use(express.json());
app.use(express.static('/app/public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('JWT_SECRET is required. Set it in the environment before starting the API.');
  process.exit(1);
}

const AUTO_UPCOMING_PER_GAME = 10;
const AUTO_MATCH_INTERVAL_MINUTES = 30;
const AUTO_GAMES = {
  'BR SURVIVAL': { prefix: 'BR Survival', variants: [
    {entryFee: 11, prizePool: 180, slots: 20, startOffsetMinutes: 30, label: 'M1'},
    {entryFee: 16, prizePool: 260, slots: 20, startOffsetMinutes: 60, label: 'M2'}
  ]},
  'PER KILL MATCHES': { prefix: 'Per Kill Match', variants: [
    {entryFee: 11, prizePool: 0, slots: 48, startOffsetMinutes: 35, label: 'M1'},
    {entryFee: 11, prizePool: 0, slots: 48, startOffsetMinutes: 65, label: 'M2'}
  ]},
  'CLASH SQUAD 1V1': { prefix: 'Clash Squad 1V1', variants: [
    {entryFee: 30, prizePool: 45, slots: 2, startOffsetMinutes: 40, label: 'M1'},
    {entryFee: 36, prizePool: 55, slots: 2, startOffsetMinutes: 70, label: 'M2'}
  ]},
  'LONE WOLF 1V1': { prefix: 'Lone Wolf 1V1', variants: [
    {entryFee: 20, prizePool: 30, slots: 2, startOffsetMinutes: 45, label: 'M1'},
    {entryFee: 26, prizePool: 36, slots: 2, startOffsetMinutes: 75, label: 'M2'}
  ]},
  'CLASH SQUAD 4V4': { prefix: 'Clash Squad 4V4', variants: [
    {entryFee: 40, prizePool: 268, slots: 8, startOffsetMinutes: 50, label: 'M1'},
    {entryFee: 46, prizePool: 308, slots: 8, startOffsetMinutes: 80, label: 'M2'}
  ]},
  'LONE WOLF 2V2': { prefix: 'Lone Wolf 2V2', variants: [
    {entryFee: 26, prizePool: 80, slots: 4, startOffsetMinutes: 55, label: 'M1'},
    {entryFee: 30, prizePool: 94, slots: 4, startOffsetMinutes: 85, label: 'M2'}
  ]}
};
const AUTO_GAME_NAMES = Object.keys(AUTO_GAMES);

async function createAutoContest(game, config, startsAt, variant) {
  const latest = await pool.query(`SELECT title FROM contests WHERE game=$1 ORDER BY id DESC LIMIT 1`, [game]);
  let nextNumber = 1;
  const match = String(latest.rows[0]?.title || '').match(/#(\d+)$/);
  if (match) nextNumber = Number(match[1]) + 1;
  else {
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM contests WHERE game=$1`, [game]);
    nextNumber = Number(count.rows[0]?.count || 0) + 1;
  }
  const title = `${config.prefix} ${variant.label} #${nextNumber}`;
  const result = await pool.query(
    `INSERT INTO contests (game,title,entry_fee,prize_pool,slots,status,starts_at)
     VALUES($1,$2,$3,$4,$5,'upcoming',$6) RETURNING *`,
    [game, title, variant.entryFee, variant.prizePool, variant.slots, startsAt]
  );
  return result.rows[0];
}

async function ensureAutoContests() {
  for (const [game, config] of Object.entries(AUTO_GAMES)) {
    const result = await pool.query(
      `SELECT id,title,starts_at FROM contests WHERE game=$1 AND status='upcoming' AND starts_at > NOW() ORDER BY starts_at ASC`, [game]
    );
    const existing = result.rows.length;
    const missing = Math.max(0, AUTO_UPCOMING_PER_GAME - existing);
    if (!missing) continue;
    let nextStart = existing
      ? new Date(result.rows[existing - 1].starts_at.getTime ? result.rows[existing - 1].starts_at.getTime() : new Date(result.rows[existing - 1].starts_at).getTime())
      : new Date(Date.now() + config.variants[0].startOffsetMinutes * 60000);
    if (existing) nextStart = new Date(nextStart.getTime() + AUTO_MATCH_INTERVAL_MINUTES * 60000);
    for (let i = 0; i < missing; i++) {
      const variant = config.variants[(existing + i) % config.variants.length];
      await createAutoContest(game, config, nextStart.toISOString(), variant);
      nextStart = new Date(nextStart.getTime() + AUTO_MATCH_INTERVAL_MINUTES * 60000);
    }
  }
}

async function updateAutoContestStatuses() {
  await pool.query(
    `UPDATE contests
     SET status='ongoing'
     WHERE status='upcoming'
       AND starts_at <= NOW()
       AND game = ANY($1::text[])`,
    [AUTO_GAME_NAMES]
  );

  await removeExpiredUnusedAutoContests();
  await ensureAutoContests();
}

function startAutoGameSystem() {
  updateAutoContestStatuses().catch(e => console.error('Auto Game System:', e));
  setInterval(() => {
    updateAutoContestStatuses().catch(e => console.error('Auto Game System:', e));
  }, 30000);
}

async function initDatabase() {
  const schema = await fs.readFile('/app/schema.sql', 'utf8');
  await pool.query(schema);
  console.log('Database schema is ready.');

  // Per Kill matches now use ₹11 entry fee. Update existing upcoming
  // matches that have no joined players so the new fee applies immediately.
  await pool.query(
    `UPDATE contests c
     SET entry_fee=11
     WHERE c.game='PER KILL MATCHES'
       AND c.status='upcoming'
       AND NOT EXISTS (SELECT 1 FROM contest_joins j WHERE j.contest_id=c.id)`
  );

  // पुराने unjoined demo matches को एक बार साफ करें। Joined matches सुरक्षित रहेंगे।
  await pool.query(`
    DELETE FROM contests c
    WHERE c.status = 'upcoming'
      AND c.game = ANY($1::text[])
      AND NOT EXISTS (
        SELECT 1 FROM contest_joins j WHERE j.contest_id = c.id
      );
  `, [AUTO_GAME_NAMES]);

  // हर गेम के लिए अलग-अलग समय वाले upcoming matches बनाएं।
  await ensureAutoContests();
  console.log('Auto Game System is ready.');
}

function sign(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      isAdmin: Boolean(user.is_admin)
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';

  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      service: 'DR Better API',
      database: 'connected'
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: 'DR Better API',
      database: 'disconnected'
    });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const gameUid = String(req.body?.gameUid || '').trim();
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const mobile = String(req.body?.mobile || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const referralInput = String(req.body?.referralCode || '').trim();

    if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3-30 letters, numbers or underscore'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters'
      });
    }

    if (
      firstName.length > 60 ||
      lastName.length > 60 ||
      mobile.length > 20 ||
      email.length > 160 ||
      referralInput.length > 30
    ) {
      return res.status(400).json({
        error: 'Profile field is too long'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const referralCode = (
      'DR' +
      username +
      Math.random().toString(36).slice(2, 7)
    ).slice(0, 30).toUpperCase();

    const result = await pool.query(
      `INSERT INTO users
       (username,password_hash,game_uid,first_name,last_name,mobile,email,referral_code,referred_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,username,game_uid,first_name,last_name,mobile,email,referral_code,created_at`,
      [
        username,
        hash,
        gameUid || null,
        firstName || null,
        lastName || null,
        mobile || null,
        email || null,
        referralCode,
        referralInput || null
      ]
    );

    const user = result.rows[0];

    await pool.query(
      'INSERT INTO wallets (user_id,balance) VALUES ($1,0)',
      [user.id]
    );

    res.status(201).json({
      token: sign(user),
      user
    });

  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({
        error: 'Username already exists'
      });
    }

    console.error(e);

    res.status(503).json({
      error: 'Database unavailable. Start/connect the real backend and PostgreSQL.'
    });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    const r = await pool.query(
      'SELECT id,username,password_hash,game_uid,is_admin,created_at FROM users WHERE username=$1',
      [username]
    );

    if (!r.rowCount) {
      return res.status(401).json({
        error: 'Invalid username or password'
      });
    }

    const user = r.rows[0];

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Invalid username or password'
      });
    }

    delete user.password_hash;

    res.json({
      token: sign(user),
      user
    });

  } catch (e) {
    console.error(e);

    res.status(503).json({
      error: 'Database unavailable. Start/connect the real backend and PostgreSQL.'
    });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT id,username,game_uid,first_name,last_name,mobile,email,
            referral_code,is_admin,created_at
     FROM users
     WHERE id=$1`,
    [req.user.sub]
  );

  if (!r.rowCount) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  res.json({
    user: r.rows[0]
  });
});

app.get('/api/wallet', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT balance FROM wallets WHERE user_id=$1',
    [req.user.sub]
  );

  res.json({
    balance: r.rowCount ? Number(r.rows[0].balance) : 0
  });
});

app.get('/api/wallet/transactions', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT id,amount,type,reference_id,status,created_at
     FROM wallet_transactions
     WHERE user_id=$1
     ORDER BY id DESC
     LIMIT 100`,
    [req.user.sub]
  );

  res.json({
    transactions: r.rows
  });
});

app.get('/api/contests', async (req, res) => {
  try {
    const params = [];
    let where = '';

    if (req.query.status) {
      params.push(String(req.query.status));
      where = 'WHERE c.status=$1';
    }

    const r = await pool.query(
      `SELECT
         c.id,
         c.game,
         c.title,
         c.entry_fee,
         c.prize_pool,
         c.slots,
         c.status,
         c.starts_at,
         COUNT(j.id) FILTER (WHERE j.status='joined')::int AS joined_slots
       FROM contests c
       LEFT JOIN contest_joins j
         ON j.contest_id=c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.starts_at ASC`,
      params
    );

    res.json(r.rows);

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message
    });
  }
});

app.get('/api/contests/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id,game,title,entry_fee,prize_pool,slots,status,starts_at
     FROM contests
     WHERE id=$1`,
    [req.params.id]
  );

  if (!r.rowCount) {
    return res.status(404).json({
      error: 'Contest not found'
    });
  }

  res.json(r.rows[0]);
});

app.get('/api/contests/:id/prizes', async (req,res)=>{
  try{
    const c=await pool.query('SELECT id,game,prize_pool,slots FROM contests WHERE id=$1',[req.params.id]);
    if(!c.rowCount) return res.status(404).json({error:'Contest not found'});
    let r=await pool.query('SELECT rank,prize FROM contest_prizes WHERE contest_id=$1 ORDER BY rank',[req.params.id]);
    if(!r.rowCount && c.rows[0].game!=='PER KILL MATCHES'){
      const defs=defaultPrizeBreakup(c.rows[0].game,c.rows[0].prize_pool,c.rows[0].slots);
      for(const x of defs) await pool.query('INSERT INTO contest_prizes(contest_id,rank,prize) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[req.params.id,x.rank,x.prize]);
      r=await pool.query('SELECT rank,prize FROM contest_prizes WHERE contest_id=$1 ORDER BY rank',[req.params.id]);
    }
    res.json({game:c.rows[0].game,prizes:r.rows.map(x=>({rank:Number(x.rank),prize:Number(x.prize)}))});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/contests/:id/joinings', async (req, res) => {
  const r = await pool.query(
    `SELECT slot,ign,status,created_at
     FROM contest_joins
     WHERE contest_id=$1
     ORDER BY slot`,
    [req.params.id]
  );

  res.json(r.rows);
});
app.post('/api/join', auth, async (req, res) => {
  const { contestId, slot, ign, uid } = req.body || {};

  if (
    !contestId ||
    !Number.isInteger(Number(contestId)) ||
    !Number.isInteger(Number(slot)) ||
    !ign ||
    !uid
  ) {
    return res.status(400).json({
      error: 'Valid contestId, slot, ign and uid are required'
    });
  }

  if (
    String(ign).trim().length > 100 ||
    String(uid).trim().length > 100
  ) {
    return res.status(400).json({
      error: 'IGN and UID must be 100 characters or less'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const c = await client.query(
      `SELECT id,entry_fee,slots,status
       FROM contests
       WHERE id=$1
       FOR UPDATE`,
      [contestId]
    );

    if (!c.rowCount) {
      throw Object.assign(
        new Error('Contest not found'),
        { status: 404 }
      );
    }

    const contest = c.rows[0];

    if (contest.status !== 'upcoming') {
      throw Object.assign(
        new Error('Contest is not open'),
        { status: 400 }
      );
    }

    if (
      Number(slot) < 1 ||
      Number(slot) > contest.slots
    ) {
      throw Object.assign(
        new Error('Invalid slot'),
        { status: 400 }
      );
    }

    const taken = await client.query(
      `SELECT 1
       FROM contest_joins
       WHERE contest_id=$1
       AND slot=$2`,
      [contestId, slot]
    );

    if (taken.rowCount) {
      throw Object.assign(
        new Error('Slot already joined'),
        { status: 409 }
      );
    }

    const w = await client.query(
      `SELECT balance
       FROM wallets
       WHERE user_id=$1
       FOR UPDATE`,
      [req.user.sub]
    );

    if (!w.rowCount) {
      throw Object.assign(
        new Error('Wallet not found'),
        { status: 400 }
      );
    }

    const balance = Number(w.rows[0].balance);
    const fee = Number(contest.entry_fee);

    if (balance < fee) {
      throw Object.assign(
        new Error('Insufficient balance'),
        { status: 400 }
      );
    }

    await client.query(
      `UPDATE wallets
       SET balance=balance-$1,updated_at=NOW()
       WHERE user_id=$2`,
      [fee, req.user.sub]
    );

    const j = await client.query(
      `INSERT INTO contest_joins
       (user_id,contest_id,slot,ign,game_uid,status)
       VALUES($1,$2,$3,$4,$5,'joined')
       RETURNING id,slot,ign,game_uid,status,created_at`,
      [
        req.user.sub,
        contestId,
        slot,
        ign,
        uid
      ]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (user_id,amount,type,reference_id,status)
       VALUES($1,$2,'contest_entry',$3,'completed')`,
      [
        req.user.sub,
        -fee,
        String(j.rows[0].id)
      ]
    );

    await client.query('COMMIT');

    const nw = await pool.query(
      'SELECT balance FROM wallets WHERE user_id=$1',
      [req.user.sub]
    );

    res.status(201).json({
      join: j.rows[0],
      balance: Number(nw.rows[0].balance)
    });

  } catch (e) {
    await client.query('ROLLBACK');

    res.status(e.status || 500).json({
      error: e.message || 'Join failed'
    });

  } finally {
    client.release();
  }
});



function resultPrizeCount(game, slots) {
  if (game === 'PER KILL MATCHES') return 0;
  return game === 'BR SURVIVAL' ? Math.min(9, Number(slots) || 0) : Math.min(5, Number(slots) || 0);
}

function defaultPrizeBreakup(game, prizePool, slots) {
  const total = Number(prizePool);
  if (total <= 0) return [];
  const maps = {
    'BR SURVIVAL': [45,32,25,20,18,15,12,8,5],
    'CLASH SQUAD 1V1': [45],
    'LONE WOLF 1V1': [30],
    'CLASH SQUAD 4V4': [67,67,67,67],
    'LONE WOLF 2V2': [40,40]
  };
  const prizes = maps[game] || [];
  const sum = prizes.reduce((a,b)=>a+b,0);
  if (sum === total) return prizes.map((prize,i)=>({rank:i+1,prize}));
  return prizes.map((prize,i)=>({rank:i+1,prize}));
}
function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }

  next();
}

app.get(
  '/api/admin/contests',
  auth,
  adminOnly,
  async (_req, res) => {
    const r = await pool.query(
      'SELECT * FROM contests ORDER BY starts_at ASC'
    );

    res.json(r.rows);
  }
);

app.post(
  '/api/admin/contests',
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const {
        game,
        title,
        entryFee,
        prizePool,
        slots,
        startsAt
      } = req.body || {};

      if (
        !game ||
        !title ||
        entryFee === undefined ||
        prizePool === undefined ||
        !Number.isFinite(Number(entryFee)) ||
        !Number.isFinite(Number(prizePool)) ||
        !Number.isInteger(Number(slots)) ||
        Number(entryFee) < 0 ||
        Number(prizePool) < 0 ||
        Number(slots) < 1 ||
        !startsAt
      ) {
        return res.status(400).json({
          error: 'game,title,entryFee,prizePool,slots,startsAt are required'
        });
      }

      const r = await pool.query(
        `INSERT INTO contests
         (game,title,entry_fee,prize_pool,slots,status,starts_at)
         VALUES($1,$2,$3,$4,$5,'upcoming',$6)
         RETURNING *`,
        [
          game,
          title,
          entryFee,
          prizePool,
          slots,
          startsAt
        ]
      );

      res.status(201).json(r.rows[0]);

    } catch (e) {
      res.status(400).json({
        error: e.message
      });
    }
  }
);
app.patch(
  '/api/admin/contests/:id/status',
  auth,
  adminOnly,
  async (req, res) => {
    const allowed = [
      'upcoming',
      'ongoing',
      'resulted',
      'cancelled'
    ];

    if (!allowed.includes(req.body?.status)) {
      return res.status(400).json({
        error: 'Invalid status'
      });
    }

    const r = await pool.query(
      `UPDATE contests
       SET status=$1
       WHERE id=$2
       RETURNING *`,
      [
        req.body.status,
        req.params.id
      ]
    );

    if (!r.rowCount) {
      return res.status(404).json({
        error: 'Contest not found'
      });
    }

    res.json(r.rows[0]);
  }
);



app.get('/api/admin/results/:contestId', auth, adminOnly, async (req, res) => {
  try {
    const c = await pool.query(
      `SELECT id,game,title,entry_fee,prize_pool,slots,status,starts_at
       FROM contests WHERE id=$1`,
      [req.params.contestId]
    );
    if (!c.rowCount) return res.status(404).json({ error: 'Contest not found' });

    const contest = c.rows[0];
    let prizes = await pool.query(
      `SELECT rank,prize FROM contest_prizes WHERE contest_id=$1 ORDER BY rank`,
      [contest.id]
    );
    if (!prizes.rowCount && contest.game !== 'PER KILL MATCHES') {
      const defaults = defaultPrizeBreakup(contest.game, contest.prize_pool, contest.slots);
      for (const p of defaults) {
        await pool.query(
          `INSERT INTO contest_prizes(contest_id,rank,prize) VALUES($1,$2,$3)
           ON CONFLICT(contest_id,rank) DO NOTHING`,
          [contest.id, p.rank, p.prize]
        );
      }
      prizes = await pool.query(
        `SELECT rank,prize FROM contest_prizes WHERE contest_id=$1 ORDER BY rank`,
        [contest.id]
      );
    }

    const joins = await pool.query(
      `SELECT j.id AS join_id,j.slot,j.ign,j.game_uid,j.user_id,
              u.username,
              r.rank,r.kills,r.score,r.prize
       FROM contest_joins j
       JOIN users u ON u.id=j.user_id
       LEFT JOIN contest_results r
         ON r.contest_join_id=j.id AND r.contest_id=j.contest_id
       WHERE j.contest_id=$1
       ORDER BY j.slot`,
      [contest.id]
    );

    res.json({ contest, prizes: prizes.rows.map(x => ({ rank:x.rank, prize:Number(x.prize) })), players: joins.rows.map(x => ({ ...x, prize:x.prize==null?null:Number(x.prize), score:x.score==null?null:Number(x.score) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/results/:contestId/prizes', auth, adminOnly, async (req, res) => {
  const prizes = Array.isArray(req.body?.prizes) ? req.body.prizes : [];
  if (!prizes.length) return res.status(400).json({ error: 'Prize breakup is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT id,prize_pool,slots,status,game FROM contests WHERE id=$1 FOR UPDATE', [req.params.contestId]);
    if (!c.rowCount) throw Object.assign(new Error('Contest not found'), {status:404});
    if (c.rows[0].status === 'resulted') throw Object.assign(new Error('Published result cannot be edited'), {status:400});
    const seen = new Set();
    let sum = 0;
    for (const p of prizes) {
      const rank = Number(p.rank), prize = Number(p.prize);
      if (!Number.isInteger(rank) || rank < 1 || !Number.isFinite(prize) || prize < 0 || seen.has(rank)) {
        throw Object.assign(new Error('Invalid prize breakup'), {status:400});
      }
      seen.add(rank); sum += prize;
    }
    if (c.rows[0].game !== 'PER KILL MATCHES' && Math.round(sum * 100) !== Math.round(Number(c.rows[0].prize_pool) * 100)) {
      throw Object.assign(new Error('Prize breakup total must equal prize pool'), {status:400});
    }
    await client.query('DELETE FROM contest_prizes WHERE contest_id=$1', [req.params.contestId]);
    for (const p of prizes) await client.query('INSERT INTO contest_prizes(contest_id,rank,prize) VALUES($1,$2,$3)', [req.params.contestId, Number(p.rank), Number(p.prize)]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error:e.message || 'Unable to save prize breakup' });
  } finally { client.release(); }
});

app.post('/api/admin/results/:contestId/publish', auth, adminOnly, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error:'Result table is empty' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT id,game,prize_pool,slots,status FROM contests WHERE id=$1 FOR UPDATE', [req.params.contestId]);
    if (!c.rowCount) throw Object.assign(new Error('Contest not found'), {status:404});
    const contest = c.rows[0];
    if (contest.status === 'resulted') throw Object.assign(new Error('Result already published for this match'), {status:409});

    const joins = await client.query('SELECT id,user_id FROM contest_joins WHERE contest_id=$1 ORDER BY slot', [contest.id]);
    const validJoinIds = new Set(joins.rows.map(x => String(x.id)));
    const seenJoins = new Set(), seenRanks = new Set();
    const clean = [];
    for (const row of rows) {
      const joinId = String(row.joinId || '');
      const rank = Number(row.rank), kills = Number(row.kills || 0), score = Number(row.score || 0);
      if (!validJoinIds.has(joinId)) throw Object.assign(new Error('Invalid player in result'), {status:400});
      if (seenJoins.has(joinId)) throw Object.assign(new Error('Duplicate player in result'), {status:400});
      if (!Number.isInteger(rank) || rank < 1 || seenRanks.has(rank)) throw Object.assign(new Error('Rank must be unique and start from 1'), {status:400});
      if (!Number.isInteger(kills) || kills < 0 || !Number.isFinite(score) || score < 0) throw Object.assign(new Error('Invalid kills or score'), {status:400});
      seenJoins.add(joinId); seenRanks.add(rank); clean.push({joinId,rank,kills,score});
    }

    let prizes = await client.query('SELECT rank,prize FROM contest_prizes WHERE contest_id=$1 ORDER BY rank', [contest.id]);
    const prizeMap = new Map(prizes.rows.map(x => [Number(x.rank), Number(x.prize)]));
    if (!prizes.rowCount && contest.game !== 'PER KILL MATCHES') {
      const defaults = defaultPrizeBreakup(contest.game, contest.prize_pool, contest.slots);
      for (const p of defaults) { await client.query('INSERT INTO contest_prizes(contest_id,rank,prize) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [contest.id,p.rank,p.prize]); prizeMap.set(p.rank,p.prize); }
    }

    for (const row of clean) {
      const join = joins.rows.find(x => String(x.id) === row.joinId);
      let prize = contest.game === 'PER KILL MATCHES' ? row.kills * 9 : (prizeMap.get(row.rank) || 0);
      await client.query(
        `INSERT INTO contest_results(contest_id,contest_join_id,rank,kills,score,prize)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [contest.id,row.joinId,row.rank,row.kills,row.score,prize]
      );
      if (prize > 0) {
        await client.query('UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2', [prize, join.user_id]);
        await client.query(`INSERT INTO wallet_transactions(user_id,amount,type,reference_id,status) VALUES($1,$2,'contest_prize',$3,'completed')`, [join.user_id, prize, `${contest.id}:${row.joinId}`]);
      }
    }
    await client.query(`UPDATE contests SET status='resulted' WHERE id=$1`, [contest.id]);
    await client.query('COMMIT');
    res.json({ok:true,message:'Result published successfully'});
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({error:e.message || 'Unable to publish result'});
  } finally { client.release(); }
});

app.get('/api/contests/:id/results', async (req,res)=>{
  try{
    const c=await pool.query(`SELECT id,game,title,prize_pool,slots,status,starts_at FROM contests WHERE id=$1`,[req.params.id]);
    if(!c.rowCount) return res.status(404).json({error:'Contest not found'});
    const r=await pool.query(`SELECT r.rank,r.kills,r.score,r.prize,j.slot,j.ign,u.username FROM contest_results r JOIN contest_joins j ON j.id=r.contest_join_id JOIN users u ON u.id=j.user_id WHERE r.contest_id=$1 ORDER BY r.rank`,[req.params.id]);
    res.json({contest:c.rows[0],results:r.rows.map(x=>({...x,score:Number(x.score),prize:Number(x.prize)}))});
  }catch(e){res.status(500).json({error:e.message});}
});

const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.sendFile('/app/public/index.html');
});

try {
  await initDatabase();
  startAutoGameSystem();

  app.listen(
    port,
    () => console.log(
      `DR Better API + frontend running on port ${port}`
    )
  );

} catch (e) {
  console.error(
    'Database initialization failed:',
    e
  );

  process.exit(1);
}