require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/api/reports', async (req, res) => {
  const { job_id, date, tech } = req.query;
  const isAdmin = req.session.role === 'admin';
  const params = [];
  let where = 'WHERE 1=1';

  if (!isAdmin) { params.push(req.session.userId); where += ` AND r.user_id = $${params.length}`; }
  if (job_id)   { params.push(job_id);             where += ` AND r.job_id = $${params.length}`; }
  if (date)     { params.push(date);               where += ` AND r.report_date = $${params.length}`; }
  if (tech && isAdmin) { params.push(`%${tech}%`); where += ` AND r.tech_name ILIKE $${params.length}`; }

  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.tech_name, r.report_date, r.hours_worked, r.notes, r.created_at,
             j.job_number, j.job_name
      FROM reports r JOIN jobs j ON r.job_id = j.id
      ${where}
      ORDER BY r.report_date DESC, r.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/reports', async (req, res) => {
  const { job_id, report_date, hours_worked, notes } = req.body;
  if (!job_id || !report_date || !notes) {
    return res.status(400).json({ error: 'job_id, report_date, and notes are required' });
  }
  try {
    const { rows: [report] } = await pool.query(`
      WITH ins AS (
        INSERT INTO reports (user_id, tech_name, job_id, report_date, hours_worked, notes)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
      )
      SELECT ins.id, ins.tech_name, ins.report_date, ins.hours_worked, ins.notes, ins.created_at,
             j.job_number, j.job_name
      FROM ins JOIN jobs j ON ins.job_id = j.id
    `, [
      req.session.userId, req.session.name, Number(job_id),
      report_date, hours_worked ? Number(hours_worked) : null, notes,
    ]);
    res.status(201).json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/reports/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'admin' && rows[0].user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
    const { rows } = await pool.query('SELECT id, name, username, role, created_at FROM users ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'name, username, and password are required' });
  if (!['tech', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be tech or admin' });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, username, role, created_at',
      [name.trim(), username.trim().toLowerCase(), hash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const { password, role, name } = req.body;
  try {
    if (password) await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(password, 12), req.params.id]);
    if (role)     await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    if (name)     await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
    const { rows } = await pool.query('SELECT id, name, username, role, created_at FROM users WHERE id = $1', [req.params.id]);
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

// ─── Start ────────────────────────────────────────────────────────────────────

init()
  .then(() => app.listen(PORT, () => console.log(`ES2 Built Tech Reports → http://localhost:${PORT}`)))
  .catch(err => { console.error('Failed to initialize database:', err); process.exit(1); });
