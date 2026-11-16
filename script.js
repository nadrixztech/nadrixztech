'use strict';

let csrfToken = null;
let currentUser = null;
let availableServices = [];
let pendingInstallPrompt = null;

/* -------------------- DOM Ready -------------------- */
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

/* -------------------- Main Init -------------------- */
function initApp() {
  initRoleSelection();
  initSignInForm();
  initServiceCards();
  initOrderForm();
  initAccount();
  initPWA();
  initBottomNav();
  initAdminActions();
  initAdminAnimations();
  initButtons();
  initSmoothScroll();
  initPhoneAnimations();
  loadAppState();
  console.log('%c NADRIX ZTECHNOLOGY App Loaded ', 'background:#17D4C4;color:#0B1F24;font-weight:bold;padding:4px 8px;border-radius:4px;');
}

/* -------------------- Role Selection -------------------- */
function initRoleSelection() {
  const roleCards = document.querySelectorAll('.role-card');
  if (!roleCards.length) return;

  roleCards.forEach(card => {
    card.addEventListener('click', () => {
      roleCards.forEach(role => {
        role.classList.remove('active');
        role.setAttribute('aria-pressed', 'false');
      });
      card.classList.add('active');
      card.setAttribute('aria-pressed', 'true');

      const roleName = card.querySelector('h3')?.textContent?.trim() || 'Unknown';
      showToast(`Selected: ${roleName}. This screen is a UI preview.`, 'info');
    });

    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        card.click();
      }
    });
  });
}

/* -------------------- Sign In Form -------------------- */
function initSignInForm() {
  const form = document.querySelector('.signin');
  if (!form) return;

  const submitButton = form.querySelector('.btn-primary');
  const identityInput = form.querySelector('input[name="identity"]');
  const passwordInput = form.querySelector('input[name="password"]');
  const signupFields = form.querySelector('.signup-fields');
  const emailInput = form.querySelector('input[name="email"]');
  const roleInput = form.querySelector('select[name="role"]');
  const toggleButton = form.querySelector('#toggle-signup');
  const heading = form.querySelector('.signin-heading');
  const identityLabel = form.querySelector('label[for="signin-identity"]');
  const signupPrompt = form.querySelector('.signup-link');
  const socialOptions = form.querySelector('.social-options');
  const forgotButton = form.querySelector('.forgot');

  const setMode = mode => {
    const signingUp = mode === 'signup';
    form.dataset.mode = mode;
    heading.textContent = signingUp ? 'Create Account' : 'Sign In';
    identityLabel.textContent = signingUp ? 'Username' : 'Email or Username';
    identityInput.autocomplete = signingUp ? 'username' : 'username';
    identityInput.placeholder = signingUp ? 'Choose a username' : 'Enter email or username';
    identityInput.maxLength = signingUp ? 30 : 254;
    signupFields.hidden = !signingUp;
    emailInput.required = signingUp;
    roleInput.required = signingUp;
    passwordInput.autocomplete = signingUp ? 'new-password' : 'current-password';
    passwordInput.minLength = signingUp ? 12 : 0;
    socialOptions.hidden = signingUp;
    forgotButton.hidden = signingUp;
    submitButton.textContent = signingUp ? 'Create Account' : 'Sign In';
    signupPrompt.firstChild.textContent = signingUp
      ? 'Already have an account? '
      : "Don't have an account? ";
    toggleButton.textContent = signingUp ? 'Sign in' : 'Create account';
  };

  toggleButton.addEventListener('click', () => {
    setMode(form.dataset.mode === 'signup' ? 'login' : 'signup');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const signingUp = form.dataset.mode === 'signup';
    const identity = identityInput.value.trim();
    const password = passwordInput.value;
    if (!identity) {
      showToast(signingUp ? 'Please choose a username.' : 'Please enter your email or username.', 'error');
      shakeElement(identityInput.closest('.input-wrap'));
      identityInput.focus();
      return;
    }
    if (!password) {
      showToast('Please enter a password.', 'error');
      shakeElement(passwordInput.closest('.input-wrap'));
      passwordInput.focus();
      return;
    }
    if (signingUp && !emailInput.validity.valid) {
      showToast('Enter a valid email address.', 'error');
      emailInput.focus();
      return;
    }
    if (signingUp && password.length < 12) {
      showToast('Password must contain at least 12 characters.', 'error');
      passwordInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = signingUp ? 'Creating account…' : 'Signing in…';
    try {
      const payload = signingUp
        ? {
            username: identity,
            email: emailInput.value.trim(),
            password,
            role: roleInput.value
          }
        : { identity, password };
      const result = await apiRequest(
        signingUp ? '/api/auth/signup' : '/api/auth/login',
        { method: 'POST', body: payload }
      );
      currentUser = result.user;
      csrfToken = result.csrf_token;
      passwordInput.value = '';
      setMode('login');
      updateConnectionStatus(`Signed in as ${currentUser.username}.`);
      await refreshAccount();
      showToast(signingUp ? 'Your account has been created.' : 'You are signed in.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = form.dataset.mode === 'signup' ? 'Create Account' : 'Sign In';
    }
  });

  form.querySelectorAll('.social-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.textContent.includes('Google') ? 'Google' : 'Apple';
      showToast(`${provider} sign-in is not connected in this preview.`, 'info');
    });
  });

  const forgot = form.querySelector('.forgot');
  if (forgot) {
    forgot.addEventListener('click', () => {
      showToast('Password recovery is not set up yet. Contact the site administrator.', 'info');
    });
  }
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `The request failed (${response.status}).`);
  }
  return result;
}

