(() => {
  // Redirect if already logged in
  if (localStorage.getItem('cs_token')) {
    window.location.replace('board.html');
    return;
  }

  // ─── Tab switching ─────────────────────────────────────────────────────────
  const tabs = document.querySelectorAll('.auth-tab');
  const forms = document.querySelectorAll('.auth-form');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.remove('active'));
      forms.forEach((f) => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(target === 'login' ? 'loginForm' : 'registerForm').classList.add('active');
      clearErrors();
    });
  });

  // ─── Password visibility toggle ────────────────────────────────────────────
  document.querySelectorAll('.toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.querySelector('.eye-icon').style.opacity = input.type === 'text' ? '0.4' : '1';
    });
  });

  // ─── Password strength ─────────────────────────────────────────────────────
  const regPassword = document.getElementById('regPassword');
  const strengthFill = document.getElementById('strengthFill');
  const strengthLabel = document.getElementById('strengthLabel');

  regPassword?.addEventListener('input', () => {
    const val = regPassword.value;
    const score = getPasswordStrength(val);
    const levels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    const colors = ['', '#ef4444', '#f59e0b', '#3b82f6', '#10b981'];
    const widths = ['0%', '25%', '50%', '75%', '100%'];

    strengthFill.style.width = widths[score];
    strengthFill.style.background = colors[score];
    strengthLabel.textContent = val.length > 0 ? levels[score] : '';
    strengthLabel.style.color = colors[score];
  });

  function getPasswordStrength(pwd) {
    if (pwd.length < 6) return 1;
    let score = 1;
    if (pwd.length >= 8) score++;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd) && /[^A-Za-z0-9]/.test(pwd)) score++;
    return score;
  }

  // ─── Login ─────────────────────────────────────────────────────────────────
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    clearErrors();

    if (!email || !password) {
      showError(errorEl, 'Please fill in all fields');
      return;
    }

    setLoading(btn, true);
    try {
      const { token, user } = await api.auth.login({ email, password });
      saveSession(token, user);
      window.location.replace('board.html');
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      setLoading(btn, false);
    }
  });

  // ─── Register ──────────────────────────────────────────────────────────────
  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const errorEl = document.getElementById('registerError');
    const btn = document.getElementById('registerBtn');

    clearErrors();

    if (!username || !email || !password) {
      showError(errorEl, 'Please fill in all fields');
      return;
    }
    if (password.length < 6) {
      showError(errorEl, 'Password must be at least 6 characters');
      return;
    }

    setLoading(btn, true);
    try {
      const { token, user } = await api.auth.register({ username, email, password });
      saveSession(token, user);
      window.location.replace('board.html');
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      setLoading(btn, false);
    }
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function saveSession(token, user) {
    localStorage.setItem('cs_token', token);
    localStorage.setItem('cs_user', JSON.stringify(user));
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearErrors() {
    document.querySelectorAll('.form-error').forEach((el) => {
      el.textContent = '';
      el.style.display = 'none';
    });
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }
})();
