const api = (() => {
  const getToken = () => localStorage.getItem('cs_token');

  const request = async (path, options = {}) => {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${CONFIG.API_URL}${path}`, { ...options, headers });
    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data.message || 'Request failed');
      err.status = res.status;
      throw err;
    }

    return data;
  };

  return {
    auth: {
      register: (body) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
      login:    (body) => request('/api/auth/login',    { method: 'POST', body: JSON.stringify(body) }),
      me:       ()     => request('/api/auth/me'),
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
      list:   ()          => request('/api/workspaces'),
      create: (name)      => request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
      rename: (id, name)  => request(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
      remove: (id)        => request(`/api/workspaces/${id}`, { method: 'DELETE' }),
    },
  };
})();
