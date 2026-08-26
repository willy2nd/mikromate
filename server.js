import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const app=express();
const port=process.env.PORT||8080;
const feePct=Number(process.env.PLATFORM_FEE_PERCENT||10);
const jwtSecret=process.env.JWT_SECRET||"DEV_ONLY_CHANGE_ME";
const db=new Database(process.env.DATABASE_PATH||"./mikromate.db");

app.use(helmet());
app.use(cors({origin:true}));
app.use(express.json({limit:"1mb"}));
app.use(rateLimit({windowMs:15*60*1000,max:300}));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT UNIQUE NOT NULL,
 phone TEXT UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'USER',
 verified INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id INTEGER NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 category TEXT NOT NULL,
 reward INTEGER NOT NULL CHECK(reward>=50),
 status TEXT NOT NULL DEFAULT 'OPEN',
 provider_id INTEGER,
 featured INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL,
 payer_id INTEGER,
 provider_id INTEGER,
 gross_amount INTEGER NOT NULL,
 platform_fee INTEGER NOT NULL,
 provider_amount INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING',
 external_reference TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS disputes(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL,
 opened_by INTEGER NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'OPEN',
 resolution TEXT
);
CREATE TABLE IF NOT EXISTS reviews(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id INTEGER NOT NULL,
 reviewer_id INTEGER NOT NULL,
 reviewee_id INTEGER NOT NULL,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT
);
CREATE TABLE IF NOT EXISTS referrals(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 referrer_id INTEGER NOT NULL,
 referred_user_id INTEGER NOT NULL,
 reward INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'PENDING'
);
`);

function auth(req,res,next){
 const h=req.headers.authorization||"";
 if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Authentication required"});
 try{req.user=jwt.verify(h.slice(7),jwtSecret);next()}catch{return res.status(401).json({error:"Invalid session"})}
}
function admin(req,res,next){if(req.user?.role!=="ADMIN")return res.status(403).json({error:"Admin only"});next()}

app.get("/api/health",(req,res)=>res.json({ok:true,version:"5.0.0"}));

app.post("/api/auth/register",async(req,res)=>{
 const {name,email,phone,password}=req.body;
 if(!name||!email||!password||password.length<8)return res.status(400).json({error:"Name, email and 8+ character password required"});
 try{
  const hash=await bcrypt.hash(password,12);
  const r=db.prepare("INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)").run(name,email,phone||null,hash);
  const token=jwt.sign({id:r.lastInsertRowid,email,role:"USER"},jwtSecret,{expiresIn:"7d"});
  res.status(201).json({token,user:{id:r.lastInsertRowid,name,email,phone,role:"USER"}});
 }catch(e){res.status(409).json({error:"Email or phone already registered"})}
});

app.post("/api/auth/login",async(req,res)=>{
 const u=db.prepare("SELECT * FROM users WHERE email=?").get(req.body.email);
 if(!u||!(await bcrypt.compare(req.body.password||"",u.password_hash)))return res.status(401).json({error:"Invalid credentials"});
 const token=jwt.sign({id:u.id,email:u.email,role:u.role},jwtSecret,{expiresIn:"7d"});
 res.json({token,user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role,verified:!!u.verified}});
});

app.get("/api/me",auth,(req,res)=>{
 const u=db.prepare("SELECT id,name,email,phone,role,verified,created_at FROM users WHERE id=?").get(req.user.id);
 res.json(u);
});

app.get("/api/tasks",(req,res)=>{
 const tasks=db.prepare("SELECT t.*,u.name owner_name FROM tasks t JOIN users u ON u.id=t.owner_id WHERE t.status='OPEN' ORDER BY t.featured DESC,t.id DESC").all();
 res.json(tasks);
});

app.post("/api/tasks",auth,(req,res)=>{
 const {title,description,category,reward,featured}=req.body; const amount=Number(reward);
 if(!title||!description||!category||!Number.isFinite(amount)||amount<50)return res.status(400).json({error:"Invalid task"});
 const r=db.prepare("INSERT INTO tasks(owner_id,title,description,category,reward,featured) VALUES(?,?,?,?,?,?)")
 .run(req.user.id,title,description,category,Math.round(amount),featured?1:0);
 res.status(201).json(db.prepare("SELECT * FROM tasks WHERE id=?").get(r.lastInsertRowid));
});

app.post("/api/tasks/:id/accept",auth,(req,res)=>{
 const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
 if(!task)return res.status(404).json({error:"Task not found"});
 if(task.status!=="OPEN")return res.status(409).json({error:"Task unavailable"});
 if(task.owner_id===req.user.id)return res.status(400).json({error:"You cannot accept your own task"});
 const fee=Math.round(task.reward*feePct/100), provider=task.reward-fee;
 db.prepare("UPDATE tasks SET status='ACCEPTED',provider_id=? WHERE id=?").run(req.user.id,task.id);
 const r=db.prepare("INSERT INTO transactions(task_id,payer_id,provider_id,gross_amount,platform_fee,provider_amount) VALUES(?,?,?,?,?,?)")
 .run(task.id,task.owner_id,req.user.id,task.reward,fee,provider);
 res.json({transaction_id:r.lastInsertRowid,task_id:task.id,gross_amount:task.reward,platform_fee:fee,provider_amount:provider,status:"PAYMENT_PENDING"});
});

app.post("/api/tasks/:id/complete",auth,(req,res)=>{
 const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
 if(!task||task.provider_id!==req.user.id)return res.status(404).json({error:"Task not found"});
 db.prepare("UPDATE tasks SET status='COMPLETED' WHERE id=?").run(task.id);
 db.prepare("UPDATE transactions SET status='RELEASE_PENDING' WHERE task_id=? AND provider_id=?").run(task.id,req.user.id);
 res.json({ok:true,status:"RELEASE_PENDING"});
});

app.post("/api/disputes",auth,(req,res)=>{
 const {taskId,reason}=req.body;if(!taskId||!reason)return res.status(400).json({error:"Task and reason required"});
 const r=db.prepare("INSERT INTO disputes(task_id,opened_by,reason) VALUES(?,?,?)").run(taskId,req.user.id,reason);
 res.status(201).json({id:r.lastInsertRowid,status:"OPEN"});
});

app.post("/api/reviews",auth,(req,res)=>{
 const {taskId,revieweeId,rating,comment}=req.body;
 if(!taskId||!revieweeId||rating<1||rating>5)return res.status(400).json({error:"Invalid review"});
 const r=db.prepare("INSERT INTO reviews(task_id,reviewer_id,reviewee_id,rating,comment) VALUES(?,?,?,?,?)")
 .run(taskId,req.user.id,revieweeId,rating,comment||"");
 res.status(201).json({id:r.lastInsertRowid});
});

app.post("/api/referrals",auth,(req,res)=>{
 const {referredUserId}=req.body;
 const r=db.prepare("INSERT INTO referrals(referrer_id,referred_user_id,reward) VALUES(?,?,?)").run(req.user.id,referredUserId,50);
 res.status(201).json({id:r.lastInsertRowid,reward:50,status:"PENDING"});
});

app.get("/api/admin/revenue",auth,admin,(req,res)=>{
 const row=db.prepare("SELECT COALESCE(SUM(gross_amount),0) gross,COALESCE(SUM(platform_fee),0) fees,COUNT(*) transactions FROM transactions").get();
 res.json(row);
});

app.get("/api/admin/disputes",auth,admin,(req,res)=>res.json(db.prepare("SELECT * FROM disputes ORDER BY id DESC").all()));

app.post("/api/payments/mpesa/initiate",auth,(req,res)=>{
 // Integration boundary. Real Daraja request must run server-side with credentials.
 res.status(501).json({error:"Daraja production credentials not configured",next:"Configure MPESA_* server environment variables and implement provider-specific request/callback verification."});
});

app.post("/api/payments/mpesa/callback",(req,res)=>{
 // IMPORTANT: validate callback signature/content and reconcile against provider data before changing money state.
 res.json({ResultCode:0,ResultDesc:"Accepted"});
});

app.listen(port,()=>console.log(`MikroMate API listening on ${port}`));
