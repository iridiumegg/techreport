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

// Seed active jobs if none exist
const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
if (jobCount.count === 0) {
  const insert = db.prepare('INSERT INTO jobs (job_number, job_name) VALUES (?, ?)');
  const seed = db.transaction(() => {
    [
      ['03-23010B', 'AWE CBMAA PH II'],
      ['03-24007B', 'ARDOT Multi Site Upgrades'],
      ['03-24010B', 'Hotel Vin Rogers'],
      ['03-24014B', 'P&W Springdale PH I'],
      ['03-24017B', 'ARDOT Welcome Center Gravette'],
      ['03-24022B', 'CN Pocola Casino Retrofit PH II'],
      ['03-24023B', 'WM Project Mockingbird Robinson, TX BMS Install'],
      ['03-25002B', 'WM DC 6031 Buckeye AZ'],
      ['03-25008B', 'Tapestry Hotel Springdale'],
      ['03-25011B', 'Jones Center JTL Retrofit'],
      ['03-25012B', 'AWE AWSOM Campus Housing'],
      ['03-25013B', 'AWE CBMAA Renovation Controls Retrofit'],
      ['03-25015B', 'Catalyst Church New Bldg. Bentonville'],
      ['03-26001B', 'WM Buckeye AZ Air Farm'],
      ['03-26002B', 'IBC TSSA 2/1/26-1/31/27'],
      ['03-26003B', 'CANTEX, Inc. Nashville, AR'],
    ].forEach(([num, name]) => insert.run(num, name));
  });
  seed();
}

module.exports = db;
