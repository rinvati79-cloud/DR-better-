import express from 'express';
import fs from 'node:fs/promises';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const app = express();

app.use(cors({
  origin:
    process.env.FRONTEND_ORIGIN
      ?.split(',')
      .map(s => s.trim()) || true
}));

app.use(express.json());
app.use(express.static('/app/public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error(
    'JWT_SECRET is required. Set it in the environment before starting the API.'
  );
  process.exit(1);
}


/* =====================================================
   AUTO GAME SYSTEM
===================================================== */

const AUTO_GAMES = {
  'BR SURVIVAL': {
    prefix: 'BR Survival',
    entryFee: 15,
    prizePool: 220,
    slots: 20
  },

  'PER KILL MATCHES': {
    prefix: 'Per Kill Match',
    entryFee: 10,
    prizePool: 350,
    slots: 48
  },

  'CLASH SQUAD 1V1': {
    prefix: 'Clash Squad 1V1',
    entryFee: 40,
    prizePool: 55,
    slots: 2
  },

  'LONE WOLF 1V1': {
    prefix: 'Lone Wolf 1V1',
    entryFee: 40,
    prizePool: 55,
    slots: 2
  },

  'CLASH SQUAD 4V4': {
    prefix: 'Clash Squad 4V4',
    entryFee: 20,
    prizePool: 100,
    slots: 8
  },

  'LONE WOLF 2V2': {
    prefix: 'Lone Wolf 2V2',
    entryFee: 25,
    prizePool: 60,
    slots: 4
  }
};


/*
  कितने upcoming matches हमेशा उपलब्ध रखने हैं।
  इससे home screen पर हर game के अंदर कई matches दिखाई देंगे।
*/
const AUTO_UPCOMING_PER_GAME = 5;


/*
  नए matches के बीच का अंतर।
  उदाहरण:
  Match #1 = अभी से 30 मिनट
  Match #2 = 60 मिनट
  Match #3 = 90 मिनट
*/
const AUTO_MATCH_INTERVAL_MINUTES = 30;


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDatabase() {
  const schema = await fs.readFile(
    '/app/schema.sql',
    'utf8'
  );

  await pool.query(schema);

  console.log('Database schema is ready.');

  /*
    पुराने fixed startup contests वाला INSERT
    अब इस्तेमाल नहीं होगा।

    इसके बजाय Auto Game System contests बनाएगा।
  */

  await removeUnusedOldAutoContests();

  await ensureAutoContests();

  console.log('Auto Game System is ready.');
}


/* =====================================================
   OLD UNUSED AUTO CONTEST CLEANUP
===================================================== */

async function removeUnusedOldAutoContests() {
  const games = Object.keys(AUTO_GAMES);

  await pool.query(
    `
    DELETE FROM contests c
    WHERE c.status = 'upcoming'
      AND c.game = ANY($1::text[])
      AND NOT EXISTS (
        SELECT 1
        FROM contest_joins j
        WHERE j.contest_id = c.id
      )
      AND c.starts_at < NOW()
    `,
    [games]
  );
}


/* =====================================================
   AUTO CONTEST CREATOR
===================================================== */

async function ensureAutoContests() {
  for (const [game, config] of Object.entries(AUTO_GAMES)) {

    const result = await pool.query(
      `
      SELECT
        COUNT(*)::int AS count
      FROM contests
      WHERE game = $1
        AND status = 'upcoming'
        AND starts_at > NOW()
      `,
      [game]
    );

    const currentCount =
      Number(result.rows[0]?.count || 0);

    const missing =
      Math.max(
        0,
        AUTO_UPCOMING_PER_GAME - currentCount
      );

    if (missing <= 0) {
      continue;
    }

    for (let i = 0; i < missing; i++) {

      await createAutoContest(
        game,
        config
      );
    }
  }
}


/* =====================================================
   CREATE ONE AUTO CONTEST
===================================================== */

