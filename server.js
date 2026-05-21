const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static assets (CSS, JS) but not index.html — auth guards that
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

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.name   = user.name;
  req.session.role   = user.role;
  res.json({ id: user.id, name: user.name, role: user.role });
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

app.get('/api/jobs', (req, res) => {
  const all = req.query.all === 'true' && req.session.role === 'admin';
  const jobs = db.prepare(`SELECT * FROM jobs ${all ? '' : 'WHERE active = 1'} ORDER BY job_number`).all();
  res.json(jobs);
});

app.post('/api/jobs', requireAdmin, (req, res) => {
  const { job_number, job_name } = req.body;
  if (!job_number || !job_name) return res.status(400).json({ error: 'job_number and job_name are required' });
  try {
    const result = db.prepare('INSERT INTO jobs (job_number, job_name) VALUES (?, ?)').run(
      job_number.trim(), job_name.trim()
    );
    res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(409).json({ error: 'Job number already exists' });
  }
});

app.patch('/api/jobs/:id', requireAdmin, (req, res) => {
  const { active, job_name } = req.body;
  if (active !== undefined) db.prepare('UPDATE jobs SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  if (job_name)             db.prepare('UPDATE jobs SET job_name = ? WHERE id = ?').run(job_name.trim(), req.params.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

// ─── Reports ──────────────────────────────────────────────────────────────────

app.get('/api/reports', (req, res) => {
  const { job_id, date, tech } = req.query;
  // Techs only see their own reports; admins see all
  const isAdmin = req.session.role === 'admin';
  let query = `
    SELECT r.id, r.tech_name, r.report_date, r.hours_worked, r.notes, r.created_at,
           j.job_number, j.job_name
    FROM reports r
    JOIN jobs j ON r.job_id = j.id
    WHERE 1=1
  `;
  const params = [];
  if (!isAdmin) { query += ' AND r.user_id = ?'; params.push(req.session.userId); }
  if (job_id)   { query += ' AND r.job_id = ?'; params.push(job_id); }
  if (date)     { query += ' AND r.report_date = ?'; params.push(date); }
  if (tech && isAdmin) { query += ' AND r.tech_name LIKE ?'; params.push(`%${tech}%`); }
  query += ' ORDER BY r.report_date DESC, r.created_at DESC';

  res.json(db.prepare(query).all(...params));
});

app.post('/api/reports', (req, res) => {
  const { job_id, report_date, hours_worked, notes } = req.body;
  if (!job_id || !report_date || !notes) {
    return res.status(400).json({ error: 'job_id, report_date, and notes are required' });
  }
  const result = db.prepare(
    'INSERT INTO reports (user_id, tech_name, job_id, report_date, hours_worked, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    req.session.userId,
    req.session.name,
    Number(job_id),
    report_date,
    hours_worked ? Number(hours_worked) : null,
    notes
  );
  const report = db.prepare(`
    SELECT r.id, r.tech_name, r.report_date, r.hours_worked, r.notes, r.created_at,
           j.job_number, j.job_name
    FROM reports r JOIN jobs j ON r.job_id = j.id WHERE r.id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json(report);
});

app.delete('/api/reports/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  // Techs can only delete their own; admins can delete any
  if (req.session.role !== 'admin' && report.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Users (admin only) ───────────────────────────────────────────────────────

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, created_at FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'name, username, and password are required' });
  if (!['tech', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be tech or admin' });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      name.trim(), username.trim().toLowerCase(), hash, role
    );
    const user = db.prepare('SELECT id, name, username, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (e) {
    res.status(409).json({ error: 'Username already exists' });
  }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const { password, role, name } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), req.params.id);
  if (role)     db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (name)     db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json(db.prepare('SELECT id, name, username, role, created_at FROM users WHERE id = ?').get(req.params.id));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete your own account" });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Password change (self) ───────────────────────────────────────────────────

app.post('/api/me/password', (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 12), req.session.userId);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`ES2 Built Tech Reports → http://localhost:${PORT}`);
});
