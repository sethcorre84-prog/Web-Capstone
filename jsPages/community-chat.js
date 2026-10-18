// community-chat.js
// Chats for the portal, from a chat button beside the notification bell on
// every page that has one (notification.js mounts it). Like Messenger's
// dropdown, the button opens a list of conversations first; picking one
// opens it, with a back arrow to the list.
//
// Two kinds of conversation, both the PeakPath app's own documents (ChatService
// in the app's lib/features/chat/chat_service.dart), under its firestore.rules:
//
//   communityChat/{id}            the one public room every hiker reads
//     senderId, senderName, senderUsername, type ("text"), text, createdAt
//     An admin's delete keeps the message as type "removed" with its text
//     wiped (removedBy, removedAt), so the app shows that an admin removed
//     it for the safety guidelines instead of it silently vanishing.
//
//   chats/{uidA_uidB}             a private chat between this admin and one
//     participants [uidA, uidB]   user (uids sorted), e.g. a warning sent
//     participantInfo {uid: {name, username}}   from User Reports
//     lastMessage, lastSenderId, lastMessageAt, unread {uid: n}, lastReadAt
//     adminNotice: true          the user can read but not reply (firestore.rules)
//   chats/{id}/messages/{id}
//     senderId, type ("text"), text, createdAt
//
// The app shows only a sender's name, so an admin's name carries "(Admin)".
// Every admin only watches the Community Chat here: no message box, just
// deleting messages. Private chats (e.g. Warn User) still send.
// Hikers' chats with each other are readable by their members only, so the
// list holds the Community Chat and this admin's own private chats.

import { auth, db, storage } from './firebase-config.js';
import { escapeHtml } from './utils.js';
import { getAdvisoryAuthorName } from './advisory-author.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDownloadURL, ref } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import {
  collection, deleteDoc, deleteField, doc, getDoc, increment, limit, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const ROOM = 'communityChat';
const MESSAGE_LIMIT = 200;   // the newest messages, as in the app
const MAX_LENGTH = 1000;     // longest message an admin can type in a private chat
// What hikers see in place of a message an admin removed (the app says the same).
const REMOVED_NOTE = "Removed by an admin for going against PeakPath's safety guidelines.";
const seenKey = (uid) => `peakpath:community-last-seen:${uid}`;

