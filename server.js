import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const app = express();
const port = Number(process.env.PORT) || 10000;
const feePct = Number(process.env.PLATFORM_FEE_PERCENT || 10);
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  console.error("JWT_SECRET is not configured");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined
});

app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER',
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks(
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      reward INTEGER NOT NULL CHECK(reward >= 50),
      status TEXT NOT NULL DEFAULT 'OPEN',
      provider_id INTEGER,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions(
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL,
      payer_id INTEGER,
      provider_id INTEGER,
      gross_amount INTEGER NOT NULL,
      platform_fee INTEGER NOT NULL,
      provider_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      external_reference TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS disputes(
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL,
      opened_by INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      resolution TEXT
    );

    CREATE TABLE IF NOT EXISTS reviews(
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      reviewee_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT
    );

    CREATE TABLE IF NOT EXISTS referrals(
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      referred_user_id INTEGER NOT NULL,
      reward INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING'
    );
  `);

  console.log("PostgreSQL database initialized");
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";

  if (!h.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(h.slice(7), jwtSecret);
    next();
} catch (e) {
  console.error("JWT verification failed:", e.name, e.message);
  return res.status(401).json({ error: "Invalid session" });
}
}

function admin(req, res, next) {
  if (req.user?.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin only" });
  }

  next();
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      version: "5.0.0",
      database: "postgresql"
    });
  } catch (e) {
    console.error("Database health check failed:", e);
    res.status(503).json({
      ok: false,
      database: "unavailable"
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({
      error: "Name, email and 8+ character password required"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const r = await pool.query(
      `INSERT INTO users(name,email,phone,password_hash)
       VALUES($1,$2,$3,$4)
       RETURNING id`,
      [name, email, phone || null, hash]
    );

    const id = r.rows[0].id;

    const token = jwt.sign(
      { id, email, role: "USER" },
      jwtSecret,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      token,
      user: {
        id,
        name,
        email,
        phone,
        role: "USER"
      }
    });
  } catch (e) {
    console.error("Registration error:", e);

    res.status(409).json({
      error: "Email or phone already registered"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [req.body.email]
    );

    const u = result.rows[0];

    if (
      !u ||
      !(await bcrypt.compare(
        req.body.password || "",
        u.password_hash
      ))
    ) {
      return res.status(401).json({
        error: "Invalid credentials"
      });
    }

    const token = jwt.sign(
      {
        id: u.id,
        email: u.email,
        role: u.role
      },
      jwtSecret,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        verified: !!u.verified
      }
    });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,phone,role,verified,created_at
       FROM users
       WHERE id=$1`,
      [req.user.id]
    );

    res.json(result.rows[0] || null);
  } catch (e) {
    console.error("Profile error:", e);
    res.status(500).json({ error: "Unable to load profile" });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.*,
        u.name AS owner_name
      FROM tasks t
      JOIN users u ON u.id=t.owner_id
      WHERE t.status='OPEN'
      ORDER BY t.featured DESC,t.id DESC
    `);

    res.json(result.rows);
  } catch (e) {
    console.error("Tasks error:", e);
    res.status(500).json({ error: "Unable to load tasks" });
  }
});

app.post("/api/tasks", auth, async (req, res) => {
  const {
    title,
    description,
    category,
    reward,
    featured
  } = req.body;

  const amount = Number(reward);

  if (
    !title ||
    !description ||
    !category ||
    !Number.isFinite(amount) ||
    amount < 50
  ) {
    return res.status(400).json({
      error: "Invalid task"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tasks
       (owner_id,title,description,category,reward,featured)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        req.user.id,
        title,
        description,
        category,
        Math.round(amount),
        featured ? 1 : 0
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("Create task error:", e);
    res.status(500).json({ error: "Unable to create task" });
  }
});

app.post("/api/tasks/:id/accept", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const taskResult = await client.query(
      "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );

    const task = taskResult.rows[0];

    if (!task) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Task not found"
      });
    }

    if (task.status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Task unavailable"
      });
    }

    if (Number(task.owner_id) === Number(req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "You cannot accept your own task"
      });
    }

    const fee = Math.round(
      Number(task.reward) * feePct / 100
    );

    const provider = Number(task.reward) - fee;

    await client.query(
      `UPDATE tasks
       SET status='ACCEPTED',provider_id=$1
       WHERE id=$2`,
      [req.user.id, task.id]
    );

    const transactionResult = await client.query(
      `INSERT INTO transactions
       (task_id,payer_id,provider_id,gross_amount,platform_fee,provider_amount)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        task.id,
        task.owner_id,
        req.user.id,
        task.reward,
        fee,
        provider
      ]
    );

    await client.query("COMMIT");

    const transactionId =
      transactionResult.rows[0].id;

    res.json({
      transaction_id: transactionId,
      task_id: task.id,
      gross_amount: task.reward,
      platform_fee: fee,
      provider_amount: provider,
      status: "PAYMENT_PENDING"
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Accept task error:", e);

    res.status(500).json({
      error: "Unable to accept task"
    });
  } finally {
    client.release();
  }
});

