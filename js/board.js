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
  let onlineUsers        = [];   // [{ username, profilePic }]

  // username → base64 profile pic; seeded with current user, updated via socket
  const profilePicCache  = user.profilePic ? { [user.username]: user.profilePic } : {};
  const isAdmin          = user.role === 'admin';
  let   handRaiseQueue   = [];   // admin only: pending screen-share requests
  let   isHandRaised     = false; // non-admin: waiting for approval

  // Screen share state
  let isBroadcasting        = false;
  let localStream           = null;
  let peerConnections       = {};   // viewerId → RTCPeerConnection (broadcaster side)
  let viewerPc              = null; // RTCPeerConnection (viewer side)
  let pendingIceCandidates  = [];   // queued before remote description is set
  let activeBroadcasterId   = null;
  let activeBroadcasterName = null;
  let connectingTimer       = null; // viewer connection timeout
  let isFallbackViewing     = false;// using canvas-frame path instead of WebRTC
  let frameInterval         = null; // broadcaster: setInterval for JPEG capture
  let frameCanvas           = null;
  let frameCtx              = null;
  let frameVideo            = null;

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceCandidatePoolSize: 4, // pre-gather candidates before signaling starts
  };

  const QUALITY_PRESETS = {
    high:   { maxBitrate: 4_000_000, scaleResolutionDownBy: 1,   label: 'HD (4 Mbps)' },
    medium: { maxBitrate: 1_500_000, scaleResolutionDownBy: 1.5, label: 'SD (1.5 Mbps)' },
    low:    { maxBitrate: 500_000,   scaleResolutionDownBy: 2.5, label: 'Low (500 Kbps)' },
  };

  // ─── WebRTC compat helpers ──────────────────────────────────────────────────
  function createPeerConnection() {
    const PC = window.RTCPeerConnection
            || window.webkitRTCPeerConnection
            || window.mozRTCPeerConnection;
    if (!PC) throw new Error('WebRTC is not supported in this browser');
    return new PC(ICE_CONFIG);
  }

  function getDisplayMediaSafe(constraints) {
    if (navigator.mediaDevices?.getDisplayMedia) {
      return navigator.mediaDevices.getDisplayMedia(constraints);
    }
    // Pre-mediaDevices Chrome (rare but exists)
    if (navigator.getDisplayMedia) {
      return Promise.resolve().then(() => navigator.getDisplayMedia(constraints));
    }
    const err = new Error('Screen sharing is not supported in this browser');
    err.name = 'NotSupportedError';
    return Promise.reject(err);
  }

  function toSessionDescription(desc) {
    if (typeof RTCSessionDescription !== 'undefined' && !(desc instanceof RTCSessionDescription)) {
      try { return new RTCSessionDescription(desc); } catch { /* fall through */ }
    }
    return desc;
  }

  function safeIceCandidate(raw) {
    if (!raw || !raw.candidate) return null; // null = end-of-candidates, skip
    try {
      return typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(raw) : raw;
    } catch {
      return raw;
    }
  }

  function requestFullscreenCompat(el) {
    const fn = el.requestFullscreen
            || el.webkitRequestFullscreen
            || el.mozRequestFullScreen
            || el.msRequestFullscreen;
    if (fn) fn.call(el);
  }

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
  setupScreenShare();
  setupOnlineUsersPanel();
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // ─── Avatar helpers ────────────────────────────────────────────────────────
  function applyAvatarPic(el, username, profilePic) {
    if (profilePic) {
      el.textContent = '';
      el.style.background = 'none';
      el.style.backgroundImage = `url(${profilePic})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.textContent = username[0].toUpperCase();
      el.style.backgroundImage = '';
      el.style.background = getAvatarColor(username);
    }
  }

  function updateAllAvatarsForUser(username, profilePic) {
    // Navbar
    if (username === user.username) {
      applyAvatarPic(document.getElementById('navAvatar'), username, profilePic);
    }
    // Clip-card author avatars
    document.querySelectorAll('.clip-author').forEach((el) => {
      if (el.querySelector('.author-name')?.textContent !== username) return;
      applyAvatarPic(el.querySelector('.avatar'), username, profilePic);
    });
  }

  // ─── Navbar ────────────────────────────────────────────────────────────────
  function initNavbar() {
    applyAvatarPic(document.getElementById('navAvatar'), user.username, user.profilePic || null);
    document.getElementById('navUsername').textContent = user.username;
    if (isAdmin) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = 'Admin';
      const logoutBtn = document.getElementById('logoutBtn');
      logoutBtn.parentElement.insertBefore(badge, logoutBtn);
    }

    const fileInput = document.getElementById('profilePicInput');
    document.getElementById('navAvatarWrap').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;

      showToast('Uploading profile picture…', 'info');
      try {
        const base64 = await compressProfilePic(file);
        const { user: updated } = await api.auth.updateProfilePic(base64);

        // Persist in localStorage so it survives page refresh
        const stored = JSON.parse(localStorage.getItem('cs_user') || '{}');
        stored.profilePic = updated.profilePic;
        localStorage.setItem('cs_user', JSON.stringify(stored));
        user.profilePic = updated.profilePic;

        showToast('Profile picture updated!', 'success');
        // The socket event user:profilePic will handle the visual update
      } catch (err) {
        if (err.status === 401) return logout();
        showToast(err.message || 'Failed to update profile picture', 'error');
      }
    });
  }

  // ─── Socket.io ─────────────────────────────────────────────────────────────
  function connectSocket() {
    socket = io(CONFIG.API_URL, {
      auth: { token },
      transports: ['websocket', 'polling'], // start with WebSocket, skip polling upgrade round-trip
    });

    socket.on('connect', () => setConnectionStatus(true));
    socket.on('disconnect', () => setConnectionStatus(false));
    socket.on('connect_error', () => setConnectionStatus(false));

    socket.on('users:online', ({ users }) => {
      onlineUsers = users;
      document.getElementById('onlineCountNum').textContent = users.length;
      renderOnlineUsers();
    });

    socket.on('user:profilePic', ({ username, profilePic }) => {
      profilePicCache[username] = profilePic;
      updateAllAvatarsForUser(username, profilePic);
    });

    // Admin stopped our broadcast remotely
    socket.on('screen:force-stop', () => {
      if (isBroadcasting) stopBroadcasting();
    });

    // We were kicked by admin
    socket.on('kicked', () => {
      showToast('You have been removed by an admin', 'error');
      setTimeout(logout, 2500);
    });

    // ── Screen share permission flow ───────────────────────────────────────
    // Non-admin: admin approved our request → start sharing
    socket.on('screen:approved', () => {
      isHandRaised = false;
      setWaitingUI(false);
      showToast('Screen share approved!', 'success');
      startBroadcasting();
    });

    // Non-admin: admin denied our request
    socket.on('screen:denied', () => {
      isHandRaised = false;
      setWaitingUI(false);
      showToast('Screen share request was denied', 'error');
    });

    // Non-admin: no admin is online when we raised our hand
    socket.on('screen:no-admin', () => {
      showToast('No admin is online — request is pending', 'info');
    });

    // Admin: a user raised their hand — show a prominent notification
    socket.on('screen:hand-raised', ({ userId, username, profilePic }) => {
      if (isAdmin) showHandRaiseAlert(userId, username, profilePic);
    });

    // Admin: receive updated queue of pending requests
    socket.on('screen:hand-queue', ({ queue }) => {
      handRaiseQueue = queue;
      renderHandRaiseQueue();
    });

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

    // ─── Screen share signaling ─────────────────────────────────────────────
    socket.on('screen:available', ({ socketId, username }) => {
      activeBroadcasterId  = socketId;
      activeBroadcasterName = username;
      if (!isBroadcasting) showLiveBanner(username);
    });

    socket.on('screen:ended', () => {
      activeBroadcasterId   = null;
      activeBroadcasterName = null;
      hideLiveBanner();
      stopViewing();
    });

    // Broadcaster: a viewer wants to connect
    socket.on('screen:viewer-joined', async ({ viewerId }) => {
      if (!isBroadcasting || !localStream) return;
      let pc;
      try { pc = createPeerConnection(); } catch { return; }
      peerConnections[viewerId] = pc;

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('screen:ice', { targetId: viewerId, candidate });
      };

      pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          pc.close();
          delete peerConnections[viewerId];
          updateViewerCount();
        }
      };

      // addTransceiver with sendEncodings bakes bitrate/scale into the SDP from the start,
      // so getParameters().encodings is populated after negotiation and setParameters() works.
      // addTrack() leaves encodings empty pre-negotiation, causing setParameters() to silently fail.
      localStream.getTracks().forEach((track) => {
        if (track.kind === 'video') {
          const transceiver = pc.addTransceiver(track, {
            streams: [localStream],
            direction: 'sendonly',
            sendEncodings: [{
              maxBitrate:            QUALITY_PRESETS.high.maxBitrate,
              scaleResolutionDownBy: QUALITY_PRESETS.high.scaleResolutionDownBy,
            }],
          });
          // Prefer VP9 / H.264 on this transceiver while we still have the reference
          if (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities) {
            const caps = RTCRtpSender.getCapabilities('video');
            if (caps) {
              const preferred = caps.codecs.filter((c) => /VP9|H264/i.test(c.mimeType));
              const rest      = caps.codecs.filter((c) => !/VP9|H264/i.test(c.mimeType));
              try { transceiver.setCodecPreferences([...preferred, ...rest]); } catch {}
            }
          }
        } else {
          pc.addTrack(track, localStream);
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('screen:offer', { viewerId, offer: pc.localDescription });
      updateViewerCount();
    });

    // Broadcaster: viewer answered
    socket.on('screen:answer', async ({ viewerId, answer }) => {
      try {
        await peerConnections[viewerId]?.setRemoteDescription(toSessionDescription(answer));
      } catch {}
    });

    // Viewer: broadcaster sent offer
    socket.on('screen:offer', async ({ broadcasterId, offer }) => {
      if (!viewerPc) return;
      try {
        await viewerPc.setRemoteDescription(toSessionDescription(offer));
        for (const c of pendingIceCandidates) {
          await viewerPc.addIceCandidate(c).catch(() => {});
        }
        pendingIceCandidates = [];
        const answer = await viewerPc.createAnswer();
        await viewerPc.setLocalDescription(answer);
        socket.emit('screen:answer', { broadcasterId, answer: viewerPc.localDescription });
      } catch {}
    });

    // ICE candidates — both directions (null candidate = end-of-candidates, safe to skip)
    socket.on('screen:ice', ({ fromId, candidate }) => {
      const ice = safeIceCandidate(candidate);
      if (!ice) return;
      if (isBroadcasting) {
        peerConnections[fromId]?.addIceCandidate(ice).catch(() => {});
      } else if (viewerPc) {
        if (viewerPc.remoteDescription) {
          viewerPc.addIceCandidate(ice).catch(() => {});
        } else {
          pendingIceCandidates.push(ice);
        }
      }
    });

    // Canvas-frame fallback: start capture when a fallback viewer joins
    socket.on('screen:fallback-viewer', () => {
      if (isBroadcasting && localStream && !frameInterval) startFrameCapture();
    });

    // Viewer receives JPEG frame from broadcaster
    socket.on('screen:frame', ({ frame }) => {
      if (!isFallbackViewing) return;
      document.getElementById('liveFallbackImg').src = frame;
      document.getElementById('liveConnecting').style.display = 'none';
    });

    // Broadcaster: viewer requests a quality change
    socket.on('screen:quality-request', ({ viewerId, preset: presetKey }) => {
      if (!isBroadcasting) return;
      const pc     = peerConnections[viewerId];
      const preset = QUALITY_PRESETS[presetKey];
      if (!pc || !preset) return;
      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind !== 'video') return;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) return; // negotiation not done yet
        params.encodings[0].maxBitrate            = preset.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;
        sender.setParameters(params).catch(() => {});
      });
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

      <div class="clip-title-row ${clip.title ? 'has-title' : ''} ${(isOwn || isAdmin) ? 'is-own' : ''}">
        ${clip.title
          ? `<span class="clip-title-text">${escapeHtml(clip.title)}</span>`
          : `<span class="clip-title-placeholder">Add a title…</span>`}
        ${(isOwn || isAdmin) ? `
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
          ${buildAuthorAvatar(clip.authorName)}
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
          ${(isOwn || isAdmin) ? `
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
    if (isOwn || isAdmin) {
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
    const isOwn = ws.ownerName === user.username || isAdmin;
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

  // ─── Screen share ──────────────────────────────────────────────────────────
  function setupScreenShare() {
    const btn = document.getElementById('shareScreenBtn');

    // Sharing requires a secure context; hide the button on plain HTTP (except localhost)
    const isSecure = location.protocol === 'https:'
                  || location.hostname === 'localhost'
                  || location.hostname === '127.0.0.1';

    const hasDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia || navigator.getDisplayMedia);
    const hasWebRTC = !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);

    if (!isSecure || !hasDisplayMedia || !hasWebRTC) {
      btn.style.display = 'none';
    } else {
      btn.addEventListener('click', () => {
        if (isBroadcasting) {
          stopBroadcasting();
        } else if (isAdmin) {
          startBroadcasting(); // admin shares directly, no permission needed
        } else if (isHandRaised) {
          lowerHand(); // cancel pending request
        } else {
          raiseHand(); // request permission
        }
      });
    }

    // Show the hand-raise panel for admin
    if (isAdmin) setupHandRaisePanel();

    // Watch/dismiss always available (viewing uses same WebRTC path)
    document.getElementById('watchLiveBtn').addEventListener('click', () => {
      hideLiveBanner();
      startViewing();
    });
    document.getElementById('liveBannerDismiss').addEventListener('click', hideLiveBanner);
    document.getElementById('liveCloseBtn').addEventListener('click', stopViewing);

    document.getElementById('adminStopBtn')?.addEventListener('click', () => {
      socket.emit('screen:admin-stop');
    });

    document.getElementById('liveQualitySelect').addEventListener('change', (e) => {
      if (!activeBroadcasterId || (!viewerPc && !isFallbackViewing)) return;
      socket.emit('screen:quality-request', { broadcasterId: activeBroadcasterId, preset: e.target.value });
    });
    document.getElementById('liveFullscreenBtn').addEventListener('click', () => {
      requestFullscreenCompat(document.getElementById('liveVideo'));
    });
    document.getElementById('liveMuteBtn').addEventListener('click', toggleMute);

    const liveVideo = document.getElementById('liveVideo');
    liveVideo.addEventListener('playing', () => {
      document.getElementById('liveConnecting').style.display = 'none';
    });
  }

  async function startBroadcasting() {
    try {
      const stream = await getDisplayMediaSafe({
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 }, cursor: 'always' },
        audio: true,
      });

      localStream    = stream;
      isBroadcasting = true;

      // Triggers when the user clicks the browser's native "Stop sharing" button
      stream.getVideoTracks()[0].addEventListener('ended', stopBroadcasting);

      socket.emit('screen:start', { username: user.username });
      setBroadcastingUI(true);
    } catch (err) {
      if (err.name === 'NotAllowedError') return; // user cancelled picker — silent
      if (err.name === 'NotFoundError')     return showToast('No screen available to share', 'error');
      if (err.name === 'NotSupportedError') return showToast('Screen sharing is not supported in this browser', 'error');
      showToast('Could not start screen share', 'error');
    }
  }

  function stopBroadcasting() {
    if (!isBroadcasting) return;
    stopFrameCapture();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream    = null;
    isBroadcasting = false;

    Object.values(peerConnections).forEach((pc) => pc.close());
    peerConnections = {};

    socket.emit('screen:stop');
    setBroadcastingUI(false);
  }

  function startFrameCapture() {
    if (frameInterval || !localStream) return;

    frameVideo = document.createElement('video');
    frameVideo.srcObject = localStream;
    frameVideo.muted = true;
    frameVideo.setAttribute('playsinline', '');
    frameVideo.play().catch(() => {});

    frameCanvas = document.createElement('canvas');
    frameCtx    = frameCanvas.getContext('2d');

    frameVideo.onloadedmetadata = () => {
      // Cap at 960 wide to keep frame size sane (≈30–60 KB/frame at JPEG 50%)
      const MAX = 960;
      let w = frameVideo.videoWidth  || 1280;
      let h = frameVideo.videoHeight || 720;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      frameCanvas.width  = w;
      frameCanvas.height = h;

      frameInterval = setInterval(() => {
        if (!localStream) { stopFrameCapture(); return; }
        try {
          frameCtx.drawImage(frameVideo, 0, 0, w, h);
          socket.emit('screen:frame', { frame: frameCanvas.toDataURL('image/jpeg', 0.65) });
        } catch {}
      }, 125); // 8 fps @ JPEG 65% — smoother fallback, still well under Socket.io limits
    };
  }

  function stopFrameCapture() {
    clearInterval(frameInterval);
    frameInterval = null;
    if (frameVideo) { frameVideo.pause(); frameVideo.srcObject = null; frameVideo = null; }
    frameCanvas = null;
    frameCtx    = null;
  }

  function showHandRaiseAlert(userId, username, profilePic) {
    const container = document.getElementById('handAlertContainer');
    if (!container) return;

    const avatarStyle   = profilePic
      ? `background:none;background-image:url(${profilePic});background-size:cover;background-position:center`
      : `background:${getAvatarColor(username)}`;
    const avatarContent = profilePic ? '' : username[0].toUpperCase();

    const el = document.createElement('div');
    el.className = 'hand-alert';
    el.innerHTML = `
      <div class="avatar avatar-xs" style="${avatarStyle}">${avatarContent}</div>
      <div class="hand-alert-body">
        <div class="hand-alert-title">${escapeHtml(username)}</div>
        <div class="hand-alert-sub">wants to share their screen</div>
      </div>
      <div class="hand-alert-actions">
        <button class="hand-alert-approve">Allow</button>
        <button class="hand-alert-deny">Deny</button>
      </div>`;

    container.appendChild(el);

    let dismissed = false;
    let autoTimer;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(autoTimer);
      el.classList.add('hand-alert--out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };

    el.querySelector('.hand-alert-approve').addEventListener('click', () => {
      socket.emit('screen:approve', { userId });
      dismiss();
    });
    el.querySelector('.hand-alert-deny').addEventListener('click', () => {
      socket.emit('screen:deny', { userId });
      dismiss();
    });

    autoTimer = setTimeout(dismiss, 20000);
  }

  function setBroadcastingUI(active) {
    const btn   = document.getElementById('shareScreenBtn');
    const label = document.getElementById('shareScreenLabel');
    btn.classList.toggle('btn-share-screen--live', active);
    btn.classList.remove('btn-share-screen--waiting');
    label.textContent = active ? 'Stop sharing' : 'Share screen';
  }

  function setWaitingUI(active) {
    const btn   = document.getElementById('shareScreenBtn');
    const label = document.getElementById('shareScreenLabel');
    btn.classList.toggle('btn-share-screen--waiting', active);
    btn.classList.remove('btn-share-screen--live');
    label.textContent = active ? '✋ Waiting… (cancel)' : 'Share screen';
  }

  function raiseHand() {
    isHandRaised = true;
    setWaitingUI(true);
    socket.emit('screen:raise-hand');
  }

  function lowerHand() {
    isHandRaised = false;
    setWaitingUI(false);
    socket.emit('screen:lower-hand');
  }

  function setupHandRaisePanel() {
    const wrap  = document.getElementById('handQueueWrap');
    const btn   = document.getElementById('handQueueBtn');
    const panel = document.getElementById('handQueuePanel');
    if (!wrap) return;
    wrap.style.display = 'flex';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', (e) => {
      if (!panel.hidden && !wrap.contains(e.target)) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function renderHandRaiseQueue() {
    const list    = document.getElementById('handQueueList');
    const empty   = document.getElementById('handQueueEmpty');
    const badge   = document.getElementById('handQueueBadge');
    if (!list) return;

    const count = handRaiseQueue.length;

    // Update badge
    badge.textContent    = count;
    badge.style.display  = count > 0 ? 'inline-flex' : 'none';
    empty.style.display  = count === 0 ? 'block' : 'none';

    list.innerHTML = handRaiseQueue.map(({ userId, username, profilePic }) => {
      const avatarStyle   = profilePic
        ? `background:none;background-image:url(${profilePic});background-size:cover;background-position:center`
        : `background:${getAvatarColor(username)}`;
      const avatarContent = profilePic ? '' : username[0].toUpperCase();
      return `
        <li class="hand-req-item" data-user-id="${escapeHtml(userId)}">
          <div class="avatar avatar-xs" style="${avatarStyle}">${avatarContent}</div>
          <span class="hand-req-name">${escapeHtml(username)}</span>
          <button class="hand-approve-btn" title="Approve" data-approve="${escapeHtml(userId)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
          <button class="hand-deny-btn" title="Deny" data-deny="${escapeHtml(userId)}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </li>`;
    }).join('');

    list.querySelectorAll('.hand-approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('screen:approve', { userId: btn.dataset.approve });
      });
    });
    list.querySelectorAll('.hand-deny-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('screen:deny', { userId: btn.dataset.deny });
      });
    });
  }

  function updateViewerCount() {
    const count = Object.keys(peerConnections).length;
    const label = document.getElementById('shareScreenLabel');
    if (isBroadcasting) {
      label.textContent = count > 0 ? `Stop sharing · ${count} watching` : 'Stop sharing';
    }
  }

  async function startViewing() {
    if (viewerPc || isFallbackViewing) stopViewing();
    if (!activeBroadcasterId) return;

    openLiveOverlay();

    // Old browsers without WebRTC → skip straight to canvas frames
    const hasWebRTC = !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
    if (!hasWebRTC) { startFallbackViewing(); return; }

    let pc;
    try { pc = createPeerConnection(); } catch { startFallbackViewing(); return; }

    pendingIceCandidates = [];
    viewerPc = pc;

    pc.ontrack = ({ streams }) => {
      const vid = document.getElementById('liveVideo');
      if (vid.srcObject !== streams[0]) vid.srcObject = streams[0];
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('screen:ice', { targetId: activeBroadcasterId, candidate });
    };

    let iceRestarted = false;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(connectingTimer);
        iceRestarted = false;
      }

      if (pc.connectionState === 'failed') {
        // One ICE restart attempt before giving up (recovers most symmetric-NAT failures)
        if (!iceRestarted && pc.restartIce) {
          iceRestarted = true;
          pc.restartIce();
          socket.emit('screen:join', { broadcasterId: activeBroadcasterId });
          return;
        }
        clearTimeout(connectingTimer);
        const vid = document.getElementById('liveVideo');
        if (!vid.srcObject) { viewerPc = null; pc.close(); startFallbackViewing(); }
        else { showToast('Stream connection lost', 'error'); stopViewing(); }
      }

      if (pc.connectionState === 'disconnected') {
        clearTimeout(connectingTimer);
        const vid = document.getElementById('liveVideo');
        if (!vid.srcObject) { viewerPc = null; pc.close(); startFallbackViewing(); }
        else { showToast('Stream connection lost', 'error'); stopViewing(); }
      }
    };

    socket.emit('screen:join', { broadcasterId: activeBroadcasterId });

    // 10 s timeout — fall back to canvas frames rather than showing an error
    connectingTimer = setTimeout(() => {
      if (viewerPc && viewerPc.connectionState !== 'connected') {
        viewerPc.close();
        viewerPc = null;
        pendingIceCandidates = [];
        startFallbackViewing();
      }
    }, 10000);
  }

  function startFallbackViewing() {
    if (!activeBroadcasterId) return;
    clearTimeout(connectingTimer);
    isFallbackViewing = true;
    // Show img instead of video
    document.getElementById('liveVideo').style.display = 'none';
    document.getElementById('liveFallbackImg').style.display = 'block';
    document.getElementById('liveConnecting').style.display = 'flex';
    socket.emit('screen:watch-fallback', { broadcasterId: activeBroadcasterId });
  }

  function stopViewing() {
    clearTimeout(connectingTimer);
    viewerPc?.close();
    viewerPc = null;
    pendingIceCandidates = [];

    if (isFallbackViewing) {
      isFallbackViewing = false;
      socket.emit('screen:leave-fallback', { broadcasterId: activeBroadcasterId });
      const img = document.getElementById('liveFallbackImg');
      img.src = '';
      img.style.display = 'none';
      document.getElementById('liveVideo').style.display = '';
    }

    const vid = document.getElementById('liveVideo');
    if (vid.srcObject) {
      vid.srcObject.getTracks().forEach((t) => t.stop());
      vid.srcObject = null;
    }

    closeLiveOverlay();

    // Broadcast is still live — restore the watch banner so the user can rejoin
    if (activeBroadcasterId) showLiveBanner(activeBroadcasterName);
  }

  function toggleMute() {
    const vid = document.getElementById('liveVideo');
    const btn = document.getElementById('liveMuteBtn');
    vid.muted = !vid.muted;
    btn.title = vid.muted ? 'Unmute audio' : 'Mute audio';
    // swap the icon
    btn.querySelector('svg').innerHTML = vid.muted
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
      : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
  }

  function showLiveBanner(username) {
    const banner    = document.getElementById('liveBanner');
    const stopBtn   = document.getElementById('adminStopBtn');
    document.getElementById('liveBannerText').textContent = `${username} is sharing their screen`;
    banner.style.display = 'flex';
    banner.classList.remove('live-banner--dismissed');
    if (stopBtn) stopBtn.style.display = isAdmin ? 'flex' : 'none';
  }

  function hideLiveBanner() {
    document.getElementById('liveBanner').style.display = 'none';
  }

  function openLiveOverlay() {
    const overlay = document.getElementById('liveOverlay');
    document.getElementById('liveOverlayLabel').textContent =
      activeBroadcasterName ? `${activeBroadcasterName}'s screen` : 'Screen share';
    document.getElementById('liveConnecting').style.display = 'flex';

    // Reset to video mode (fallback will switch to img if needed)
    document.getElementById('liveVideo').style.display = '';
    document.getElementById('liveFallbackImg').style.display = 'none';

    // Reset quality selector to highest for each new viewing session
    document.getElementById('liveQualitySelect').value = 'high';

    // Always start muted (avoids autoplay-with-audio block on Safari/Firefox)
    const vid = document.getElementById('liveVideo');
    vid.muted = true;
    const muteBtn = document.getElementById('liveMuteBtn');
    muteBtn.title = 'Unmute audio';
    muteBtn.querySelector('svg').innerHTML =
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('live-overlay--visible'));
  }

  function closeLiveOverlay() {
    const overlay = document.getElementById('liveOverlay');
    overlay.classList.remove('live-overlay--visible');
    overlay.addEventListener('transitionend', () => { overlay.style.display = 'none'; }, { once: true });
  }

  // ─── Online users panel ────────────────────────────────────────────────────
  function setupOnlineUsersPanel() {
    const btn   = document.getElementById('onlineCount');
    const panel = document.getElementById('onlineUsersPanel');

    const exportBtn = document.getElementById('exportPresenceBtn');
    if (exportBtn && !isAdmin) exportBtn.style.display = 'none';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', (e) => {
      if (!panel.hidden && !document.getElementById('onlineCountWrap').contains(e.target)) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    document.getElementById('exportPresenceBtn').addEventListener('click', (e) => {
      e.stopPropagation(); // keep the panel open while generating
      exportPresencePDF();
    });
  }

  function renderOnlineUsers() {
    const list = document.getElementById('onlineUsersList');
    if (!list) return;
    list.innerHTML = onlineUsers.map(({ userId, username, profilePic, role }) => {
      const isYou        = username === user.username;
      const isUserAdmin  = role === 'admin';
      const avatarStyle  = profilePic
        ? `background:none;background-image:url(${profilePic});background-size:cover;background-position:center`
        : `background:${getAvatarColor(username)}`;
      const avatarContent = profilePic ? '' : username[0].toUpperCase();
      return `
        <li class="online-user-item" data-user-id="${escapeHtml(userId || '')}">
          <div class="avatar avatar-xs" style="${avatarStyle}">${avatarContent}</div>
          ${isUserAdmin ? `<svg class="admin-crown" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2 20h20v2H2v-2zm2-8l5 3 3-6 3 6 5-3-1.5 7H5.5L4 12z"/></svg>` : ''}
          <span class="user-name">${escapeHtml(username)}</span>
          ${isYou ? '<span class="you-badge">you</span>' : ''}
          ${(isAdmin && !isYou) ? `<button class="kick-btn" title="Remove user" data-kick-id="${escapeHtml(userId || '')}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>` : ''}
        </li>`;
    }).join('');

    if (isAdmin) {
      list.querySelectorAll('.kick-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = btn.dataset.kickId;
          if (targetId) socket.emit('user:kick', { userId: targetId });
        });
      });
    }
  }

  function exportPresencePDF() {
    if (!window.jspdf) { showToast('PDF library not ready, try again', 'error'); return; }

    const { jsPDF } = window.jspdf;
    const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const now  = new Date();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();

    const dateLong = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr  = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // ── Header band ────────────────────────────────────────────────────────
    doc.setFillColor(18, 18, 36);
    doc.rect(0, 0, pageW, 44, 'F');

    doc.setFillColor(124, 58, 237); // purple accent stripe
    doc.rect(0, 0, 4.5, 44, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(226, 232, 240);
    doc.text('ClipShare', 13, 18);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(148, 163, 184);
    doc.text('Presence Report', 13, 27);

    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Generated: ${dateLong} at ${timeStr}`, pageW - 13, 27, { align: 'right' });

    // ── Summary ────────────────────────────────────────────────────────────
    const count = onlineUsers.length;
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 60);
    doc.text(`${count} user${count !== 1 ? 's' : ''} currently online`, 13, 57);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(`Snapshot taken at ${timeStr}`, 13, 64);

    // ── Table ──────────────────────────────────────────────────────────────
    const rows = onlineUsers.map((u, i) => [
      String(i + 1),
      u.username,
      u.username === user.username ? 'You' : '',
    ]);

    doc.autoTable({
      startY: 70,
      head: [['#', 'Username', 'Note']],
      body: rows,
      theme: 'grid',
      headStyles: {
        fillColor:   [124, 58, 237],
        textColor:   [255, 255, 255],
        fontStyle:   'bold',
        fontSize:    10,
        cellPadding: { top: 5, right: 7, bottom: 5, left: 7 },
      },
      bodyStyles: {
        fontSize:    10,
        textColor:   [30, 30, 55],
        cellPadding: { top: 4.5, right: 7, bottom: 4.5, left: 7 },
      },
      alternateRowStyles: { fillColor: [245, 243, 255] },
      columnStyles: {
        0: { cellWidth: 16,   halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 26,   halign: 'center', textColor: [124, 58, 237], fontStyle: 'bold' },
      },
      margin: { left: 13, right: 13 },
      tableLineColor: [220, 215, 240],
      tableLineWidth: 0.25,
      didDrawPage: () => {
        const cur   = doc.internal.getCurrentPageInfo().pageNumber;
        const total = doc.internal.getNumberOfPages();
        doc.setDrawColor(220, 215, 240);
        doc.setLineWidth(0.3);
        doc.line(13, pageH - 14, pageW - 13, pageH - 14);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(148, 163, 184);
        doc.text(`Page ${cur} of ${total}`, 13, pageH - 8);
        doc.text('ClipShare · Presence Report', pageW - 13, pageH - 8, { align: 'right' });
      },
    });

    doc.save(`clipshare-presence-${now.toISOString().slice(0, 10)}.pdf`);
    showToast('Presence PDF downloaded!', 'success');
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  function logout() {
    if (isBroadcasting) stopBroadcasting();
    stopViewing();
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

  // ─── Profile pic helpers ───────────────────────────────────────────────────
  function buildAuthorAvatar(username) {
    const pic = profilePicCache[username];
    if (pic) {
      return `<div class="avatar avatar-xs" style="background:none;background-image:url(${pic});background-size:cover;background-position:center"></div>`;
    }
    return `<div class="avatar avatar-xs" style="background:${getAvatarColor(username)}">${username[0].toUpperCase()}</div>`;
  }

  function compressProfilePic(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const SIZE = 256;
        let { naturalWidth: w, naturalHeight: h } = img;
        const ratio = Math.min(SIZE / w, SIZE / h);
        if (ratio < 1) { w = Math.round(w * ratio); h = Math.round(h * ratio); }
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Failed to read image'));
      img.src = url;
    });
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