async function loadAppState() {
  try {
    const [session, serviceResult] = await Promise.all([
      apiRequest('/api/session'),
      apiRequest('/api/services')
    ]);
    currentUser = session.user;
    csrfToken = session.csrf_token;
    availableServices = serviceResult.services;
    populateServiceOptions();
    updateConnectionStatus(
      currentUser ? `Signed in as ${currentUser.username}.` : 'Service connected. Sign in or create an account to submit a request.'
    );
    await refreshAccount();
  } catch (error) {
    updateConnectionStatus(`Backend unavailable: ${error.message} Start the app with python3 server.py.`);
  }
}

function updateConnectionStatus(message) {
  const status = document.querySelector('#connection-status');
  if (status) status.textContent = message;
}

function populateServiceOptions() {
  const select = document.querySelector('#order-service');
  if (!select) return;
  select.replaceChildren();
  availableServices.forEach(service => {
    const option = document.createElement('option');
    option.value = service.id;
    option.textContent = service.name;
    select.append(option);
  });
}

async function refreshAccount() {
  const accountContent = document.querySelector('#account-content');
  const greeting = document.querySelector('#account-greeting');
  const adminSummary = document.querySelector('#admin-summary');
  const ordersHeading = document.querySelector('#account-orders h3');
  if (!accountContent) return;

  accountContent.hidden = !currentUser;
  if (!currentUser) {
    adminSummary.hidden = true;
    document.querySelector('#orders-list').replaceChildren();
    return;
  }

  greeting.textContent = `${currentUser.username} · ${currentUser.role}`;
  const isAdmin = currentUser.role === 'admin';
  ordersHeading.textContent = isAdmin ? 'All service requests' : 'Your service requests';
  try {
    const orderResult = await apiRequest('/api/orders');
    renderOrders(orderResult.orders, isAdmin);
    if (isAdmin) {
      const summaryResult = await apiRequest('/api/admin/summary');
      renderAdminSummary(summaryResult.summary);
      adminSummary.hidden = false;
    } else {
      adminSummary.hidden = true;
    }
  } catch (error) {
    updateConnectionStatus(error.message);
  }
}

function renderAdminSummary(summary) {
  const container = document.querySelector('#admin-summary');
  container.replaceChildren();
  [
    ['Users', summary.users],
    ['Service requests', summary.orders],
    ['Services', summary.services],
    ['New requests', summary.new_orders]
  ].forEach(([label, count]) => {
    const item = document.createElement('span');
    item.textContent = `${label}: ${Number(count).toLocaleString()}`;
    container.append(item);
  });
}

