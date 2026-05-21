const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      username  TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'tech',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id         SERIAL PRIMARY KEY,
      job_number TEXT NOT NULL,
      job_name   TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id),
      tech_name    TEXT NOT NULL,
      job_id       INTEGER NOT NULL REFERENCES jobs(id),
      report_date  TEXT NOT NULL,
      hours_worked REAL,
      notes        TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed admin account on first run
  const { rows: [{ count: userCount }] } = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(userCount) === 0) {
    const hash = bcrypt.hashSync('es2admin', 12);
    await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      ['Administrator', 'admin', hash, 'admin']
    );
    console.log('\n  Default admin account created:');
    console.log('  Username: admin');
    console.log('  Password: es2admin');
    console.log('  Change this password from the Admin panel after first login.\n');
  }

  // Seed active jobs on first run
  const { rows: [{ count: jobCount }] } = await pool.query('SELECT COUNT(*) as count FROM jobs');
  if (parseInt(jobCount) === 0) {
    const jobs = [
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
    ];
    for (const [num, name] of jobs) {
      await pool.query('INSERT INTO jobs (job_number, job_name) VALUES ($1, $2)', [num, name]);
    }
  }
}

module.exports = { pool, init };