const CSS = `
.chat-wrap { position: relative; }
.chat-wrap .chat-btn { width: 100%; height: 100%; border: 0; background: transparent; padding: 0;
  color: var(--accent, #2f8f4e); font-size: 18px; line-height: 1; cursor: pointer; }
.chat-wrap .chat-btn:focus-visible { outline: 2px solid var(--accent, #2f8f4e); outline-offset: 2px; }
.chat-wrap .bell-badge[hidden] { display: none; }
.chat-panel { position: absolute; top: calc(100% + 10px); right: 0; z-index: 60; display: none;
  flex-direction: column; width: min(380px, calc(100vw - 32px)); height: min(520px, calc(100vh - 120px));
  background: var(--card-bg, #fff); border: 1px solid var(--border, #e4e7e1); border-radius: 12px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, .18); overflow: hidden; text-align: left; cursor: default;
  color: var(--text-primary, #1c231c); }
.chat-panel.open { display: flex; }
/* pages.css colours every icon green by default; in the chat each icon takes
   its container's colour (white on the green avatar and Send button). */
.chat-panel i, .chat-confirm i { color: inherit; }
.chat-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
.chat-panel[data-view="list"] .chat-view-list,
.chat-panel[data-view="room"] .chat-view-room { display: flex; }

/* The list of chats */
.chat-list-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
.chat-list-head h3 { margin: 0; font-size: 20px; font-weight: 700; }
.chat-icon-btn { width: 30px; height: 30px; flex-shrink: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: var(--dm-surface-2, #f1f3ef); color: var(--text-secondary, #5b6b60); font-size: 13px; }
.chat-icon-btn:hover { color: var(--text-primary, #1c231c); }
.chat-search { display: flex; align-items: center; gap: 8px; margin: 0 16px; padding: 8px 12px; border-radius: 20px;
  background: var(--dm-surface-2, #f1f3ef); color: var(--text-secondary, #5b6b60); }
.chat-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit;
  font-size: 13px; color: var(--text-primary, #1c231c); }
.chat-tabs { display: flex; gap: 6px; padding: 10px 16px 6px; }
.chat-tabs button { border: 0; border-radius: 20px; padding: 6px 12px; cursor: pointer; font: inherit;
  font-size: 12.5px; font-weight: 600; background: transparent; color: var(--text-secondary, #5b6b60); }
.chat-tabs button.active { background: var(--accent-light, #e7f5eb); color: var(--accent, #2f8f4e); }
.chat-threads { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 10px; }
.chat-thread { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 8px; border: 0;
  border-radius: 10px; background: transparent; cursor: pointer; text-align: left; font: inherit; color: inherit; }
.chat-thread:hover { background: var(--dm-surface-2, #f1f3ef); }
.chat-avatar { position: relative; flex-shrink: 0; display: grid; place-items: center; width: 48px; height: 48px;
  border-radius: 50%; background: var(--accent, #2f8f4e); color: #fff; font-size: 20px; font-weight: 700; }
.chat-avatar.is-person { background: #2a63b5; font-size: 16px; overflow: hidden; }
.chat-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.chat-thread-text { flex: 1; min-width: 0; }
.chat-thread-name { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.chat-thread-preview { display: block; margin-top: 2px; font-size: 12.5px; color: var(--text-secondary, #5b6b60);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-thread.unread .chat-thread-name,
.chat-thread.unread .chat-thread-preview { font-weight: 700; color: var(--text-primary, #1c231c); }
.chat-unread-dot { flex-shrink: 0; width: 10px; height: 10px; border-radius: 50%; background: var(--accent, #2f8f4e); }
.chat-list-empty { padding: 30px 16px; text-align: center; font-size: 12.5px; color: var(--text-secondary, #5b6b60); }

/* One conversation */
.chat-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-bottom: 1px solid var(--border, #e4e7e1); }
.chat-head .chat-avatar { width: 36px; height: 36px; font-size: 15px; }
.chat-head .chat-avatar.is-person { font-size: 13px; }
/* The title block only: the logo beside it is a span too, and must keep its
   white, centred icon. */
.chat-head-title { min-width: 0; }
.chat-head-title strong { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-head-title span { display: block; font-size: 11.5px; color: var(--text-secondary, #5b6b60); }
.chat-head .chat-icon-btn:last-child { margin-left: auto; }
.chat-messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px;
  display: flex; flex-direction: column; gap: 8px; }
.chat-empty { margin: auto; text-align: center; font-size: 12.5px; color: var(--text-secondary, #5b6b60); }
.chat-day { align-self: center; margin: 6px 0 2px; padding: 2px 10px; border-radius: 20px; font-size: 11px;
  background: var(--dm-surface-2, #f1f3ef); color: var(--text-secondary, #5b6b60); }
.chat-msg { display: flex; flex-direction: column; max-width: 82%; align-self: flex-start; }
.chat-msg.mine { align-self: flex-end; align-items: flex-end; }
.chat-meta { display: flex; align-items: center; gap: 6px; margin: 0 4px 2px; font-size: 11px;
  color: var(--text-secondary, #5b6b60); }
.chat-meta strong { font-weight: 600; color: var(--text-primary, #1c231c); }
.chat-bubble { padding: 8px 11px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--dm-surface-2, #f1f3ef); color: var(--text-primary, #1c231c);
  border-top-left-radius: 4px; }
.chat-msg.mine .chat-bubble { background: var(--accent, #2f8f4e); color: #fff;
  border-top-left-radius: 12px; border-top-right-radius: 4px; }
.chat-msg.is-admin:not(.mine) .chat-bubble { box-shadow: inset 3px 0 0 var(--accent, #2f8f4e); }
.chat-msg.is-system { align-self: center; max-width: 90%; }
.chat-msg.is-system .chat-bubble { background: none; padding: 2px 6px; font-size: 11.5px; text-align: center;
  color: var(--text-secondary, #5b6b60); }
.chat-delete { border: 0; background: none; padding: 0 2px; cursor: pointer; font-size: 11px;
  color: var(--text-secondary, #93a199); opacity: 0; transition: opacity .15s; }
.chat-msg:hover .chat-delete, .chat-delete:focus-visible { opacity: 1; }
.chat-delete:hover { color: var(--danger, #c8402f); }
.chat-form { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px;
  border-top: 1px solid var(--border, #e4e7e1); }
.chat-form textarea { flex: 1; min-height: 38px; max-height: 110px; resize: none; padding: 9px 11px;
  border: 1px solid var(--border, #e4e7e1); border-radius: 10px; font: inherit; font-size: 13px;
  background: var(--dm-surface-2, #fbfcfa); color: var(--text-primary, #1c231c); }
.chat-form button { width: 38px; height: 38px; flex-shrink: 0; border: 0; border-radius: 10px; cursor: pointer;
  background: var(--accent, #2f8f4e); color: #fff; font-size: 14px; }
.chat-form button:disabled { opacity: .5; cursor: not-allowed; }
.chat-confirm { position: fixed; inset: 0; z-index: 2000; display: none; align-items: center;
  justify-content: center; padding: 20px; background: rgba(15, 28, 18, .52); }
.chat-confirm.open { display: flex; }
.chat-confirm-card { width: min(400px, 100%); padding: 22px 24px; border-radius: 14px; text-align: left;
  background: var(--card-bg, #fff); color: var(--text-primary, #1c231c); box-shadow: 0 18px 44px rgba(0, 0, 0, .28); }
.chat-confirm-icon { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 12px;
  border-radius: 50%; background: rgba(200, 64, 47, .12); color: var(--danger, #c8402f); font-size: 18px; }
.chat-confirm-card h3 { margin: 0 0 6px; font-size: 17px; }
.chat-confirm-card p { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary, #5b6b60); }
.chat-confirm-quote { margin: 0 0 16px; padding: 9px 12px; border-left: 3px solid var(--border, #e4e7e1);
  border-radius: 6px; background: var(--dm-surface-2, #f1f3ef); font-size: 12.5px; white-space: pre-wrap;
  overflow-wrap: anywhere; max-height: 120px; overflow-y: auto; color: var(--text-primary, #1c231c); }
.chat-confirm-error { margin: -6px 0 12px; font-size: 12px; color: var(--danger, #c8402f); }
.chat-confirm-error:empty { display: none; }
.chat-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.chat-confirm-actions button { padding: 9px 16px; border-radius: 8px; font: inherit; font-size: 13px;
  font-weight: 700; cursor: pointer; }
.chat-confirm-cancel { border: 1px solid var(--border, #e4e7e1); background: var(--dm-surface-2, #f1f3ef);
  color: var(--text-primary, #1c231c); }
.chat-confirm-delete { display: inline-flex; align-items: center; gap: 7px; border: 0;
  background: var(--danger, #c8402f); color: #fff; }
.chat-confirm-delete:disabled { opacity: .6; cursor: not-allowed; }
.chat-watch { display: flex; align-items: center; gap: 9px; padding: 10px 12px; font-size: 12px;
  line-height: 1.4; border-top: 1px solid var(--border, #e4e7e1); background: var(--dm-surface-2, #f6f8f5);
  color: var(--text-secondary, #5b6b60); }
.chat-watch i { color: var(--accent, #2f8f4e); font-size: 13px; }
.chat-watch strong { color: var(--text-primary, #1c231c); font-weight: 600; }
.chat-watch[hidden], .chat-form[hidden] { display: none; }
/* Watching the Community Chat, deleting is the one action, so it always shows. */
.chat-panel.is-watching .chat-delete { opacity: .75; }
.chat-msg.is-removed .chat-bubble { display: flex; align-items: center; gap: 7px; font-style: italic;
  background: none; border: 1px dashed var(--border, #d5dbd3); color: var(--text-secondary, #5b6b60); box-shadow: none; }
.chat-msg.is-removed .chat-bubble i { font-style: normal; color: var(--danger, #c8402f); }
.chat-error { padding: 0 12px 8px; font-size: 11.5px; color: var(--danger, #c8402f); }
.chat-error:empty { display: none; }
`;

