/* ─── State ───────────────────────────────────────────────────────────────── */
let currentUser = null;
let jobs = [];
let toastTimer = null;
let selectedPhotos = [];   // File objects staged for upload
let photosEnabled = false;

/* ─── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentUser();
  applyRoleUI();
  setTodayDate();
  setTodayBadge();
  setupTabs();
  setupLogout();

  await Promise.all([loadJobs(), loadConfig()]);
  populateJobDropdown('job-select');
  populateJobDropdown('filter-job', true);

  document.getElementById('report-form').addEventListener('submit', handleSubmit);
  document.getElementById('clear-btn').addEventListener('click', clearForm);
  document.getElementById('filter-btn').addEventListener('click', loadReports);
  document.getElementById('clear-filter-btn').addEventListener('click', clearFilters);

  setupPhotoInput();
  if (currentUser?.role === 'admin') setupAdmin();
});

/* ─── Auth ────────────────────────────────────────────────────────────────── */
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) { window.location.href = '/login'; return; }
    currentUser = await res.json();
  } catch {
    window.location.href = '/login';
  }
}

function applyRoleUI() {
  if (!currentUser) return;
  document.getElementById('header-user-name').textContent = currentUser.name;
  document.getElementById('tech-name-display').textContent = currentUser.name;

  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.tech-only').forEach(el => el.classList.add('hidden'));
  }
}

function setupLogout() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

/* ─── Config ──────────────────────────────────────────────────────────────── */
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    photosEnabled = cfg.photosEnabled;
    if (photosEnabled) document.getElementById('photo-field').style.display = '';
  } catch { /* photos just stay hidden */ }
}

/* ─── Photo input ─────────────────────────────────────────────────────────── */
function setupPhotoInput() {
  const input = document.getElementById('photo-input');
  const drop  = document.getElementById('photo-drop');
  if (!input) return;

  input.addEventListener('change', () => addPhotos(Array.from(input.files)));

  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    addPhotos(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
  });
}

function addPhotos(files) {
  const remaining = 5 - selectedPhotos.length;
  if (remaining <= 0) { showToast('Maximum 5 photos per report.', 'error'); return; }
  const toAdd = files.slice(0, remaining);
  selectedPhotos.push(...toAdd);
  renderPhotoPreviews();
}

function renderPhotoPreviews() {
  const container = document.getElementById('photo-previews');
  container.innerHTML = '';
  selectedPhotos.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const wrap = document.createElement('div');
    wrap.className = 'photo-preview-item';
    wrap.innerHTML = `
      <img src="${url}" alt="Preview" />
      <button class="photo-preview-remove" data-index="${i}" title="Remove">&times;</button>
    `;
    wrap.querySelector('button').addEventListener('click', () => {
      selectedPhotos.splice(i, 1);
      renderPhotoPreviews();
    });
    container.appendChild(wrap);
  });
}

/* ─── Date helpers ────────────────────────────────────────────────────────── */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function setTodayDate() {
  document.getElementById('report-date').value = todayISO();
}

function setTodayBadge() {
  const el = document.getElementById('today-badge');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
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
      if (tab === 'admin')   loadAdminData();
    });
  });
}

/* ─── Jobs ────────────────────────────────────────────────────────────────── */
async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error();
    jobs = await res.json();
  } catch {
    showToast('Could not load job list.', 'error');
  }
}

