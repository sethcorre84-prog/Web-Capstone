/* ==========================================================================
   image-viewer.js
   Opens pictures in a pop-up on the same page instead of a new browser tab.

       <script src="../jsPages/image-viewer.js"></script>

   Mark anything clickable with data-lightbox="<image url>". Pictures that
   share a data-lightbox-group value are browsed together with the arrows
   (or the Left/Right keys); data-lightbox-caption sets the caption.

       <button data-lightbox="https://..." data-lightbox-group="report-1">

   Works on markup added later by innerHTML, since the click is caught on the
   document. Pages that already hold a list of URLs can call
   window.openImageViewer(urls, startIndex) directly.
   ========================================================================== */
(function () {
    var CSS = '' +
        '.iv-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;' +
        'background:rgba(8,14,10,.88);padding:56px 64px;box-sizing:border-box;}' +
        '.iv-overlay.open{display:flex;}' +
        '.iv-overlay img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;' +
        'box-shadow:0 10px 40px rgba(0,0,0,.5);background:#111;user-select:none;}' +
        '.iv-btn{position:absolute;border:0;border-radius:50%;width:44px;height:44px;cursor:pointer;' +
        'background:rgba(255,255,255,.14);color:#fff;font-size:22px;line-height:44px;text-align:center;padding:0;}' +
        '.iv-btn:hover,.iv-btn:focus-visible{background:rgba(255,255,255,.28);outline:none;}' +
        '.iv-close{top:12px;right:12px;}' +
        '.iv-prev{left:12px;top:50%;transform:translateY(-50%);}' +
        '.iv-next{right:12px;top:50%;transform:translateY(-50%);}' +
        '.iv-caption{position:absolute;bottom:14px;left:16px;right:16px;text-align:center;color:#e8efe9;' +
        'font:600 13px/1.4 system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.iv-error{color:#e8efe9;font:600 14px system-ui,sans-serif;}' +
        '[data-lightbox]{cursor:zoom-in;}' +
        '@media (max-width:560px){.iv-overlay{padding:56px 12px;}.iv-prev,.iv-next{top:auto;bottom:44px;transform:none;}}';

    var state = { urls: [], captions: [], index: 0, lastFocus: null };
    var overlay, img, caption, prevBtn, nextBtn, errorEl;

    function build() {
        if (overlay) return;
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        overlay = document.createElement('div');
        overlay.className = 'iv-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Image viewer');
        overlay.innerHTML =
            '<img alt="">' +
            '<div class="iv-error" hidden>This picture could not be loaded.</div>' +
            '<button type="button" class="iv-btn iv-close" aria-label="Close">&times;</button>' +
            '<button type="button" class="iv-btn iv-prev" aria-label="Previous picture">&#8249;</button>' +
            '<button type="button" class="iv-btn iv-next" aria-label="Next picture">&#8250;</button>' +
            '<div class="iv-caption"></div>';
        document.body.appendChild(overlay);

        img = overlay.querySelector('img');
        errorEl = overlay.querySelector('.iv-error');
        caption = overlay.querySelector('.iv-caption');
        prevBtn = overlay.querySelector('.iv-prev');
        nextBtn = overlay.querySelector('.iv-next');

        img.addEventListener('error', function () { img.hidden = true; errorEl.hidden = false; });
        img.addEventListener('load', function () { img.hidden = false; errorEl.hidden = true; });
        overlay.querySelector('.iv-close').addEventListener('click', close);
        prevBtn.addEventListener('click', function () { show(state.index - 1); });
        nextBtn.addEventListener('click', function () { show(state.index + 1); });
        // A click on the dark backdrop closes it; a click on the picture doesn't.
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    function show(index) {
        var n = state.urls.length;
        state.index = (index + n) % n;
        img.hidden = false;
        errorEl.hidden = true;
        img.src = state.urls[state.index];
        var text = state.captions[state.index] || '';
        caption.textContent = n > 1 ? (state.index + 1) + ' of ' + n + (text ? ' · ' + text : '') : text;
        img.alt = text || 'Picture ' + (state.index + 1);
        prevBtn.hidden = nextBtn.hidden = n < 2;
    }

    function open(urls, index, captions) {
        urls = (urls || []).filter(Boolean);
        if (!urls.length) return;
        build();
        state.urls = urls;
        state.captions = captions || [];
        state.lastFocus = document.activeElement;
        overlay.classList.add('open');
        show(index || 0);
        overlay.querySelector('.iv-close').focus();
    }

    function close() {
        if (!overlay || !overlay.classList.contains('open')) return;
        overlay.classList.remove('open');
        img.removeAttribute('src');
        if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    }

    document.addEventListener('click', function (e) {
        var el = e.target.closest && e.target.closest('[data-lightbox]');
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        var group = el.getAttribute('data-lightbox-group');
        var items = group
            ? Array.prototype.filter.call(document.querySelectorAll('[data-lightbox-group]'),
                function (x) { return x.getAttribute('data-lightbox-group') === group; })
            : [el];
        open(items.map(function (x) { return x.getAttribute('data-lightbox'); }),
            Math.max(0, items.indexOf(el)),
            items.map(function (x) { return x.getAttribute('data-lightbox-caption') || ''; }));
    }, true);

    document.addEventListener('keydown', function (e) {
        if (!overlay || !overlay.classList.contains('open')) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowLeft' && state.urls.length > 1) show(state.index - 1);
        else if (e.key === 'ArrowRight' && state.urls.length > 1) show(state.index + 1);
    }, true);

    window.openImageViewer = open;
    window.closeImageViewer = close;
})();
