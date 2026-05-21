/* ─── State ───────────────────────────────────────────────────────────────── */
let jobs = [];
let toastTimer = null;

/* ─── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setTodayDate();
  setTodayBadge();
  setupTabs();
  loadJobs().then(() => {
    populateJobDropdown('job-select');
    populateJobDropdown('filter-job', true);
  });

  document.getElementById('report-form').addEventListener('submit', handleSubmit);
  document.getElementById('clear-btn').addEventListener('click', clearForm);
  document.getElementById('filter-btn').addEventListener('click', loadReports);
  document.getElementById('clear-filter-btn').addEventListener('click', clearFilters);
});

/* ─── Date helpers ────────────────────────────────────────────────────────── */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function setTodayDate() {
  document.getElementById('report-date').value = todayISO();
}

function setTodayBadge() {
  const el = document.getElementById('today-badge');
  if (!el) return;
  const d = new Date();
  el.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts + (ts.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ─── Tabs ────────────────────────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      if (tab === 'reports') loadReports();
    });
  });
}

/* ─── Jobs ────────────────────────────────────────────────────────────────── */
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error('Failed to load jobs');
    jobs = await res.json();
  } catch (e) {
    showToast('Could not load job list.', 'error');
  }
}

function populateJobDropdown(id, includeAll = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const first = el.options[0];
  el.innerHTML = '';
  el.appendChild(first);
  jobs.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${j.job_number} — ${j.job_name}`;
    el.appendChild(opt);
  });
}

/* ─── Submit Report ───────────────────────────────────────────────────────── */
async function handleSubmit(e) {
  e.preventDefault();

  const fields = {
    tech_name:    document.getElementById('tech-name').value.trim(),
    job_id:       document.getElementById('job-select').value,
    report_date:  document.getElementById('report-date').value,
    hours_worked: document.getElementById('hours-worked').value,
    notes:        document.getElementById('notes').value.trim(),
  };

  // Validate
  let valid = true;
  ['tech-name', 'job-select', 'report-date', 'notes'].forEach(id => {
    const el = document.getElementById(id);
    const val = el.value.trim();
    if (!val) {
      el.classList.add('error');
      valid = false;
    } else {
      el.classList.remove('error');
    }
  });
  if (!valid) { showToast('Please fill in all required fields.', 'error'); return; }

  const payload = {
    tech_name:   fields.tech_name,
    job_id:      fields.job_id,
    report_date: fields.report_date,
    notes:       fields.notes,
  };
  if (fields.hours_worked) payload.hours_worked = fields.hours_worked;

  const submitBtn = document.querySelector('#report-form .btn-primary');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');
    clearForm();
    showToast('Report submitted successfully!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to submit report.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Submit Report`;
  }
}

function clearForm() {
  document.getElementById('report-form').reset();
  setTodayDate();
  document.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
}

/* ─── View Reports ────────────────────────────────────────────────────────── */
async function loadReports() {
  const container = document.getElementById('reports-container');
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading reports…</span></div>`;

  const params = new URLSearchParams();
  const tech  = document.getElementById('filter-tech')?.value.trim();
  const date  = document.getElementById('filter-date')?.value;
  const jobId = document.getElementById('filter-job')?.value;
  if (tech)  params.set('tech', tech);
  if (date)  params.set('date', date);
  if (jobId) params.set('job_id', jobId);

  try {
    const res = await fetch('/api/reports?' + params.toString());
    if (!res.ok) throw new Error('Failed to load reports');
    const reports = await res.json();
    renderReports(reports, container);
  } catch (err) {
    container.innerHTML = `
      <div class="error-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>
        <span>Could not load reports. Please try again.</span>
      </div>`;
  }
}

function renderReports(reports, container) {
  if (reports.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
        <span>No reports found. Try adjusting your filters.</span>
      </div>`;
    return;
  }

  container.innerHTML = '';
  reports.forEach(r => {
    const card = document.createElement('div');
    card.className = 'report-card';
    card.innerHTML = `
      <div class="report-card-header">
        <div>
          <div class="report-meta">
            <span class="report-tech-name">${escHtml(r.tech_name)}</span>
            <span class="tag tag-green">${escHtml(formatDate(r.report_date))}</span>
            ${r.hours_worked != null ? `<span class="tag tag-gray">${r.hours_worked} hrs</span>` : ''}
          </div>
          <div class="report-job">${escHtml(r.job_number)} — ${escHtml(r.job_name)}</div>
        </div>
      </div>
      <div class="report-notes">${escHtml(r.notes)}</div>
      <div class="report-card-footer">
        <span class="report-timestamp">Submitted ${formatTimestamp(r.created_at)}</span>
        <button class="btn btn-danger" data-id="${r.id}">Delete</button>
      </div>
    `;
    card.querySelector('.btn-danger').addEventListener('click', () => deleteReport(r.id, card));
    container.appendChild(card);
  });
}

async function deleteReport(id, cardEl) {
  if (!confirm('Delete this report? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    cardEl.style.opacity = '0';
    cardEl.style.transition = 'opacity .2s';
    setTimeout(() => cardEl.remove(), 200);
    showToast('Report deleted.', 'success');
  } catch {
    showToast('Could not delete report.', 'error');
  }
}

function clearFilters() {
  document.getElementById('filter-tech').value = '';
  document.getElementById('filter-date').value = '';
  document.getElementById('filter-job').value = '';
  loadReports();
}

/* ─── Toast ───────────────────────────────────────────────────────────────── */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon = type === 'success'
    ? `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`
    : `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;

  toast.innerHTML = icon + escHtml(message);
  toast.className = `toast toast-${type} show`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

/* ─── Utils ───────────────────────────────────────────────────────────────── */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