const toDate = (value) => (value?.toDate ? value.toDate() : value ? new Date(value) : null);
const timeLabel = (date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = (date) => {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
// "6m", "2h", "3d", then the date: how long ago, as in the chat list.
const agoLabel = (date) => {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const firstName = (name) => String(name || 'Hiker').replace(/\s*\(Admin\)$/, '').split(' ')[0];
const initials = (name) => {
  const parts = String(name || '').replace(/\s*\(Admin\)$/, '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0].toUpperCase()).join('')) || '?';
};
/* A user's profile photo, from users/{uid}: the same fields User Management
   reads, as a link or a Storage path. Loaded once per user; '' when there is
   none, so the avatar keeps the initials. */
const PHOTO_FIELDS = ['photoURL', 'photoUrl', 'profilePhoto', 'profileImage', 'profileImageUrl',
  'profileImageURL', 'profilePicture', 'profilePictureUrl', 'profilePictureURL', 'avatarUrl', 'avatarURL',
  'avatar', 'imageUrl', 'photoPath', 'profileImagePath', 'profilePicturePath', 'avatarPath'];
const photoUrls = new Map();   // uid -> url ('' for none), once known
const photoLoads = new Map();  // uid -> the load in progress

function photoOf(uid) {
  if (!uid) return '';
  if (photoUrls.has(uid)) return photoUrls.get(uid);
  if (!photoLoads.has(uid)) {
    photoLoads.set(uid, getDoc(doc(db, 'users', uid))
      .then((snap) => {
        const data = snap.data() || {};
        const value = PHOTO_FIELDS.map((field) => data[field])
          .map((item) => (typeof item === 'string' ? item : item?.url || item?.downloadURL || item?.path))
          .find((item) => typeof item === 'string' && item.trim());
        if (!value) return '';
        return /^https?:\/\//i.test(value) ? value.trim() : getDownloadURL(ref(storage, value.trim()));
      })
      .catch((error) => {
        console.warn('Could not load a chat profile photo:', uid, error.code || error.message);
        return '';
      })
      .then((url) => {
        photoUrls.set(uid, url || '');
        if (url) render();
      }));
  }
  return '';
}

// The round avatar of a person: their photo, or their initials until it loads.
const personAvatar = (uid, name) => {
  const url = photoOf(uid);
  return url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy">`
    : escapeHtml(initials(name));
};

// The app's chat id: the two uids, sorted, joined by "_".
const chatIdFor = (a, b) => [a, b].sort().join('_');

let me = null;
let myName = null;           // "Name (Admin)", as the app will show it
let community = [];          // Community Chat messages, oldest first
let unsubCommunity = null;
let directChats = [];        // this admin's private chats
let unsubDirectChats = null;
let current = { kind: 'community' };  // the conversation the room view shows
let directMessages = [];
let unsubDirect = null;
const widgets = [];

const adminName = async () => {
  myName ??= `${await getAdvisoryAuthorName()} (Admin)`;
  return myName;
};

const lastSeen = () => {
  try { return Number(localStorage.getItem(seenKey(me?.uid))) || 0; } catch { return 0; }
};
const markSeen = () => {
  try { localStorage.setItem(seenKey(me?.uid), String(Date.now())); } catch { /* storage blocked */ }
};
const communityUnread = () => {
  const seen = lastSeen();
  return community.filter((m) => m.senderId !== me?.uid && m.date.getTime() > seen).length;
};
const directUnread = (chat) => Number(chat.unread?.[me?.uid]) || 0;
const isRoomOpen = (widget) => widget.panel.classList.contains('open') && widget.panel.dataset.view === 'room';
const otherOf = (chat) => (chat.participants || []).find((uid) => uid !== me?.uid) || '';

/* ---- The list ---- */

function threads() {
  const latest = community[community.length - 1];
  const list = [{
    id: 'community',
    name: 'Community Chat',
    avatar: '<i class="fa-solid fa-users" aria-hidden="true"></i>',
    person: false,
    preview: latest
      ? (latest.type === 'removed'
        ? 'A message was removed by an admin'
        : `${latest.senderId === me?.uid ? 'You' : firstName(latest.senderName)}: ${latest.text || ''}`)
      : 'No messages yet',
    at: latest?.date || null,
    unread: communityUnread() > 0
  }];
  directChats.forEach((chat) => {
    const other = chat.participantInfo?.[otherOf(chat)] || {};
    const name = other.name || other.username || 'PeakPath user';
    list.push({
      id: chat.id,
      name,
      avatar: personAvatar(otherOf(chat), name),
      person: true,
      preview: chat.lastMessage
        ? `${chat.lastSenderId === me?.uid ? 'You: ' : ''}${chat.lastMessage}`
        : 'No messages yet',
      at: toDate(chat.lastMessageAt),
      unread: directUnread(chat) > 0
    });
  });
  // The Community Chat stays on top; private chats follow, newest first.
  return [list[0], ...list.slice(1).sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0))];
}

function threadsHtml(widget) {
  const search = widget.search.value.trim().toLowerCase();
  const shown = threads()
    .filter((thread) => widget.tab !== 'unread' || thread.unread)
    .filter((thread) => !search || `${thread.name} ${thread.preview}`.toLowerCase().includes(search));
  if (!shown.length) {
    return `<div class="chat-list-empty">${widget.tab === 'unread' ? 'No unread chats.' : 'No chats match your search.'}</div>`;
  }
  return shown.map((thread) => `
    <button type="button" class="chat-thread${thread.unread ? ' unread' : ''}" data-thread="${escapeHtml(thread.id)}">
      <span class="chat-avatar${thread.person ? ' is-person' : ''}">${thread.avatar}</span>
      <span class="chat-thread-text">
        <span class="chat-thread-name">${escapeHtml(thread.name)}</span>
        <span class="chat-thread-preview">${escapeHtml(thread.preview)}${thread.at ? ` · ${agoLabel(thread.at)}` : ''}</span>
      </span>
      ${thread.unread ? '<span class="chat-unread-dot" aria-label="Unread"></span>' : ''}
    </button>`).join('');
}

/* ---- One conversation ---- */

const roomMessages = () => (current.kind === 'community' ? community : directMessages);

function messagesHtml() {
  const list = roomMessages();
  if (!list.length) {
    const hint = current.kind === 'community' ? 'Messages from hikers will show here.' : 'Write the first message.';
    return `<div class="chat-empty"><i class="fa-regular fa-comments" aria-hidden="true"></i><br>No messages yet. ${hint}</div>`;
  }
  let lastDay = '';
  return list.map((message) => {
    const date = message.date;
    const day = dayLabel(date);
    const divider = day !== lastDay ? `<div class="chat-day">${day}</div>` : '';
    lastDay = day;
    if (message.type === 'system') {
      return `${divider}<div class="chat-msg is-system"><div class="chat-bubble">${escapeHtml(message.text || '')}</div></div>`;
    }
    const mine = message.senderId === me?.uid;
    if (message.type === 'removed') {
      return `${divider}
      <div class="chat-msg is-removed">
        <div class="chat-meta"><strong>${escapeHtml(message.senderName || 'Hiker')}</strong><span>${timeLabel(date)}</span></div>
        <div class="chat-bubble"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i>${escapeHtml(REMOVED_NOTE)}</div>
      </div>`;
    }
    const isAdmin = message.senderRole === 'admin' || /\(Admin\)$/.test(message.senderName || '');
    const name = current.kind === 'community' ? (message.senderName || 'Hiker') : current.name;
    const text = message.type === 'location' ? `📍 Shared a location${message.text ? `: ${message.text}` : ''}` : (message.text || '');
    return `${divider}
      <div class="chat-msg${mine ? ' mine' : ''}${isAdmin ? ' is-admin' : ''}">
        <div class="chat-meta">
          ${mine ? '' : `<strong>${escapeHtml(name)}</strong>`}
          <span>${timeLabel(date)}</span>
          <button type="button" class="chat-delete" data-delete="${escapeHtml(message.id)}" title="Delete message" aria-label="Delete message"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
        </div>
        <div class="chat-bubble">${escapeHtml(text)}</div>
      </div>`;
  }).join('');
}

function roomHeadHtml() {
  if (current.kind === 'community') {
    return `<span class="chat-avatar"><i class="fa-solid fa-users" aria-hidden="true"></i></span>
      <div class="chat-head-title"><strong>Community Chat</strong><span>Watching · admins can't post here</span></div>`;
  }
  return `<span class="chat-avatar is-person">${personAvatar(current.otherUid, current.name)}</span>
    <div class="chat-head-title"><strong>${escapeHtml(current.name)}</strong><span>Official notice · they can't reply${current.username ? ` · @${escapeHtml(current.username)}` : ''}</span></div>`;
}

/* ---- Drawing ---- */

function render() {
  // Messages arriving while a room is open on screen are already read.
  if (widgets.some(isRoomOpen)) {
    if (current.kind === 'community') markSeen();
    else markDirectRead(current.chatId);
  }
  const unread = communityUnread() + directChats.reduce((sum, chat) => sum + directUnread(chat), 0);
  widgets.forEach((widget) => {
    widget.threads.innerHTML = threadsHtml(widget);
    widget.roomHead.innerHTML = roomHeadHtml();
    // Community Chat: admins watch only, so the message box gives way to a note.
    const watching = current.kind === 'community';
    widget.panel.classList.toggle('is-watching', watching);
    widget.form.hidden = watching;
    widget.watch.hidden = !watching;
    if (!watching) widget.input.placeholder = `Message ${firstName(current.name)}...`;
    const { list } = widget;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = messagesHtml();
    if (atBottom || !list.dataset.rendered) list.scrollTop = list.scrollHeight;
    list.dataset.rendered = '1';
    widget.badge.hidden = !(unread > 0);
    widget.badge.textContent = unread > 99 ? '99+' : String(unread);
  });
}

/* ---- Firestore ---- */

const withDates = (snapshot) => snapshot.docs
  .map((item) => {
    // A message just sent has no server time yet; use the local estimate.
    const data = item.data({ serverTimestamps: 'estimate' });
    return { id: item.id, ...data, date: toDate(data.createdAt) || new Date() };
  })
  .reverse();

function listen() {
  stopListening();
  const room = query(collection(db, ROOM), orderBy('createdAt', 'desc'), limit(MESSAGE_LIMIT));
  unsubCommunity = onSnapshot(room, (snapshot) => {
    community = withDates(snapshot);
    render();
  }, (error) => {
    console.error('Could not load the Community Chat:', error);
    widgets.forEach(({ error: el }) => { el.textContent = 'The Community Chat could not be loaded.'; });
  });
  // This admin's private chats; group chats are the hikers' own.
  const mine = query(collection(db, 'chats'), where('participants', 'array-contains', me.uid));
  unsubDirectChats = onSnapshot(mine, (snapshot) => {
    directChats = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data({ serverTimestamps: 'estimate' }) }))
      .filter((chat) => chat.type !== 'group');
    render();
  }, (error) => console.error('Could not load private chats:', error));
}

