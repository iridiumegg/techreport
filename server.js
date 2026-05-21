require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const { pool, init } = require('./database');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const smsEnabled = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
const twilioClient = smsEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

const photosEnabled = !!(process.env.CLOUDINARY_CLOUD_NAME);
const aiEnabled = !!(process.env.ANTHROPIC_API_KEY);
const anthropic = aiEnabled ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', quality: 'auto', fetch_format: 'auto' },
      (err, result) => err ? reject(err) : resolve(result)
    );
    Readable.from(buffer).pipe(stream);
  });
}

function thumbUrl(url) {
  return url.replace('/upload/', '/upload/w_400,h_400,c_fill,q_auto,f_auto/');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'es2built-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ─── Auth routes (public) ─────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.userId = user.id;
    req.session.name   = user.name;
    req.session.role   = user.role;
    res.json({ id: user.id, name: user.name, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ─── All routes below require auth ───────────────────────────────────────────

app.use(requireAuth);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/me', (req, res) => {
  res.json({ id: req.session.userId, name: req.session.name, role: req.session.role });
});

app.get('/api/config', (req, res) => {
  res.json({ photosEnabled, aiEnabled });
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

app.get('/api/jobs', async (req, res) => {
  try {
    const showAll = req.query.all === 'true' && req.session.role === 'admin';
    const q = showAll
      ? 'SELECT * FROM jobs ORDER BY job_number'
      : 'SELECT * FROM jobs WHERE active = 1 ORDER BY job_number';
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/jobs', requireAdmin, async (req, res) => {
  const { job_number, job_name } = req.body;
  if (!job_number || !job_name) return res.status(400).json({ error: 'job_number and job_name are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO jobs (job_number, job_name) VALUES ($1, $2) RETURNING *',
      [job_number.trim(), job_name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Job number already exists' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/jobs/:id', requireAdmin, async (req, res) => {
  const { active, job_name } = req.body;
  try {
    if (active !== undefined) await pool.query('UPDATE jobs SET active = $1 WHERE id = $2', [active ? 1 : 0, req.params.id]);
    if (job_name)             await pool.query('UPDATE jobs SET job_name = $1 WHERE id = $2', [job_name.trim(), req.params.id]);
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

async function attachPhotos(reports) {
  if (!reports.length) return;
  const ids = reports.map(r => r.id);
  const { rows: photos } = await pool.query(
    'SELECT * FROM photos WHERE report_id = ANY($1) ORDER BY created_at ASC',
    [ids]
  );
  const byReport = {};
  photos.forEach(p => {
    if (!byReport[p.report_id]) byReport[p.report_id] = [];
    byReport[p.report_id].push({ id: p.id, url: p.url, thumb: thumbUrl(p.url) });
  });
  reports.forEach(r => { r.photos = byReport[r.id] || []; });
}

app.get('/api/reports', async (req, res) => {
  const { job_id, date, tech } = req.query;
  const isAdmin = req.session.role === 'admin';
  const params = [];
  let where = 'WHERE 1=1';

  if (job_id) { params.push(job_id);         where += ` AND r.job_id = $${params.length}`; }
  if (date)   { params.push(date);           where += ` AND r.report_date = $${params.length}`; }
  if (tech)   { params.push(`%${tech}%`);   where += ` AND r.tech_name ILIKE $${params.length}`; }

  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.user_id, r.job_id, r.tech_name, r.report_date, r.notes, r.created_at,
             j.job_number, j.job_name,
             (SELECT COUNT(*) * 5 FROM reports r2 WHERE r2.user_id = r.user_id) AS points
      FROM reports r JOIN jobs j ON r.job_id = j.id
      ${where}
      ORDER BY r.report_date DESC, r.created_at DESC
    `, params);
    await attachPhotos(rows);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reports', async (req, res) => {
  const { job_id, report_date, notes } = req.body;
  if (!job_id || !report_date || !notes) {
    return res.status(400).json({ error: 'job_id, report_date, and notes are required' });
  }
  try {
    const { rows: [report] } = await pool.query(`
      WITH ins AS (
        INSERT INTO reports (user_id, tech_name, job_id, report_date, notes)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      )
      SELECT ins.id, ins.tech_name, ins.report_date, ins.notes, ins.created_at,
             j.job_number, j.job_name
      FROM ins JOIN jobs j ON ins.job_id = j.id
    `, [
      req.session.userId, req.session.name, Number(job_id),
      report_date, notes,
    ]);
    report.photos = [];
    res.status(201).json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/reports/:id', async (req, res) => {
  const { job_id, report_date, notes } = req.body;
  if (!job_id || !report_date || !notes) {
    return res.status(400).json({ error: 'job_id, report_date, and notes are required' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && rows[0].user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows: [updated] } = await pool.query(`
      WITH upd AS (
        UPDATE reports SET job_id = $1, report_date = $2, notes = $3 WHERE id = $4 RETURNING *
      )
      SELECT upd.id, upd.user_id, upd.job_id, upd.tech_name, upd.report_date, upd.notes, upd.created_at,
             j.job_number, j.job_name
      FROM upd JOIN jobs j ON upd.job_id = j.id
    `, [Number(job_id), report_date, notes, req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reports/:id/photos', upload.array('photos', 5), async (req, res) => {
  if (!photosEnabled) return res.status(503).json({ error: 'Photo uploads are not configured' });
  if (!req.files?.length) return res.status(400).json({ error: 'No photos provided' });

  try {
    const { rows } = await pool.query('SELECT user_id FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
    if (req.session.role !== 'admin' && rows[0].user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const uploaded = await Promise.all(
      req.files.map(f => uploadToCloudinary(f.buffer, 'es2-reports'))
    );

    const saved = await Promise.all(
      uploaded.map(r =>
        pool.query(
          'INSERT INTO photos (report_id, url, public_id) VALUES ($1, $2, $3) RETURNING *',
          [req.params.id, r.secure_url, r.public_id]
        )
      )
    );

    res.status(201).json(
      saved.map(r => ({ id: r.rows[0].id, url: r.rows[0].url, thumb: thumbUrl(r.rows[0].url) }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Photo upload failed' });
  }
});

app.delete('/api/reports/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && rows[0].user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // photos deleted automatically via ON DELETE CASCADE
    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Users (admin only) ───────────────────────────────────────────────────────

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, username, role, phone, created_at FROM users ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { name, username, password, role, phone } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'name, username, and password are required' });
  if (!['tech', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be tech or admin' });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name, username, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, username, role, phone, created_at',
      [name.trim(), username.trim().toLowerCase(), hash, role, phone?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const { password, role, name, phone } = req.body;
  try {
    if (password)          await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(password, 12), req.params.id]);
    if (role)              await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    if (name)              await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
    if (phone !== undefined) await pool.query('UPDATE users SET phone = $1 WHERE id = $2', [phone?.trim() || null, req.params.id]);
    const { rows } = await pool.query('SELECT id, name, username, role, phone, created_at FROM users WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete your own account" });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/users/:id/test-sms', requireAdmin, async (req, res) => {
  if (!smsEnabled) return res.status(503).json({ error: 'SMS is not configured' });
  try {
    const { rows } = await pool.query('SELECT name, phone FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.phone) return res.status(400).json({ error: 'This user has no phone number set' });
    const to = normalizePhone(user.phone);
    if (!to) return res.status(400).json({ error: 'Phone number format is invalid' });
    await twilioClient.messages.create({
      body: `Hi ${user.name}, this is a test message from ES2 Built Tech Daily Reports. SMS notifications are working correctly!`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    res.json({ success: true, to });
  } catch (err) {
    console.error('Test SMS error:', err);
    res.status(500).json({ error: err.message || 'Failed to send test SMS' });
  }
});

// ─── Password change (self) ───────────────────────────────────────────────────

app.post('/api/me/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    if (!bcrypt.compareSync(current_password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(new_password, 12), req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── AI Summary ───────────────────────────────────────────────────────────────

app.post('/api/summarize', requireAdmin, async (req, res) => {
  if (!aiEnabled) return res.status(503).json({ error: 'AI summarization is not configured' });

  const { job_id, date_from, date_to } = req.body;

  // Fetch reports for the requested scope
  const params = [];
  let where = 'WHERE 1=1';
  if (job_id)    { params.push(job_id);    where += ` AND r.job_id = $${params.length}`; }
  if (date_from) { params.push(date_from); where += ` AND r.report_date >= $${params.length}`; }
  if (date_to)   { params.push(date_to);   where += ` AND r.report_date <= $${params.length}`; }

  let reports;
  try {
    const { rows } = await pool.query(`
      SELECT r.tech_name, r.report_date, r.notes,
             j.job_number, j.job_name
      FROM reports r JOIN jobs j ON r.job_id = j.id
      ${where}
      ORDER BY r.report_date DESC, r.created_at DESC
    `, params);
    reports = rows;
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!reports.length) return res.status(404).json({ error: 'No reports found for the selected scope' });

  const reportText = reports.map(r =>
    `Date: ${r.report_date}\nTechnician: ${r.tech_name}\n${r.notes}`
  ).join('\n\n---\n\n');

  const jobLabel = job_id ? `${reports[0].job_number} — ${reports[0].job_name}` : 'All Job Sites';

  // Stream the response as SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: 'You are a construction project assistant for ES2 Built, a specialty electrical and low-voltage contractor. You write clear, professional summaries of technician daily field reports. Focus on work completed, progress made, issues noted, and next steps. Be concise and factual.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Please summarize the following field reports for **${jobLabel}**. Provide a brief executive overview followed by key points organized by theme (work completed, issues/blockers, materials, progress, next steps). Use markdown formatting.\n\n${reportText}`,
        },
      ],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('AI summarize error:', err);
    res.write(`data: ${JSON.stringify({ error: 'AI request failed' })}\n\n`);
  } finally {
    res.end();
  }
});

// ─── SMS Reminders ────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function todayCT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

const notifiedDates = new Set();

async function sendDailyReportReminders() {
  if (!smsEnabled) return;
  const today = todayCT();
  if (notifiedDates.has(today)) return;
  notifiedDates.add(today);

  let missingWithPhone, allMissing, admins;
  try {
    const { rows: a } = await pool.query(`
      SELECT u.name, u.phone FROM users u
      WHERE u.role = 'tech'
        AND u.phone IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.user_id = u.id AND r.report_date = $1)
    `, [today]);
    missingWithPhone = a;

    const { rows: b } = await pool.query(`
      SELECT u.name FROM users u
      WHERE u.role = 'tech'
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.user_id = u.id AND r.report_date = $1)
      ORDER BY u.name
    `, [today]);
    allMissing = b;

    const { rows: c } = await pool.query(
      `SELECT name, phone FROM users WHERE role = 'admin' AND phone IS NOT NULL`
    );
    admins = c;
  } catch (err) {
    console.error('SMS reminder: DB error', err);
    return;
  }

  if (allMissing.length === 0) return;

  // Text each missing tech individually
  for (const tech of missingWithPhone) {
    const to = normalizePhone(tech.phone);
    if (!to) continue;
    try {
      await twilioClient.messages.create({
        body: `Hi ${tech.name}, just a reminder that your daily report hasn't been submitted yet today. Please log in to submit it.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to,
      });
    } catch (err) {
      console.error(`SMS to tech ${tech.name} failed:`, err.message);
    }
  }

  // Text admins with a full list of who's missing
  const names = allMissing.map(u => u.name).join(', ');
  for (const admin of admins) {
    const to = normalizePhone(admin.phone);
    if (!to) continue;
    try {
      await twilioClient.messages.create({
        body: `ES2 Built — Daily report reminder (${today}): The following techs have not submitted a report today: ${names}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to,
      });
    } catch (err) {
      console.error(`SMS to admin ${admin.name} failed:`, err.message);
    }
  }

  console.log(`Daily report reminders sent. Missing techs: ${names || 'none'}`);
}

// Runs at 22:00 UTC (5pm CDT) and 23:00 UTC (5pm CST) Mon–Fri
// CT-hour check inside ensures only one actually fires at 5pm
cron.schedule('0 22,23 * * 1-5', async () => {
  const ctHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  if (ctHour === 17) await sendDailyReportReminders();
});

// ─── Start ────────────────────────────────────────────────────────────────────

init()
  .then(() => app.listen(PORT, () => console.log(`ES2 Built Tech Reports → http://localhost:${PORT}`)))
  .catch(err => { console.error('Failed to initialize database:', err); process.exit(1); });
