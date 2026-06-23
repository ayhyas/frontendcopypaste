(() => {
  // ─── Session guard ─────────────────────────────────────────────────────────
  const token = localStorage.getItem('cs_token');
  const user  = JSON.parse(localStorage.getItem('cs_user') || 'null');
  if (!token || !user) { window.location.replace('index.html'); return; }

  // ─── State ─────────────────────────────────────────────────────────────────
  let clips              = [];
  let currentPage        = 1;
  let totalPages         = 1;
  let socket             = null;
  let isModalOpen        = false;
  let workspaces         = [];
  let currentWorkspaceId = null; // null = All clips

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
  loadWorkspaces();
  loadClips();
  setupPaste();
  setupDragDrop();
  setupFileUpload();
  setupModal();
  setupLoadMore();
  setupImageModal();
  setupWorkspaceSidebar();
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

      if (data.workspace) {
        const ws = workspaces.find((w) => w._id === data.workspace);
        if (ws) {
          ws.clipCount = (ws.clipCount || 0) + 1;
          updateWorkspaceCountBadge(ws._id, ws.clipCount);
        }
      }

      const inView = currentWorkspaceId === null || data.workspace === currentWorkspaceId;
      if (!inView) return;

      clips.unshift(data);
      prependClipCard(data);
      updateClipCount(clips.length);
    });

    socket.on('clip:updated', ({ data }) => {
      const idx = clips.findIndex((c) => c._id === data._id);
      if (idx !== -1) clips[idx] = { ...clips[idx], ...data };
      const existing = document.querySelector(`.clip-card[data-id="${data._id}"]`);
      if (!existing) return;
      const updated = buildCard(clips[idx] || data);
      existing.replaceWith(updated);
      Prism.highlightAllUnder(updated);
    });

    socket.on('clip:deleted', ({ id }) => {
      const deleted = clips.find((c) => c._id === id);
      if (deleted?.workspace) {
        const ws = workspaces.find((w) => w._id === deleted.workspace);
        if (ws) {
          ws.clipCount = Math.max(0, (ws.clipCount || 1) - 1);
          updateWorkspaceCountBadge(ws._id, ws.clipCount);
        }
      }
      clips = clips.filter((c) => c._id !== id);
      document.querySelector(`.clip-card[data-id="${id}"]`)?.remove();
      updateClipCount(clips.length);
      if (clips.length === 0) emptyState.style.display = 'flex';
    });

    socket.on('workspace:new', ({ data }) => {
      if (workspaces.some((w) => w._id === data._id)) return;
      workspaces.push(data);
      appendWorkspaceItem(data);
    });

    socket.on('workspace:updated', ({ data }) => {
      const idx = workspaces.findIndex((w) => w._id === data._id);
      if (idx === -1) return;
      workspaces[idx] = { ...workspaces[idx], name: data.name };
      const li = document.querySelector(`.ws-item[data-id="${data._id}"]`);
      if (li) li.querySelector('.ws-item-name').textContent = data.name;
      if (currentWorkspaceId === data._id) updateBoardTitle(data.name);
    });

    socket.on('workspace:deleted', ({ id }) => {
      workspaces = workspaces.filter((w) => w._id !== id);
      document.querySelector(`.ws-item[data-id="${id}"]`)?.remove();
      if (currentWorkspaceId === id) selectWorkspace(null);
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
      if (page === 1) showSkeletons();
      const { data, pagination } = await api.clips.list(page, currentWorkspaceId);
      currentPage = pagination.page;
      totalPages  = pagination.pages;

      if (page === 1) {
        clips = data;
        renderAllClips();
      } else {
        clips = [...clips, ...data];
        data.forEach((clip) => appendClipCard(clip));
      }

      updateClipCount(pagination.total);
      loadMoreWrapper.style.display = pagination.hasMore ? 'flex' : 'none';
    } catch (err) {
      if (err.status === 401) return logout();
      clipsGrid.innerHTML = '';
      showToast('Failed to load clips', 'error');
    }
  }

  function showSkeletons() {
    clipsGrid.innerHTML = '';
    emptyState.style.display = 'none';
    loadingState.style.display = 'none';
    for (let i = 0; i < 6; i++) clipsGrid.appendChild(buildSkeletonCard());
  }

  function buildSkeletonCard() {
    const d = document.createElement('div');
    d.className = 'clip-card skeleton-card';
    d.innerHTML = `
      <div class="sk-header">
        <div class="sk-pill sk-block"></div>
        <div class="sk-line sk-short sk-block"></div>
      </div>
      <div class="sk-body">
        <div class="sk-line sk-block"></div>
        <div class="sk-line sk-block"></div>
        <div class="sk-line sk-medium sk-block"></div>
      </div>
      <div class="sk-footer">
        <div class="sk-circle sk-block"></div>
        <div class="sk-line sk-short sk-block"></div>
      </div>`;
    return d;
  }

  function renderAllClips() {
    clipsGrid.innerHTML = '';
    if (clips.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    clips.forEach((clip, i) => {
      const card = buildCard(clip);
      card.classList.add('card-appear');
      card.style.animationDelay = `${i < 8 ? i * 45 : 8 * 45}ms`;
      clipsGrid.appendChild(card);
    });
    Prism.highlightAllUnder(clipsGrid);
  }

  function prependClipCard(clip) {
    emptyState.style.display = 'none';
    const card = buildCard(clip);
    card.classList.add('card-appear');
    clipsGrid.prepend(card);
    Prism.highlightAllUnder(card);
  }

  function appendClipCard(clip) {
    const card = buildCard(clip);
    card.classList.add('card-appear');
    clipsGrid.appendChild(card);
    Prism.highlightAllUnder(card);
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

      <div class="clip-title-row ${clip.title ? 'has-title' : ''} ${isOwn ? 'is-own' : ''}">
        ${clip.title
          ? `<span class="clip-title-text">${escapeHtml(clip.title)}</span>`
          : `<span class="clip-title-placeholder">Add a title…</span>`}
        ${isOwn ? `
        <button class="clip-title-edit-btn" title="Edit title">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>` : ''}
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
          <button class="action-btn copy-btn" data-id="${clip._id}" title="${clip.type === 'file' ? 'Download file' : 'Copy to clipboard'}">
            ${clip.type === 'file'
              ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                   <polyline points="7 10 12 15 17 10"/>
                   <line x1="12" y1="15" x2="12" y2="3"/>
                 </svg>`
              : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                 </svg>`}
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
    if (isOwn) {
      div.querySelector('.clip-title-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        startTitleEdit(clip, div.querySelector('.clip-title-row'));
      });
    }

    return div;
  }

  function startTitleEdit(clip, row) {
    const textEl = row.querySelector('.clip-title-text, .clip-title-placeholder');
    const currentTitle = clip.title || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'clip-title-inline-input';
    input.value = currentTitle;
    input.maxLength = 100;
    input.placeholder = 'Add a title…';

    textEl.replaceWith(input);
    input.focus();
    if (currentTitle) input.select();

    let saved = false;
    async function commit() {
      if (saved) return;
      saved = true;
      const newTitle = input.value.trim();
      if (newTitle === currentTitle) {
        // No change — socket won't fire, restore manually
        input.replaceWith(textEl);
        return;
      }
      try {
        await api.clips.update(clip._id, { title: newTitle });
        // clip:updated socket event will re-render the card
      } catch (err) {
        input.replaceWith(textEl);
        showToast(err.message || 'Could not save title', 'error');
      }
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { saved = true; input.replaceWith(textEl); }
    });
  }

  function renderContent(clip) {
    switch (clip.type) {
      case 'image':
        return `<div class="image-preview"><img class="clip-image" src="${clip.content}" alt="Shared image" loading="lazy" /></div>`;

      case 'file': {
        const ext = (clip.fileName || '').split('.').pop().toLowerCase();
        const size = clip.fileSize ? formatFileSize(clip.fileSize) : '';
        const { svg, colorClass } = getFileIcon(clip.mimeType, ext);
        return `
          <div class="file-preview">
            <div class="file-icon-wrap ${colorClass}">${svg}</div>
            <div class="file-info">
              <span class="file-name">${escapeHtml(clip.fileName || 'Unknown file')}</span>
              ${size ? `<span class="file-size">${size}</span>` : ''}
            </div>
            <a class="file-download-btn" href="${clip.content}" download="${escapeHtml(clip.fileName || 'file')}" title="Download file">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </a>
          </div>`;
      }

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

      // Files pasted from OS (e.g. file manager copy on browsers that support it)
      const pastedFiles = Array.from(e.clipboardData.files);
      if (pastedFiles.length > 0) {
        for (const file of pastedFiles) {
          if (file.type.startsWith('image/')) {
            await handleImagePaste(file);
          } else {
            await handleFilePaste(file);
          }
        }
        return;
      }

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

  // ─── Drag and drop ──────────────────────────────────────────────────────────
  function setupDragDrop() {
    let dragDepth = 0;
    const overlay = document.getElementById('dragDropOverlay');

    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      dragDepth++;
      overlay.classList.add('active');
    });

    document.addEventListener('dragleave', () => {
      dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        overlay.classList.remove('active');
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('active');
      if (isModalOpen) return;

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleImagePaste(file);
        } else {
          await handleFilePaste(file);
        }
      }
    });
  }

  // ─── File upload button ─────────────────────────────────────────────────────
  function setupFileUpload() {
    const fileInput = document.getElementById('fileInput');
    document.getElementById('uploadFileBtn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await handleImagePaste(file);
        } else {
          await handleFilePaste(file);
        }
      }
      fileInput.value = '';
    });
  }

  async function handleFilePaste(file) {
    const MAX_FILE_BYTES = 9 * 1024 * 1024; // ~9 MB binary → ~12 MB base64
    if (file.size > MAX_FILE_BYTES) {
      showToast(`"${file.name}" is too large (max 9 MB)`, 'error');
      return;
    }

    showToast(`Uploading "${file.name}"…`, 'info');
    try {
      const base64 = await fileToBase64(file);
      const { data } = await api.clips.create({
        content: base64,
        type: 'file',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        workspaceId: currentWorkspaceId,
      });
      if (!clips.some((c) => c._id === data._id)) {
        clips.unshift(data);
        prependClipCard(data, true);
        updateClipCount(clips.length);
      }
      showToast(`"${file.name}" shared!`, 'success');
    } catch (err) {
      if (err.status === 401) return logout();
      showToast(err.message || `Failed to share "${file.name}"`, 'error');
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function handleTextPaste(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const type     = detectType(trimmed);
    const language = type === 'code' ? detectLanguage(trimmed) : null;

    showToast('Sharing…', 'info');
    try {
      const { data } = await api.clips.create({ content: trimmed, type, language, workspaceId: currentWorkspaceId });
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
      const { data } = await api.clips.create({ content: base64, type: 'image', workspaceId: currentWorkspaceId });
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
      if (clip.type === 'file') {
        const a = document.createElement('a');
        a.href = clip.content;
        a.download = clip.fileName || 'file';
        a.click();
        showToast('Download started', 'success');
        return;
      }
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
    document.getElementById('clipTitleInput').value = '';
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
      const title    = document.getElementById('clipTitleInput').value.trim() || null;
      const { data } = await api.clips.create({ content: text, type, language, title, workspaceId: currentWorkspaceId });
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

  // ─── Workspaces ────────────────────────────────────────────────────────────
  async function loadWorkspaces() {
    try {
      const { data } = await api.workspaces.list();
      workspaces = data;
      const list = document.getElementById('wsList');
      workspaces.forEach((ws) => appendWorkspaceItem(ws));
    } catch (err) {
      if (err.status === 401) logout();
    }
  }

  function appendWorkspaceItem(ws) {
    const list = document.getElementById('wsList');
    const li = buildWorkspaceItem(ws);
    list.appendChild(li);
  }

  function buildWorkspaceItem(ws) {
    const isOwn = ws.ownerName === user.username;
    const li = document.createElement('li');
    li.className = 'ws-item';
    li.dataset.id = ws._id;

    li.innerHTML = `
      <div class="ws-item-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <span class="ws-item-name">${escapeHtml(ws.name)}</span>
      ${ws.clipCount ? `<span class="ws-item-count">${ws.clipCount}</span>` : '<span class="ws-item-count" style="display:none">0</span>'}
      ${isOwn ? `
      <div class="ws-item-actions">
        <button class="ws-action-btn ws-rename-btn" title="Rename">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="ws-action-btn ws-delete-btn" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>` : ''}
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.ws-action-btn')) return;
      selectWorkspace(ws._id);
    });

    li.querySelector('.ws-rename-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(ws._id, li);
    });

    li.querySelector('.ws-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteWorkspaceHandler(ws._id, ws.name);
    });

    return li;
  }

  function selectWorkspace(id) {
    currentWorkspaceId = id;

    // Update active state
    document.querySelectorAll('.ws-item').forEach((el) => el.classList.remove('ws-item-active'));
    const target = id
      ? document.querySelector(`.ws-item[data-id="${id}"]`)
      : document.getElementById('wsAllItem');
    target?.classList.add('ws-item-active');

    // Update board title
    if (!id) {
      updateBoardTitle('All clips');
    } else {
      const ws = workspaces.find((w) => w._id === id);
      if (ws) updateBoardTitle(ws.name);
    }

    // Update empty state message
    const emptyText = document.getElementById('emptyStateText');
    if (emptyText) {
      emptyText.textContent = id ? 'No clips in this workspace yet.' : 'No clips yet — be the first to share!';
    }

    // Reload clips for new view
    currentPage = 1;
    clips = [];
    loadClips(1);
  }

  function updateBoardTitle(name) {
    const title = document.getElementById('boardTitle');
    if (title) {
      const count = document.getElementById('clipCount');
      title.textContent = name + ' ';
      title.appendChild(count);
    }
  }

  function updateWorkspaceCountBadge(wsId, count) {
    const li = document.querySelector(`.ws-item[data-id="${wsId}"]`);
    if (!li) return;
    let badge = li.querySelector('.ws-item-count');
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }

  function startRename(wsId, li) {
    const nameEl = li.querySelector('.ws-item-name');
    const ws = workspaces.find((w) => w._id === wsId);
    if (!ws) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-rename-input';
    input.value = ws.name;
    input.maxLength = 50;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    async function commitRename() {
      const newName = input.value.trim();
      input.replaceWith(nameEl);
      if (!newName || newName === ws.name) return;
      try {
        await api.workspaces.rename(wsId, newName);
      } catch (err) {
        showToast(err.message || 'Rename failed', 'error');
      }
    }

    input.addEventListener('blur', commitRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = ws.name; input.blur(); }
    });
  }

  async function deleteWorkspaceHandler(wsId, wsName) {
    if (!confirm(`Delete workspace "${wsName}"?\n\nClips inside will be moved to All clips.`)) return;
    try {
      await api.workspaces.remove(wsId);
    } catch (err) {
      showToast(err.message || 'Delete failed', 'error');
    }
  }

  function setupWorkspaceSidebar() {
    document.getElementById('wsAllItem').addEventListener('click', () => selectWorkspace(null));
    document.getElementById('addWorkspaceBtn').addEventListener('click', () => {
      const form = document.getElementById('wsNewForm');
      form.style.display = form.style.display === 'none' ? '' : 'none';
      if (form.style.display !== 'none') document.getElementById('wsNewInput').focus();
    });

    document.getElementById('wsConfirmBtn').addEventListener('click', createWorkspaceFromForm);
    document.getElementById('wsCancelBtn').addEventListener('click', () => {
      document.getElementById('wsNewForm').style.display = 'none';
      document.getElementById('wsNewInput').value = '';
    });
    document.getElementById('wsNewInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createWorkspaceFromForm();
      if (e.key === 'Escape') {
        document.getElementById('wsNewForm').style.display = 'none';
        document.getElementById('wsNewInput').value = '';
      }
    });
  }

  async function createWorkspaceFromForm() {
    const input = document.getElementById('wsNewInput');
    const name = input.value.trim();
    if (!name) { showToast('Enter a workspace name', 'error'); return; }
    try {
      await api.workspaces.create(name);
      input.value = '';
      document.getElementById('wsNewForm').style.display = 'none';
    } catch (err) {
      showToast(err.message || 'Failed to create workspace', 'error');
    }
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

  // ─── File helpers ──────────────────────────────────────────────────────────
  function formatFileSize(bytes) {
    if (bytes < 1024)            return `${bytes} B`;
    if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getFileIcon(mimeType, ext) {
    const mime = mimeType || '';
    const fileSvg = (lines) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>${lines}</svg>`;

    if (ext === 'pdf' || mime === 'application/pdf') {
      return { colorClass: 'file-icon-pdf', svg: fileSvg('<line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/>') };
    }
    if (['doc', 'docx'].includes(ext) || mime.includes('word')) {
      return { colorClass: 'file-icon-word', svg: fileSvg('<line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>') };
    }
    if (['xls', 'xlsx', 'csv'].includes(ext) || mime.includes('spreadsheet') || mime.includes('excel')) {
      return { colorClass: 'file-icon-excel', svg: fileSvg('<polyline points="9 13 12 16 15 13"/><line x1="12" y1="16" x2="12" y2="10"/>') };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) {
      return { colorClass: 'file-icon-zip', svg: fileSvg('<line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="15" x2="12" y2="15"/>') };
    }
    return { colorClass: '', svg: fileSvg('') };
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
