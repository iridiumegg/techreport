const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Jobs ---

app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY job_number').all();
  res.json(jobs);
});

app.post('/api/jobs', (req, res) => {
  const { job_number, job_name } = req.body;
  if (!job_number || !job_name) {
    return res.status(400).json({ error: 'job_number and job_name are required' });
  }
  const result = db.prepare('INSERT INTO jobs (job_number, job_name) VALUES (?, ?)').run(job_number, job_name);
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid));
});

app.patch('/api/jobs/:id', (req, res) => {
  const { active } = req.body;
  db.prepare('UPDATE jobs SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// --- Reports ---

app.get('/api/reports', (req, res) => {
  const { job_id, date, tech } = req.query;
  let query = `
    SELECT r.id, r.tech_name, r.report_date, r.hours_worked, r.notes, r.created_at,
           j.job_number, j.job_name
    FROM reports r
    JOIN jobs j ON r.job_id = j.id
    WHERE 1=1
  `;
  const params = [];
  if (job_id) { query += ' AND r.job_id = ?'; params.push(job_id); }
  if (date)   { query += ' AND r.report_date = ?'; params.push(date); }
  if (tech)   { query += ' AND r.tech_name LIKE ?'; params.push(`%${tech}%`); }
  query += ' ORDER BY r.report_date DESC, r.created_at DESC';

  res.json(db.prepare(query).all(...params));
});

app.post('/api/reports', (req, res) => {
  const { tech_name, job_id, report_date, hours_worked, notes } = req.body;
  if (!tech_name || !job_id || !report_date || !notes) {
    return res.status(400).json({ error: 'tech_name, job_id, report_date, and notes are required' });
  }
  const result = db.prepare(
    'INSERT INTO reports (tech_name, job_id, report_date, hours_worked, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(tech_name, Number(job_id), report_date, hours_worked ? Number(hours_worked) : null, notes);

  const report = db.prepare(`
    SELECT r.id, r.tech_name, r.report_date, r.hours_worked, r.notes, r.created_at,
           j.job_number, j.job_name
    FROM reports r JOIN jobs j ON r.job_id = j.id
    WHERE r.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json(report);
});

app.delete('/api/reports/:id', (req, res) => {
  const info = db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Report not found' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\nES2 Built Tech Reports → http://localhost:${PORT}\n`);
});
