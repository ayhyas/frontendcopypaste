const api = (() => {
  const getToken = () => localStorage.getItem('cs_token');
  let _wsToken = null;

  const request = async (path, options = {}) => {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (_wsToken) headers['x-workspace-token'] = _wsToken;

    const res = await fetch(`${CONFIG.API_URL}${path}`, { ...options, headers });
    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data.message || 'Request failed');
      err.status = res.status;
      err.code   = data.code || null;
      throw err;
    }

    return data;
  };

  return {
    setWorkspaceToken: (t) => { _wsToken = t || null; },
    auth: {
      register:         (body) => request('/api/auth/register',     { method: 'POST',  body: JSON.stringify(body) }),
      login:            (body) => request('/api/auth/login',         { method: 'POST',  body: JSON.stringify(body) }),
      me:               ()     => request('/api/auth/me'),
      updateProfilePic: (profilePic) => request('/api/auth/profile-pic', { method: 'PATCH', body: JSON.stringify({ profilePic }) }),
    },
    clips: {
      list:   (page = 1, workspaceId = null) => {
        const params = new URLSearchParams({ page, limit: 50 });
        if (workspaceId) params.set('workspace', workspaceId);
        return request(`/api/clips?${params}`);
      },
      create: (body)     => request('/api/clips', { method: 'POST', body: JSON.stringify(body) }),
      update: (id, body) => request(`/api/clips/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id)       => request(`/api/clips/${id}`, { method: 'DELETE' }),
    },
    workspaces: {
      list:       ()              => request('/api/workspaces'),
      create:     (name)          => request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
      rename:     (id, name)      => request(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
      remove:     (id)            => request(`/api/workspaces/${id}`, { method: 'DELETE' }),
      lock:       (id, password)  => request(`/api/workspaces/${id}/lock`, { method: 'PATCH', body: JSON.stringify({ password }) }),
      removeLock: (id)            => request(`/api/workspaces/${id}/lock`, { method: 'DELETE' }),
      getLock:    (id)            => request(`/api/workspaces/${id}/lock`),
      verify:     (id, password)  => request(`/api/workspaces/${id}/verify`, { method: 'POST', body: JSON.stringify({ password }) }),
    },
    drawings: {
      list:   (workspaceId) => {
        const p = workspaceId ? `?workspace=${workspaceId}` : '';
        return request(`/api/drawings${p}`);
      },
      create: (title, elements, preview, workspaceId) =>
        request('/api/drawings', { method: 'POST', body: JSON.stringify({ title, elements, preview, workspaceId }) }),
      rename: (id, title) => request(`/api/drawings/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
      remove: (id) => request(`/api/drawings/${id}`, { method: 'DELETE' }),
    },
    resources: {
      list:   (workspaceId) => {
        const p = workspaceId ? `?workspace=${workspaceId}` : '';
        return request(`/api/resources${p}`);
      },
      create: (type, name, content, workspaceId) =>
        request('/api/resources', { method: 'POST', body: JSON.stringify({ type, name, content, workspaceId }) }),
      remove: (id) => request(`/api/resources/${id}`, { method: 'DELETE' }),
    },
  };
})();