function stopListening() {
  unsubCommunity?.();
  unsubDirectChats?.();
  unsubDirect?.();
  unsubCommunity = unsubDirectChats = unsubDirect = null;
}

function listenDirect(chatId) {
  unsubDirect?.();
  directMessages = [];
  const messagesRef = query(collection(db, 'chats', chatId, 'messages'), orderBy('createdAt', 'desc'), limit(MESSAGE_LIMIT));
  unsubDirect = onSnapshot(messagesRef, (snapshot) => {
    directMessages = withDates(snapshot);
    render();
  }, (error) => console.error('Could not load the chat:', error));
}

// Clears this admin's unread count on a private chat, as the app does on open.
function markDirectRead(chatId) {
  const chat = directChats.find((item) => item.id === chatId);
  if (!chat || !directUnread(chat)) return;
  chat.unread = { ...chat.unread, [me.uid]: 0 };
  updateDoc(doc(db, 'chats', chatId), {
    [`unread.${me.uid}`]: 0,
    [`lastReadAt.${me.uid}`]: serverTimestamp()
  }).catch((error) => console.warn('Could not mark the chat read:', error.message));
}

/* Creates the private chat with `user` if it is not there yet, the way the
   app's ChatService.openChatWith does, and returns its id. */
async function ensureDirectChat(user) {
  const chatId = chatIdFor(me.uid, user.uid);
  await setDoc(doc(db, 'chats', chatId), {
    participants: [me.uid, user.uid].sort(),
    // An official notice: the user reads it in the app but cannot reply
    // (firestore.rules refuses their messages; the app says why).
    adminNotice: true,
    participantInfo: {
      [me.uid]: { name: await adminName(), username: '' },
      [user.uid]: { name: user.name || user.username || 'PeakPath user', username: user.username || '' }
    }
  }, { merge: true });
  return chatId;
}

