// quick-actions.js
// The Dashboard's Quick Actions "Add Trail" and "Post Announcement" open a
// popup right on the Dashboard instead of sending the admin to another page.
//
//   [data-quick-action="add-trail"]      the Add New Trail form (trail.html)
//   [data-quick-action="post-advisory"]  the Create New Advisory form (A&A.html)
//
// Each popup is a copy of the create path on its own page: the same fields,
// saved to the same collection with the same field names, and the same
// Storage folder for photos and videos. If a field is added to or renamed in
// either form on its page, change it here too, or records created from the
// Dashboard will differ from ones created on the page.
//
// The markup and styles are added by this file, scoped to .qa-modal, so the
// Dashboard's own .button / .card styles and these never affect each other.

import { auth, db, storage } from './firebase-config.js';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  deleteObject,
  getDownloadURL,
  ref as storageRef,
  uploadBytes,
  uploadBytesResumable
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

/* ---------- Styles ---------- */

const STYLES = `
.qa-modal { position: fixed; inset: 0; z-index: 1000; display: none; justify-content: center; padding: 40px 16px; overflow-y: auto; background: rgba(15, 25, 15, .45); }
.qa-modal.open { display: flex; }
.qa-modal .qa-card { width: 100%; max-width: 560px; height: max-content; padding: 22px 24px 24px; border-radius: 12px; background: var(--card-bg); color: var(--text-primary); }
.qa-modal.qa-trail .qa-card { max-width: 480px; padding: 26px; }
.qa-modal h2 { margin: 0 0 16px; font-size: 18px; }
.qa-modal .qa-field { margin-bottom: 13px; }
.qa-modal .qa-field label { display: block; margin-bottom: 5px; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
.qa-modal .qa-field input,
.qa-modal .qa-field select,
.qa-modal .qa-field textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--dm-surface-2, #fbfcfa); color: var(--text-primary); font-family: inherit; font-size: 13px; }
.qa-modal .qa-field textarea { min-height: 60px; resize: vertical; line-height: 1.5; }
.qa-modal .qa-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.qa-modal .qa-checks { display: flex; flex-wrap: wrap; gap: 16px; padding-top: 2px; }
.qa-modal .qa-checks label { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--text-primary); }
.qa-modal .qa-checks input { width: auto; }
.qa-modal .qa-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.qa-modal.qa-trail .qa-actions > * { flex: 1; }
.qa-modal .qa-btn { padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }
.qa-modal .qa-btn-primary { border: none; background: var(--accent); color: #fff; }
.qa-modal .qa-btn-primary:hover { background: var(--accent-dark); }
.qa-modal .qa-btn-secondary { border: 1px solid var(--border); background: var(--dm-surface-2, #f1f3ef); color: var(--text-primary); }
.qa-modal .qa-btn:disabled { opacity: .6; cursor: not-allowed; }
.qa-modal .qa-error { margin-top: 10px; font-size: 12.5px; color: var(--danger); }
.qa-modal .qa-error:empty { display: none; }
/* Photo / media drop zones */
.qa-modal .qa-drop { display: flex; align-items: center; gap: 14px; padding: 14px; border: 1.5px dashed var(--border); border-radius: 10px; background: var(--dm-surface-2, #fbfcfa); cursor: pointer; transition: border-color .15s, background .15s; }
.qa-modal .qa-drop:hover,
.qa-modal .qa-drop:focus-visible,
.qa-modal .qa-drop.dragover { border-color: var(--accent); background: var(--accent-light); outline: none; }
.qa-modal .qa-drop.disabled { pointer-events: none; opacity: .55; }
.qa-modal .qa-drop-icon { width: 40px; height: 40px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 9px; background: var(--accent-light); color: var(--accent); }
.qa-modal .qa-photo-preview { width: 60px; height: 60px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--dm-surface-3, #f1f3ef) center / cover; font-size: 20px; }
.qa-modal .qa-drop-title { font-size: 12.5px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
.qa-modal .qa-drop-hint { margin-top: 2px; font-size: 11px; color: var(--text-secondary); }
.qa-modal .qa-drop-remove { flex-shrink: 0; padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); font-size: 11px; color: var(--danger); cursor: pointer; }
.qa-modal .qa-media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin-top: 10px; }
.qa-modal .qa-media-grid:empty { display: none; }
.qa-modal .qa-media-item { position: relative; aspect-ratio: 1; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--dm-surface-2, #f1f3ef); }
.qa-modal .qa-media-item img,
.qa-modal .qa-media-item video { display: block; width: 100%; height: 100%; object-fit: cover; }
.qa-modal .qa-media-kind { position: absolute; left: 5px; bottom: 7px; padding: 2px 6px; border-radius: 6px; background: rgba(0, 0, 0, .6); font-size: 10px; font-weight: 700; color: #fff; }
.qa-modal .qa-media-remove { position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: rgba(0, 0, 0, .6); font-size: 15px; line-height: 1; color: #fff; cursor: pointer; }
.qa-modal .qa-media-remove:hover { background: var(--danger); }
.qa-modal .qa-media-remove:disabled { display: none; }
.qa-modal .qa-media-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; display: none; background: rgba(0, 0, 0, .18); }
.qa-modal .qa-media-progress span { display: block; width: 0; height: 100%; background: var(--accent); transition: width .15s; }
.qa-modal .qa-media-item.uploading .qa-media-progress { display: block; }
@media (max-width: 560px) {
  .qa-modal { padding: 20px 12px; }
  .qa-modal .qa-row { grid-template-columns: 1fr; }
}
/* Saved confirmation, bottom centre, gone after a few seconds. */
.qa-toast { position: fixed; left: 50%; bottom: 24px; z-index: 1100; display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 12px 16px; border-radius: 10px; background: var(--sidebar-bg); color: #fff; font-size: 13px; font-weight: 600; box-shadow: 0 12px 30px rgba(20, 35, 20, .25); transform: translate(-50%, 20px); opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease; }
.qa-toast.show { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
.qa-toast a { color: #9fe0b4; white-space: nowrap; }
`;

