import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import { lookup } from "node:dns/promises";

import { randomBytes, createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getAccessToken, stkPush, normalizeKenyanPhone, queryStkPush } from "./mpesa.js";
import { parseWorkerCapacity, getRemainingWorkerSlots } from "./worker-capacity.js";
import { parseMoneyToMinorUnits, formatMinorUnits, calculateFeeMinorUnits } from "./money.js";
const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const app = express();

app.set("trust proxy", 1);
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

try {
  const dbUrl = new URL(process.env.DATABASE_URL);
  const resolved = await lookup(dbUrl.hostname).catch((error) => ({
    error: error.code || "DNS_LOOKUP_FAILED"
  }));
  console.log("PostgreSQL target diagnostic:", {
    hostname: dbUrl.hostname,
    port: dbUrl.port || "5432",
    database: dbUrl.pathname.slice(1),
    resolvedAddress: resolved.address || null,
    dnsError: resolved.error || null,
    sslEnabled: process.env.DATABASE_SSL === "true"
  });
} catch (error) {
  console.error("DATABASE_URL diagnostic parse failed:", error.message);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"]
      }
    }
  })
);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

async function initDatabase() {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`
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
      worker_capacity INTEGER NOT NULL DEFAULT 1 CHECK(worker_capacity >= 1),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS task_applications(
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      applicant_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, applicant_id)
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
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
    ON password_reset_tokens(user_id);
    
    -- MikroMate multi-currency wallets
    CREATE TABLE IF NOT EXISTS wallets(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      currency VARCHAR(3) NOT NULL
        CHECK(currency ~ '^[A-Z]{3}$'),
      balance NUMERIC(14,2) NOT NULL DEFAULT 0
        CHECK(balance >= 0),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, currency)
    );

    -- Wallet transaction ledger
    CREATE TABLE IF NOT EXISTS wallet_transactions(
      id SERIAL PRIMARY KEY,
      wallet_id INTEGER NOT NULL REFERENCES wallets(id),
      transaction_type TEXT NOT NULL
        CHECK(transaction_type IN (
          'DEPOSIT',
          'TASK_PAYMENT',
          'TASK_EARNING',
          'WITHDRAWAL',
          'REFUND',
          'ADJUSTMENT'
        )),
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN (
          'PENDING',
          'COMPLETED',
          'FAILED',
          'REVERSED'
        )),
      provider TEXT,
      provider_reference TEXT,
      description TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      UNIQUE(provider, provider_reference)
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_user_id
    ON wallets(user_id);

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id
    ON wallet_transactions(wallet_id);

    -- M-PESA deposit reconciliation metadata for wallet ledger entries.
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS payment_phone TEXT;
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS checkout_request_id TEXT;
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS merchant_request_id TEXT;
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS provider_receipt TEXT;
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS transaction_date TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_checkout_request_id
    ON wallet_transactions(checkout_request_id)
    WHERE checkout_request_id IS NOT NULL;

    DO $
    BEGIN
      IF EXISTS (
        SELECT provider_receipt FROM wallet_transactions
        WHERE provider_receipt IS NOT NULL
        GROUP BY provider_receipt HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION 'Duplicate wallet M-PESA receipts exist; resolve them before enabling receipt uniqueness.';
      END IF;
    END
    $;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_provider_receipt
    ON wallet_transactions(provider_receipt)
    WHERE provider_receipt IS NOT NULL;

    -- International country support
ALTER TABLE users
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NOT NULL DEFAULT 'KE';

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NOT NULL DEFAULT 'KE';

-- Posters choose how many workers are needed for each task.
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS worker_capacity INTEGER NOT NULL DEFAULT 1
CHECK (worker_capacity >= 1);

-- Multi-currency support
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'KES';

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'KES';
-- M-PESA payment verification fields
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider_receipt TEXT;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS payment_phone TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT provider_receipt FROM transactions
    WHERE provider_receipt IS NOT NULL
    GROUP BY provider_receipt HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique M-PESA receipt index: duplicate provider_receipt values exist. Resolve duplicates before retrying migration.';
  END IF;
END
$$;

-- Prevent duplicate M-PESA receipts
CREATE UNIQUE INDEX IF NOT EXISTS
idx_transactions_provider_receipt
ON transactions(provider_receipt)
WHERE provider_receipt IS NOT NULL;

-- Prepare monetary fields for decimal amounts
ALTER TABLE tasks
ALTER COLUMN reward TYPE NUMERIC(14,2)
USING reward::NUMERIC(14,2);
-- Update task reward constraint for international currencies
ALTER TABLE tasks
DROP CONSTRAINT IF EXISTS tasks_reward_check;

ALTER TABLE tasks
ADD CONSTRAINT tasks_reward_check
CHECK (
  (currency = 'KES' AND reward >= 50)
  OR
  (currency <> 'KES' AND reward >= 1)
);

ALTER TABLE transactions
ALTER COLUMN gross_amount TYPE NUMERIC(14,2)
USING gross_amount::NUMERIC(14,2);

ALTER TABLE transactions
ALTER COLUMN platform_fee TYPE NUMERIC(14,2)
USING platform_fee::NUMERIC(14,2);

ALTER TABLE transactions
ALTER COLUMN provider_amount TYPE NUMERIC(14,2)
USING provider_amount::NUMERIC(14,2);
    `);
    await client.query("COMMIT");
    transactionStarted = false;
    console.log("PostgreSQL database initialized");
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Database migration rollback failed:", rollbackError.message); }
    }
    throw error;
  } finally {
    client.release();
  }
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
app.post("/api/admin/setup", async (req, res) => {
  const setupSecret = process.env.ADMIN_SETUP_SECRET;

  if (!setupSecret) {
    return res.status(503).json({
      error: "Admin setup is not configured"
    });
  }

  if (req.get("x-admin-setup-secret") !== setupSecret) {
    return res.status(403).json({
      error: "Invalid setup secret"
    });
  }

  const { name, email, password } = req.body;

  if (!name || !email || !password || password.length < 12) {
    return res.status(400).json({
      error: "Name, email and 12+ character password required"
    });
  }

  try {
    
const existingAdmin = await pool.query(
  "SELECT id FROM users WHERE role='ADMIN' LIMIT 1"
);

if (existingAdmin.rows.length > 0) {
  return res.status(409).json({
    error: "Administrator setup has already been completed"
  });
}
    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users
       (name,email,password_hash,role,verified)
       VALUES($1,$2,$3,'ADMIN',1)
       RETURNING id,name,email,role,verified`,
      [name, email, hash]
    );

    res.status(201).json({
      message: "Administrator created successfully",
      user: result.rows[0]
    });
  } catch (e) {
    console.error("Admin setup error:", e);

    res.status(500).json({
      error: "Unable to create administrator"
    });
  }
});
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
  const {
    name,
    email,
    phone,
    password,
    country_code
  } = req.body;

  const countryCode = String(country_code || "KE")
    .trim()
    .toUpperCase();

  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({
      error: "Name, email and 8+ character password required"
    });
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return res.status(400).json({
      error: "Valid two-letter country code required"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const r = await pool.query(
      `INSERT INTO users
       (name, email, phone, password_hash, country_code)
       VALUES($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, email, phone || null, hash, countryCode]
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
        country_code: countryCode,
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




app.post(
  "/api/auth/forgot-password",
  forgotPasswordLimiter,
  async (req, res) => {
    const message =
      "If an account exists for that email, a password reset link has been sent.";

    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(200).json({ message });
      }

      const result = await pool.query(
        `SELECT id, email FROM users
         WHERE LOWER(TRIM(email)) = $1
         LIMIT 1`,
        [email]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(200).json({ message });
      }

      const token = randomBytes(32).toString("hex");

      const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

      const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

      await pool.query(
        `UPDATE password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      await pool.query(
        `INSERT INTO password_reset_tokens
         (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const baseUrl = (
        process.env.APP_BASE_URL ||
        "https://mikromate.onrender.com"
      ).replace(/\/+$/, "");

      const resetUrl =
        `${baseUrl}/reset-password?token=${token}`;

      try {
        const emailResponse = await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "MikroMate <onboarding@resend.dev>",
              to: [user.email],
              subject: "MikroMate Password Reset",
              text:
                `You requested a MikroMate password reset.\n\n` +
                `Open this link to reset your password:\n${resetUrl}\n\n` +
                `This link expires in 20 minutes. ` +
                `If you did not request this, ignore this email.`,
              html: `
                <p>You requested a MikroMate password reset.</p>
                <p>
                  <a href="${resetUrl}">Reset your MikroMate password</a>
                </p>
                <p>This link expires in 20 minutes.</p>
                <p>If you did not request this, ignore this email.</p>
              `
            })
          }
        );

        if (!emailResponse.ok) {
          const errorDetails = await emailResponse.text();
          throw new Error(
            `Resend API error ${emailResponse.status}: ${errorDetails}`
          );
        }

        const emailResult = await emailResponse.json();

        console.log(
          "Password reset email accepted by Resend:",
          emailResult.id
        );

      } catch (mailError) {
        await pool.query(
          `UPDATE password_reset_tokens
           SET used_at = CURRENT_TIMESTAMP
           WHERE token_hash = $1`,
          [tokenHash]
        );

        console.error(
          "Password reset email delivery failed:",
          mailError.message
        );
      }

      return res.status(200).json({ message });
    } catch (error) {
      console.error("Forgot password error:", error.message);
      return res.status(200).json({ message });
    }
  }
);