// One private message and the chat's inbox fields, as the app's _send writes them.
async function sendDirect(chatId, otherUid, text) {
  const chatRef = doc(db, 'chats', chatId);
  const batch = writeBatch(db);
  batch.set(doc(collection(chatRef, 'messages')), {
    type: 'text',
    text,
    senderId: me.uid,
    createdAt: serverTimestamp()
  });
  batch.update(chatRef, {
    lastMessage: text,
    lastSenderId: me.uid,
    lastSenderName: deleteField(),
    adminNotice: true,
    lastMessageAt: serverTimestamp(),
    [`unread.${otherUid}`]: increment(1),
    [`unread.${me.uid}`]: 0,
    [`lastReadAt.${me.uid}`]: serverTimestamp()
  });
  await batch.commit();
}

async function deleteMessage(id) {
  // Community Chat: the message stays as a "removed by an admin" notice, its
  // text wiped, so hikers see why it went (firestore.rules allows only this).
  if (current.kind === 'community') {
    await updateDoc(doc(db, ROOM, id), {
      type: 'removed',
      text: '',
      removedBy: me.uid,
      removedAt: serverTimestamp()
    });
    return;
  }
  const chatRef = doc(db, 'chats', current.chatId);
  const wasLatest = directMessages[directMessages.length - 1]?.id === id;
  await deleteDoc(doc(chatRef, 'messages', id));
  // The inbox preview falls back to the message before, as in the app.
  if (wasLatest) {
    const previous = directMessages.filter((m) => m.id !== id).pop();
    await updateDoc(chatRef, {
      lastMessage: previous ? (previous.text || '') : 'Message deleted',
      lastSenderId: previous?.senderId || me.uid
    }).catch(() => {});
  }
}