async function createAutoContest(game, config) {

  const last = await pool.query(
    `
    SELECT
      title,
      starts_at
    FROM contests
    WHERE game = $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [game]
  );

  let matchNumber = 1;

  if (last.rowCount) {

    const match =
      String(last.rows[0].title || '')
        .match(/#(\d+)/);

    if (match) {
      matchNumber =
        Number(match[1]) + 1;
    }
  }

  let startsAt =
    new Date(
      Date.now() +
      AUTO_MATCH_INTERVAL_MINUTES * 60 * 1000
    );

  if (last.rowCount && last.rows[0].starts_at) {

    const lastStart =
      new Date(last.rows[0].starts_at);

    const nextStart =
      new Date(
        lastStart.getTime() +
        AUTO_MATCH_INTERVAL_MINUTES * 60 * 1000
      );

    if (nextStart > startsAt) {
      startsAt = nextStart;
    }
  }

  const title =
    `${config.prefix} #${matchNumber}`;

  const result = await pool.query(
    `
    INSERT INTO contests
      (
        game,
        title,
        entry_fee,
        prize_pool,
        slots,
        status,
        starts_at
      )
    VALUES
      ($1,$2,$3,$4,$5,'upcoming',$6)
    RETURNING *
    `,
    [
      game,
      title,
      config.entryFee,
      config.prizePool,
      config.slots,
      startsAt
    ]
  );

  console.log(
    `Auto contest created: ${game} - ${title}`
  );

  return result.rows[0];
}
/* =====================================================
   JWT
===================================================== */

function sign(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      isAdmin: Boolean(user.is_admin)
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );
}


/* =====================================================
   AUTH MIDDLEWARE
===================================================== */

