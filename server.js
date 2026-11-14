import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

import { randomBytes, createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getAccessToken, stkPush } from "./mpesa.js";
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

    -- International country support
ALTER TABLE users
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NOT NULL DEFAULT 'KE';

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NOT NULL DEFAULT 'KE';

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
  const message = String(req.body.message || "").trim();

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).json({
      error: "Invalid job ID"
    });
  }

  if (message.length > 1000) {
    return res.status(400).json({
      error: "Application message is too long"
    });
  }

  try {
    const taskResult = await pool.query(
      "SELECT id, owner_id, status FROM tasks WHERE id=$1",
      [taskId]
    );

    const task = taskResult.rows[0];

    if (!task) {
      return res.status(404).json({
        error: "Job not found"
      });
    }

    if (task.status !== "OPEN") {
      return res.status(409).json({
        error: "This job is no longer available"
      });
    }

    if (Number(task.owner_id) === Number(req.user.id)) {
      return res.status(403).json({
        error: "You cannot apply for your own job"
      });
    }

    const result = await pool.query(
      `INSERT INTO task_applications
       (task_id, applicant_id, message)
       VALUES($1, $2, $3)
       ON CONFLICT(task_id, applicant_id) DO NOTHING
       RETURNING id, task_id, applicant_id, message, status, created_at`,
      [taskId, req.user.id, message || null]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        error: "You have already applied for this job"
      });
    }

    res.status(201).json({
      message: "Job application submitted successfully",
      application: result.rows[0]
    });

  } catch (e) {
    console.error("Job application error:", e);

    res.status(500).json({
      error: "Unable to submit job application"
    });
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

app.post("/api/tasks", auth, async (req, res) => {
  const {
    title,
    description,
    category,
    reward,
    currency = "KES",
    featured
  } = req.body;

  const amount = Number(reward);
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
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !supportedCurrencies.has(taskCurrency)
  ) {
    return res.status(400).json({
      error: "Invalid task details or currency"
    });
  }

  if (
    (taskCurrency === "KES" && amount < 50) ||
    (taskCurrency !== "KES" && amount < 1)
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
        reward, featured, country_code, currency)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.user.id,
        title,
        description,
        category,
        amount,
        featured ? 1 : 0,
        countryCode,
        taskCurrency
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

app.post("/api/payments/mpesa/initiate", auth, async (req, res) => {
  try {
    const { phone, amount, taskId, currency = "KES" } = req.body;

const paymentCurrency = String(currency).trim().toUpperCase();

if (paymentCurrency !== "KES") {
  return res.status(400).json({
    error: "M-Pesa only supports KES payments"
  });
}

    const paymentAmount = Number(amount);

    if (!phone || !Number.isFinite(paymentAmount) || paymentAmount <= 0) {
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
        Math.round(paymentAmount),
        Math.round(paymentAmount * feePct / 100),
        Math.round(
          paymentAmount - (paymentAmount * feePct / 100)
        ),
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
  try {
    console.log(
      "M-Pesa callback received:",
      JSON.stringify(req.body)
    );

    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = Number(callback.ResultCode);

    if (checkoutRequestId) {
      const status =
        resultCode === 0
          ? "PAID"
          : "PAYMENT_FAILED";

      await pool.query(
        `UPDATE transactions
         SET status=$1
         WHERE external_reference=$2`,
        [status, checkoutRequestId]
      );
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (e) {
    console.error("M-Pesa callback error:", e);

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
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
