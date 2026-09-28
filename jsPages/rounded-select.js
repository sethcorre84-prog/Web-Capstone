/* ==========================================================================
   rounded-select.js
   Gives every dropdown in the portal a rounded option list.

   A native <select>'s open list is drawn by the browser, and no CSS can round
   its corners. So when a dropdown is opened (click, Space, Alt+Down or F4)
   this shows its own rounded list in place of the browser's, built from the
   <select>'s options at that moment. The <select> itself stays on the page
   and still holds the value: picking an item sets select.value and fires the
   usual input + change events, so every page's existing code (filters,
   forms, select.value = ..., options filled in later) keeps working as is.

   Loaded on every page by sidebar.js. Phones and tablets keep their own
   full-screen pickers, which are not a plain box to begin with.
   ========================================================================== */
(function () {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;

    var style = document.createElement('style');
    style.textContent = [
        '.rs-list{position:fixed;z-index:2147483000;margin:0;padding:5px;list-style:none;',
        'box-sizing:border-box;max-height:260px;overflow-y:auto;overscroll-behavior:contain;',
        'background:var(--card-bg,#fff);color:var(--text-primary,#1c231c);',
        'border:1px solid var(--border,#e4e7e1);border-radius:12px;',
        'box-shadow:0 12px 28px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.08);}',
        '.rs-list li{padding:8px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;',
        'overflow:hidden;text-overflow:ellipsis;line-height:1.3;}',
        '.rs-list li + li{margin-top:2px;}',
        '.rs-list li.rs-active{background:var(--dm-surface-2,#f2f4f2);}',
        '.rs-list li.rs-selected{background:var(--accent-light,#e7f5eb);color:var(--accent-dark,#1f6b39);font-weight:600;}',
        // Stays light green under the mouse/keyboard too; the border marks the hover.
        '.rs-list li.rs-selected.rs-active{background:var(--accent-light,#e7f5eb);color:var(--accent-dark,#1f6b39);',
        'box-shadow:inset 0 0 0 1px var(--accent,#2f8f4e);}',
        '.rs-list li.rs-disabled{opacity:.45;cursor:default;background:none;}'
    ].join('');
    document.head.appendChild(style);

    var list = null;      // the open <ul>, if any
    var owner = null;     // the <select> it belongs to
    var items = [];       // [{ li, index }] for the options shown
    var active = -1;      // position in `items` highlighted by mouse/keyboard

    function usable(select) {
        return select instanceof HTMLSelectElement &&
            !select.multiple && !(select.size > 1) && !select.disabled;
    }

    function setActive(pos, scroll) {
        if (active >= 0 && items[active]) items[active].li.classList.remove('rs-active');
        active = pos;
        if (active < 0 || !items[active]) return;
        items[active].li.classList.add('rs-active');
        if (scroll) items[active].li.scrollIntoView({ block: 'nearest' });
    }

    function place() {
        var rect = owner.getBoundingClientRect();
        var gap = 4, margin = 8;
        list.style.minWidth = rect.width + 'px';
        list.style.maxWidth = Math.max(rect.width, window.innerWidth - margin * 2) + 'px';
        var height = list.offsetHeight;
        var below = window.innerHeight - rect.bottom - margin;
        var above = rect.top - margin;
        var top = (below < height + gap && above > below)
            ? Math.max(margin, rect.top - gap - height)
            : rect.bottom + gap;
        var left = Math.min(rect.left, window.innerWidth - list.offsetWidth - margin);
        list.style.top = top + 'px';
        list.style.left = Math.max(margin, left) + 'px';
    }

    function open(select) {
        close();
        owner = select;
        list = document.createElement('ul');
        list.className = 'rs-list';
        list.setAttribute('role', 'listbox');
        var computed = getComputedStyle(select);
        list.style.fontFamily = computed.fontFamily;
        list.style.fontSize = computed.fontSize;

        items = [];
        Array.prototype.forEach.call(select.options, function (option, index) {
            if (option.hidden) return;
            var li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.textContent = option.label || option.textContent;
            if (option.disabled) li.classList.add('rs-disabled');
            if (index === select.selectedIndex) {
                li.classList.add('rs-selected');
                li.setAttribute('aria-selected', 'true');
            }
            var pos = items.length;
            li.addEventListener('mousemove', function () {
                if (active !== pos && !option.disabled) setActive(pos, false);
            });
            li.addEventListener('click', function () {
                if (!option.disabled) choose(index);
            });
            items.push({ li: li, index: index, disabled: option.disabled });
            list.appendChild(li);
        });
        if (!items.length) { list = null; owner = null; return; }

        // Keep focus on the <select>, and keep page-level "click outside"
        // handlers (menus, modals) from treating a pick as an outside click.
        ['mousedown', 'pointerdown', 'click', 'touchstart'].forEach(function (type) {
            list.addEventListener(type, function (event) {
                if (type === 'mousedown') event.preventDefault();
                event.stopPropagation();
            });
        });

        document.body.appendChild(list);
        place();
        var current = items.findIndex(function (item) { return item.index === select.selectedIndex; });
        setActive(current, true);
        select.setAttribute('aria-expanded', 'true');
    }

    function close() {
        if (!list) return;
        list.remove();
        owner.setAttribute('aria-expanded', 'false');
        list = null;
        owner = null;
        items = [];
        active = -1;
    }

    function choose(index) {
        var select = owner;
        close();
        select.focus();
        if (select.selectedIndex === index) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function step(from, delta) {
        for (var pos = from + delta; pos >= 0 && pos < items.length; pos += delta) {
            if (!items[pos].disabled) return pos;
        }
        return from;
    }

    // Open on a left click instead of the browser's list.
    document.addEventListener('mousedown', function (event) {
        var select = event.target.closest && event.target.closest('select');
        if (list && event.target !== owner && !list.contains(event.target)) close();
        if (!select || event.button !== 0 || !usable(select)) return;
        event.preventDefault();
        select.focus();
        if (owner === select) close();
        else open(select);
    }, true);

    document.addEventListener('keydown', function (event) {
        var select = event.target;
        if (!usable(select)) return;
        var key = event.key;

        if (owner !== select) {
            // Plain arrows keep changing the value in place, as they always did.
            if (key === ' ' || key === 'F4' || (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp'))) {
                event.preventDefault();
                open(select);
            }
            return;
        }

        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            if (event.altKey) { close(); return; }
            setActive(step(active, key === 'ArrowDown' ? 1 : -1), true);
        } else if (key === 'Home' || key === 'End') {
            event.preventDefault();
            setActive(key === 'Home' ? step(-1, 1) : step(items.length, -1), true);
        } else if (key === 'Enter' || key === ' ') {
            event.preventDefault();
            if (items[active] && !items[active].disabled) choose(items[active].index);
            else close();
        } else if (key === 'Escape') {
            event.preventDefault();
            event.stopPropagation(); // close the list, not the modal around it
            close();
        } else if (key === 'Tab') {
            close();
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Jump to the next item starting with that letter.
            event.preventDefault();
            var letter = key.toLowerCase();
            for (var n = 1; n <= items.length; n++) {
                var pos = (active + n) % items.length;
                if (!items[pos].disabled && items[pos].li.textContent.trim().toLowerCase().startsWith(letter)) {
                    setActive(pos, true);
                    break;
                }
            }
        }
    }, true);

    document.addEventListener('focusout', function (event) {
        if (event.target === owner) close();
    }, true);

    // The list is pinned to the viewport, so it closes rather than drift away
    // when the page scrolls or resizes (scrolling the list itself is fine).
    document.addEventListener('scroll', function (event) {
        if (list && event.target !== list) close();
    }, true);
    window.addEventListener('resize', close);
})();