function auth(req, res, next) {
  const h =
    req.headers.authorization || '';

  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  try {
    req.user =
      jwt.verify(
        h.slice(7),
        JWT_SECRET
      );

    next();

  } catch {
    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
}


/* =====================================================
   HEALTH
===================================================== */

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


/* =====================================================
   REGISTER
===================================================== */

app.post(
  '/api/auth/register',
  async (req, res) => {

    try {

      const username =
        String(
          req.body?.username || ''
        ).trim();

      const password =
        String(
          req.body?.password || ''
        );

      const gameUid =
        String(
          req.body?.gameUid || ''
        ).trim();

      const firstName =
        String(
          req.body?.firstName || ''
        ).trim();

      const lastName =
        String(
          req.body?.lastName || ''
        ).trim();

      const mobile =
        String(
          req.body?.mobile || ''
        ).trim();

      const email =
        String(
          req.body?.email || ''
        ).trim()
        .toLowerCase();

      const referralInput =
        String(
          req.body?.referralCode || ''
        ).trim();


      if (
        !/^[A-Za-z0-9_]{3,30}$/
          .test(username)
      ) {
        return res.status(400).json({
          error:
            'Username must be 3-30 letters, numbers or underscore'
        });
      }


      if (password.length < 8) {
        return res.status(400).json({
          error:
            'Password must be at least 8 characters'
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
          error:
            'Profile field is too long'
        });
      }


      const hash =
        await bcrypt.hash(
          password,
          12
        );


      const referralCode = (
        'DR' +
        username +
        Math.random()
          .toString(36)
          .slice(2, 7)
      )
        .slice(0, 30)
        .toUpperCase();


      const result =
        await pool.query(
          `
          INSERT INTO users
          (
            username,
            password_hash,
            game_uid,
            first_name,
            last_name,
            mobile,
            email,
            referral_code,
            referred_by
          )
          VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING
            id,
            username,
            game_uid,
            first_name,
            last_name,
            mobile,
            email,
            referral_code,
            created_at
          `,
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


      const user =
        result.rows[0];


      await pool.query(
        `
        INSERT INTO wallets
          (user_id,balance)
        VALUES
          ($1,0)
        `,
        [user.id]
      );


      res.status(201).json({
        token: sign(user),
        user
      });


    } catch (e) {

      if (e.code === '23505') {
        return res.status(409).json({
          error:
            'Username already exists'
        });
      }

      console.error(e);

      res.status(503).json({
        error:
          'Database unavailable. Start/connect the real backend and PostgreSQL.'
      });
    }
  }
);


/* =====================================================
   LOGIN
===================================================== */

app.post(
  '/api/auth/login',
  async (req, res) => {

    try {

      const username =
        String(
          req.body?.username || ''
        ).trim();

      const password =
        String(
          req.body?.password || ''
        );


      const r =
        await pool.query(
          `
          SELECT
            id,
            username,
            password_hash,
            game_uid,
            created_at
          FROM users
          WHERE username=$1
          `,
          [username]
        );


      if (!r.rowCount) {
        return res.status(401).json({
          error:
            'Invalid username or password'
        });
      }


      const user =
        r.rows[0];


      if (
        !(await bcrypt.compare(
          password,
          user.password_hash
        ))
      ) {
        return res.status(401).json({
          error:
            'Invalid username or password'
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
        error:
          'Database unavailable. Start/connect the real backend and PostgreSQL.'
      });
    }
  }
);


/* =====================================================
   CURRENT USER
===================================================== */

app.get(
  '/api/auth/me',
  auth,
  async (req, res) => {

    const r =
      await pool.query(
        `
        SELECT
          id,
          username,
          game_uid,
          first_name,
          last_name,
          mobile,
          email,
          referral_code,
          is_admin,
          created_at
        FROM users
        WHERE id=$1
        `,
        [req.user.sub]
      );


    if (!r.rowCount) {
      return res.status(404).json({
        error:
          'User not found'
      });
    }


    res.json({
      user: r.rows[0]
    });
  }
);


/* =====================================================
   WALLET
===================================================== */

app.get(
  '/api/wallet',
  auth,
  async (req, res) => {

    const r =
      await pool.query(
        `
        SELECT balance
        FROM wallets
        WHERE user_id=$1
        `,
        [req.user.sub]
      );


    res.json({
      balance:
        r.rowCount
          ? Number(r.rows[0].balance)
          : 0
    });
  }
);


/* =====================================================
   WALLET TRANSACTIONS
===================================================== */

app.get(
  '/api/wallet/transactions',
  auth,
  async (req, res) => {

    const r =
      await pool.query(
        `
        SELECT
          id,
          amount,
          type,
          reference_id,
          status,
          created_at
        FROM wallet_transactions
        WHERE user_id=$1
        ORDER BY id DESC
        LIMIT 100
        `,
        [req.user.sub]
      );


    res.json({
      transactions:
        r.rows
    });
  }
);
/* =====================================================
   CONTEST LIST
===================================================== */

app.get(
  '/api/contests',
  async (req, res) => {

    try {

      const params = [];
      const conditions = [];

      /* Game filter */
      if (req.query.game) {

        params.push(
          String(req.query.game)
        );

        conditions.push(
          `c.game=$${params.length}`
        );
      }


      /* Status filter */
      if (req.query.status) {

        params.push(
          String(req.query.status)
        );

        conditions.push(
          `c.status=$${params.length}`
        );
      }


      const where =
        conditions.length
          ? `WHERE ${conditions.join(' AND ')}`
          : '';


      const r =
        await pool.query(
          `
          SELECT
            c.id,
            c.game,
            c.title,
            c.entry_fee,
            c.prize_pool,
            c.slots,
            c.status,
            c.starts_at,

            COUNT(j.id)
              FILTER (
                WHERE j.status='joined'
              )::int AS joined_slots

          FROM contests c

          LEFT JOIN contest_joins j
            ON j.contest_id=c.id

          ${where}

          GROUP BY c.id

          ORDER BY
            c.starts_at ASC
          `,
          params
        );


      res.json(r.rows);

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error: e.message
      });
    }
  }
);


/* =====================================================
   SINGLE CONTEST
===================================================== */

app.get(
  '/api/contests/:id',
  async (req, res) => {

    try {

      const r =
        await pool.query(
          `
          SELECT
            id,
            game,
            title,
            entry_fee,
            prize_pool,
            slots,
            status,
            starts_at
          FROM contests
          WHERE id=$1
          `,
          [req.params.id]
        );


      if (!r.rowCount) {

        return res.status(404).json({
          error:
            'Contest not found'
        });
      }


      res.json({
        contest:
          r.rows[0]
      });

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error:
          'Unable to load contest'
      });
    }
  }
);


