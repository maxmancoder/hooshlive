(() => {
  const state = {
    view: { type: 'all', folderId: null },
    sources: [],
    folders: [],
    news: [],
    search: '',
    loading: false,
  };

  const els = {
    refreshBtn: document.getElementById('refreshBtn'),
    sourceForm: document.getElementById('sourceForm'),
    sourceType: document.getElementById('sourceType'),
    sourceName: document.getElementById('sourceName'),
    sourceValue: document.getElementById('sourceValue'),
    sourceValueLabel: document.getElementById('sourceValueLabel'),
    sourceHelp: document.getElementById('sourceHelp'),
    sourcesList: document.getElementById('sourcesList'),
    foldersNav: document.getElementById('foldersNav'),
    newsList: document.getElementById('newsList'),
    feedTitle: document.getElementById('feedTitle'),
    feedMeta: document.getElementById('feedMeta'),
    folderActions: document.getElementById('folderActions'),
    statusBar: document.getElementById('statusBar'),
    searchInput: document.getElementById('searchInput'),
    countAll: document.getElementById('countAll'),
    countPinned: document.getElementById('countPinned'),
    newFolderBtn: document.getElementById('newFolderBtn'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    modalTitle: document.getElementById('modalTitle'),
    modalClose: document.getElementById('modalClose'),
    folderForm: document.getElementById('folderForm'),
    folderId: document.getElementById('folderId'),
    folderName: document.getElementById('folderName'),
    folderKeywords: document.getElementById('folderKeywords'),
    folderSourcesList: document.getElementById('folderSourcesList'),
    folderCancel: document.getElementById('folderCancel'),
    toast: document.getElementById('toast'),
    newsItemTemplate: document.getElementById('newsItemTemplate'),
    previewBackdrop: document.getElementById('previewBackdrop'),
    previewTitle: document.getElementById('previewTitle'),
    previewClose: document.getElementById('previewClose'),
    previewSource: document.getElementById('previewSource'),
    previewUrl: document.getElementById('previewUrl'),
    previewOpenTab: document.getElementById('previewOpenTab'),
    previewCopy: document.getElementById('previewCopy'),
    previewFrame: document.getElementById('previewFrame'),
    previewEmbed: document.getElementById('previewEmbed'),
  };

  const sourceTypeMeta = {
    telegram: {
      label: 'شناسه کانال تلگرام',
      placeholder: '@channel یا https://t.me/channel',
      help: 'برای تلگرام: نام کاربری یا لینک عمومی کانال را وارد کنید (مثلاً @durov).',
    },
    youtube: {
      label: 'کانال یوتیوب',
      placeholder: 'https://www.youtube.com/@handle یا آدرس کانال',
      help: 'لینک کانال، هندل (@handle) یا آدرس feed کانال یوتیوب را وارد کنید.',
    },
    rss: {
      label: 'آدرس فید RSS / سایت',
      placeholder: 'https://example.com/feed.xml',
      help: 'آدرس کامل فید RSS یا Atom سایت/وبلاگ/خبرگزاری را وارد کنید.',
    },
  };

  function showToast(message, type = 'info') {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (type ? ` toast-${type}` : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2600);
  }

  function setStatus(message) {
    els.statusBar.textContent = message || '';
  }

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

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat('fa-IR', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  function sourceConfigSummary(source) {
    let cfg = {};
    try { cfg = typeof source.config === 'string' ? JSON.parse(source.config) : (source.config || {}); } catch {}
    if (source.type === 'telegram') return cfg.username || cfg.url || cfg.channel || '';
    if (source.type === 'youtube') return cfg.url || cfg.channel || cfg.handle || '';
    if (source.type === 'rss') return cfg.url || '';
    return '';
  }

  function parseFolderSourceIds(folder) {
    const raw = folder && folder.source_ids;
    let arr = [];
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === 'string') {
      try { arr = JSON.parse(raw); } catch { arr = []; }
    }
    if (!Array.isArray(arr)) return [];
    return arr.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0);
  }

  function getSelectedFolderSourceIds() {
    if (!els.folderSourcesList) return [];
    return Array.from(els.folderSourcesList.querySelectorAll('input[type="checkbox"]:checked'))
      .map(el => parseInt(el.value, 10))
      .filter(x => Number.isInteger(x) && x > 0);
  }

  function renderFolderSourcesSelector(selectedIds = []) {
    const selected = new Set((selectedIds || []).map(x => Number(x)));
    if (!state.sources.length) {
      els.folderSourcesList.className = 'folder-sources-list empty';
      els.folderSourcesList.innerHTML = '<div>هنوز منبعی تعریف نشده است. می‌توانید فقط با کلمات کلیدی فیلتر کنید.</div>';
      return;
    }
    els.folderSourcesList.className = 'folder-sources-list';
    els.folderSourcesList.innerHTML = state.sources.map(s => {
      const checked = selected.has(s.id) ? 'checked' : '';
      return `<label class="source-check">
        <input type="checkbox" value="${s.id}" ${checked} />
        <span class="source-check-name">${escapeHtml(s.name)}</span>
        <span class="source-check-meta">(${escapeHtml(typeLabel(s.type))})</span>
      </label>`;
    }).join('');
  }

  function typeLabel(type) {
    if (type === 'telegram') return 'تلگرام';
    if (type === 'youtube') return 'یوتیوب';
    if (type === 'rss') return 'RSS';
    return type;
  }

  function updateSourceFormMeta() {
    const meta = sourceTypeMeta[els.sourceType.value] || sourceTypeMeta.rss;
    els.sourceValueLabel.textContent = meta.label;
    els.sourceValue.placeholder = meta.placeholder;
    els.sourceHelp.textContent = meta.help;
  }

  function renderSources() {
    if (!state.sources.length) {
      els.sourcesList.innerHTML = `<div class="empty-state" style="padding:24px 12px; border:1px dashed var(--border); border-radius:12px; margin-top:4px;">
        <h3>هنوز منبعی اضافه نشده است</h3>
        <p>از فرم بالا یک کانال تلگرام، کانال یوتیوب یا فید RSS اضافه کنید.</p>
      </div>`;
      return;
    }
    els.sourcesList.innerHTML = state.sources.map(s => {
      const summary = sourceConfigSummary(s);
      const enabled = !!s.enabled;
      return `<div class="source-item" data-id="${s.id}">
        <div class="source-info">
          <div class="source-name-row">
            <span class="source-name">${escapeHtml(s.name)}</span>
            <span class="badge">${escapeHtml(typeLabel(s.type))}</span>
            <span class="badge ${enabled ? '' : 'off'}">${enabled ? 'فعال' : 'غیرفعال'}</span>
          </div>
          <div class="source-meta" title="${escapeHtml(summary)}">${escapeHtml(summary || '—')}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-secondary btn-small" data-action="fetch-source" data-id="${s.id}">دریافت</button>
          <button class="btn btn-ghost btn-small" data-action="toggle-source" data-id="${s.id}" data-enabled="${enabled ? '1' : '0'}">${enabled ? 'غیرفعال کردن' : 'فعال کردن'}</button>
          <button class="btn btn-ghost btn-small btn-danger" data-action="delete-source" data-id="${s.id}">حذف</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderFoldersNav() {
    if (!state.folders.length) {
      els.foldersNav.innerHTML = `<div class="muted small" style="padding:6px 8px;">پوشه‌ای ساخته نشده است.</div>`;
      return;
    }
    els.foldersNav.innerHTML = state.folders.map(f => {
      const active = state.view.type === 'folder' && state.view.folderId === f.id;
      return `<div class="folder-nav-row">
        <button class="nav-item ${active ? 'active' : ''}" data-view="folder" data-folder-id="${f.id}" type="button" title="${escapeHtml(f.keywords || '')}">
          <span>${escapeHtml(f.name)}</span>
        </button>
        <div class="folder-mini-actions">
          <button class="mini-btn" data-action="edit-folder" data-id="${f.id}" title="ویرایش">✎</button>
          <button class="mini-btn" data-action="delete-folder" data-id="${f.id}" title="حذف">🗑</button>
        </div>
      </div>`;
    }).join('');
  }

  function setActiveNav() {
    document.querySelectorAll('.sidebar .nav-item[data-view="all"], .sidebar .nav-item[data-view="pinned"]').forEach(btn => {
      btn.classList.toggle('active', state.view.type === btn.dataset.view);
    });
    document.querySelectorAll('.folders-nav .nav-item[data-view="folder"]').forEach(btn => {
      const id = Number(btn.dataset.folderId);
      btn.classList.toggle('active', state.view.type === 'folder' && state.view.folderId === id);
    });
  }

  function currentFolder() {
    if (state.view.type !== 'folder') return null;
    return state.folders.find(f => f.id === state.view.folderId) || null;
  }

  function folderFilterDescription(folder) {
    const parts = [];
    const sourceIds = parseFolderSourceIds(folder);
    if (sourceIds.length) {
      const names = sourceIds.map(id => {
        const s = state.sources.find(x => x.id === id);
        return s ? s.name : `منبع #${id}`;
      });
      parts.push(`منابع: ${names.join('، ')}`);
    }
    const keywords = String(folder.keywords || '').trim();
    if (keywords) {
      parts.push(`کلمات کلیدی: ${keywords}`);
    }
    if (!parts.length) return 'بدون فیلتر فعال (این پوشه خالی خواهد بود).';
    return `فیلتر پوشه — ${parts.join(' | ')}`;
  }

  function updateFeedHeader(total = null) {
    const folder = currentFolder();
    if (state.view.type === 'all') {
      els.feedTitle.textContent = 'همه خبرها';
      els.feedMeta.textContent = 'جدیدترین خبرها از همه منابع (مرتب‌شده بر اساس تاریخ انتشار/دریافت)';
    } else if (state.view.type === 'pinned') {
      els.feedTitle.textContent = 'پین‌شده‌ها';
      els.feedMeta.textContent = 'خبرهایی که برای دسترسی سریع پین کرده‌اید';
    } else if (folder) {
      els.feedTitle.textContent = folder.name;
      els.feedMeta.textContent = folderFilterDescription(folder);
    } else {
      els.feedTitle.textContent = 'پوشه';
      els.feedMeta.textContent = 'این پوشه پیدا نشد.';
    }

    if (folder) {
      els.folderActions.classList.remove('hidden');
      els.folderActions.innerHTML = `
        <button class="btn btn-secondary btn-small" data-action="edit-current-folder">ویرایش پوشه</button>
        <button class="btn btn-ghost btn-small btn-danger" data-action="delete-current-folder">حذف پوشه</button>
      `;
    } else {
      els.folderActions.classList.add('hidden');
      els.folderActions.innerHTML = '';
    }

    if (typeof total === 'number') {
      setStatus(`${total} خبر نمایش داده می‌شود.`);
    }
  }

  function renderNews() {
    updateFeedHeader(state.news.length);
    if (!state.news.length) {
      let msg = 'خبری برای نمایش وجود ندارد.';
      if (state.view.type === 'pinned') msg = 'هنوز خبری پین نشده است.';
      else if (state.view.type === 'folder') msg = 'خبری مطابق فیلتر این پوشه پیدا نشد.';
      else if (!state.sources.length) msg = 'ابتدا یک یا چند منبع خبری اضافه کنید، سپس خبرها دریافت می‌شوند.';
      els.newsList.innerHTML = `<div class="empty-state"><h3>موردی یافت نشد</h3><p>${escapeHtml(msg)}</p></div>`;
      return;
    }

    els.newsList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const item of state.news) {
      const node = els.newsItemTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = item.id;
      const dateEl = node.querySelector('.news-date');
      const srcEl = node.querySelector('.news-source');
      const titleEl = node.querySelector('.news-title');
      const pinBtn = node.querySelector('.pin-btn');
      const copyBtn = node.querySelector('.copy-btn');

      const displayDate = item.published_at || item.fetched_at;
      dateEl.textContent = formatDate(displayDate);
      dateEl.setAttribute('datetime', displayDate || '');
      dateEl.title = displayDate || '';
      const sourceText = item.source_name ? `${item.source_name} (${typeLabel(item.source_type)})` : 'منبع نامشخص';
      srcEl.textContent = sourceText;

      titleEl.textContent = item.title || 'بدون عنوان';
      titleEl.href = item.link || '#';
      titleEl.title = item.title || item.link || '';
      titleEl.dataset.link = item.link || '';
      titleEl.dataset.title = item.title || 'بدون عنوان';
      titleEl.dataset.sourceText = sourceText;

      if (item.pinned) {
        pinBtn.classList.add('active');
        pinBtn.textContent = 'پین‌شده';
        pinBtn.title = 'برداشتن پین';
      } else {
        pinBtn.classList.remove('active');
        pinBtn.textContent = 'پین';
        pinBtn.title = 'پین کردن';
      }
      pinBtn.dataset.id = item.id;
      pinBtn.dataset.pinned = item.pinned ? '1' : '0';
      copyBtn.dataset.link = item.link || '';

      frag.appendChild(node);
    }
    els.newsList.appendChild(frag);
  }

  async function loadCounts() {
    try {
      const [allRes, pinnedRes] = await Promise.all([
        api('/api/news?limit=1'),
        api('/api/news?pinned=1&limit=1'),
      ]);
      els.countAll.textContent = String(allRes.total ?? 0);
      els.countPinned.textContent = String(pinnedRes.total ?? 0);
    } catch (e) {
      // non-fatal
    }
  }

  async function loadSources() {
    const data = await api('/api/sources');
    state.sources = data.sources || [];
    renderSources();
  }

  async function loadFolders() {
    const data = await api('/api/folders');
    state.folders = data.folders || [];
    // if current folder deleted, fallback to all
    if (state.view.type === 'folder' && !state.folders.some(f => f.id === state.view.folderId)) {
      state.view = { type: 'all', folderId: null };
    }
    renderFoldersNav();
    setActiveNav();
  }

  async function loadNews() {
    state.loading = true;
    setStatus('در حال بارگذاری خبرها...');
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
      setStatus('خطا در بارگذاری خبرها: ' + e.message);
      els.newsList.innerHTML = `<div class="empty-state"><h3>خطا</h3><p>${escapeHtml(e.message)}</p></div>`;
    } finally {
      state.loading = false;
    }
  }

  async function refreshAllData(fetchRemote = false) {
    try {
      if (fetchRemote) {
        setStatus('در حال دریافت خبرهای جدید از منابع...');
        els.refreshBtn.disabled = true;
        const res = await api('/api/fetch', { method: 'POST', body: '{}' });
        if (res && res.skipped) showToast('یک دریافت دیگر در حال انجام است.');
        else showToast('به‌روزرسانی خبرها انجام شد.');
      }
      await Promise.all([loadSources(), loadFolders()]);
      await loadNews();
      await loadCounts();
    } catch (e) {
      showToast(e.message || 'خطا در به‌روزرسانی');
      setStatus(e.message);
    } finally {
      els.refreshBtn.disabled = false;
    }
  }

  function openFolderModal(folder = null) {
    els.folderId.value = folder ? folder.id : '';
    els.folderName.value = folder ? folder.name : '';
    els.folderKeywords.value = folder ? (folder.keywords || '') : '';
    renderFolderSourcesSelector(folder ? parseFolderSourceIds(folder) : []);
    els.modalTitle.textContent = folder ? 'ویرایش پوشه' : 'پوشه جدید';
    els.modalBackdrop.classList.remove('hidden');
    els.modalBackdrop.setAttribute('aria-hidden', 'false');
    setTimeout(() => els.folderName.focus(), 0);
  }

  function closeFolderModal() {
    els.modalBackdrop.classList.add('hidden');
    els.modalBackdrop.setAttribute('aria-hidden', 'true');
    els.folderForm.reset();
    els.folderId.value = '';
  }

  let currentPreviewLink = '';

  function parseTelegramPost(link) {
    try {
      const u = new URL(link);
      if (u.hostname !== 't.me' && u.hostname !== 'telegram.me' && u.hostname !== 'www.t.me') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      // expect /<channel>/<postId> (public post). ignore /s/<channel> pages etc.
      if (parts.length >= 2 && parts[0] !== 's' && /^\d+$/.test(parts[1])) {
        return `${parts[0]}/${parts[1]}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  function clearPreviewContent() {
    if (els.previewFrame) {
      els.previewFrame.src = 'about:blank';
      els.previewFrame.classList.remove('hidden');
    }
    if (els.previewEmbed) {
      els.previewEmbed.innerHTML = '';
      els.previewEmbed.classList.add('hidden');
    }
  }

  function openPreview(item) {
    if (!item || !item.link) return;
    currentPreviewLink = item.link;
    const title = item.title || 'بدون عنوان';
    const sourceText = item.sourceText
      || (item.source_name ? `${item.source_name} (${typeLabel(item.source_type)})` : 'منبع نامشخص');

    els.previewTitle.textContent = title;
    els.previewSource.textContent = sourceText;
    els.previewUrl.textContent = item.link;
    els.previewUrl.title = item.link;

    clearPreviewContent();

    const tgPost = parseTelegramPost(item.link);
    if (tgPost && els.previewEmbed) {
      // Render Telegram post via official widget (t.me pages block plain iframes)
      els.previewFrame.classList.add('hidden');
      els.previewEmbed.classList.remove('hidden');
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.setAttribute('data-telegram-post', tgPost);
      script.setAttribute('data-width', '100%');
      script.setAttribute('data-dark', '1');
      els.previewEmbed.appendChild(script);
    } else {
      // Default: load in iframe. Some sites may block embedding (X-Frame-Options/CSP).
      els.previewFrame.classList.remove('hidden');
      if (els.previewEmbed) els.previewEmbed.classList.add('hidden');
      const link = item.link;
      setTimeout(() => { if (currentPreviewLink === link) els.previewFrame.src = link; }, 0);
    }

    els.previewBackdrop.classList.remove('hidden');
    els.previewBackdrop.setAttribute('aria-hidden', 'false');
  }

  function closePreview() {
    els.previewBackdrop.classList.add('hidden');
    els.previewBackdrop.setAttribute('aria-hidden', 'true');
    clearPreviewContent();
    currentPreviewLink = '';
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function bindEvents() {
    els.sourceType.addEventListener('change', updateSourceFormMeta);

    els.sourceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = els.sourceType.value;
      const name = els.sourceName.value.trim();
      const value = els.sourceValue.value.trim();
      if (!name || !value) return;
      const config = {};
      if (type === 'telegram') config.username = value;
      else if (type === 'youtube') config.url = value;
      else config.url = value;
      try {
        const btn = els.sourceForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        await api('/api/sources', { method: 'POST', body: JSON.stringify({ type, name, config }) });
        els.sourceForm.reset();
        els.sourceType.value = type;
        updateSourceFormMeta();
        showToast('منبع اضافه شد و دریافت خبرها آغاز شد.');
        await loadSources();
        // news may arrive shortly after background fetch
        setTimeout(() => { loadNews(); loadCounts(); }, 2500);
        setTimeout(() => { loadNews(); loadCounts(); }, 7000);
      } catch (err) {
        showToast(err.message || 'خطا در افزودن منبع');
      } finally {
        els.sourceForm.querySelector('button[type="submit"]').disabled = false;
      }
    });

    els.sourcesList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = Number(btn.dataset.id);
      try {
        if (action === 'delete-source') {
          if (!confirm('این منبع حذف شود؟ خبرهای ذخیره‌شده باقی می‌مانند.')) return;
          await api(`/api/sources/${id}`, { method: 'DELETE' });
          showToast('منبع حذف شد.');
          await loadSources();
        } else if (action === 'toggle-source') {
          const enabled = btn.dataset.enabled !== '1';
          await api(`/api/sources/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
          await loadSources();
          showToast(enabled ? 'منبع فعال شد.' : 'منبع غیرفعال شد.');
        } else if (action === 'fetch-source') {
          btn.disabled = true;
          setStatus('در حال دریافت خبر از این منبع...');
          const res = await api(`/api/sources/${id}/fetch`, { method: 'POST', body: '{}' });
          const r = res.result || {};
          if (r.error) showToast('خطا در دریافت: ' + r.error);
          else showToast(`دریافت انجام شد: ${r.inserted || 0} خبر جدید`);
          await loadNews();
          await loadCounts();
        }
      } catch (err) {
        showToast(err.message || 'خطا');
      } finally {
        btn.disabled = false;
      }
    });

    document.querySelectorAll('.sidebar .nav-item[data-view="all"], .sidebar .nav-item[data-view="pinned"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.view = { type: btn.dataset.view, folderId: null };
        setActiveNav();
        renderFoldersNav();
        await loadNews();
      });
    });

    els.foldersNav.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-action="edit-folder"]');
      const delBtn = e.target.closest('[data-action="delete-folder"]');
      if (editBtn) {
        const folder = state.folders.find(f => f.id === Number(editBtn.dataset.id));
        if (folder) openFolderModal(folder);
        return;
      }
      if (delBtn) {
        const id = Number(delBtn.dataset.id);
        if (!confirm('این پوشه حذف شود؟')) return;
        try {
          await api(`/api/folders/${id}`, { method: 'DELETE' });
          showToast('پوشه حذف شد.');
          await loadFolders();
          await loadNews();
        } catch (err) { showToast(err.message); }
        return;
      }
      const nav = e.target.closest('.nav-item[data-view="folder"]');
      if (nav) {
        state.view = { type: 'folder', folderId: Number(nav.dataset.folderId) };
        setActiveNav();
        renderFoldersNav();
        await loadNews();
      }
    });

    els.folderActions.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const folder = currentFolder();
      if (!folder) return;
      if (btn.dataset.action === 'edit-current-folder') openFolderModal(folder);
      if (btn.dataset.action === 'delete-current-folder') {
        if (!confirm('این پوشه حذف شود؟')) return;
        try {
          await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
          showToast('پوشه حذف شد.');
          await loadFolders();
          await loadNews();
        } catch (err) { showToast(err.message); }
      }
    });

    els.newsList.addEventListener('click', async (e) => {
      const titleLink = e.target.closest('.news-title');
      const pinBtn = e.target.closest('.pin-btn');
      const copyBtn = e.target.closest('.copy-btn');

      if (titleLink) {
        e.preventDefault();
        const link = titleLink.dataset.link || titleLink.getAttribute('href') || '';
        if (!link || link === '#') return;
        openPreview({
          link,
          title: titleLink.dataset.title || titleLink.textContent || 'بدون عنوان',
          sourceText: titleLink.dataset.sourceText || '',
        });
        return;
      }

      if (pinBtn) {
        const id = Number(pinBtn.dataset.id);
        const pinned = pinBtn.dataset.pinned !== '1';
        try {
          pinBtn.disabled = true;
          await api(`/api/news/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
          showToast(pinned ? 'خبر پین شد.' : 'پین خبر برداشته شد.');
          await loadNews();
          await loadCounts();
        } catch (err) { showToast(err.message); }
        finally { pinBtn.disabled = false; }
        return;
      }
      if (copyBtn) {
        const link = copyBtn.dataset.link || '';
        const ok = await copyToClipboard(link);
        if (ok) {
          const old = copyBtn.textContent;
          copyBtn.textContent = 'کپی شد';
          showToast('لینک کپی شد.');
          setTimeout(() => { copyBtn.textContent = old; }, 1200);
        } else {
          showToast('کپی لینک انجام نشد.');
        }
      }
    });

    els.refreshBtn.addEventListener('click', () => refreshAllData(true));

    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = els.searchInput.value.trim();
        loadNews();
      }, 250);
    });

    els.newFolderBtn.addEventListener('click', () => openFolderModal(null));
    els.modalClose.addEventListener('click', closeFolderModal);
    els.folderCancel.addEventListener('click', closeFolderModal);
    els.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.modalBackdrop) closeFolderModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (els.previewBackdrop && !els.previewBackdrop.classList.contains('hidden')) {
          closePreview();
          return;
        }
        if (!els.modalBackdrop.classList.contains('hidden')) closeFolderModal();
      }
    });

    if (els.previewClose) els.previewClose.addEventListener('click', closePreview);
    if (els.previewBackdrop) {
      els.previewBackdrop.addEventListener('click', (e) => {
        if (e.target === els.previewBackdrop) closePreview();
      });
    }
    if (els.previewOpenTab) {
      els.previewOpenTab.addEventListener('click', () => {
        if (!currentPreviewLink) return;
        window.open(currentPreviewLink, '_blank', 'noopener,noreferrer');
      });
    }
    if (els.previewCopy) {
      els.previewCopy.addEventListener('click', async () => {
        if (!currentPreviewLink) return;
        const ok = await copyToClipboard(currentPreviewLink);
        showToast(ok ? 'لینک کپی شد.' : 'کپی لینک انجام نشد.');
      });
    }

    els.folderForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = els.folderId.value ? Number(els.folderId.value) : null;
      const name = els.folderName.value.trim();
      const keywords = els.folderKeywords.value.trim();
      const source_ids = getSelectedFolderSourceIds();
      if (!name) return;
      try {
        if (id) {
          await api(`/api/folders/${id}`, { method: 'PUT', body: JSON.stringify({ name, keywords, source_ids }) });
          showToast('پوشه ویرایش شد.');
        } else {
          const res = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name, keywords, source_ids }) });
          showToast('پوشه ایجاد شد.');
          if (res && res.folder) {
            state.view = { type: 'folder', folderId: res.folder.id };
          }
        }
        closeFolderModal();
        await loadFolders();
        await loadNews();
      } catch (err) {
        showToast(err.message || 'خطا در ذخیره پوشه');
      }
    });
  }

  async function init() {
    updateSourceFormMeta();
    bindEvents();
    setStatus('در حال آماده‌سازی...');
    try {
      await Promise.all([loadSources(), loadFolders()]);
      await loadNews();
      await loadCounts();
    } catch (e) {
      setStatus('خطا در اتصال به سرور: ' + e.message);
    }
  }

  init();
})();