/* ---- Delete confirmation ---- */

let confirmBox = null;
let pendingDelete = null;

function closeConfirm() {
  confirmBox?.classList.remove('open');
  pendingDelete = null;
}

function buildConfirm() {
  confirmBox = document.createElement('div');
  confirmBox.className = 'chat-confirm';
  confirmBox.setAttribute('role', 'dialog');
  confirmBox.setAttribute('aria-modal', 'true');
  confirmBox.setAttribute('aria-labelledby', 'chatConfirmTitle');
  confirmBox.innerHTML = `
    <div class="chat-confirm-card">
      <div class="chat-confirm-icon"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></div>
      <h3 id="chatConfirmTitle">Delete this message?</h3>
      <p class="chat-confirm-text"></p>
      <div class="chat-confirm-quote"></div>
      <div class="chat-confirm-error" role="alert"></div>
      <div class="chat-confirm-actions">
        <button type="button" class="chat-confirm-cancel">Cancel</button>
        <button type="button" class="chat-confirm-delete"><i class="fa-regular fa-trash-can" aria-hidden="true"></i>Delete</button>
      </div>
    </div>`;
  document.body.appendChild(confirmBox);

  // Clicks in the pop-up must not reach the page and close the chat panel.
  confirmBox.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target === confirmBox) closeConfirm();
  });
  confirmBox.querySelector('.chat-confirm-cancel').addEventListener('click', closeConfirm);
  const deleteBtn = confirmBox.querySelector('.chat-confirm-delete');
  deleteBtn.addEventListener('click', async () => {
    if (!pendingDelete) return;
    const errorEl = confirmBox.querySelector('.chat-confirm-error');
    deleteBtn.disabled = true;
    errorEl.textContent = '';
    try {
      await deleteMessage(pendingDelete);
      closeConfirm();
    } catch (error) {
      console.error('Could not delete the message:', error);
      errorEl.textContent = error?.code === 'permission-denied'
        ? 'Your admin role cannot delete messages.'
        : 'The message could not be deleted. Try again.';
    } finally {
      deleteBtn.disabled = false;
    }
  });
}