app.get("/reset-password", async (req, res) => {
  const token = String(req.query.token || "");

  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).send(
      "Invalid or expired password reset link."
    );
  }

  try {
    const tokenHash = createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `SELECT id FROM password_reset_tokens
       WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [tokenHash]
    );

    if (!result.rows.length) {
      return res.status(400).send(
        "This password reset link is invalid, expired, or already used."
      );
    }

    return res.type("html").send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>MikroMate Password Reset</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 420px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f7fa;
          }
          form {
            background: white;
            padding: 24px;
            border-radius: 12px;
          }
          input {
            width: 100%;
            box-sizing: border-box;
            padding: 12px;
            margin: 8px 0 18px;
          }
          button {
            width: 100%;
            padding: 13px;
            background: #087f5b;
            color: white;
            border: 0;
            border-radius: 6px;
            font-size: 16px;
          }
        </style>
      </head>
      <body>
        <h2>Reset your MikroMate password</h2>
        <p>Enter and confirm your new password below.</p>

        <form method="POST" action="/api/auth/reset-password">
          <input
            type="hidden"
            name="token"
            value="${token}"
          >

          <label>New password</label>
          <input
            type="password"
            name="password"
            minlength="8"
            autocomplete="new-password"
            required
          >

          <label>Confirm new password</label>
          <input
            type="password"
            name="confirmPassword"
            minlength="8"
            autocomplete="new-password"
            required
          >

          <button type="submit">Reset password</button>
        </form>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Reset page error:", error.message);

    return res.status(500).send(
      "Unable to open the password reset page. Please try again."
    );
  }
});

app.post(
  "/api/auth/reset-password",
  resetPasswordLimiter,
  async (req, res) => {
    const token = String(req.body?.token || "");
    const password =
      typeof req.body?.password === "string"
        ? req.body.password
        : "";
    const confirmPassword =
      typeof req.body?.confirmPassword === "string"
        ? req.body.confirmPassword
        : "";

    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).send(
        "Invalid or expired password reset link."
      );
    }

    if (
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).send(
        "Your password must contain at least 8 characters and cannot exceed 72 bytes."
      );
    }

    if (password !== confirmPassword) {
      return res.status(400).send(
        "The passwords do not match. Please go back and try again."
      );
    }

    let client;
    let transactionStarted = false;

    try {
      const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

      const passwordHash = await bcrypt.hash(password, 12);

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query(
        `SELECT id, user_id
         FROM password_reset_tokens
         WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP
         FOR UPDATE`,
        [tokenHash]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).send(
          "This password reset link is invalid, expired, or already used."
        );
      }

      const userId = result.rows[0].user_id;

      await client.query(
        `UPDATE users
         SET password_hash = $1
         WHERE id = $2`,
        [passwordHash, userId]
      );

      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
         AND used_at IS NULL`,
        [userId]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      res.set("Cache-Control", "no-store");

      return res.type("html").send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport"
                content="width=device-width, initial-scale=1">
          <title>Password Reset Successful</title>
        </head>
        <body style="font-family:Arial,sans-serif;
                     text-align:center;padding:40px;">
          <h2>MikroMate Password Reset Successful</h2>
          <p>Your password has been changed successfully.</p>
          <p>You can now return to the MikroMate app
             and log in using your new password.</p>
        </body>
        </html>
      `);
    } catch (error) {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Password reset rollback failed:",
            rollbackError.message
          );
        }
      }

      console.error(
        "Password reset error:",
        error.message
      );

      return res.status(500).send(
        "Unable to reset your password. Please try again."
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = req.body.password || "";

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required"
      });
    }

    const result = await pool.query(
      `SELECT * FROM users
       WHERE LOWER(TRIM(email)) = $1
       LIMIT 1`,
      [email]
    );

    const u = result.rows[0];

    const passwordMatched = u
      ? await bcrypt.compare(password, u.password_hash)
      : false;

      

    if (!u || !passwordMatched) {
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

    return res.json({
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
    return res.status(500).json({
      error: "Login failed"
    });
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

app.post("/api/tasks/:id/applications", auth, async (req, res) => {
  const taskId = Number(req.params.id);
  const message = String(req.body?.message || "").trim();

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: "Invalid job ID" });
  }

  if (message.length > 1000) {
    return res.status(400).json({ error: "Application message is too long" });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    // Use the same task-row lock as accept/reject decisions. This serializes
    // capacity checks with applications and prevents stale capacity reads.
    const taskResult = await client.query(
      `SELECT id, owner_id, status, worker_capacity
       FROM tasks WHERE id=$1 FOR UPDATE`,
      [taskId]
    );
    const task = taskResult.rows[0];

    if (!task) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Job not found" });
    }

    if (task.status !== "OPEN") {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({ error: "This job is no longer available" });
    }

    if (Number(task.owner_id) === Number(req.user.id)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(403).json({ error: "You cannot apply for your own job" });
    }

    const acceptedResult = await client.query(
      `SELECT COUNT(*)::int AS accepted_workers
       FROM task_applications
       WHERE task_id=$1 AND status='ACCEPTED'`,
      [taskId]
    );
    const acceptedWorkers = Number(acceptedResult.rows[0].accepted_workers);
    const remainingPositions = getRemainingWorkerSlots(
      task.worker_capacity,
      acceptedWorkers
    );

    if (remainingPositions <= 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        error: "All worker positions for this job have been filled"
      });
    }

    const result = await client.query(
      `INSERT INTO task_applications
       (task_id, applicant_id, message)
       VALUES($1, $2, $3)
       ON CONFLICT(task_id, applicant_id) DO NOTHING
       RETURNING id, task_id, applicant_id, message, status, created_at`,
      [taskId, req.user.id, message || null]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        error: "You have already applied for this job"
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Job application submitted successfully",
      application: result.rows[0]
    });
  } catch (e) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Application submission rollback failed:", rollbackError);
      }
    }

    console.error("Job application error:", e);
    return res.status(500).json({
      error: "Unable to submit job application"
    });
  } finally {
    if (client) client.release();
  }
});


app.get("/api/my-applications", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id AS application_id,
         a.task_id,
         a.message,
         a.status AS application_status,
         a.created_at AS applied_at,
         t.title,
         t.description,
         t.category,
         t.reward,
         t.status AS job_status,
         u.name AS employer_name
       FROM task_applications a
       JOIN tasks t ON t.id = a.task_id
       JOIN users u ON u.id = t.owner_id
       WHERE a.applicant_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (e) {
    console.error("My applications error:", e);

    res.status(500).json({
      error: "Unable to load your applications"
    });
  }
});


async function loadPosterApplications(req, res, taskId = null) {
  const result = await pool.query(
    `SELECT
       a.id AS application_id,
       a.task_id,
       a.message,
       a.status AS application_status,
       a.created_at AS applied_at,
       t.title AS task_title,
       t.status AS task_status,
       t.reward,
       t.currency,
       t.worker_capacity,
       (SELECT COUNT(*)::int
        FROM task_applications accepted
        WHERE accepted.task_id=t.id
          AND accepted.status='ACCEPTED') AS accepted_workers,
       GREATEST(
         t.worker_capacity -
         (SELECT COUNT(*)::int
          FROM task_applications accepted
          WHERE accepted.task_id=t.id
            AND accepted.status='ACCEPTED'),
         0
       ) AS remaining_positions,
       u.id AS applicant_id,
       u.name AS applicant_name,
       u.phone AS applicant_phone,
       u.verified AS applicant_verified
     FROM task_applications a
     JOIN tasks t ON t.id=a.task_id
     JOIN users u ON u.id=a.applicant_id
     WHERE t.owner_id=$1
       AND ($2::integer IS NULL OR t.id=$2)
     ORDER BY a.created_at DESC`,
    [req.user.id, taskId]
  );

  return res.json({ applications: result.rows });
}

app.get("/api/poster/applications", auth, async (req, res) => {
  const taskId = req.query.task_id === undefined
    ? null
    : Number(req.query.task_id);

  if (
    taskId !== null &&
    (!Number.isInteger(taskId) || taskId <= 0)
  ) {
    return res.status(400).json({ error: "Invalid task ID" });
  }

  try {
    return await loadPosterApplications(req, res, taskId);
  } catch (e) {
    console.error("Poster applications error:", e);
    return res.status(500).json({
      error: "Unable to load received applications"
    });
  }
});

app.get("/api/tasks/:id/applications", auth, async (req, res) => {
  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: "Invalid task ID" });
  }

  try {
    const taskResult = await pool.query(
      "SELECT id, owner_id FROM tasks WHERE id=$1",
      [taskId]
    );
    const task = taskResult.rows[0];

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (Number(task.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({
        error: "You can only view applications for your own tasks"
      });
    }

    return await loadPosterApplications(req, res, taskId);
  } catch (e) {
    console.error("Task applications error:", e);
    return res.status(500).json({
      error: "Unable to load task applications"
    });
  }
});

async function decideTaskApplication(req, res, decision) {
  const applicationId = Number(req.params.id);

  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return res.status(400).json({ error: "Invalid application ID" });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const applicationLookup = await client.query(
      "SELECT task_id FROM task_applications WHERE id=$1",
      [applicationId]
    );

    if (!applicationLookup.rows.length) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Application not found" });
    }

    // Lock the task first so concurrent decisions cannot exceed capacity.
    const taskResult = await client.query(
      `SELECT id, owner_id, status, worker_capacity
       FROM tasks
       WHERE id=$1
       FOR UPDATE`,
      [applicationLookup.rows[0].task_id]
    );
    const task = taskResult.rows[0];

    if (!task) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Task not found" });
    }

    if (Number(task.owner_id) !== Number(req.user.id)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(403).json({
        error: "Only the task poster can decide applications"
      });
    }

    const applicationResult = await client.query(
      `SELECT id, task_id, status
       FROM task_applications
       WHERE id=$1 AND task_id=$2
       FOR UPDATE`,
      [applicationId, task.id]
    );
    const application = applicationResult.rows[0];

    if (!application) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.status !== "PENDING") {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        error: "This application has already been decided",
        application_status: application.status
      });
    }

    let acceptedWorkers = 0;

    if (decision === "ACCEPTED") {
      if (task.status !== "OPEN") {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({
          error: "This task is no longer accepting workers"
        });
      }

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS accepted_workers
         FROM task_applications
         WHERE task_id=$1 AND status='ACCEPTED'`,
        [task.id]
      );
      acceptedWorkers = Number(countResult.rows[0].accepted_workers);

      if (!getRemainingWorkerSlots(task.worker_capacity, acceptedWorkers)) {
        await client.query(
          "UPDATE tasks SET status='FILLED' WHERE id=$1",
          [task.id]
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return res.status(409).json({
          error: "All worker positions for this task have been filled",
          worker_capacity: Number(task.worker_capacity),
          accepted_workers: acceptedWorkers,
          remaining_positions: 0
        });
      }
    }

    const updatedApplication = await client.query(
      `UPDATE task_applications
       SET status=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
       RETURNING id, task_id, applicant_id, message, status, created_at, updated_at`,
      [decision, applicationId]
    );

    if (decision === "ACCEPTED") {
      acceptedWorkers += 1;
      const remainingPositions = getRemainingWorkerSlots(
        task.worker_capacity,
        acceptedWorkers
      );

      if (remainingPositions === 0) {
        await client.query(
          "UPDATE tasks SET status='FILLED' WHERE id=$1",
          [task.id]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        message: "Applicant accepted successfully",
        application: updatedApplication.rows[0],
        worker_capacity: Number(task.worker_capacity),
        accepted_workers: acceptedWorkers,
        remaining_positions: remainingPositions,
        task_status: remainingPositions === 0 ? "FILLED" : "OPEN"
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      message: "Applicant rejected successfully",
      application: updatedApplication.rows[0]
    });
  } catch (e) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Application decision rollback failed:", rollbackError);
      }
    }

    console.error("Application decision error:", e);
    return res.status(500).json({
      error: "Unable to update application"
    });
  } finally {
    if (client) client.release();
  }
}

