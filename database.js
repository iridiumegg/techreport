const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'reports.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'tech',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT NOT NULL,
    job_name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    tech_name TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    report_date TEXT NOT NULL,
    hours_worked REAL,
    notes TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
`);

// Seed default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync('es2admin', 12);
  db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Administrator', 'admin', hash, 'admin'
  );
  console.log('\n  Default admin account created:');
  console.log('  Username: admin');
  console.log('  Password: es2admin');
  console.log('  Change this password from the Admin panel after first login.\n');
}

// Seed placeholder jobs if none exist
const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
if (jobCount.count === 0) {
  const insert = db.prepare('INSERT INTO jobs (job_number, job_name) VALUES (?, ?)');
  const seed = db.transaction(() => {
    [
      ['J-1001', 'Commercial Office Build-Out — Suite 400'],
      ['J-1002', 'Residential HVAC Install — 123 Oak St'],
      ['J-1003', 'Industrial Electrical Upgrade — Warehouse B'],
      ['J-1004', 'New Construction — Riverside Apartments'],
      ['J-1005', 'Preventive Maintenance — Downtown Complex'],
      ['J-1006', 'Service Call — Metro Building'],
      ['J-1007', 'Parking Structure Retrofit — Level 2'],
      ['J-1008', 'Restaurant Fit-Out — Market St'],
    ].forEach(([num, name]) => insert.run(num, name));
  });
  seed();
}

module.exports = db;