function renderOrders(orders, isAdmin) {
  const list = document.querySelector('#orders-list');
  list.replaceChildren();
  if (!orders.length) {
    const empty = document.createElement('p');
    empty.className = 'connection-status';
    empty.textContent = 'No service requests yet.';
    list.append(empty);
    return;
  }

  orders.forEach(order => {
    const card = document.createElement('article');
    card.className = 'order-card';
    const header = document.createElement('div');
    header.className = 'order-card-header';
    const title = document.createElement('span');
    title.textContent = `${order.service} · #${order.id}`;
    const status = document.createElement('span');
    status.textContent = order.status.replace('_', ' ');
    header.append(title, status);
    card.append(header);

    if (isAdmin && order.username) {
      const customer = document.createElement('p');
      customer.textContent = `Customer: ${order.username}`;
      card.append(customer);
    }
    const details = document.createElement('p');
    details.textContent = order.details;
    card.append(details);
    const created = document.createElement('time');
    created.dateTime = new Date(order.created_at * 1000).toISOString();
    created.textContent = new Date(order.created_at * 1000).toLocaleString();
    card.append(created);

    if (isAdmin) {
      const select = document.createElement('select');
      select.className = 'order-status-select';
      select.setAttribute('aria-label', `Update status for request ${order.id}`);
      ['new', 'in_progress', 'completed', 'cancelled'].forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value.replace('_', ' ');
        option.selected = value === order.status;
        select.append(option);
      });
      select.addEventListener('change', () => updateOrderStatus(order.id, select.value, select));
      card.append(select);
    }
    list.append(card);
  });
}