function askDelete(id) {
  if (!confirmBox) buildConfirm();
  const message = roomMessages().find((m) => m.id === id);
  pendingDelete = id;
  const who = message?.senderId === me?.uid
    ? 'You'
    : (current.kind === 'community' ? (message?.senderName || 'Hiker') : current.name);
  confirmBox.querySelector('.chat-confirm-text').textContent = current.kind === 'community'
    ? 'Its text will be removed for everyone. In the PeakPath app, hikers and its sender will see that an admin removed it for going against the safety guidelines. This can\'t be undone.'
    : `It will be removed from your chat with ${current.name}, including in the PeakPath app. This can't be undone.`;
  confirmBox.querySelector('.chat-confirm-quote').textContent = message ? `${who}: ${message.text || ''}` : '';
  confirmBox.querySelector('.chat-confirm-error').textContent = '';
  confirmBox.classList.add('open');
  confirmBox.querySelector('.chat-confirm-cancel').focus();
}

/* ---- Panel ---- */

function openThread(id) {
  if (id === 'community') {
    unsubDirect?.();
    unsubDirect = null;
    current = { kind: 'community' };
    return;
  }
  const chat = directChats.find((item) => item.id === id);
  const otherUid = chat ? otherOf(chat) : '';
  const info = chat?.participantInfo?.[otherUid] || {};
  current = { kind: 'direct', chatId: id, otherUid, name: info.name || info.username || 'PeakPath user', username: info.username || '' };
  listenDirect(id);
}

function showView(widget, view) {
  widget.panel.dataset.view = view;
  widget.error.textContent = '';
  render();
  if (view === 'room') {
    widget.list.scrollTop = widget.list.scrollHeight;
    widget.input.focus();
  }
}

function openPanel(widget, view) {
  closeAll();
  document.querySelectorAll('.notification-panel.open').forEach((panel) => panel.classList.remove('open'));
  widget.panel.classList.add('open');
  widget.button.setAttribute('aria-expanded', 'true');
  showView(widget, view);
}

function closeAll() {
  widgets.forEach(({ panel, button }) => {
    panel.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
  });
  render();
}