/* ---------- Shared helpers ---------- */

const html = (markup) => {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
};

let toastTimer = null;
function showToast(message, link) {
  let toast = document.getElementById('qaToast');
  if (!toast) {
    toast = html('<div class="qa-toast" id="qaToast" role="status" aria-live="polite"></div>');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.textContent = link.label;
    toast.appendChild(anchor);
  }
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// The popup that is open, so Escape closes only that one.
let openModal = null;
function open(modal, focusId) {
  modal.overlay.classList.add('open');
  openModal = modal;
  document.getElementById(focusId)?.focus();
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openModal) openModal.close();
});

// <input type="date"> / "datetime-local" values, from the local date parts
// rather than toISOString(), which would shift the day for anyone east of UTC.
const pad = (n) => String(n).padStart(2, '0');
const toDateInputValue = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const toDateTimeInputValue = (date) => `${toDateInputValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
function fromDateInputValue(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function describeSaveError(error) {
  switch (error?.code) {
    case 'permission-denied':
      return 'Your account is not allowed to save this. Check that it is listed as an admin.';
    case 'storage/unauthorized':
      return 'Upload was blocked by the Firebase Storage rules. Publish storage.rules in the Firebase console.';
    case 'storage/unknown':
    case 'storage/bucket-not-found':
    case 'storage/project-not-found':
      return 'Firebase Storage is not set up for this project yet, so photos/videos cannot be uploaded.';
    case 'storage/quota-exceeded':
      return 'The Firebase Storage quota has been reached.';
    case 'storage/retry-limit-exceeded':
      return 'The upload timed out. Check your connection and try again.';
    default:
      return error?.message || String(error);
  }
}

const UPLOAD_ICON = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';

/* ---------- Add Trail (trail.html > + Add Trail) ---------- */

function createAddTrailModal() {
  const overlay = html(`
    <div class="qa-modal qa-trail" id="qaTrailModal">
      <div class="qa-card" role="dialog" aria-modal="true" aria-labelledby="qaTrailTitle">
        <h2 id="qaTrailTitle">+ Add New Trail</h2>
        <div class="qa-field"><label for="qaTrailName">Trail Name</label><input type="text" id="qaTrailName" placeholder="e.g. Mariang Makiling Trail"></div>
        <div class="qa-field"><label for="qaTrailDesc">Description</label><textarea id="qaTrailDesc"></textarea></div>
        <div class="qa-field">
          <label for="qaTrailPhoto">Trail Photo</label>
          <div class="qa-drop" id="qaTrailPhotoDrop" tabindex="0" role="button">
            <div class="qa-photo-preview" id="qaTrailPhotoPreview">🏞️</div>
            <div style="flex:1;min-width:0">
              <div class="qa-drop-title" id="qaTrailPhotoText">Click to upload a photo</div>
              <div class="qa-drop-hint" id="qaTrailPhotoSubtext">PNG or JPG, up to 5MB</div>
            </div>
            <button type="button" class="qa-drop-remove" id="qaTrailPhotoRemove" hidden>Remove</button>
          </div>
          <input type="file" id="qaTrailPhoto" accept="image/*" hidden>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaTrailDiff">Difficulty</label><select id="qaTrailDiff"><option>Easy</option><option>Moderate</option><option>Hard</option><option>Undefined</option></select></div>
          <div class="qa-field"><label for="qaTrailType">Trail Type</label><select id="qaTrailType"><option>Major Trail</option><option>Side Trail</option><option>Undefined</option></select></div>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaTrailDist">Approximate Distance</label><input type="text" id="qaTrailDist" placeholder="e.g. 7.2 km"></div>
          <div class="qa-field"><label for="qaTrailDur">Duration</label><input type="text" id="qaTrailDur" placeholder="e.g. 4–6 hrs"></div>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaTrailElev">Elevation</label><input type="text" id="qaTrailElev" placeholder="e.g. 1,200 m"></div>
          <div class="qa-field"><label for="qaTrailMunicipality">Municipality</label><input type="text" id="qaTrailMunicipality" placeholder="e.g. Los Baños, Laguna"></div>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaTrailStatus">Status</label><select id="qaTrailStatus"><option>Open</option><option>Closed</option></select></div>
          <div class="qa-field"><label for="qaTrailRatings">Ratings</label><input type="text" id="qaTrailRatings" placeholder="e.g. 4.8"></div>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaTrailEntryType">Entry Type</label><select id="qaTrailEntryType"><option>Legal Entry</option><option>Unregistered Map</option></select></div>
          <div class="qa-field"><label for="qaTrailPublishDate">Publish Date</label><input type="date" id="qaTrailPublishDate"></div>
        </div>
        <div class="qa-error" id="qaTrailError" role="alert"></div>
        <div class="qa-actions">
          <button type="button" class="qa-btn qa-btn-secondary" id="qaTrailCancel">Cancel</button>
          <button type="button" class="qa-btn qa-btn-primary" id="qaTrailSave">Add Trail</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(id);
  const photoInput = $('qaTrailPhoto');
  const photoDrop = $('qaTrailPhotoDrop');
  const photoPreview = $('qaTrailPhotoPreview');
  const removePhotoBtn = $('qaTrailPhotoRemove');
  const errorEl = $('qaTrailError');
  const saveBtn = $('qaTrailSave');
  const cancelBtn = $('qaTrailCancel');
  let saving = false;

  function resetPhoto() {
    photoInput.value = '';
    photoPreview.style.backgroundImage = '';
    photoPreview.textContent = '🏞️';
    $('qaTrailPhotoText').textContent = 'Click to upload a photo';
    $('qaTrailPhotoSubtext').textContent = 'PNG or JPG, up to 5MB';
    removePhotoBtn.hidden = true;
  }

  function resetForm() {
    ['qaTrailName', 'qaTrailDesc', 'qaTrailDist', 'qaTrailDur', 'qaTrailElev', 'qaTrailMunicipality', 'qaTrailRatings', 'qaTrailPublishDate']
      .forEach((id) => { $(id).value = ''; });
    ['qaTrailDiff', 'qaTrailType', 'qaTrailStatus', 'qaTrailEntryType'].forEach((id) => { $(id).selectedIndex = 0; });
    errorEl.textContent = '';
    resetPhoto();
  }

  const modal = {
    overlay,
    open() {
      // Most trails are published the day they are added, so today is the
      // starting point; the admin can move it forward or back.
      if (!$('qaTrailPublishDate').value) $('qaTrailPublishDate').value = toDateInputValue(new Date());
      open(modal, 'qaTrailName');
    },
    close() {
      if (saving) return;
      overlay.classList.remove('open');
      openModal = null;
    }
  };

  photoDrop.addEventListener('click', (event) => {
    if (event.target === removePhotoBtn) return;
    photoInput.click();
  });
  photoDrop.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    photoInput.click();
  });
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    errorEl.textContent = '';
    if (!file) return resetPhoto();
    if (!file.type.startsWith('image/')) {
      resetPhoto();
      errorEl.textContent = 'Please choose an image file.';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      resetPhoto();
      errorEl.textContent = 'Trail photos must be 5 MB or smaller.';
      return;
    }
    photoPreview.style.backgroundImage = `url('${URL.createObjectURL(file)}')`;
    photoPreview.textContent = '';
    $('qaTrailPhotoText').textContent = file.name;
    $('qaTrailPhotoSubtext').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB — click to change`;
    removePhotoBtn.hidden = false;
  });
  removePhotoBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    resetPhoto();
  });

  cancelBtn.addEventListener('click', () => modal.close());
  overlay.addEventListener('click', (event) => { if (event.target === overlay) modal.close(); });

  // Same record as trail.html's submitAddTrail.
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    const name = $('qaTrailName').value.trim();
    if (!name) {
      errorEl.textContent = 'Please enter a trail name.';
      $('qaTrailName').focus();
      return;
    }

    const publishDate = fromDateInputValue($('qaTrailPublishDate').value);
    const newTrail = {
      Trail: name,
      Description: $('qaTrailDesc').value,
      Difficulty: $('qaTrailDiff').value,
      Type: $('qaTrailType').value,
      EntryType: $('qaTrailEntryType').value,
      'Approximate Distance': $('qaTrailDist').value,
      Duration: $('qaTrailDur').value,
      Elevation: $('qaTrailElev').value,
      Municipality: $('qaTrailMunicipality').value,
      Status: $('qaTrailStatus').value,
      Ratings: $('qaTrailRatings').value,
      ...(publishDate ? { PublishDate: publishDate } : {}),
      UpdatedAt: serverTimestamp(),
      StatusUpdatedAt: serverTimestamp()
    };

    saving = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    errorEl.textContent = '';
    try {
      const docRef = await addDoc(collection(db, 'trails'), newTrail);
      const photoFile = photoInput.files[0];
      if (photoFile) {
        saveBtn.textContent = 'Uploading photo…';
        const safeName = photoFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const imageRef = storageRef(storage, `trails/${docRef.id}/${Date.now()}-${safeName}`);
        await uploadBytes(imageRef, photoFile, { contentType: photoFile.type });
        await updateDoc(docRef, { imageUrl: await getDownloadURL(imageRef) });
      }
      saving = false;
      modal.close();
      resetForm();
      showToast(`Trail "${name}" added.`, { href: 'trail.html', label: 'View in Trail Management' });
    } catch (error) {
      console.error('Failed to add trail:', error);
      errorEl.textContent = `Failed to add trail: ${describeSaveError(error)}`;
    } finally {
      saving = false;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Add Trail';
    }
  });

  return modal;
}

/* ---------- Post Announcement (A&A.html > + Create New) ---------- */

const MAX_MEDIA_FILES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function createAdvisoryModal() {
  const overlay = html(`
    <div class="qa-modal" id="qaAdvisoryModal">
      <div class="qa-card" role="dialog" aria-modal="true" aria-labelledby="qaAdvTitleHeading">
        <h2 id="qaAdvTitleHeading">Create New Advisory</h2>
        <div class="qa-field"><label for="qaAdvTitle">Title</label><input id="qaAdvTitle" placeholder="e.g. Trail Closure: Sipit Trail"></div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaAdvType">Type</label><select id="qaAdvType"><option>Advisory</option><option>Weather</option><option>Update</option><option>Alert</option><option>Announcement</option></select></div>
          <div class="qa-field"><label for="qaAdvStatus">Status</label><select id="qaAdvStatus"><option>Active</option><option>Scheduled</option><option>Expired</option></select></div>
        </div>
        <div class="qa-field"><label for="qaAdvRisk">Risk Level</label><select id="qaAdvRisk"><option>Low</option><option>Moderate</option><option>High</option></select></div>
        <div class="qa-field"><label for="qaAdvTarget">Target</label><input id="qaAdvTarget" placeholder="e.g. Sipit Trail (Section 2) or All Trails"></div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaAdvEffective">Effective Date</label><input type="datetime-local" id="qaAdvEffective"></div>
          <div class="qa-field"><label for="qaAdvExpires">Expires On (optional)</label><input type="datetime-local" id="qaAdvExpires"></div>
        </div>
        <div class="qa-row">
          <div class="qa-field"><label for="qaAdvPublishedBy">Published By</label><input id="qaAdvPublishedBy" value="Admin User"></div>
          <div class="qa-field"><label for="qaAdvVisibility">Visibility</label><select id="qaAdvVisibility"><option>All Users</option><option>Guide</option></select></div>
        </div>
        <div class="qa-field"><label>Channels</label>
          <div class="qa-checks">
            <label><input type="checkbox" id="qaAdvChanInApp" checked> In-App</label>
            <label><input type="checkbox" id="qaAdvChanEmail"> Email</label>
          </div>
        </div>
        <div class="qa-field"><label for="qaAdvDesc">Description</label><textarea id="qaAdvDesc" placeholder="Full details shown to hikers"></textarea></div>
        <div class="qa-field"><label for="qaAdvMediaInput">Photos &amp; Videos (optional)</label>
          <div class="qa-drop" id="qaAdvMediaDrop" tabindex="0" role="button" aria-describedby="qaAdvMediaHint">
            <div class="qa-drop-icon">${UPLOAD_ICON}</div>
            <div style="flex:1;min-width:0">
              <div class="qa-drop-title" id="qaAdvMediaTitle">Click to upload or drag files here</div>
              <div class="qa-drop-hint" id="qaAdvMediaHint">Images up to 10 MB · Videos (MP4 recommended) up to 100 MB · Max 6 files</div>
            </div>
          </div>
          <input type="file" id="qaAdvMediaInput" accept="image/*,video/*" multiple hidden>
          <div class="qa-media-grid" id="qaAdvMediaList"></div>
        </div>
        <div class="qa-field"><label for="qaAdvActions">Recommended Actions (one per line)</label><textarea id="qaAdvActions" placeholder="Avoid the area until further notice.&#10;Take alternative trails."></textarea></div>
        <div class="qa-error" id="qaAdvError" role="alert"></div>
        <div class="qa-actions">
          <button type="button" class="qa-btn qa-btn-secondary" id="qaAdvCancel">Cancel</button>
          <button type="button" class="qa-btn qa-btn-primary" id="qaAdvSave">Create Advisory</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(id);
  const mediaDrop = $('qaAdvMediaDrop');
  const mediaInput = $('qaAdvMediaInput');
  const mediaList = $('qaAdvMediaList');
  const errorEl = $('qaAdvError');
  const saveBtn = $('qaAdvSave');
  const cancelBtn = $('qaAdvCancel');
  let saving = false;
  // Picked files: { file, kind, previewUrl }, and { saved } once uploaded.
  let mediaItems = [];
  // Uploaded by a save that then failed; deleted from Storage on Cancel.
  let unsavedUploads = [];
  // Chosen on open, so the new advisory already has an id to upload under.
  let draftRef = null;

  const mediaKind = (file) => (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null);

  function renderMedia() {
    mediaList.innerHTML = '';
    mediaItems.forEach((item, index) => {
      const kind = item.saved ? item.saved.type : item.kind;
      const name = item.saved ? item.saved.name : item.file.name;
      const tile = document.createElement('div');
      tile.className = 'qa-media-item';
      tile.title = name || '';
      const preview = document.createElement(kind === 'video' ? 'video' : 'img');
      preview.src = item.saved ? item.saved.url : item.previewUrl;
      if (kind === 'video') {
        preview.muted = true;
        preview.preload = 'metadata';
        tile.appendChild(preview);
        tile.appendChild(html('<span class="qa-media-kind">VIDEO</span>'));
      } else {
        preview.alt = name || 'Advisory photo';
        tile.appendChild(preview);
      }
      const remove = html('<button type="button" class="qa-media-remove">&times;</button>');
      remove.setAttribute('aria-label', `Remove ${name || 'file'}`);
      remove.disabled = saving;
      remove.addEventListener('click', () => {
        const [removed] = mediaItems.splice(index, 1);
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        errorEl.textContent = '';
        renderMedia();
      });
      tile.appendChild(remove);
      tile.appendChild(html('<div class="qa-media-progress"><span></span></div>'));
      item.tile = tile;
      mediaList.appendChild(tile);
    });
    const full = mediaItems.length >= MAX_MEDIA_FILES;
    mediaDrop.classList.toggle('disabled', saving || full);
    mediaDrop.setAttribute('aria-disabled', String(saving || full));
    $('qaAdvMediaTitle').textContent = full
      ? `Maximum of ${MAX_MEDIA_FILES} files attached`
      : 'Click to upload or drag files here';
  }

  function addMediaFiles(files) {
    const problems = [];
    for (const file of files) {
      const kind = mediaKind(file);
      if (!kind) { problems.push(`${file.name} is not an image or video.`); continue; }
      const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (file.size > limit) { problems.push(`${file.name} is larger than ${limit / 1024 / 1024} MB.`); continue; }
      if (mediaItems.length >= MAX_MEDIA_FILES) { problems.push(`Only ${MAX_MEDIA_FILES} files can be attached.`); break; }
      mediaItems.push({ file, kind, previewUrl: URL.createObjectURL(file) });
    }
    errorEl.textContent = problems.join(' ');
    renderMedia();
  }

  function uploadMediaFile(advisoryId, item) {
    const safeName = item.file.name.replace(/[^\w.-]+/g, '_').slice(-80);
    const path = `advisories/${advisoryId}/${Date.now()}-${safeName}`;
    const task = uploadBytesResumable(storageRef(storage, path), item.file, { contentType: item.file.type });
    const bar = item.tile?.querySelector('.qa-media-progress span');
    item.tile?.classList.add('uploading');
    return new Promise((resolve, reject) => {
      task.on('state_changed',
        (snap) => { if (bar) bar.style.width = `${(snap.bytesTransferred / snap.totalBytes) * 100}%`; },
        reject,
        async () => {
          try {
            resolve({
              url: await getDownloadURL(task.snapshot.ref),
              path,
              type: item.kind,
              name: item.file.name,
              contentType: item.file.type,
              size: item.file.size
            });
          } catch (error) {
            reject(error);
          }
        });
    }).finally(() => item.tile?.classList.remove('uploading'));
  }

  function deleteUploads(list) {
    list.forEach((media) => {
      if (!media?.path) return;
      deleteObject(storageRef(storage, media.path))
        .catch((error) => console.warn('Could not delete advisory media', media.path, error.code || error.message));
    });
  }

  function resetForm() {
    ['qaAdvTitle', 'qaAdvTarget', 'qaAdvExpires', 'qaAdvDesc', 'qaAdvActions'].forEach((id) => { $(id).value = ''; });
    $('qaAdvType').value = 'Advisory';
    $('qaAdvStatus').value = 'Active';
    $('qaAdvRisk').value = 'Moderate';
    $('qaAdvPublishedBy').value = 'Admin User';
    $('qaAdvVisibility').value = 'All Users';
    $('qaAdvChanInApp').checked = true;
    $('qaAdvChanEmail').checked = false;
    mediaItems.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
    mediaItems = [];
    errorEl.textContent = '';
    renderMedia();
  }

  function setSaving(on) {
    saving = on;
    saveBtn.disabled = on;
    cancelBtn.disabled = on;
    if (!on) saveBtn.textContent = 'Create Advisory';
    renderMedia();
  }

  const modal = {
    overlay,
    open() {
      // The same defaults A&A.html's openModal(null) sets.
      resetForm();
      draftRef = doc(collection(db, 'Advisory'));
      unsavedUploads = [];
      $('qaAdvEffective').value = toDateTimeInputValue(new Date());
      open(modal, 'qaAdvTitle');
    },
    close() {
      if (saving) return;
      deleteUploads(unsavedUploads);
      unsavedUploads = [];
      overlay.classList.remove('open');
      openModal = null;
    }
  };

  mediaDrop.addEventListener('click', () => mediaInput.click());
  mediaDrop.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!mediaDrop.classList.contains('disabled')) mediaInput.click();
  });
  mediaInput.addEventListener('change', () => {
    addMediaFiles(mediaInput.files);
    mediaInput.value = '';
  });
  mediaDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    mediaDrop.classList.add('dragover');
  });
  mediaDrop.addEventListener('dragleave', (event) => {
    if (!mediaDrop.contains(event.relatedTarget)) mediaDrop.classList.remove('dragover');
  });
  mediaDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    mediaDrop.classList.remove('dragover');
    addMediaFiles(event.dataTransfer.files);
  });
  // A file dropped anywhere else on the popup must not open in the browser.
  overlay.addEventListener('dragover', (event) => event.preventDefault());
  overlay.addEventListener('drop', (event) => event.preventDefault());

  cancelBtn.addEventListener('click', () => modal.close());
  overlay.addEventListener('click', (event) => { if (event.target === overlay) modal.close(); });

  // Same record as A&A.html's modalSave, for a new advisory.
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    const title = $('qaAdvTitle').value.trim();
    if (!title) {
      errorEl.textContent = 'Title is required.';
      $('qaAdvTitle').focus();
      return;
    }

    const channels = [];
    if ($('qaAdvChanInApp').checked) channels.push('In-App');
    if ($('qaAdvChanEmail').checked) channels.push('Email');
    const effective = $('qaAdvEffective').value;
    const expires = $('qaAdvExpires').value;

    const payload = {
      title,
      type: $('qaAdvType').value,
      status: $('qaAdvStatus').value,
      riskLevel: $('qaAdvRisk').value,
      target: $('qaAdvTarget').value.trim() || 'All Trails',
      effectiveDate: effective ? Timestamp.fromDate(new Date(effective)) : null,
      expiresAt: expires ? Timestamp.fromDate(new Date(expires)) : null,
      publishedBy: $('qaAdvPublishedBy').value.trim() || 'Admin User',
      visibility: $('qaAdvVisibility').value,
      channels,
      desc: $('qaAdvDesc').value.trim(),
      recommendedActions: $('qaAdvActions').value.split('\n').map((line) => line.trim()).filter(Boolean),
      // Same as A&A.html: the Email channel is sent from the admin who
      // created it (see advisorySender in functions/index.js).
      sentByEmail: auth.currentUser?.email || null
    };

    errorEl.textContent = '';
    setSaving(true);
    try {
      const pending = mediaItems.filter((item) => item.file);
      for (const [i, item] of pending.entries()) {
        saveBtn.textContent = `Uploading ${i + 1} of ${pending.length}…`;
        const saved = await uploadMediaFile(draftRef.id, item);
        URL.revokeObjectURL(item.previewUrl);
        Object.assign(item, { saved, file: null, previewUrl: null });
        unsavedUploads.push(saved);
      }
      payload.media = mediaItems.map((item) => item.saved);
      saveBtn.textContent = 'Saving…';
      await setDoc(draftRef, { ...payload, visible: true, createdAt: serverTimestamp() });

      // The advisory now references every upload, so none are orphaned.
      unsavedUploads = [];
      const id = draftRef.id;
      setSaving(false);
      modal.close();
      showToast('Advisory created.', {
        href: `A&A.html?advisory=${encodeURIComponent(id)}`,
        label: 'View in Advisories'
      });
    } catch (error) {
      console.error('Failed to save advisory:', error);
      setSaving(false);
      errorEl.textContent = `Failed to save advisory: ${describeSaveError(error)}`;
    }
  });

  return modal;
}

/* ---------- Wiring ---------- */

const triggers = {
  'add-trail': createAddTrailModal,
  'post-advisory': createAdvisoryModal
};

const buttons = document.querySelectorAll('[data-quick-action]');
if (buttons.length) {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: STYLES }));
  const modals = {};
  buttons.forEach((button) => {
    const action = button.dataset.quickAction;
    if (!triggers[action]) return;
    button.addEventListener('click', (event) => {
      // The buttons are links to the full page, which still works if this
      // script fails to load; when it has loaded, the popup opens instead.
      event.preventDefault();
      modals[action] ||= triggers[action]();
      modals[action].open();
    });
  });
}