app.post("/api/applications/:id/accept", auth, async (req, res) => {
  return decideTaskApplication(req, res, "ACCEPTED");
});

app.post("/api/applications/:id/reject", auth, async (req, res) => {
  return decideTaskApplication(req, res, "REJECTED");
});

app.post("/api/tasks", auth, async (req, res) => {
  const {
    title,
    description,
    category,
    reward,
    currency = "KES",
    featured
  } = req.body;

  const workerCapacityInput =
    req.body.worker_capacity ?? req.body.workerCapacity ?? 1;
  const workerCapacity = parseWorkerCapacity(workerCapacityInput);
  const amountMinorUnits = parseMoneyToMinorUnits(reward);
  const amount = amountMinorUnits === null ? null : formatMinorUnits(amountMinorUnits);
  const taskCurrency = String(currency).trim().toUpperCase();
    const supportedCurrencies = new Set([
    "KES",
    "USD",
    "UGX",
    "TZS",
    "RWF",
    "ZAR",
    "GBP",
    "EUR"
  ]);

  if (
    !title ||
    !description ||
    !category ||
    amountMinorUnits === null ||
    amountMinorUnits <= 0 ||
    workerCapacity === null ||
    !supportedCurrencies.has(taskCurrency)
  ) {
    return res.status(400).json({
      error: "Invalid task details or currency"
    });
  }

  if (
    (taskCurrency === "KES" && amountMinorUnits < 5000) ||
    (taskCurrency !== "KES" && amountMinorUnits < 100)
  ) {
    return res.status(400).json({
      error: "Minimum reward is 50 KES or 1 unit of other currencies"
    });
  }

  try {
    const userResult = await pool.query(
      "SELECT country_code FROM users WHERE id=$1",
      [req.user.id]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        error: "User account not found"
      });
    }

    const countryCode =
      userResult.rows[0].country_code || "KE";

    const result = await pool.query(
      `INSERT INTO tasks
       (owner_id, title, description, category,
        reward, featured, country_code, currency, worker_capacity)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.user.id,
        title,
        description,
        category,
        amount,
        featured ? 1 : 0,
        countryCode,
        taskCurrency,
        workerCapacity
      ]
    );

    res.status(201).json(result.rows[0]);

  } catch (e) {
    console.error("Create task error:", e);

    res.status(500).json({
      error: "Unable to create task"
    });
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

    if (Number(task.worker_capacity || 1) > 1) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "This task requires poster selection from submitted applications. Apply for the task and wait for the poster to review your application."
      });
    }

    if (Number(task.owner_id) === Number(req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "You cannot accept your own task"
      });
    }

    const rewardMinorUnits = parseMoneyToMinorUnits(String(task.reward));
    if (rewardMinorUnits === null) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Task reward has an invalid stored amount" });
    }
    const feeMinorUnits = calculateFeeMinorUnits(rewardMinorUnits, feePct);
    const providerMinorUnits = rewardMinorUnits - feeMinorUnits;
    const fee = formatMinorUnits(feeMinorUnits);
    const provider = formatMinorUnits(providerMinorUnits);

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
        formatMinorUnits(rewardMinorUnits),
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
      gross_amount: formatMinorUnits(rewardMinorUnits),
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
app.get("/api/admin/dashboard", auth, admin, async (req, res) => {
  try {
    const revenueResult = await pool.query(`
      SELECT
        COALESCE(SUM(gross_amount),0) AS gross,
        COALESCE(SUM(platform_fee),0) AS fees,
        COUNT(*) AS transactions
      FROM transactions
    `);

    const usersResult = await pool.query(`
      SELECT COUNT(*) AS users
      FROM users
    `);

    const disputesResult = await pool.query(`
      SELECT COUNT(*) AS disputes
      FROM disputes
      WHERE status='OPEN'
    `);

    const revenue = revenueResult.rows[0];

    res.json({
      revenue: revenue.fees,
      gross: revenue.gross,
      fees: revenue.fees,
      transactions: Number(revenue.transactions),
      users: Number(usersResult.rows[0].users),
      disputes: Number(disputesResult.rows[0].disputes)
    });

  } catch (e) {
    console.error("Admin dashboard error:", e);

    res.status(500).json({
      error: "Unable to load admin dashboard"
    });
  }
});
/*
 * M-Pesa Daraja STK Push
 */

app.get("/api/wallet", auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO wallets(user_id, currency)
       VALUES($1, 'KES')
       ON CONFLICT(user_id, currency) DO NOTHING`,
      [req.user.id]
    );

    const walletsResult = await pool.query(
      `SELECT id, currency, balance, created_at, updated_at
       FROM wallets WHERE user_id=$1 ORDER BY currency`,
      [req.user.id]
    );
    const transactionsResult = await pool.query(
      `SELECT wt.id, wt.transaction_type, wt.amount, wt.status,
              wt.provider, wt.provider_receipt, wt.description,
              wt.created_at, wt.completed_at, w.currency
       FROM wallet_transactions wt
       JOIN wallets w ON w.id=wt.wallet_id
       WHERE w.user_id=$1
       ORDER BY wt.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    return res.json({ wallets: walletsResult.rows, transactions: transactionsResult.rows });
  } catch (e) {
    console.error("Wallet load error:", e);
    return res.status(500).json({ error: "Unable to load your wallet" });
  }
});

app.post("/api/wallet/deposits/mpesa", auth, async (req, res) => {
  let walletTransactionId = null;
  try {
    const currency = String(req.body.currency || "KES").trim().toUpperCase();
    const amountMinorUnits = parseMoneyToMinorUnits(req.body.amount);
    if (currency !== "KES") {
      return res.status(400).json({ error: "M-PESA wallet deposits are only available in KES" });
    }
    if (amountMinorUnits === null || amountMinorUnits < 100 || amountMinorUnits % 100 !== 0) {
      return res.status(400).json({ error: "Enter a whole-number KES deposit of at least KSh 1" });
    }

    const phone = normalizeKenyanPhone(req.body.phone);
    const amount = amountMinorUnits / 100;

    await pool.query(
      `INSERT INTO wallets(user_id, currency)
       VALUES($1, 'KES')
       ON CONFLICT(user_id, currency) DO NOTHING`,
      [req.user.id]
    );
    const walletResult = await pool.query(
      "SELECT id FROM wallets WHERE user_id=$1 AND currency='KES'",
      [req.user.id]
    );
    const ledgerResult = await pool.query(
      `INSERT INTO wallet_transactions
       (wallet_id, transaction_type, amount, status, provider, payment_phone, description)
       VALUES($1, 'DEPOSIT', $2, 'PENDING', 'MPESA', $3, 'M-PESA wallet deposit')
       RETURNING id`,
      [walletResult.rows[0].id, formatMinorUnits(amountMinorUnits), phone]
    );
    walletTransactionId = ledgerResult.rows[0].id;

    const stk = await stkPush({
      phone,
      amount,
      accountReference: `MMW${walletTransactionId}`,
      transactionDesc: "MikroMate wallet"
    });
    const checkoutRequestId = stk.CheckoutRequestID;
    if (String(stk.ResponseCode) !== "0" || !checkoutRequestId) {
      await pool.query(
        "UPDATE wallet_transactions SET status='FAILED' WHERE id=$1 AND status='PENDING'",
        [walletTransactionId]
      );
      return res.status(502).json({
        error: stk.ResponseDescription || "Safaricom did not accept the M-PESA request"
      });
    }

    await pool.query(
      `UPDATE wallet_transactions
       SET checkout_request_id=$1, merchant_request_id=$2, provider_reference=$1
       WHERE id=$3`,
      [checkoutRequestId, stk.MerchantRequestID || null, walletTransactionId]
    );
    return res.status(202).json({
      ok: true,
      transaction_id: walletTransactionId,
      status: "PENDING",
      checkout_request_id: checkoutRequestId,
      customer_message: stk.CustomerMessage || "Check your phone and enter your M-PESA PIN to complete the deposit."
    });
  } catch (e) {
    if (walletTransactionId !== null) {
      await pool.query(
        "UPDATE wallet_transactions SET status='FAILED' WHERE id=$1 AND status='PENDING'",
        [walletTransactionId]
      ).catch((updateError) => console.error("Wallet deposit failure update error:", updateError.message));
    }
    console.error("M-PESA wallet deposit initiation error:", e);
    return res.status(400).json({ error: e.message || "Unable to initiate M-PESA wallet deposit" });
  }
});

app.post("/api/payments/mpesa/initiate", auth, async (req, res) => {
  try {
    const { phone, amount, taskId, currency = "KES" } = req.body;

const paymentCurrency = String(currency).trim().toUpperCase();

if (paymentCurrency !== "KES") {
  return res.status(400).json({
    error: "M-Pesa only supports KES payments"
  });
}

    const paymentMinorUnits = parseMoneyToMinorUnits(amount);
    const paymentAmount = paymentMinorUnits === null ? null : paymentMinorUnits / 100;

    if (!phone || paymentAmount === null || paymentAmount <= 0 ||
        !Number.isSafeInteger(paymentAmount)) {
      return res.status(400).json({
        error: "Phone and valid amount are required"
      });
    }

    
    const result = await pool.query(
      `INSERT INTO transactions
       (
         task_id,
         payer_id,
         gross_amount,
         platform_fee,
         provider_amount,
         status,
         currency,
         payment_phone
       )
       VALUES($1,$2,$3,$4,$5,'PAYMENT_PENDING',$6,$7)
       RETURNING id`,
      [
        taskId || 0,
        req.user.id,
        formatMinorUnits(paymentMinorUnits),
        formatMinorUnits(calculateFeeMinorUnits(paymentMinorUnits, feePct)),
        formatMinorUnits(paymentMinorUnits - calculateFeeMinorUnits(paymentMinorUnits, feePct)),
        paymentCurrency,
        phone.trim()
      ]
    );


    const transactionId = result.rows[0].id;

    const stk = await stkPush({
      phone,
      amount: paymentAmount,
      accountReference: `MM${transactionId}`,
      transactionDesc: "MikroMate payment"
    });

    await pool.query(
      `UPDATE transactions
       SET external_reference=$1
       WHERE id=$2`,
      [
        stk.CheckoutRequestID ||
        stk.MerchantRequestID ||
        null,
        transactionId
      ]
    );

    res.json({
      ok: true,
      transaction_id: transactionId,
      merchant_request_id: stk.MerchantRequestID || null,
      checkout_request_id: stk.CheckoutRequestID || null,
      response_code: stk.ResponseCode || null,
      customer_message: stk.CustomerMessage || null
    });

  } catch (e) {
    console.error("M-Pesa STK initiation error:", e);

    res.status(500).json({
      error: "Unable to initiate M-Pesa payment",
      message: e.message
    });
  }
});


app.post("/api/payments/mpesa/callback", async (req, res) => {
  const acknowledge = () => res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  let client;
  let inTransaction = false;
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) return acknowledge();
    const checkoutRequestId = String(callback.CheckoutRequestID);
    const resultCode = Number(callback.ResultCode);

    if (resultCode !== 0) {
      await pool.query(
        `UPDATE wallet_transactions SET status='FAILED'
         WHERE checkout_request_id=$1 AND status='PENDING'`,
        [checkoutRequestId]
      );
      await pool.query(
        `UPDATE transactions SET status='PAYMENT_FAILED'
         WHERE external_reference=$1 AND status='PAYMENT_PENDING'`,
        [checkoutRequestId]
      );
      return acknowledge();
    }

    const items = callback.CallbackMetadata?.Item;
    if (!Array.isArray(items)) return acknowledge();
    const metadata = {};
    for (const item of items) {
      if (item && typeof item.Name === "string") metadata[item.Name] = item.Value;
    }
    const callbackAmountMinor = parseMoneyToMinorUnits(String(metadata.Amount ?? ""));
    const receipt = String(metadata.MpesaReceiptNumber ?? "").trim();
    if (callbackAmountMinor === null || callbackAmountMinor <= 0 || !receipt || metadata.PhoneNumber === undefined) {
      console.error("M-PESA callback missing valid amount, receipt, or phone", checkoutRequestId);
      return acknowledge();
    }

    const queryResult = await queryStkPush({ checkoutRequestId });
    if (String(queryResult.ResultCode) !== "0" ||
        String(queryResult.CheckoutRequestID) !== checkoutRequestId) {
      console.warn("Daraja STK query has not confirmed payment", checkoutRequestId, queryResult.ResultDesc);
      return acknowledge();
    }

    const normalizedCallbackPhone = normalizeKenyanPhone(String(metadata.PhoneNumber));
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;

    const walletResult = await client.query(
      `SELECT wt.id, wt.wallet_id, wt.amount, wt.status, wt.payment_phone
       FROM wallet_transactions wt
       JOIN wallets w ON w.id=wt.wallet_id
       WHERE wt.checkout_request_id=$1 AND wt.provider='MPESA'
       FOR UPDATE OF wt, w`,
      [checkoutRequestId]
    );

    if (walletResult.rows.length > 0) {
      const deposit = walletResult.rows[0];
      const expectedAmountMinor = parseMoneyToMinorUnits(String(deposit.amount));
      const expectedPhone = normalizeKenyanPhone(deposit.payment_phone);
      if (expectedAmountMinor !== callbackAmountMinor || expectedPhone !== normalizedCallbackPhone) {
        await client.query("ROLLBACK");
        inTransaction = false;
        console.error("M-PESA wallet callback metadata mismatch", checkoutRequestId);
        return acknowledge();
      }
      if (deposit.status === "COMPLETED") {
        await client.query("COMMIT");
        inTransaction = false;
        return acknowledge();
      }

      const completed = await client.query(
        `UPDATE wallet_transactions
         SET status='COMPLETED', provider_receipt=$1, transaction_date=$2,
             completed_at=CURRENT_TIMESTAMP
         WHERE id=$3 AND status='PENDING'
         RETURNING id`,
        [receipt, metadata.TransactionDate ? String(metadata.TransactionDate) : null, deposit.id]
      );
      if (completed.rows.length > 0) {
        await client.query(
          `UPDATE wallets SET balance=balance + $1::numeric,
             updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
          [String(deposit.amount), deposit.wallet_id]
        );
      }
      await client.query("COMMIT");
      inTransaction = false;
      return acknowledge();
    }

    // Task payments are recorded separately; they never credit a wallet.
    const taskPaymentResult = await client.query(
      `SELECT id, gross_amount, payment_phone, status
       FROM transactions WHERE external_reference=$1 FOR UPDATE`,
      [checkoutRequestId]
    );
    if (taskPaymentResult.rows.length > 0) {
      const payment = taskPaymentResult.rows[0];
      const expectedAmountMinor = parseMoneyToMinorUnits(String(payment.gross_amount));
      const expectedPhone = normalizeKenyanPhone(payment.payment_phone);
      if (expectedAmountMinor !== callbackAmountMinor || expectedPhone !== normalizedCallbackPhone) {
        await client.query("ROLLBACK");
        inTransaction = false;
        console.error("M-PESA task payment callback metadata mismatch", checkoutRequestId);
        return acknowledge();
      }
      if (payment.status !== "PAID") {
        await client.query(
          `UPDATE transactions SET status='PAID', provider_receipt=$1
           WHERE id=$2 AND status='PAYMENT_PENDING'`,
          [receipt, payment.id]
        );
      }
    }
    await client.query("COMMIT");
    inTransaction = false;
    return acknowledge();
  } catch (e) {
    if (client && inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("M-PESA callback rollback failed:", rollbackError.message); }
    }
    console.error("M-PESA callback processing error:", e);
    return acknowledge();
  } finally {
    if (client) client.release();
  }
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