function mountOne(bell) {
  const wrap = document.createElement('div');
  // bell-wrap borrows each page's own bell-box styling, so the two match.
  wrap.className = 'bell-wrap chat-wrap';
  wrap.innerHTML = `
    <button class="chat-btn" type="button" aria-label="Open chats" aria-expanded="false" title="Chats">
      <i class="fa-solid fa-comments" aria-hidden="true"></i>
    </button>
    <span class="bell-badge" aria-live="polite" hidden>0</span>
    <div class="chat-panel" role="dialog" aria-label="Chats" data-view="list">
      <div class="chat-view chat-view-list">
        <div class="chat-list-head">
          <h3>Chats</h3>
          <button type="button" class="chat-icon-btn chat-close" aria-label="Close chats"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
        <label class="chat-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input type="search" placeholder="Search chats" aria-label="Search chats">
        </label>
        <div class="chat-tabs" role="tablist">
          <button type="button" class="active" data-tab="all" role="tab" aria-selected="true">All</button>
          <button type="button" data-tab="unread" role="tab" aria-selected="false">Unread</button>
        </div>
        <div class="chat-threads"></div>
      </div>
      <div class="chat-view chat-view-room">
        <div class="chat-head">
          <button type="button" class="chat-icon-btn chat-back" aria-label="Back to chats"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
          <div class="chat-room-head" style="display:flex;align-items:center;gap:10px;min-width:0"></div>
          <button type="button" class="chat-icon-btn chat-close" aria-label="Close chats"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
        <div class="chat-messages" aria-live="polite"><div class="chat-empty">Loading messages...</div></div>
        <div class="chat-error" role="alert"></div>
        <div class="chat-watch" hidden>
          <i class="fa-regular fa-eye" aria-hidden="true"></i>
          <span><strong>You're watching.</strong> Admins can't post in the Community Chat. Use the trash icon to delete a message.</span>
        </div>
        <form class="chat-form">
          <textarea rows="1" maxlength="${MAX_LENGTH}" placeholder="Message..." aria-label="Message"></textarea>
          <button type="submit" aria-label="Send message" disabled><i class="fa-solid fa-paper-plane" aria-hidden="true"></i></button>
        </form>
      </div>
    </div>`;
  bell.before(wrap);
  // Opening the notifications closes the chats, and the other way round.
  bell.querySelector('.bell-btn')?.addEventListener('click', () => {
    if (widgets.some(({ panel }) => panel.classList.contains('open'))) closeAll();
  });

  const widget = {
    tab: 'all',
    button: wrap.querySelector('.chat-btn'),
    badge: wrap.querySelector('.bell-badge'),
    panel: wrap.querySelector('.chat-panel'),
    threads: wrap.querySelector('.chat-threads'),
    search: wrap.querySelector('.chat-search input'),
    roomHead: wrap.querySelector('.chat-room-head'),
    list: wrap.querySelector('.chat-messages'),
    error: wrap.querySelector('.chat-error'),
    form: wrap.querySelector('.chat-form'),
    watch: wrap.querySelector('.chat-watch'),
    input: wrap.querySelector('textarea'),
    sendBtn: wrap.querySelector('.chat-form button')
  };
  widgets.push(widget);

  // The button always opens on the list of chats.
  widget.button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (widget.panel.classList.contains('open')) {
      closeAll();
      return;
    }
    openPanel(widget, 'list');
  });
  // Clicks inside the panel must not reach the page's close-on-click.
  widget.panel.addEventListener('click', (event) => event.stopPropagation());
  wrap.querySelectorAll('.chat-close').forEach((button) => button.addEventListener('click', closeAll));
  wrap.querySelector('.chat-back').addEventListener('click', () => showView(widget, 'list'));

  widget.threads.addEventListener('click', (event) => {
    const thread = event.target.closest('[data-thread]');
    if (!thread) return;
    openThread(thread.dataset.thread);
    showView(widget, 'room');
  });
  widget.search.addEventListener('input', () => { widget.threads.innerHTML = threadsHtml(widget); });
  wrap.querySelectorAll('.chat-tabs button').forEach((tab) => tab.addEventListener('click', () => {
    widget.tab = tab.dataset.tab;
    wrap.querySelectorAll('.chat-tabs button').forEach((other) => {
      other.classList.toggle('active', other === tab);
      other.setAttribute('aria-selected', String(other === tab));
    });
    widget.threads.innerHTML = threadsHtml(widget);
  }));

  const resize = () => {
    widget.input.style.height = 'auto';
    widget.input.style.height = `${Math.min(widget.input.scrollHeight, 110)}px`;
    widget.sendBtn.disabled = !widget.input.value.trim();
  };
  widget.input.addEventListener('input', resize);
  // Enter sends; Shift+Enter starts a new line.
  widget.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      widget.form.requestSubmit();
    }
  });

  widget.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = widget.input.value.trim();
    // Nothing is ever posted to the Community Chat from here.
    if (!text || !me || current.kind !== 'direct') return;
    widget.sendBtn.disabled = true;
    widget.error.textContent = '';
    try {
      await sendDirect(current.chatId, current.otherUid, text);
      widget.input.value = '';
      resize();
      widget.list.scrollTop = widget.list.scrollHeight;
    } catch (error) {
      console.error('Could not send the message:', error);
      widget.error.textContent = 'The message could not be sent. Try again.';
      widget.sendBtn.disabled = false;
    }
  });

  widget.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete]');
    if (button) askDelete(button.dataset.delete);
  });
}

/* ---- For other pages ---- */

/* Sends `text` to `user` ({ uid, name, username }) as a private chat from the
   signed-in admin, creating the chat if needed, then opens it in the Chats
   panel. User Reports' Warn User uses it to deliver the warning. */
export async function sendDirectMessage(user, text) {
  if (!me) throw new Error('Not signed in.');
  if (!user?.uid || user.uid === me.uid) throw new Error('No user to message.');
  const chatId = await ensureDirectChat(user);
  await sendDirect(chatId, user.uid, text);
  const widget = widgets[0];
  if (widget) {
    current = {
      kind: 'direct',
      chatId,
      otherUid: user.uid,
      name: user.name || user.username || 'PeakPath user',
      username: user.username || ''
    };
    listenDirect(chatId);
    openPanel(widget, 'room');
  }
  return chatId;
}

/* Puts a chat button just before every notification bell on the page.
   Called by notification.js once the bells are built. */
export function mountCommunityChat() {
  const bells = document.querySelectorAll('.notification-center');
  if (!bells.length) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  bells.forEach(mountOne);

  document.addEventListener('click', () => {
    if (widgets.some(({ panel }) => panel.classList.contains('open'))) closeAll();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (confirmBox?.classList.contains('open')) {
      closeConfirm();
      return;
    }
    if (widgets.some(({ panel }) => panel.classList.contains('open'))) closeAll();
  });
  // Keeps the list's "6m ago" times current while it is open.
  setInterval(() => {
    widgets.forEach((widget) => {
      if (widget.panel.classList.contains('open') && widget.panel.dataset.view === 'list') {
        widget.threads.innerHTML = threadsHtml(widget);
      }
    });
  }, 60000);

  onAuthStateChanged(auth, (user) => {
    me = user;
    myName = null;
    current = { kind: 'community' };
    if (user) {
      listen();
    } else {
      stopListening();
      community = [];
      directChats = [];
      directMessages = [];
      render();
    }
  });
}
