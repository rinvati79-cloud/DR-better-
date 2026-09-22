import express from 'express';
import fs from 'node:fs/promises';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',').map(s=>s.trim()) || true }));
app.use(express.json());

app.use(express.static('/app/public'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized:false } : undefined });
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET is required. Set it in the environment before starting the API.'); process.exit(1); }

async function initDatabase(){
  const schema = await fs.readFile('/app/schema.sql', 'utf8');
  await pool.query(schema);
  console.log('Database schema is ready.');
}
await pool.query(`
  INSERT INTO contests
    (game,title,entry_fee,prize_pool,slots,status,starts_at)
  SELECT
    'BR SURVIVAL',
    'BR Survival #1',
    10,
    100,
    48,
    'upcoming',
    NOW() + INTERVAL '30 minutes'
  WHERE NOT EXISTS (
    SELECT 1 FROM contests
    WHERE game='BR SURVIVAL'
      AND status='upcoming'
  );
`);

console.log('BR Survival contest ready.');
function sign(user){ return jwt.sign({sub:String(user.id), username:user.username, isAdmin:Boolean(user.is_admin)}, JWT_SECRET, {expiresIn:'7d'}); }
function auth(req,res,next){
  const h=req.headers.authorization||'';
  if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required'});
  try { req.user=jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { return res.status(401).json({error:'Invalid or expired token'}); }
}

app.get('/api/health', async (_req,res)=>{
  try {
    await pool.query('SELECT 1');
    res.json({ok:true,service:'DR Better API',database:'connected'});
  } catch {
    res.status(503).json({ok:false,service:'DR Better API',database:'disconnected'});
  }
});

app.post('/api/auth/register', async (req,res)=>{
  try {
    const username=String(req.body?.username||'').trim();
    const password=String(req.body?.password||'');
    const gameUid=String(req.body?.gameUid||'').trim();
    const firstName=String(req.body?.firstName||'').trim();
    const lastName=String(req.body?.lastName||'').trim();
    const mobile=String(req.body?.mobile||'').trim();
    const email=String(req.body?.email||'').trim().toLowerCase();
    const referralInput=String(req.body?.referralCode||'').trim();
    if(!/^[A-Za-z0-9_]{3,30}$/.test(username)) return res.status(400).json({error:'Username must be 3-30 letters, numbers or underscore'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters'});
    if(firstName.length>60||lastName.length>60||mobile.length>20||email.length>160||referralInput.length>30) return res.status(400).json({error:'Profile field is too long'});
    const hash=await bcrypt.hash(password,12);
    const referralCode=('DR'+username+Math.random().toString(36).slice(2,7)).slice(0,30).toUpperCase();
    const result=await pool.query('INSERT INTO users (username,password_hash,game_uid,first_name,last_name,mobile,email,referral_code,referred_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,username,game_uid,first_name,last_name,mobile,email,referral_code,created_at',[username,hash,gameUid||null,firstName||null,lastName||null,mobile||null,email||null,referralCode,referralInput||null]);
    const user=result.rows[0];
    await pool.query('INSERT INTO wallets (user_id,balance) VALUES ($1,0)',[user.id]);
    res.status(201).json({token:sign(user),user});
  } catch(e){
    if(e.code==='23505') return res.status(409).json({error:'Username already exists'});
    console.error(e); res.status(503).json({error:'Database unavailable. Start/connect the real backend and PostgreSQL.'});
  }
});

app.post('/api/auth/login', async (req,res)=>{
  try {
    const username=String(req.body?.username||'').trim();
    const password=String(req.body?.password||'');
    const r=await pool.query('SELECT id,username,password_hash,game_uid,created_at FROM users WHERE username=$1',[username]);
    if(!r.rowCount) return res.status(401).json({error:'Invalid username or password'});
    const user=r.rows[0];
    if(!(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'Invalid username or password'});
    delete user.password_hash;
    res.json({token:sign(user),user});
  } catch(e){ console.error(e); res.status(503).json({error:'Database unavailable. Start/connect the real backend and PostgreSQL.'}); }
});

app.get('/api/auth/me',auth,async(req,res)=>{
  const r=await pool.query('SELECT id,username,game_uid,first_name,last_name,mobile,email,referral_code,is_admin,created_at FROM users WHERE id=$1',[req.user.sub]);
  if(!r.rowCount) return res.status(404).json({error:'User not found'});
  res.json({user:r.rows[0]});
});

app.get('/api/wallet',auth,async(req,res)=>{
  const r=await pool.query('SELECT balance FROM wallets WHERE user_id=$1',[req.user.sub]);
  res.json({balance:r.rowCount?Number(r.rows[0].balance):0});
});

app.get('/api/wallet/transactions',auth,async(req,res)=>{
  const r=await pool.query('SELECT id,amount,type,reference_id,status,created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100',[req.user.sub]);
  res.json({transactions:r.rows});
});

app.get('/api/contests', async (req,res)=>{
  try{
    const status = String(req.query.status || 'upcoming');

    const r = await pool.query(
      `SELECT c.id,c.game,c.title,c.entry_fee,c.prize_pool,c.slots,c.status,c.starts_at,
              COUNT(j.id) AS joined
       FROM contests c
       LEFT JOIN contest_joins j ON j.contest_id=c.id
       WHERE c.status=$1
       GROUP BY c.id
       ORDER BY c.starts_at`,
      [status]
    );

    res.json(r.rows);
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.get('/api/contests/:id',async(req,res)=>{
  const r=await pool.query('SELECT id,game,title,entry_fee,prize_pool,slots,status,starts_at FROM contests WHERE id=$1',[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:'Contest not found'}); res.json(r.rows[0]);
});

app.get('/api/contests/:id/joinings',async(req,res)=>{
  const r=await pool.query('SELECT slot,ign,status,created_at FROM contest_joins WHERE contest_id=$1 ORDER BY slot',[req.params.id]);
  res.json(r.rows);
});

app.post('/api/join',auth,async(req,res)=>{
  const {contestId,slot,ign,uid}=req.body||{};
  if(!contestId||!Number.isInteger(Number(contestId))||!Number.isInteger(Number(slot))||!ign||!uid) return res.status(400).json({error:'Valid contestId, slot, ign and uid are required'});
  if(String(ign).trim().length>100 || String(uid).trim().length>100) return res.status(400).json({error:'IGN and UID must be 100 characters or less'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const c=await client.query('SELECT id,entry_fee,slots,status FROM contests WHERE id=$1 FOR UPDATE',[contestId]);
    if(!c.rowCount) throw Object.assign(new Error('Contest not found'),{status:404});
    const contest=c.rows[0];
    if(contest.status!=='upcoming') throw Object.assign(new Error('Contest is not open'),{status:400});
    if(Number(slot)<1||Number(slot)>contest.slots) throw Object.assign(new Error('Invalid slot'),{status:400});
    const taken=await client.query('SELECT 1 FROM contest_joins WHERE contest_id=$1 AND slot=$2',[contestId,slot]);
    if(taken.rowCount) throw Object.assign(new Error('Slot already joined'),{status:409});
    const w=await client.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE',[req.user.sub]);
    if(!w.rowCount) throw Object.assign(new Error('Wallet not found'),{status:400});
    const balance=Number(w.rows[0].balance), fee=Number(contest.entry_fee);
    if(balance<fee) throw Object.assign(new Error('Insufficient balance'),{status:400});
    await client.query('UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2',[fee,req.user.sub]);
    const j=await client.query('INSERT INTO contest_joins(user_id,contest_id,slot,ign,game_uid,status) VALUES($1,$2,$3,$4,$5,\'joined\') RETURNING id,slot,ign,game_uid,status,created_at',[req.user.sub,contestId,slot,ign,uid]);
    await client.query('INSERT INTO wallet_transactions(user_id,amount,type,reference_id,status) VALUES($1,$2,\'contest_entry\',$3,\'completed\')',[req.user.sub,-fee,String(j.rows[0].id)]);
    await client.query('COMMIT');
    const nw=await pool.query('SELECT balance FROM wallets WHERE user_id=$1',[req.user.sub]);
    res.status(201).json({join:j.rows[0],balance:Number(nw.rows[0].balance)});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Join failed'});}finally{client.release();}
});


function adminOnly(req,res,next){ if(!req.user?.isAdmin) return res.status(403).json({error:'Admin access required'}); next(); }
app.get('/api/admin/contests',auth,adminOnly,async(_req,res)=>{ const r=await pool.query('SELECT * FROM contests ORDER BY starts_at ASC'); res.json(r.rows); });
app.post('/api/admin/contests',auth,adminOnly,async(req,res)=>{ try { const {game,title,entryFee,prizePool,slots,startsAt}=req.body||{}; if(!game||!title||entryFee===undefined||prizePool===undefined||!Number.isFinite(Number(entryFee))||!Number.isFinite(Number(prizePool))||!Number.isInteger(Number(slots))||Number(entryFee)<0||Number(prizePool)<0||Number(slots)<1||!startsAt) return res.status(400).json({error:'game,title,entryFee,prizePool,slots,startsAt are required'}); const r=await pool.query("INSERT INTO contests(game,title,entry_fee,prize_pool,slots,status,starts_at) VALUES($1,$2,$3,$4,$5,'upcoming',$6) RETURNING *",[game,title,entryFee,prizePool,slots,startsAt]); res.status(201).json(r.rows[0]); } catch(e){res.status(400).json({error:e.message});} });
app.patch('/api/admin/contests/:id/status',auth,adminOnly,async(req,res)=>{ const allowed=['upcoming','ongoing','resulted','cancelled']; if(!allowed.includes(req.body?.status)) return res.status(400).json({error:'Invalid status'}); const r=await pool.query('UPDATE contests SET status=$1 WHERE id=$2 RETURNING *',[req.body.status,req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Contest not found'}); res.json(r.rows[0]); });

const port=process.env.PORT||3000;
app.get('/', (_req,res)=>res.sendFile('/app/public/index.html'));

try {
  await initDatabase();
  app.listen(port,()=>console.log(`DR Better API + frontend running on port ${port}`));
} catch (e) {
  console.error('Database initialization failed:', e);
  process.exit(1);
}
