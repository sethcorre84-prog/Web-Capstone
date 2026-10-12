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
    var CSS = `
        .iv-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;background:rgba(15,25,15,.45);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:20px;box-sizing:border-box;}
        .iv-overlay.open{display:flex;}
        .iv-card{width:100%;max-width:1025px;max-height:100%;min-width:0;padding:20px;border-radius:16px;background:#fff;box-sizing:border-box;overflow:auto;font-family:system-ui,sans-serif;box-shadow:0 18px 48px rgba(20,40,25,.22);}
        .iv-stage{position:relative;display:grid;place-items:center;min-height:260px;height:min(70vh,683px);border-radius:12px;background:#101710;overflow:hidden;}
        .iv-overlay img{display:block;width:100%;height:100%;min-height:0;max-height:min(70vh,683px);object-fit:contain;user-select:none;}
        .iv-overlay [hidden]{display:none!important;}
        .iv-btn{position:absolute;top:50%;transform:translateY(-50%);border:0;border-radius:50%;width:36px;height:36px;cursor:pointer;background:rgba(255,255,255,.88);color:#202820;font-size:22px;line-height:36px;text-align:center;padding:0;}
        .iv-btn:hover{background:#fff;}
        .iv-btn:focus-visible,.iv-close:focus-visible{outline:2px solid #52785c;outline-offset:3px;}
        .iv-prev{left:10px;}.iv-next{right:10px;}
        .iv-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:14px;}
        .iv-close{flex-shrink:0;border:0;border-radius:10px;padding:10px 18px;background:#f0f2ef;color:#202820;font:600 14px/1.4 system-ui,sans-serif;cursor:pointer;}
        .iv-close:hover{background:#e4e9e2;}
        .iv-caption{min-width:0;color:#617065;font:400 14px/1.4 system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .iv-error{color:#e8efe9;font:600 14px system-ui,sans-serif;}
        [data-lightbox]{cursor:zoom-in;}
        @media(max-width:560px){.iv-overlay{padding:12px;}.iv-card{padding:12px;}.iv-stage{min-height:160px;}.iv-caption{font-size:12px;}}
        @media(max-height:480px){.iv-stage{min-height:0;height:calc(100dvh - 130px);}.iv-overlay img{max-height:calc(100dvh - 130px);}}
    `;

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
            '<div class="iv-card"><div class="iv-stage"><img alt="">' +
            '<div class="iv-error" hidden>This picture could not be loaded.</div>' +
            '<button type="button" class="iv-btn iv-prev" aria-label="Previous picture">&#8249;</button>' +
            '<button type="button" class="iv-btn iv-next" aria-label="Next picture">&#8250;</button>' +
            '</div><div class="iv-bar"><div class="iv-caption" aria-live="polite"></div>' +
            '<button type="button" class="iv-close">Close</button></div></div>';
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
        if (!text && !/^(data|blob):/i.test(state.urls[state.index])) {
            try {
                text = decodeURIComponent(new URL(state.urls[state.index], document.baseURI).pathname).split('/').pop() || '';
            } catch (e) { text = ''; }
        }
        caption.textContent = (state.index + 1) + ' of ' + n + (text ? ' \u00b7 ' + text : '');
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
