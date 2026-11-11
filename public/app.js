(() => {
  /* =========================
     State
     ========================= */
  const state = {
    view: { type: 'all', folderId: null },
    sources: [],
    folders: [],
    news: [],
    search: '',
    loading: false,
  };

  const els = {
    time: document.getElementById('time'),
    date: document.getElementById('date'),
    refreshBtn: document.getElementById('refreshBtn'),
    searchInput: document.getElementById('searchInput'),
    sectionCount: document.getElementById('sectionCount'),
    newsList: document.getElementById('newsList'),
    sidebar: document.querySelector('.sidebar'),
    toast: document.querySelector('.toast'),
  };

  /* =========================
     Platform icons (Telegram / YouTube / RSS)
     ========================= */
  const platformCfg = {
    telegram: { name: 'Telegram', slug: 'telegram', color: '#3b82f6', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l8 3-1 10 10-8z"/></svg>' },
    youtube:  { name: 'YouTube', slug: 'youtube', color: '#ff0000', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>' },
    rss:      { name: 'RSS',     slug: 'rss',     color: '#f59e0b', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>' },
  };

  /* =========================
     Persian (Shamsi) date
     ========================= */
  function toJalali(gy, gm, gd) {
    const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const gy2 = gm > 2 ? gy + 1 : gy;
    let days = 355666 + (365 * gy) + ((gy2 + 3) / 4 | 0) - ((gy2 + 99) / 100 | 0) + ((gy2 + 399) / 400 | 0) + gd + g_d_m[gm - 1];
    let jy = -1595 + (33 * (days / 12053 | 0) | 0);
    days %= 12053;
    jy += 4 * (days / 1461 | 0);
    days %= 1461;
    if (days > 365) {
      jy += (days - 1) / 365 | 0;
      days = (days - 1) % 365;
    }
    const jm = days < 186 ? 1 + (days / 31 | 0) : 7 + ((days - 186) / 30 | 0);
    const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return [jy, jm, jd];
  }

  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  function toPersianDigits(n) {
    return String(n).replace(/\d/g, d => persianDigits[d]);
  }

  function formatShamsi(iso) {
    if (!iso) return { time: 'ـ:ـ', date: 'ـ/ـ/ـ' };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { time: iso, date: '' };
    const [jy, jm, jd] = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const h = (d.getUTCHours() + 3) % 24;
    const m = d.getUTCMinutes();
    const time = `${toPersianDigits(String(h).padStart(2, '0'))}:${toPersianDigits(String(m).padStart(2, '0'))}`;
    const date = `${toPersianDigits(jy)}/${toPersianDigits(String(jm).padStart(2, '0'))}/${toPersianDigits(String(jd).padStart(2, '0'))}`;
    return { time, date };
  }

  /* =========================
     Helpers
     ========================= */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && data.error) || `خطا (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function showToast(message, type = 'info') {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (type ? ` toast-${type}` : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2600);
  }

  /* =========================
     Render news list
     ========================= */
  function renderNews() {
    const list = els.newsList;
    list.innerHTML = '';

    const total = state.news.length;
    if (els.sectionCount) els.sectionCount.textContent = `${toPersianDigits(String(total))} خبر اخیر`;

    if (total === 0) {
      let msg = 'خبر وجود ندارد.';
      if (state.view.type === 'pinned') msg = 'خبر پین شده‌ای وجود ندارد.';
      else if (state.view.type === 'folder') msg = 'در این پوشه خبری وجود ندارد.';
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><h3>خبر موجود نیست</h3><p>${escapeHtml(msg)}</p></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of state.news) {
      const li = document.createElement('li');
      li.className = 'news-item';
      li.dataset.id = item.id;

      const dt = formatShamsi(item.published_at || item.fetched_at);
      const p = platformCfg[item.source_type] || platformCfg.rss;

      li.innerHTML = `
        <div class="time-badge">
          <span class="time">${dt.time}</span>
          <span class="date">${dt.date}</span>
        </div>
        <div class="platform-wrap">
          <span class="platform-icon" style="color:${p.color}">${p.svg}</span>
          <span class="platform-name">${p.name}</span>
          <span class="platform-slug">${p.slug}</span>
        </div>
        <div class="title-wrap">
          <a class="news-title" href="${escapeHtml(item.link || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || 'بدون عنوان')}</a>
        </div>
        <div class="item-actions">
          <button class="action-btn pin-btn" data-id="${item.id}" data-pinned="${item.pinned ? '1' : '0'}" title="${item.pinned ? 'پین را بردار' : 'پین کنید'}">
            <span class="pin-icon">📌</span>
          </button>
          <button class="action-btn copy-btn" data-link="${escapeHtml(item.link || '')}" title="کپی لینک">
            <span class="copy-icon">🔗</span>
          </button>
        </div>
      `;

      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  /* =========================
     API calls
     ========================= */
  async function loadNews() {
    state.loading = true;
    try {
      const params = new URLSearchParams();
      if (state.view.type === 'pinned') params.set('pinned', '1');
      if (state.view.type === 'folder' && state.view.folderId) params.set('folder_id', String(state.view.folderId));
      if (state.search) params.set('q', state.search);
      params.set('limit', '500');

      const data = await api('/api/news?' + params.toString());
      state.news = data.items || [];
      renderNews();
    } catch (e) {
      els.newsList.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>خطا در بارگذاری</h3><p>${escapeHtml(e.message)}</p></div>`;
    } finally {
      state.loading = false;
    }
  }

  async function loadSources() {
    try {
      const data = await api('/api/sources');
      state.sources = data.sources || [];
    } catch (e) {
      console.error(e);
    }
  }

  async function refreshNews() {
    els.refreshBtn.disabled = true;
    try {
      await api('/api/fetch', { method: 'POST', body: '{}' });
      showToast('خبرها بروزرسانی شدند.', 'success');
    } catch (e) {
      showToast(e.message || 'خطا در بروزرسانی', 'error');
    } finally {
      els.refreshBtn.disabled = false;
      await loadNews();
    }
  }

  async function togglePin(id, pinned) {
    try {
      await api(`/api/news/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
      await loadNews();
    } catch (e) {
      showToast(e.message || 'خطا در پین کردن', 'error');
    }
  }

  async function copyLink(link) {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      showToast('لینک کپی شد.', 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('لینک کپی شد.', 'success');
    }
  }

  /* =========================
     Event bindings
     ========================= */
  function bindEvents() {
    // Refresh
    els.refreshBtn.addEventListener('click', refreshNews);

    // Search
    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = els.searchInput.value.trim();
        loadNews();
      }, 250);
    });

    // News item clicks (pin / copy)
    els.newsList.addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('.pin-btn');
      const copyBtn = e.target.closest('.copy-btn');

      if (pinBtn) {
        const id = Number(pinBtn.dataset.id);
        const pinned = pinBtn.dataset.pinned !== '1';
        pinBtn.dataset.pinned = pinned ? '1' : '0';
        await togglePin(id, pinned);
        return;
      }

      if (copyBtn) {
        const link = copyBtn.dataset.link;
        await copyLink(link);
        return;
      }
    });

    // Sidebar navigation
    els.sidebar.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;

      if (item.dataset.view === 'all') {
        state.view = { type: 'all', folderId: null };
      } else if (item.dataset.view === 'pinned') {
        state.view = { type: 'pinned', folderId: null };
      } else if (item.dataset.folder) {
        // Map demo folder names to actual folder IDs from the API
        const folderName = item.dataset.folder;
        const folder = state.folders.find(f => f.name === folderName);
        state.view = { type: 'folder', folderId: folder ? folder.id : null };
      }

      // update active state
      document.querySelectorAll('.sidebar-item').forEach(it => it.classList.remove('active'));
      item.classList.add('active');

      loadNews();
    });
  }

  /* =========================
     Clock
     ========================= */
  function updateClock() {
    const now = new Date();
    const timeOpts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const dateOpts = { year: 'numeric', month: '2-digit', day: '2-digit' };
    els.time.textContent = new Intl.DateTimeFormat('fa-IR', timeOpts).format(now).replace(/\d/g, d => persianDigits[d]);
    els.date.textContent = new Intl.DateTimeFormat('fa-IR', dateOpts).format(now).replace(/\d/g, d => persianDigits[d]);
  }
  setInterval(updateClock, 1000);
  updateClock();

  /* =========================
     Init
     ========================= */
  async function init() {
    bindEvents();
    await Promise.all([loadSources(), loadNews()]);
  }

  init();
})();