/* =====================================================
   CONTEST JOININGS / TAKEN SLOTS
===================================================== */

app.get(
  '/api/contests/:id/joinings',
  async (req, res) => {

    try {

      const r =
        await pool.query(
          `
          SELECT
            slot,
            ign,
            status,
            created_at
          FROM contest_joins
          WHERE contest_id=$1
          ORDER BY slot
          `,
          [req.params.id]
        );


      res.json({
        joinings:
          r.rows
      });

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error:
          'Unable to load slots'
      });
    }
  }
);


/* =====================================================
   AUTO CONTEST STATUS UPDATE
===================================================== */

async function updateAutoContestStatuses() {

  try {

    /*
      जिन upcoming matches का start time आ चुका है,
      उन्हें ongoing किया जाएगा।
    */

    await pool.query(
      `
      UPDATE contests
      SET status='ongoing'
      WHERE status='upcoming'
        AND starts_at <= NOW()
      `
    );


    /*
      पुराने ongoing matches को automatic result नहीं किया
      जा रहा है।

      Result admin manually set करेगा।
    */

    /*
      हर game में फिर से required upcoming matches
      बनाए जाते हैं।
    */

    await ensureAutoContests();


  } catch (e) {

    console.error(
      'Auto Game System error:',
      e.message
    );
  }
}


/* =====================================================
   AUTO GAME SYSTEM TIMER
===================================================== */

let autoGameTimer = null;


function startAutoGameSystem() {

  if (autoGameTimer) {
    clearInterval(
      autoGameTimer
    );
  }


  /*
    हर 30 सेकंड में:
    1. पुराने upcoming matches check
    2. start हुए matches = ongoing
    3. नए upcoming matches create
  */

  autoGameTimer =
    setInterval(
      updateAutoContestStatuses,
      30 * 1000
    );


  console.log(
    'Auto Game System timer started.'
  );
}


/* =====================================================
   MANUAL REFRESH ENDPOINT
===================================================== */

app.post(
  '/api/admin/auto-games/refresh',
  auth,
  adminOnly,
  async (_req, res) => {

    try {

      await updateAutoContestStatuses();

      const r =
        await pool.query(
          `
          SELECT
            id,
            game,
            title,
            entry_fee,
            prize_pool,
            slots,
            status,
            starts_at
          FROM contests
          ORDER BY starts_at ASC
          `
        );


      res.json({
        success: true,
        contests:
          r.rows
      });

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error:
          'Auto refresh failed'
      });
    }
  }
);
/* =====================================================
   JOIN CONTEST
===================================================== */