function populateJobDropdown(id, includeAll = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const placeholder = el.options[0].cloneNode(true);
  el.innerHTML = '';
  el.appendChild(placeholder);
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

  const job_id      = document.getElementById('job-select').value;
  const report_date = document.getElementById('report-date').value;
  const notes       = document.getElementById('notes').value.trim();

  let valid = true;
  [['job-select', job_id], ['report-date', report_date], ['notes', notes]].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!val) { el.classList.add('error'); valid = false; }
    else       el.classList.remove('error');
  });
  if (!valid) { showToast('Please fill in all required fields.', 'error'); return; }

  const payload = { job_id, report_date, notes };

  const btn = document.querySelector('#report-form .btn-primary');
  btn.disabled = true;
  btn.innerHTML = 'Submitting…';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');

    // Upload photos if any were selected
    if (photosEnabled && selectedPhotos.length > 0) {
      btn.innerHTML = `Uploading photos…`;
      const fd = new FormData();
      selectedPhotos.forEach(f => fd.append('photos', f));
      const photoRes = await fetch(`/api/reports/${data.id}/photos`, { method: 'POST', body: fd });
      if (!photoRes.ok) showToast('Report saved, but photo upload failed.', 'error');
    }

    clearForm();
    showToast('Report submitted successfully!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to submit report.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Submit Report`;
  }
}

function clearForm() {
  document.getElementById('report-form').reset();
  setTodayDate();
  selectedPhotos = [];
  renderPhotoPreviews();
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
    if (!res.ok) throw new Error();
    renderReports(await res.json(), container);
  } catch {
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
    const canDelete = currentUser?.role === 'admin';
    card.innerHTML = `
      <div class="report-card-header">
        <div>
          <div class="report-meta">
            <span class="report-tech-name">${escHtml(r.tech_name)}</span>
            <span class="tag tag-green">${escHtml(formatDate(r.report_date))}</span>
          </div>
          <div class="report-job">${escHtml(r.job_number)} — ${escHtml(r.job_name)}</div>
        </div>
      </div>
      <div class="report-notes">${escHtml(r.notes)}</div>
      ${renderPhotoGallery(r.photos)}
      <div class="report-card-footer">
        <span class="report-timestamp">Submitted ${formatTimestamp(r.created_at)}</span>
        ${canDelete ? `<button class="btn btn-danger" data-id="${r.id}">Delete</button>` : ''}
      </div>
    `;
    if (canDelete) {
      card.querySelector('.btn-danger').addEventListener('click', () => deleteReport(r.id, card));
    }
    container.appendChild(card);
  });
}

function renderPhotoGallery(photos) {
  if (!photos?.length) return '';
  const visible = photos.slice(0, 4);
  const extra   = photos.length - visible.length;
  const thumbs  = visible.map(p =>
    `<a class="report-photo-thumb" href="${escHtml(p.url)}" target="_blank" rel="noopener">
       <img src="${escHtml(p.thumb)}" alt="Job photo" loading="lazy" />
     </a>`
  ).join('');
  const more = extra > 0
    ? `<a class="photo-count-badge" href="${escHtml(photos[4].url)}" target="_blank" rel="noopener">+${extra} more</a>`
    : '';
  return `<div class="report-photo-gallery">${thumbs}${more}</div>`;
}