async function updateOrderStatus(orderId, status, select) {
  select.disabled = true;
  try {
    await apiRequest(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      body: { status }
    });
    await refreshAccount();
    showToast(`Request #${orderId} updated.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
    await refreshAccount();
  } finally {
    select.disabled = false;
  }
}

function initAccount() {
  document.querySelector('#logout-button')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
      currentUser = null;
      csrfToken = null;
      await refreshAccount();
      updateConnectionStatus('You have signed out.');
      showToast('You have signed out.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function initOrderForm() {
  const dialog = document.querySelector('#order-dialog');
  const form = document.querySelector('#order-form');
  if (!dialog || !form) return;
  const serviceSelect = form.querySelector('#order-service');
  const detailsInput = form.querySelector('#order-details');
  const status = form.querySelector('.order-status');

  document.querySelectorAll('[data-service-name], .service-item, .popular-card').forEach(button => {
    button.addEventListener('click', () => {
      const requestedName = button.dataset.serviceName || button.getAttribute('aria-label') || 'Business Website';
      if (!currentUser) {
        showToast('Sign in or create an account before submitting a request.', 'info');
        document.querySelector('.signin')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (!availableServices.length) {
        showToast('Services are not available yet. Check the server connection and try again.', 'error');
        return;
      }
      const match = availableServices.find(service => service.name.toLowerCase() === requestedName.toLowerCase());
      if (match) serviceSelect.value = String(match.id);
      status.textContent = '';
      detailsInput.value = '';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else showToast('Your browser does not support the service request form.', 'error');
    });
  });

  document.querySelector('#cancel-order')?.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentUser) {
      status.textContent = 'Sign in before submitting a service request.';
      return;
    }
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    status.textContent = 'Sending your request…';
    try {
      await apiRequest('/api/orders', {
        method: 'POST',
        body: {
          service_id: Number(serviceSelect.value),
          details: detailsInput.value.trim()
        }
      });
      dialog.close();
      await refreshAccount();
      showToast('Your service request was submitted.', 'success');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}

function initPWA() {
  const installButton = document.querySelector('#install-app');
  if (!installButton) return;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pendingInstallPrompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    if (!pendingInstallPrompt) return;
    try {
      await pendingInstallPrompt.prompt();
      const choice = await pendingInstallPrompt.userChoice;
      pendingInstallPrompt = null;
      installButton.hidden = true;
      if (choice.outcome === 'accepted') showToast('NADRIX is being installed.', 'success');
    } catch (error) {
      showToast(`Could not start installation: ${error.message}`, 'error');
    }
  });
  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
    showToast('NADRIX has been installed.', 'success');
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(error => {
      updateConnectionStatus(`Offline support could not start: ${error.message}`);
    });
  }
}

/* -------------------- Service Cards -------------------- */
function initServiceCards() {
  const services = document.querySelectorAll('.service-item');
  if (!services.length) return;

  services.forEach(item => {
    item.addEventListener('click', () => {
      item.style.transform = 'scale(0.95)';
      setTimeout(() => {
        item.style.transform = '';
      }, 150);
    });
  });

  const searchInput = document.querySelector('#service-search');
  const searchStatus = document.querySelector('.search-status');
  if (searchInput && searchStatus) {
    const serviceCards = [...document.querySelectorAll('.service-item')];
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLocaleLowerCase();
      const visibleCount = serviceCards.filter(card => {
        const matches = card.textContent.toLocaleLowerCase().includes(query);
        card.hidden = !matches;
        return matches;
      }).length;

      searchStatus.textContent = query
        ? visibleCount
          ? `${visibleCount} ${visibleCount === 1 ? 'service' : 'services'} found.`
          : 'No services match your search.'
        : '';
    });
  }
}

/* -------------------- Bottom Navigation -------------------- */
function initBottomNav() {
  const navItems = document.querySelectorAll('.bottom-nav .nav-item, .admin-nav .nav-item');
  if (!navItems.length) return;

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      // Find parent nav
      const parent = item.closest('.bottom-nav, .admin-nav');
      if (!parent) return;

      // Remove active from siblings
      parent.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active');
        n.setAttribute('aria-pressed', 'false');
      });
      item.classList.add('active');
      item.setAttribute('aria-pressed', 'true');

      const label = item.textContent.trim();
      if (label === 'Orders') {
        document.querySelector('#account-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      showToast(`${label} selected. Navigation is a UI preview.`, 'info');
    });
  });
}

/* -------------------- Admin Dashboard Actions -------------------- */
function initAdminActions() {
  // Quick action buttons
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.textContent.trim();
      showToast(`${action} is not connected in this preview.`, 'info');
    });
  });

  document.querySelector('.menu-btn')?.addEventListener('click', () => {
    showToast('The admin menu is not connected in this preview.', 'info');
  });
}

/* -------------------- General Buttons -------------------- */
function initButtons() {
  document.querySelectorAll('.link-button').forEach(button => {
    if (button.id === 'toggle-signup' || button.id === 'logout-button') return;
    button.addEventListener('click', () => {
      showToast(button.dataset.message || 'This action is not available in this prototype.', 'info');
    });
  });

  // Get Started / Continue buttons
  document.querySelectorAll('.btn-primary').forEach(btn => {
    // Skip sign-in button (already handled)
    if (btn.closest('.signin')) return;

    btn.addEventListener('click', () => {
      const text = btn.textContent.trim();

      if (text.includes('Get Started')) {
        showToast('You are viewing the NADRIX app preview.', 'info');
        pulseElement(btn);
      } else if (text.includes('Continue')) {
        const activeRole = document.querySelector('.role-card.active h3')?.textContent || 'Customer';
        showToast(`${activeRole} selected. Navigation is a UI preview.`, 'info');
        pulseElement(btn);
      }
    });
  });

  // Header icon buttons
  document.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const icon = btn.textContent.trim();
      if (icon.includes('🔔')) {
        showToast('Notifications are not connected in this preview.', 'info');
      } else {
        showToast('The profile menu is not connected in this preview.', 'info');
      }
    });
  });
}

/* -------------------- Smooth Scroll -------------------- */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      const targetId = anchor.getAttribute('href')?.slice(1);
      if (!targetId) {
        e.preventDefault();
        return;
      }

      const target = document.getElementById(targetId);
      if (!target) return;

      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* -------------------- Phone Entrance Animations -------------------- */
function initPhoneAnimations() {
  const phones = document.querySelectorAll('.phone-wrapper');
  if (!phones.length || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Intersection Observer for scroll animations
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, index) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
        }, index * 80);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  phones.forEach(phone => {
    phone.style.opacity = '0';
    phone.style.transform = 'translateY(30px)';
    phone.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    observer.observe(phone);
  });
}

/* -------------------- Toast Notification System -------------------- */
function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.nadrix-toast');
  if (existing) existing.remove();

  const colors = {
    success: { bg: 'rgba(23, 212, 196, 0.95)',  text: '#0B1F24' },
    error:   { bg: 'rgba(255, 80, 80, 0.95)',    text: '#fff' },
    info:    { bg: 'rgba(15, 42, 48, 0.95)',     text: '#17D4C4' },
    warning: { bg: 'rgba(255, 122, 0, 0.95)',    text: '#fff' }
  };

  const style = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.className = 'nadrix-toast';
  toast.textContent = message;

  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '30px',
    left: '50%',
    transform: 'translateX(-50%) translateY(20px)',
    background: style.bg,
    color: style.text,
    padding: '12px 24px',
    borderRadius: '12px',
    fontSize: '13px',
    fontWeight: '600',
    fontFamily: "'Poppins', sans-serif",
    zIndex: '99999',
    boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
    opacity: '0',
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(23, 212, 196, 0.2)',
    maxWidth: '90%',
    textAlign: 'center',
    pointerEvents: 'none'
  });

  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  // Auto remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* -------------------- Utility: Shake Animation -------------------- */
function shakeElement(el) {
  if (!el) return;
  el.style.transition = 'transform 0.1s';
  el.style.transform = 'translateX(-6px)';
  setTimeout(() => { el.style.transform = 'translateX(6px)'; }, 80);
  setTimeout(() => { el.style.transform = 'translateX(-4px)'; }, 160);
  setTimeout(() => { el.style.transform = 'translateX(4px)'; }, 240);
  setTimeout(() => { el.style.transform = 'translateX(0)'; }, 320);
}

/* -------------------- Utility: Pulse Animation -------------------- */
function pulseElement(el) {
  if (!el) return;
  el.style.transition = 'transform 0.15s ease';
  el.style.transform = 'scale(0.96)';
  setTimeout(() => {
    el.style.transform = 'scale(1)';
  }, 150);
}

/* -------------------- Counter Animation (Admin Stats) -------------------- */
function animateCounters() {
  const counters = document.querySelectorAll('.stat-card .value');
  if (!counters.length) return;

  counters.forEach(counter => {
    const text = counter.textContent.trim();
    const isCurrency = text.includes('₹');
    const numeric = parseInt(text.replace(/[^\d]/g, ''), 10);

    if (isNaN(numeric)) return;

    let current = 0;
    const increment = Math.ceil(numeric / 40);
    const timer = setInterval(() => {
      current += increment;
      if (current >= numeric) {
        current = numeric;
        clearInterval(timer);
      }
      counter.textContent = isCurrency
        ? '₹' + current.toLocaleString('en-IN')
        : current.toLocaleString('en-IN');
    }, 30);
  });
}

/* -------------------- Chart Bar Animation -------------------- */
function animateChartBars() {
  const bars = document.querySelectorAll('.chart-bars .bar');
  if (!bars.length) return;

  bars.forEach((bar, i) => {
    const targetHeight = bar.style.height;
    bar.style.height = '0%';
    setTimeout(() => {
      bar.style.transition = 'height 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
      bar.style.height = targetHeight;
    }, 100 + i * 50);
  });
}

/* -------------------- Run animations when admin dashboard is visible -------------------- */
function initAdminAnimations() {
  const adminDash = document.querySelector('.admin-dash');
  if (!adminDash) return;

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animateCounters();
    animateChartBars();
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      animateCounters();
      animateChartBars();
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.3 });

  observer.observe(adminDash);
}

/* -------------------- Keyboard Shortcuts -------------------- */
document.addEventListener('keydown', (e) => {
  // Escape closes any toast
  if (e.key === 'Escape') {
    const toast = document.querySelector('.nadrix-toast');
    if (toast) toast.remove();
  }
});

/* -------------------- Export for potential module use -------------------- */
window.NadrixApp = {
  showToast,
  shakeElement,
  pulseElement,
  animateCounters,
  animateChartBars
};