app.post(
  '/api/join',
  auth,
  async (req, res) => {

    const {
      contestId,
      slot,
      ign,
      uid
    } = req.body || {};

    if (
      !contestId ||
      !Number.isInteger(Number(contestId)) ||
      !Number.isInteger(Number(slot)) ||
      !ign ||
      !uid
    ) {
      return res.status(400).json({
        error:
          'Valid contestId, slot, ign and uid are required'
      });
    }

    if (
      String(ign).trim().length > 100 ||
      String(uid).trim().length > 100
    ) {
      return res.status(400).json({
        error:
          'IGN and UID must be 100 characters or less'
      });
    }


    const client =
      await pool.connect();

    try {

      await client.query('BEGIN');


      /* -----------------------------------------
         LOCK CONTEST
      ----------------------------------------- */

      const c =
        await client.query(
          `
          SELECT
            id,
            entry_fee,
            slots,
            status
          FROM contests
          WHERE id=$1
          FOR UPDATE
          `,
          [contestId]
        );


      if (!c.rowCount) {

        throw Object.assign(
          new Error(
            'Contest not found'
          ),
          { status: 404 }
        );
      }


      const contest =
        c.rows[0];


      if (
        contest.status !== 'upcoming'
      ) {

        throw Object.assign(
          new Error(
            'Contest is not open'
          ),
          { status: 400 }
        );
      }


      /* -----------------------------------------
         SLOT VALIDATION
      ----------------------------------------- */

      if (
        Number(slot) < 1 ||
        Number(slot) >
          Number(contest.slots)
      ) {

        throw Object.assign(
          new Error(
            'Invalid slot'
          ),
          { status: 400 }
        );
      }


      /* -----------------------------------------
         CHECK SLOT
      ----------------------------------------- */

      const taken =
        await client.query(
          `
          SELECT 1
          FROM contest_joins
          WHERE contest_id=$1
            AND slot=$2
          FOR UPDATE
          `,
          [
            contestId,
            slot
          ]
        );


      if (taken.rowCount) {

        throw Object.assign(
          new Error(
            'Slot already joined'
          ),
          { status: 409 }
        );
      }


      /* -----------------------------------------
         CHECK WALLET
      ----------------------------------------- */

      const w =
        await client.query(
          `
          SELECT balance
          FROM wallets
          WHERE user_id=$1
          FOR UPDATE
          `,
          [req.user.sub]
        );


      if (!w.rowCount) {

        throw Object.assign(
          new Error(
            'Wallet not found'
          ),
          { status: 400 }
        );
      }


      const balance =
        Number(
          w.rows[0].balance
        );

      const fee =
        Number(
          contest.entry_fee
        );


      if (
        balance < fee
      ) {

        throw Object.assign(
          new Error(
            'Insufficient balance'
          ),
          { status: 400 }
        );
      }


      /* -----------------------------------------
         DEDUCT ENTRY FEE
      ----------------------------------------- */

      await client.query(
        `
        UPDATE wallets
        SET
          balance=balance-$1,
          updated_at=NOW()
        WHERE user_id=$2
        `,
        [
          fee,
          req.user.sub
        ]
      );


      /* -----------------------------------------
         CREATE JOIN
      ----------------------------------------- */

      const j =
        await client.query(
          `
          INSERT INTO contest_joins
          (
            user_id,
            contest_id,
            slot,
            ign,
            game_uid,
            status
          )
          VALUES
          (
            $1,$2,$3,$4,$5,'joined'
          )
          RETURNING
            id,
            slot,
            ign,
            game_uid,
            status,
            created_at
          `,
          [
            req.user.sub,
            contestId,
            slot,
            String(ign).trim(),
            String(uid).trim()
          ]
        );


      /* -----------------------------------------
         WALLET TRANSACTION
      ----------------------------------------- */

      await client.query(
        `
        INSERT INTO wallet_transactions
        (
          user_id,
          amount,
          type,
          reference_id,
          status
        )
        VALUES
        (
          $1,
          $2,
          'contest_entry',
          $3,
          'completed'
        )
        `,
        [
          req.user.sub,
          -fee,
          String(
            j.rows[0].id
          )
        ]
      );


      await client.query(
        'COMMIT'
      );


      /* -----------------------------------------
         NEW BALANCE
      ----------------------------------------- */

      const nw =
        await pool.query(
          `
          SELECT balance
          FROM wallets
          WHERE user_id=$1
          `,
          [req.user.sub]
        );


      res.status(201).json({
        join: j.rows[0],
        balance:
          Number(
            nw.rows[0].balance
          )
      });


    } catch (e) {

      try {
        await client.query(
          'ROLLBACK'
        );
      } catch {}


      console.error(
        'Join error:',
        e
      );


      res.status(
        e.status || 500
      ).json({
        error:
          e.message ||
          'Join failed'
      });


    } finally {

      client.release();
    }
  }
);