async function deleteReport(id, cardEl) {
  if (!confirm('Delete this report? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    cardEl.style.transition = 'opacity .2s';
    cardEl.style.opacity = '0';
    setTimeout(() => cardEl.remove(), 200);
    showToast('Report deleted.', 'success');
  } catch {
    showToast('Could not delete report.', 'error');
  }
}

function clearFilters() {
  const tech = document.getElementById('filter-tech');
  if (tech) tech.value = '';
  document.getElementById('filter-date').value = '';
  document.getElementById('filter-job').value = '';
  loadReports();
}

/* ─── Admin ───────────────────────────────────────────────────────────────── */
function setupAdmin() {
  document.getElementById('add-job-btn').addEventListener('click', addJob);
  document.getElementById('add-user-btn').addEventListener('click', addUser);
  document.getElementById('change-pw-btn').addEventListener('click', changePassword);
}

async function loadAdminData() {
  await Promise.all([loadAdminJobs(), loadAdminUsers()]);
}

async function loadAdminJobs() {
  const container = document.getElementById('jobs-list');
  container.innerHTML = `<div class="loading-state" style="padding:20px"><div class="spinner"></div></div>`;
  try {
    const res = await fetch('/api/jobs?all=true');
    const jobs = await res.json();
    if (!jobs.length) { container.innerHTML = '<p style="color:var(--gray-400);font-size:13px;padding:4px 0">No jobs yet.</p>'; return; }
    container.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Job #</th><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${jobs.map(j => `
            <tr>
              <td><strong>${escHtml(j.job_number)}</strong></td>
              <td>${escHtml(j.job_name)}</td>
              <td><span class="badge-role ${j.active ? 'badge-active' : 'badge-inactive'}">${j.active ? 'Active' : 'Inactive'}</span></td>
              <td class="action-btns">
                <button class="btn btn-ghost btn-sm" data-id="${j.id}" data-active="${j.active}">
                  ${j.active ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    container.querySelectorAll('[data-id][data-active]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active === '1' ? 0 : 1;
        await fetch(`/api/jobs/${btn.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: newActive }),
        });
        await loadAdminJobs();
        await loadJobs();
        populateJobDropdown('job-select');
        populateJobDropdown('filter-job', true);
      });
    });
  } catch {
    container.innerHTML = '<p style="color:#dc2626;font-size:13px">Failed to load jobs.</p>';
  }
}

async function addJob() {
  const num  = document.getElementById('new-job-number').value.trim();
  const name = document.getElementById('new-job-name').value.trim();
  if (!num || !name) { showToast('Job number and name are required.', 'error'); return; }
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_number: num, job_name: name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('new-job-number').value = '';
    document.getElementById('new-job-name').value = '';
    await loadAdminJobs();
    await loadJobs();
    populateJobDropdown('job-select');
    populateJobDropdown('filter-job', true);
    showToast('Job added.', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to add job.', 'error');
  }
}

async function loadAdminUsers() {
  const container = document.getElementById('users-list');
  container.innerHTML = `<div class="loading-state" style="padding:20px"><div class="spinner"></div></div>`;
  try {
    const res   = await fetch('/api/users');
    const users = await res.json();
    container.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td><strong>${escHtml(u.name)}</strong></td>
              <td>${escHtml(u.username)}</td>
              <td><span class="badge-role ${u.role === 'admin' ? 'badge-admin' : 'badge-tech'}">${u.role}</span></td>
              <td class="action-btns">
                ${u.id !== currentUser?.id ? `
                  <button class="btn btn-danger btn-sm" data-uid="${u.id}">Remove</button>
                ` : '<span style="font-size:12px;color:var(--gray-400)">You</span>'}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    container.querySelectorAll('[data-uid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Remove user? This cannot be undone.`)) return;
        await fetch(`/api/users/${btn.dataset.uid}`, { method: 'DELETE' });
        showToast('User removed.', 'success');
        loadAdminUsers();
      });
    });
  } catch {
    container.innerHTML = '<p style="color:#dc2626;font-size:13px">Failed to load users.</p>';
  }
}

async function addUser() {
  const name     = document.getElementById('new-user-name').value.trim();
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-user-password').value;
  const role     = document.getElementById('new-user-role').value;
  if (!name || !username || !password) { showToast('Name, username, and password are required.', 'error'); return; }
  if (password.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-username').value = '';
    document.getElementById('new-user-password').value = '';
    loadAdminUsers();
    showToast(`User "${name}" added.`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to add user.', 'error');
  }
}

async function changePassword() {
  const cur = document.getElementById('cur-password').value;
  const nw  = document.getElementById('new-password').value;
  if (!cur || !nw) { showToast('Both password fields are required.', 'error'); return; }
  try {
    const res = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: cur, new_password: nw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('cur-password').value = '';
    document.getElementById('new-password').value = '';
    showToast('Password changed.', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to change password.', 'error');
  }
}

/* ─── Toast ───────────────────────────────────────────────────────────────── */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon  = type === 'success'
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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
