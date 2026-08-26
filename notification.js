import { db } from './firebase-config.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const notificationLimit = 20;
let notifications = [];
let pendingReports = [];

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const getDate = (value) => {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDate = (value) => {
  const date = getDate(value);
  if (!date) return 'Just now';
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
};

const sortNotifications = (items) => items
  .sort((first, second) => (getDate(second.createdAt)?.getTime() || 0) - (getDate(first.createdAt)?.getTime() || 0))
  .slice(0, notificationLimit);

const pendingReadKey = (id) => `peakpath:pending-hazard-read:${id}`;

const isPendingRead = (id) => localStorage.getItem(pendingReadKey(id)) === 'true';

const refreshNotifications = () => {
  const pendingNotifications = pendingReports.map((report) => ({
    id: `report-${report.id}`,
    type: 'hazard_pending',
    title: 'New hazard report',
    message: `${report.hazardType || 'Hazard'} at ${report.location || 'reported location'} is awaiting verification.`,
    createdAt: report.timestamp || report.createdAt,
    read: isPendingRead(report.id),
    reportDocumentId: report.id
  }));

  notifications = sortNotifications(pendingNotifications);
  render();
};

const render = () => {
  document.querySelectorAll('.notification-center').forEach((center) => {
    const badge = center.querySelector('.bell-badge');
    const list = center.querySelector('.notification-list');
    const unreadCount = notifications.filter((item) => item.read !== true).length;

    badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    badge.hidden = unreadCount === 0;

    if (!notifications.length) {
      list.innerHTML = '<div class="notification-empty">No hazard reports to review.</div>';
      return;
    }

    list.innerHTML = notifications.map((item) => `
      <a class="notification-item${item.read === true ? '' : ' unread'}" href="hazardreport.html" data-notification-id="${escapeHtml(item.id)}">
        <span class="notification-mark" aria-hidden="true">!</span>
        <span class="notification-copy">
          <strong>${escapeHtml(item.title || 'Hazard report update')}</strong>
          <span>${escapeHtml(item.message || `${item.hazardType || 'Hazard'} at ${item.location || 'reported location'} is awaiting verification.`)}</span>
          <small>${escapeHtml(formatDate(item.createdAt))}</small>
        </span>
      </a>
    `).join('');
  });
};

const markAsRead = (notificationId) => {
  const notification = notifications.find((item) => item.id === notificationId);
  if (!notification || notification.read === true) return;
  localStorage.setItem(pendingReadKey(notification.reportDocumentId), 'true');
  notification.read = true;
  render();
};

const setupCenter = (center) => {
  const button = center.querySelector('.bell-btn');
  const panel = center.querySelector('.notification-panel');
  if (!button || !panel) return;

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = panel.classList.toggle('open');
    button.setAttribute('aria-expanded', String(isOpen));
  });

  panel.addEventListener('click', (event) => {
    const item = event.target.closest('[data-notification-id]');
    if (item) markAsRead(item.dataset.notificationId);
  });
};

document.querySelectorAll('.bell-wrap').forEach((bell) => {
  bell.classList.add('notification-center');
  bell.innerHTML = `
    <button class="bell-btn" type="button" aria-label="Open notifications" aria-expanded="false">
      <span class="bell-icon" aria-hidden="true">&#128276;</span>
    </button>
    <span class="bell-badge" aria-live="polite" hidden>0</span>
    <div class="notification-panel" role="region" aria-label="Notifications">
      <div class="notification-header"><strong>Notifications</strong><span>New hazard reports</span></div>
      <div class="notification-list"><div class="notification-empty">Loading notifications...</div></div>
    </div>
  `;
  setupCenter(bell);
});

document.addEventListener('click', () => {
  document.querySelectorAll('.notification-panel.open').forEach((panel) => {
    panel.classList.remove('open');
    panel.closest('.notification-center')?.querySelector('.bell-btn')?.setAttribute('aria-expanded', 'false');
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.notification-panel.open').forEach((panel) => {
    panel.classList.remove('open');
    panel.closest('.notification-center')?.querySelector('.bell-btn')?.setAttribute('aria-expanded', 'false');
  });
});

onSnapshot(collection(db, 'reports'), (snapshot) => {
  pendingReports = snapshot.docs
    .map((report) => ({ id: report.id, ...report.data() }))
    .filter((report) => (report.status || 'pending').toLowerCase() === 'pending');
  refreshNotifications();
}, (error) => {
  console.error('Unable to load pending hazard reports:', error);
  refreshNotifications();
});