/* =====================================================
   ADMIN AUTH
===================================================== */

function adminOnly(
  req,
  res,
  next
) {

  if (!req.user?.isAdmin) {

    return res.status(403).json({
      error:
        'Admin access required'
    });
  }

  next();
}


/* =====================================================
   ADMIN CONTEST LIST
===================================================== */

app.get(
  '/api/admin/contests',
  auth,
  adminOnly,
  async (_req, res) => {

    try {

      const r =
        await pool.query(
          `
          SELECT *
          FROM contests
          ORDER BY starts_at ASC
          `
        );


      res.json(
        r.rows
      );

    } catch (e) {

      console.error(e);

      res.status(500).json({
        error:
          'Unable to load contests'
      });
    }
  }
);


/* =====================================================
   ADMIN CREATE MANUAL CONTEST
===================================================== */

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
        !Number.isFinite(
          Number(entryFee)
        ) ||
        !Number.isFinite(
          Number(prizePool)
        ) ||
        !Number.isInteger(
          Number(slots)
        ) ||
        Number(entryFee) < 0 ||
        Number(prizePool) < 0 ||
        Number(slots) < 1 ||
        !startsAt
      ) {

        return res.status(400).json({
          error:
            'game,title,entryFee,prizePool,slots,startsAt are required'
        });
      }


      const r =
        await pool.query(
          `
          INSERT INTO contests
          (
            game,
            title,
            entry_fee,
            prize_pool,
            slots,
            status,
            starts_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            'upcoming',
            $6
          )
          RETURNING *
          `,
          [
            game,
            title,
            entryFee,
            prizePool,
            slots,
            startsAt
          ]
        );


      res.status(201).json(
        r.rows[0]
      );


    } catch (e) {

      console.error(e);

      res.status(400).json({
        error:
          e.message
      });
    }
  }
);


/* =====================================================
   ADMIN CHANGE STATUS
===================================================== */

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


    if (
      !allowed.includes(
        req.body?.status
      )
    ) {

      return res.status(400).json({
        error:
          'Invalid status'
      });
    }


    try {

      const r =
        await pool.query(
          `
          UPDATE contests
          SET status=$1
          WHERE id=$2
          RETURNING *
          `,
          [
            req.body.status,
            req.params.id
          ]
        );


      if (!r.rowCount) {

        return res.status(404).json({
          error:
            'Contest not found'
        });
      }


      res.json(
        r.rows[0]
      );


    } catch (e) {

      console.error(e);

      res.status(500).json({
        error:
          'Unable to update status'
      });
    }
  }
);
// ===============================
// MY MATCHES
// ===============================
app.get('/api/my-joinings', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        j.id,
        j.slot,
        j.ign,
        j.game_uid,
        j.status,
        j.created_at,
        c.id AS contest_id,
        c.game,
        c.title,
        c.status AS contest_status,
        c.starts_at,
        c.entry_fee,
        c.prize_pool,
        c.total_slots
      FROM contest_joins j
      JOIN contests c ON c.id = j.contest_id
      WHERE j.user_id = $1
      ORDER BY c.starts_at ASC
    `, [req.user.sub]);

    res.json({ joinings: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'My matches load failed' });
  }
});


// ===============================
// SERVER START
// ===============================
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.sendFile('/app/public/index.html');
});

try {
  await initDatabase();

  // Auto Game System को तुरंत sync करें
  await updateAutoContestStatuses();

  // हर 30 सेकंड auto system check
  startAutoGameSystem();

  app.listen(port, () => {
    console.log(`DR Better API + frontend running on port ${port}`);
  });
} catch (e) {
  console.error('Database initialization failed:', e);
  process.exit(1);
}
