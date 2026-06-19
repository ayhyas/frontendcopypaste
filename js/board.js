(() => {
  // ─── Session guard ─────────────────────────────────────────────────────────
  const token = localStorage.getItem('cs_token');
  const user  = JSON.parse(localStorage.getItem('cs_user') || 'null');
  if (!token || !user) { window.location.replace('index.html'); return; }

  // ─── State ─────────────────────────────────────────────────────────────────
  let clips       = [];
  let currentPage = 1;
  let totalPages  = 1;
  let socket      = null;
  let isModalOpen = false;

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const clipsGrid       = document.getElementById('clipsGrid');
  const emptyState      = document.getElementById('emptyState');
  const loadingState    = document.getElementById('loadingState');
  const loadMoreWrapper = document.getElementById('loadMoreWrapper');
  const loadMoreBtn     = document.getElementById('loadMoreBtn');
  const clipCountEl     = document.getElementById('clipCount');
  const modalOverlay    = document.getElementById('modalOverlay');
  const clipTextarea    = document.getElementById('clipTextarea');
  const imageOverlay    = document.getElementById('imageOverlay');
  const imageModalSrc   = document.getElementById('imageModalSrc');

  // ─── Bootstrap ─────────────────────────────────────────────────────────────
  initNavbar();
  connectSocket();
  loadClips();
  setupPaste();
  setupModal();
  setupLoadMore();
  setupImageModal();
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // ─── Navbar ────────────────────────────────────────────────────────────────
  function initNavbar() {
    const avatar = document.getElementById('navAvatar');
    avatar.textContent  = user.username[0].toUpperCase();
    avatar.style.background = getAvatarColor(user.username);
    document.getElementById('navUsername').textContent = user.username;
  }

  // ─── Socket.io ─────────────────────────────────────────────────────────────
  function connectSocket() {
    socket = io(CONFIG.API_URL, { auth: { token } });

    socket.on('connect', () => setConnectionStatus(true));
    socket.on('disconnect', () => setConnectionStatus(false));
    socket.on('connect_error', () => setConnectionStatus(false));

    socket.on('clip:new', ({ data }) => {
      if (clips.some((c) => c._id === data._id)) return;
      clips.unshift(data);
      prependClipCard(data, true);
      updateClipCount(clips.length);
    });

    socket.on('clip:deleted', ({ id }) => {
      clips = clips.filter((c) => c._id !== id);
      document.querySelector(`.clip-card[data-id="${id}"]`)?.remove();
      updateClipCount(clips.length);
      if (clips.length === 0) emptyState.style.display = 'flex';
    });
  }

  function setConnectionStatus(online) {
    const el   = document.getElementById('connectionStatus');
    const dot  = el.querySelector('.status-dot');
    const text = el.querySelector('.status-text');
    dot.className  = `status-dot ${online ? 'online' : 'offline'}`;
    text.textContent = online ? 'Live' : 'Reconnecting…';
  }

  // ─── Load clips ────────────────────────────────────────────────────────────
  async function loadClips(page = 1) {
    try {
      if (page === 1) loadingState.style.display = 'flex';
      const { data, pagination } = await api.clips.list(page);
      currentPage = pagination.page;
      totalPages  = pagination.pages;

      if (page === 1) {
        clips = data;
        renderAllClips();
      } else {
        clips = [...clips, ...data];
        data.forEach((clip) => prependClipCard(clip, false, true));
      }

      updateClipCount(pagination.total);
      loadMoreWrapper.style.display = pagination.hasMore ? 'flex' : 'none';
    } catch (err) {
      if (err.status === 401) return logout();
      showToast('Failed to load clips', 'error');
    } finally {
      loadingState.style.display = 'none';
    }
  }

  function renderAllClips() {
    clipsGrid.innerHTML = '';
    if (clips.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    clips.forEach((clip) => clipsGrid.appendChild(buildCard(clip)));
    Prism.highlightAllUnder(clipsGrid);
  }

  function prependClipCard(clip, animate = false, append = false) {
    emptyState.style.display = 'none';
    const card = buildCard(clip);
    if (animate) card.classList.add('clip-enter');
    if (append) {
      clipsGrid.appendChild(card);
    } else {
      clipsGrid.prepend(card);
    }
    Prism.highlightAllUnder(card);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('clip-enter-active')));
  }

  function updateClipCount(total) {
    clipCountEl.textContent = total > 0 ? `(${total})` : '';
  }

  // ─── Card builder ──────────────────────────────────────────────────────────
  function buildCard(clip) {
    const isOwn = clip.author === user.id || clip.authorName === user.username;
    const div = document.createElement('div');
    div.className = 'clip-card';
    div.dataset.id   = clip._id;
    div.dataset.type = clip.type;

    div.innerHTML = `
      <div class="clip-card-header">
        <div class="clip-meta">
          <span class="type-badge type-${clip.type}">${clip.type}</span>
          ${clip.language ? `<span class="lang-badge">${clip.language}</span>` : ''}
        </div>
        <time class="clip-time" datetime="${clip.createdAt}" title="${new Date(clip.createdAt).toLocaleString()}">${timeAgo(clip.createdAt)}</time>
      </div>

      <div class="clip-body">
        ${renderContent(clip)}
      </div>

      <div class="clip-card-footer">
        <div class="clip-author">
          <div class="avatar avatar-xs" style="background:${getAvatarColor(clip.authorName)}">${clip.authorName[0].toUpperCase()}</div>
          <span class="author-name">${escapeHtml(clip.authorName)}</span>
        </div>
        <div class="clip-actions">
          <button class="action-btn copy-btn" data-id="${clip._id}" title="Copy to clipboard">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          ${isOwn ? `
          <button class="action-btn delete-btn" data-id="${clip._id}" title="Delete clip">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>` : ''}
        </div>
      </div>
    `;

    div.querySelector('.copy-btn')?.addEventListener('click', () => copyClip(clip));
    div.querySelector('.delete-btn')?.addEventListener('click', () => deleteClip(clip._id));
    div.querySelector('.code-copy-btn')?.addEventListener('click', () => {
      navigator.clipboard.writeText(clip.content)
        .then(() => showToast('Code copied!', 'success'))
        .catch(() => showToast('Copy failed', 'error'));
    });
    if (clip.type === 'image') {
      div.querySelector('.clip-image')?.addEventListener('click', () => openImageModal(clip.content));
    }

    return div;
  }

  function renderContent(clip) {
    switch (clip.type) {
      case 'image':
        return `<div class="image-preview"><img class="clip-image" src="${clip.content}" alt="Shared image" loading="lazy" /></div>`;

      case 'code': {
        const lang = clip.language || 'javascript';
        const safe = escapeHtml(clip.content);
        return `
          <div class="code-block">
            <div class="code-header">
              <span class="code-lang">${lang}</span>
              <button class="code-copy-btn">Copy code</button>
            </div>
            <pre class="code-pre"><code class="language-${lang}">${safe}</code></pre>
          </div>`;
      }

      case 'link':
        return `
          <div class="link-preview">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <a href="${escapeHtml(clip.content)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clip.content)}</a>
          </div>`;

      default:
        return `<p class="text-content">${escapeHtml(clip.content)}</p>`;
    }
  }

  // ─── Paste handling ────────────────────────────────────────────────────────
  function setupPaste() {
    document.addEventListener('paste', async (e) => {
      if (isModalOpen) return;
      e.preventDefault();

      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find((i) => i.type.startsWith('image/'));

      if (imageItem) {
        await handleImagePaste(imageItem.getAsFile());
        return;
      }

      const text = e.clipboardData.getData('text');
      if (text) await handleTextPaste(text);
    });
  }

  async function handleTextPaste(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const type     = detectType(trimmed);
    const language = type === 'code' ? detectLanguage(trimmed) : null;

    showToast('Sharing…', 'info');
    try {
      const { data } = await api.clips.create({ content: trimmed, type, language });
      // Socket will push it to everyone; we add locally for instant feedback
      if (!clips.some((c) => c._id === data._id)) {
        clips.unshift(data);
        prependClipCard(data, true);
        updateClipCount(clips.length);
      }
      showToast('Clip shared!', 'success');
    } catch (err) {
      if (err.status === 401) return logout();
      showToast(err.message, 'error');
    }
  }

  async function handleImagePaste(file) {
    showToast('Processing image…', 'info');
    try {
      const base64 = await compressImage(file);
      const { data } = await api.clips.create({ content: base64, type: 'image' });
      if (!clips.some((c) => c._id === data._id)) {
        clips.unshift(data);
        prependClipCard(data, true);
        updateClipCount(clips.length);
      }
      showToast('Image shared!', 'success');
    } catch (err) {
      if (err.status === 401) return logout();
      showToast(err.message || 'Failed to share image', 'error');
    }
  }

  // ─── Clip actions ──────────────────────────────────────────────────────────
  async function copyClip(clip) {
    try {
      if (clip.type === 'image') {
        await copyImageToClipboard(clip.content);
      } else {
        await navigator.clipboard.writeText(clip.content);
      }
      showToast('Copied to clipboard!', 'success');
    } catch {
      showToast('Copy failed — browser blocked clipboard access', 'error');
    }
  }

  function copyImageToClipboard(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          try {
            // ClipboardItem requires image/png across all browsers
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }, 'image/png');
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function deleteClip(id) {
    if (!confirm('Delete this clip?')) return;
    try {
      await api.clips.remove(id);
      clips = clips.filter((c) => c._id !== id);
      document.querySelector(`.clip-card[data-id="${id}"]`)?.remove();
      updateClipCount(clips.length);
      if (clips.length === 0) emptyState.style.display = 'flex';
      showToast('Clip deleted', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ─── Modal ─────────────────────────────────────────────────────────────────
  function setupModal() {
    document.getElementById('newClipBtn').addEventListener('click', openModal);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
    document.getElementById('modalSubmitBtn').addEventListener('click', submitModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isModalOpen) closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && isModalOpen) submitModal();
    });
  }

  function openModal() {
    isModalOpen = true;
    modalOverlay.classList.add('active');
    clipTextarea.focus();
  }

  function closeModal() {
    isModalOpen = false;
    modalOverlay.classList.remove('active');
    clipTextarea.value = '';
    const btn = document.getElementById('modalSubmitBtn');
    btn.disabled = false;
    btn.classList.remove('loading');
  }

  async function submitModal() {
    const text = clipTextarea.value.trim();
    if (!text) { showToast('Please enter some content', 'error'); return; }

    const btn = document.getElementById('modalSubmitBtn');
    btn.disabled = true;
    btn.classList.add('loading');

    try {
      const type     = detectType(text);
      const language = type === 'code' ? detectLanguage(text) : null;
      const { data } = await api.clips.create({ content: text, type, language });
      if (!clips.some((c) => c._id === data._id)) {
        clips.unshift(data);
        prependClipCard(data, true);
        updateClipCount(clips.length);
      }
      showToast('Clip shared!', 'success');
      closeModal();
    } catch (err) {
      if (err.status === 401) return logout();
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  }

  // ─── Load more ─────────────────────────────────────────────────────────────
  function setupLoadMore() {
    loadMoreBtn.addEventListener('click', async () => {
      if (currentPage >= totalPages) return;
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
      await loadClips(currentPage + 1);
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more clips';
    });
  }

  // ─── Image modal ───────────────────────────────────────────────────────────
  function setupImageModal() {
    document.getElementById('imageModalClose').addEventListener('click', () => {
      imageOverlay.classList.remove('active');
    });
    imageOverlay.addEventListener('click', (e) => {
      if (e.target === imageOverlay) imageOverlay.classList.remove('active');
    });
  }

  function openImageModal(src) {
    imageModalSrc.src = src;
    imageOverlay.classList.add('active');
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  function logout() {
    localStorage.removeItem('cs_token');
    localStorage.removeItem('cs_user');
    socket?.disconnect();
    window.location.replace('index.html');
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
      success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
      error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
      info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    };

    toast.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast-show'));

    setTimeout(() => {
      toast.classList.remove('toast-show');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 3200);
  }

  // ─── Image compression ─────────────────────────────────────────────────────
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        let { naturalWidth: w, naturalHeight: h } = img;
        const MAX = 1920;
        if (w > MAX || h > MAX) {
          const r = Math.min(MAX / w, MAX / h);
          w = Math.round(w * r);
          h = Math.round(h * r);
        }
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        let quality = 0.85;
        let dataUrl;
        do {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
          quality -= 0.1;
        } while (dataUrl.length > 3.5 * 1024 * 1024 && quality > 0.2);

        if (dataUrl.length > 6 * 1024 * 1024) {
          reject(new Error('Image is too large even after compression (max 5MB)'));
        } else {
          resolve(dataUrl);
        }
      };

      img.onerror = () => reject(new Error('Failed to read image'));
      img.src = url;
    });
  }

  // ─── Type detection ────────────────────────────────────────────────────────
  function detectType(text) {
    if (/^https?:\/\/\S+$/.test(text)) return 'link';

    const codeHints = [
      /^(import|from|def |async def|class .+:)/m,
      /^(const|let|var|function |class |import .+ from|export )/m,
      /^(#include|int main|cout|printf|scanf)/m,
      /^(public class|System\.out|import java\.)/m,
      /<[a-zA-Z][^>]*>[\s\S]*<\/[a-zA-Z]+>/,
      /^(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|DROP)/i,
      /^(fn |pub |use |struct |impl |mod )/m,
      /^(package main|func |import \()/m,
      /^\{[\s\S]*\}$|^\[[\s\S]*\]$/,
      /(=>|->|\?\?|===|!==|\|\||\&\&|::|#\[)/,
    ];

    return codeHints.some((re) => re.test(text)) ? 'code' : 'text';
  }

  function detectLanguage(code) {
    const t = code.trim();
    if (/^(def |import |from |async def|class .+:)/m.test(t))         return 'python';
    if (/^(const|let|var|function |=>|import .+ from|export )/m.test(t)) return 'javascript';
    if (/<[a-zA-Z][^>]*>[\s\S]*<\/[a-zA-Z]+>/.test(t))               return 'markup';
    if (/^(\.|#)[a-zA-Z][\w-]*\s*\{/m.test(t))                        return 'css';
    if (/^(#include|int main|cout|cin|printf|scanf)/m.test(t))         return 'cpp';
    if (/^(public class|System\.out|import java\.)/m.test(t))          return 'java';
    if (/^(#!\/|echo |if \[|fi$|export )/m.test(t))                   return 'bash';
    if (/^[\[\{]/.test(t) && /[\]\}]$/.test(t))                       return 'json';
    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE)/i.test(t))              return 'sql';
    if (/^(package main|func |import \()/m.test(t))                   return 'go';
    if (/^(fn |pub |use |struct |impl )/m.test(t))                    return 'rust';
    return 'javascript';
  }

  // ─── Utils ─────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr)) / 1000;
    if (diff < 60)     return 'just now';
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  function getAvatarColor(name) {
    const palette = ['#7c3aed','#2563eb','#059669','#dc2626','#d97706','#db2777','#0891b2','#65a30d','#7c2d12','#9333ea'];
    let h = 0;
    for (const c of name) h = c.charCodeAt(0) + ((h << 5) - h);
    return palette[Math.abs(h) % palette.length];
  }
})();
