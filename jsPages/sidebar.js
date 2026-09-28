/* ==========================================================================
   sidebar.js
   Makes the PeakPath admin sidebar collapsible on every page.
   Just add this one line near the top of <head>, before your stylesheets:

       <script src="sidebar.js"></script>

   It does everything else automatically:
   - Applies the collapsed width instantly (before paint) if the sidebar
     was left collapsed on a previous page, so there's no flash.
   - Once the page's DOM is ready, injects the toggle button and wraps
     each nav label in a <span class="nav-text"> so pages.css can hide
     them when collapsed — no HTML edits needed.
   - Saves the collapsed/expanded state to localStorage so it persists
     as the admin navigates between pages.
   - Applies the Theme setting (Settings > General Settings: Light, Dark or
     System) the same way: before paint, so a dark page never flashes white first.
   ========================================================================== */

/* Rounded dropdown lists on every page (see rounded-select.js), loaded from
   the same folder as this file. */
(function () {
    var self = document.currentScript;
    if (!self) return;
    var script = document.createElement('script');
    script.src = new URL('rounded-select.js', self.src).href;
    document.head.appendChild(script);
})();

/* Dark mode. Kept outside the sidebar code because it applies to the whole
   page, and exposed as window.PeakPathTheme so Settings can switch it. The
   choice is stored per browser, like the other Settings toggles. */
(function () {
    var THEME_KEY = 'peakpath-theme';
    var THEMES = ['light', 'dark', 'system'];
    // "system" follows the computer's own light/dark setting, live.
    var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    // The stored choice: 'light', 'dark' or 'system'.
    function read() {
        try {
            var saved = localStorage.getItem(THEME_KEY);
            return THEMES.indexOf(saved) === -1 ? 'light' : saved;
        } catch (error) {
            return 'light'; // storage blocked: stay on the default look
        }
    }

    function apply(theme) {
        var dark = theme === 'dark' || (theme === 'system' && !!systemDark && systemDark.matches);
        if (dark) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    apply(read());

    // Switching in one tab switches every other open portal tab too.
    window.addEventListener('storage', function (event) {
        if (event.key === THEME_KEY) apply(read());
    });

    // On "system", flip along with the computer (e.g. its evening dark mode).
    if (systemDark) {
        var onSystemChange = function () {
            if (read() === 'system') apply('system');
        };
        if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemChange);
        else if (systemDark.addListener) systemDark.addListener(onSystemChange);
    }

    window.PeakPathTheme = {
        get: read,
        set: function (theme) {
            var next = THEMES.indexOf(theme) === -1 ? 'light' : theme;
            localStorage.setItem(THEME_KEY, next);
            apply(next);
            return next;
        }
    };
})();

(function () {
    var STORAGE_KEY = 'peakpath-sidebar-collapsed';
    var wasCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';

    // Step 1: apply instantly, before paint, to avoid a flash of the
    // expanded sidebar on load. Requires the matching CSS rule in pages.css:
    //   .sidebar-was-collapsed .sidebar { width: 76px; padding: 22px 10px; }
    if (wasCollapsed) {
        document.documentElement.classList.add('sidebar-was-collapsed');
    }

    function wrapNavText(link) {
        // Wrap the trailing text node of a nav/logout link in <span class="nav-text">
        // so pages.css can hide it while collapsed, without touching your HTML.
        var childNodes = Array.prototype.slice.call(link.childNodes);
        childNodes.forEach(function (node) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
                var span = document.createElement('span');
                span.className = 'nav-text';
                span.textContent = node.textContent;
                link.replaceChild(span, node);
            }
        });
    }

    function init() {
        var sidebar = document.querySelector('.sidebar');
        if (!sidebar) return; // page has no sidebar, nothing to do

        // Wrap nav item labels
        document.querySelectorAll('.nav li a').forEach(wrapNavText);

        // Wrap the logout link label
        var logoutBtn = document.querySelector('.logout-btn');
        if (logoutBtn) wrapNavText(logoutBtn);

        // Inject the toggle button as the first child of the sidebar,
        // unless a page has already added one manually.
        var toggleBtn = document.getElementById('sidebarToggle');
        if (!toggleBtn) {
            toggleBtn = document.createElement('button');
            toggleBtn.id = 'sidebarToggle';
            toggleBtn.className = 'sidebar-toggle';
            toggleBtn.setAttribute('aria-label', 'Toggle sidebar');
            toggleBtn.innerHTML =
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
            sidebar.insertBefore(toggleBtn, sidebar.firstChild);
        }

        // Restore actual collapsed state (in addition to the pre-paint class above)
        if (wasCollapsed) {
            sidebar.classList.add('collapsed');
        }

        toggleBtn.addEventListener('click', function () {
            var isCollapsed = sidebar.classList.toggle('collapsed');
            // Keep the pre-paint helper class in sync too, otherwise expanding
            // leaves the sidebar forced narrow while the labels reappear.
            document.documentElement.classList.toggle('sidebar-was-collapsed', isCollapsed);
            localStorage.setItem(STORAGE_KEY, isCollapsed);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();