app.post("/api/tasks/:id/complete", auth, async (req, res) => {
  try {
    const taskResult = await pool.query(
      "SELECT * FROM tasks WHERE id=$1",
      [req.params.id]
    );

    const task = taskResult.rows[0];

    if (
      !task ||
      Number(task.provider_id) !== Number(req.user.id)
    ) {
      return res.status(404).json({
        error: "Task not found"
      });
    }

    await pool.query(
      "UPDATE tasks SET status='COMPLETED' WHERE id=$1",
      [task.id]
    );

    await pool.query(
      `UPDATE transactions
       SET status='RELEASE_PENDING'
       WHERE task_id=$1 AND provider_id=$2`,
      [task.id, req.user.id]
    );

    res.json({
      ok: true,
      status: "RELEASE_PENDING"
    });
  } catch (e) {
    console.error("Complete task error:", e);

    res.status(500).json({
      error: "Unable to complete task"
    });
  }
});

app.post("/api/disputes", auth, async (req, res) => {
  const { taskId, reason } = req.body;

  if (!taskId || !reason) {
    return res.status(400).json({
      error: "Task and reason required"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO disputes(task_id,opened_by,reason)
       VALUES($1,$2,$3)
       RETURNING id`,
      [taskId, req.user.id, reason]
    );

    res.status(201).json({
      id: result.rows[0].id,
      status: "OPEN"
    });
  } catch (e) {
    console.error("Dispute error:", e);

    res.status(500).json({
      error: "Unable to create dispute"
    });
  }
});

app.post("/api/reviews", auth, async (req, res) => {
  const {
    taskId,
    revieweeId,
    rating,
    comment
  } = req.body;

  if (
    !taskId ||
    !revieweeId ||
    rating < 1 ||
    rating > 5
  ) {
    return res.status(400).json({
      error: "Invalid review"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO reviews
       (task_id,reviewer_id,reviewee_id,rating,comment)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        taskId,
        req.user.id,
        revieweeId,
        rating,
        comment || ""
      ]
    );

    res.status(201).json({
      id: result.rows[0].id
    });
  } catch (e) {
    console.error("Review error:", e);

    res.status(500).json({
      error: "Unable to create review"
    });
  }
});

app.post("/api/referrals", auth, async (req, res) => {
  const { referredUserId } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO referrals
       (referrer_id,referred_user_id,reward)
       VALUES($1,$2,$3)
       RETURNING id`,
      [req.user.id, referredUserId, 50]
    );

    res.status(201).json({
      id: result.rows[0].id,
      reward: 50,
      status: "PENDING"
    });
  } catch (e) {
    console.error("Referral error:", e);

    res.status(500).json({
      error: "Unable to create referral"
    });
  }
});

app.get("/api/admin/revenue", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(gross_amount),0) AS gross,
        COALESCE(SUM(platform_fee),0) AS fees,
        COUNT(*) AS transactions
      FROM transactions
    `);

    res.json(result.rows[0]);
  } catch (e) {
    console.error("Revenue error:", e);

    res.status(500).json({
      error: "Unable to load revenue"
    });
  }
});

app.get("/api/admin/disputes", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM disputes ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (e) {
    console.error("Disputes error:", e);

    res.status(500).json({
      error: "Unable to load disputes"
    });
  }
});

/*
 * M-Pesa integration remains intentionally disabled for this step.
 * We will implement Daraja STK Push after PostgreSQL is verified.
 */

app.post("/api/payments/mpesa/initiate", auth, (req, res) => {
  res.status(501).json({
    error: "M-Pesa integration not implemented yet",
    next: "PostgreSQL must be verified before enabling Daraja payments."
  });
});

app.post("/api/payments/mpesa/callback", (req, res) => {
  res.status(501).json({
    error: "M-Pesa callback not implemented yet"
  });
});
app.get("/", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});
async function startServer() {
  // Start HTTP server immediately so Render can detect the port.
 
  app.listen(port, "0.0.0.0", () => {
    console.log(`MikroMate API listening on ${port}`);
  });

  try {
    await initDatabase();
    await pool.query("SELECT 1");

    console.log("MikroMate PostgreSQL database connected");
  } catch (e) {
    console.error("PostgreSQL connection failed:", e);
  }
}

startServer();
