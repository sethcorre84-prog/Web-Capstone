import { db } from './firebase-config.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const notificationLimit = 20;
let notifications = [];
let pendingReports = [];
let activeAdvisories = [];

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
// Versioned so re-accepting an expired advisory (which stamps a fresh
// restoredAt) gets a brand-new key — any "read" flag from before it expired
// no longer applies, and the notification comes back as unread/recent.
const advisoryReadKey = (id, version) => `peakpath:advisory-read:${id}:${version || 0}`;
// Pre-versioning key, kept only to migrate old read flags forward (see below).
const legacyAdvisoryReadKey = (id) => `peakpath:advisory-read:${id}`;

// Reads back when a notification was actually opened. Older entries were
// written as the literal string 'true' (before read receipts existed) —
// treat those as "read just now" rather than losing the read state.
const getReadAt = (key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  if (raw === 'true') return new Date();
  return getDate(raw);
};

// Advisories read before the versioned key existed are still tracked under
// the old, unversioned key. Migrate that flag forward so an advisory that
// simply never expired doesn't suddenly reappear as unread — but skip the
// migration once the advisory has actually been restored from Expired,
// since that case should always come back as unread/recent.
const getAdvisoryReadAt = (advisory, readKey) => {
  const direct = getReadAt(readKey);
  if (direct) return direct;
  if (advisory.restoredAt) return null;

  const legacyKey = legacyAdvisoryReadKey(advisory.id);
  if (!localStorage.getItem(legacyKey)) return null;

  const now = new Date();
  localStorage.setItem(readKey, now.toISOString());
  localStorage.removeItem(legacyKey);
  return now;
};

const refreshNotifications = () => {
  const pendingNotifications = pendingReports.map((report) => {
    const readKey = pendingReadKey(report.id);
    const readAt = getReadAt(readKey);
    return {
      id: `report-${report.id}`,
      type: 'hazard_pending',
      title: 'New hazard report',
      message: `${report.hazardType || 'Hazard'} at ${report.location || 'reported location'} is awaiting verification.`,
      createdAt: report.timestamp || report.createdAt,
      read: !!readAt,
      readAt,
      readKey,
      reportDocumentId: report.id
    };
  });

  const advisoryNotifications = activeAdvisories.map((advisory) => {
    const createdAt = advisory.restoredAt || advisory.effectiveDate || advisory.createdAt || advisory.publishedAt;
    const readKey = advisoryReadKey(advisory.id, getDate(createdAt)?.getTime());
    const readAt = getAdvisoryReadAt(advisory, readKey);
    return {
      id: `advisory-${advisory.id}`,
      type: 'advisory',
      title: advisory.title || 'New advisory',
      message: advisory.desc || `${advisory.type || 'Advisory'} for ${advisory.target || 'all trails'} is now available.`,
      createdAt,
      read: !!readAt,
      readAt,
      readKey,
      advisoryDocumentId: advisory.id,
      link: `A&A.html?advisory=${encodeURIComponent(advisory.id)}`
    };
  });

  notifications = sortNotifications([...pendingNotifications, ...advisoryNotifications]);
  render();
};

const render = () => {
  document.querySelectorAll('.notification-center').forEach((center) => {
    const badge = center.querySelector('.bell-badge');
    const list = center.querySelector('.notification-list');
    const unreadCount = notifications.filter((item) => item.read !== true).length;

    badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    badge.hidden = unreadCount === 0;

    // Kept enabled in the DOM (only visually dimmed) so clicks are still
    // dispatched and the panel-level handler can stop them from bubbling to
    // the document close handler.
    const markAllBtn = center.querySelector('.notification-mark-all');
    if (markAllBtn) {
      markAllBtn.classList.toggle('is-disabled', unreadCount === 0);
      markAllBtn.setAttribute('aria-disabled', String(unreadCount === 0));
    }

    if (!notifications.length) {
      list.innerHTML = '<div class="notification-empty">No alerts to review.</div>';
      return;
    }

    list.innerHTML = notifications.map((item) => {
      const href = item.type === 'advisory'
    ? (item.link || 'A&A.html')
    : `hazardreport.html?report=${encodeURIComponent(item.reportDocumentId)}`;
      const fallbackText = item.type === 'advisory'
        ? (item.message || 'A new advisory is available.')
        : (item.hazardType ? `${item.hazardType} at ${item.location || 'reported location'} is awaiting verification.` : 'Hazard report update');

      const retrievedLine = item.read === true
        ? `<small class="notification-retrieved">Retrieved ${escapeHtml(formatDate(item.readAt))}</small>`
        : '';

      return `
        <a class="notification-item${item.read === true ? '' : ' unread'}" href="${href}" data-notification-id="${escapeHtml(item.id)}">
          <span class="notification-mark" aria-hidden="true">!</span>
          <span class="notification-copy">
            <strong>${escapeHtml(item.title || 'Update')}</strong>
            <span>${escapeHtml(item.message || fallbackText)}</span>
            <small>${escapeHtml(formatDate(item.createdAt))}</small>
            ${retrievedLine}
          </span>
        </a>
      `;
    }).join('');
  });
};

const markAsRead = (notificationId) => {
  const notification = notifications.find((item) => item.id === notificationId);
  if (!notification || notification.read === true) return;
  const now = new Date();
  localStorage.setItem(notification.readKey, now.toISOString());
  notification.read = true;
  notification.readAt = now;
  render();
};

const markAllAsRead = () => {
  const hasUnread = notifications.some((item) => item.read !== true);
  if (!hasUnread) return;

  const now = new Date();
  notifications.forEach((notification) => {
    if (notification.read === true) return;
    localStorage.setItem(notification.readKey, now.toISOString());
    notification.read = true;
    notification.readAt = now;
  });

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
    if (item) {
      // The item is a link, so the page navigates away; let the click through.
      markAsRead(item.dataset.notificationId);
      return;
    }

    // Any other click inside the panel (including "Mark all as read") keeps the
    // notification interface open instead of letting the document handler
    // close it.
    event.stopPropagation();

    if (event.target.closest('.notification-mark-all')) {
      event.preventDefault();
      markAllAsRead();
    }
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
      <div class="notification-header">
        <strong>Notifications</strong>
        <button type="button" class="notification-mark-all is-disabled" aria-disabled="true">Mark all as read</button>
      </div>
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

onSnapshot(collection(db, 'Advisory'), (snapshot) => {
  activeAdvisories = snapshot.docs
    .map((advisory) => ({ id: advisory.id, ...advisory.data() }))
    .filter((advisory) => advisory.visible !== false)
    .filter((advisory) => (advisory.status || 'Active').toLowerCase() !== 'expired')
    .filter((advisory) => Array.isArray(advisory.channels) && advisory.channels.includes('In-App'));
  refreshNotifications();
}, (error) => {
  console.error('Unable to load advisory notifications:', error);
  refreshNotifications();
});
