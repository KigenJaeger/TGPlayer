// TGPlayer motion runtime ----------------------------------------------------
// A small, dependency-free animation layer modelled on Telegram Desktop's own
// engine. Two ideas are copied directly from it:
//
//   1. Progress is computed from a timestamp, never accumulated frame by frame.
//      A dropped frame changes nothing about where the animation ends, and a
//      stalled tab cannot leave a value stranded mid-way.
//   2. Entering and leaving are separate curves with separate durations. Arrive
//      quickly and settle; leave more slowly and ease in.
//
// Every entry point checks `reduced()` first and, when motion is off, jumps
// straight to the final value instead of animating a shorter distance. That is
// what Telegram does when animations are disabled, and it is the only behaviour
// that keeps the UI correct: a half-finished fade is a bug, not a compromise.
//
// Durations are read from the CSS custom properties in motion.css, so the
// stylesheet stays the single source of truth for timing.
(function () {
  'use strict';

  if (window.TGMotion) return;

  // --- Easing ---------------------------------------------------------------
  // Exact formulas rather than cubic-bezier approximations: CSS cannot express
  // easeOutCirc's curvature, and a bezier stand-in visibly changes the feel of a
  // page slide. These match the shapes Telegram Desktop ships.
  const ease = {
    linear: (t) => t,
    outCirc: (t) => Math.sqrt(1 - (t - 1) * (t - 1)),
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    inCirc: (t) => 1 - Math.sqrt(1 - t * t),
    outBack: (t) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  };

  // --- Token access ---------------------------------------------------------
  // getComputedStyle().getPropertyValue() forces a style resolution, and it was
  // being called for every tween creation -- on every page transition, counter
  // roll, shake and flight. The values only change when the theme does, so they
  // are read once and cached, and the app invalidates the cache when it reports
  // a new appearance. Falls back to the documented value so a missing custom
  // property cannot freeze an animation.
  const tokenCache = new Map();

  function readTokenMs(name, fallback) {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const value = parseFloat(raw);
      if (!Number.isFinite(value)) return fallback;
      return /ms$/.test(raw) ? value : value * 1000;
    } catch (error) {
      return fallback;
    }
  }

  function tokenMs(name, fallback) {
    const cached = tokenCache.get(name);
    if (cached !== undefined) return cached;
    const value = readTokenMs(name, fallback);
    tokenCache.set(name, value);
    return value;
  }

  // Called when the theme or preset changes, so the next read picks up the new
  // timing without paying a style resolution on every animation in between.
  function invalidateTokens() {
    tokenCache.clear();
  }

  const reduceQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  // Either the in-app switch or the OS setting turns motion off. They mean the
  // same thing, so they resolve to one predicate.
  function reduced() {
    if (document.body && document.body.classList.contains('reduce-motion')) return true;
    return Boolean(reduceQuery && reduceQuery.matches);
  }

  // --- Tween ----------------------------------------------------------------
  // Animations are tracked per element, so starting a new one on the same element
  // cancels the previous one. Without this, a rapid sequence of updates leaves the
  // earlier tween running: it keeps writing the element's style, and its onDone
  // then overwrites whatever the newer animation had already applied.
  const activeByElement = new WeakMap();

  function cancelFor(el) {
    if (!el) return;
    const previous = activeByElement.get(el);
    if (previous) {
      previous.cancel();
      activeByElement.delete(el);
    }
  }

  function trackOn(el, handle) {
    if (!el) return handle;
    cancelFor(el);
    activeByElement.set(el, handle);
    return handle;
  }

  // from/to are plain numbers; onUpdate receives the eased value plus the raw
  // 0..1 progress. With reduced motion the final value is applied once.
  function tween(options) {
    const opts = options || {};
    const from = opts.from == null ? 0 : opts.from;
    const to = opts.to == null ? 1 : opts.to;
    const duration = opts.duration == null ? tokenMs('--motion-normal', 200) : opts.duration;
    const curve = opts.ease || ease.outCubic;
    const onUpdate = opts.onUpdate || function () {};
    const onDone = opts.onDone;

    if (reduced() || !(duration > 0)) {
      onUpdate(to, 1);
      if (onDone) onDone();
      return { cancel() {} };
    }

    let frame = 0;
    let cancelled = false;
    let settled = false;
    const start = performance.now();

    // A watchdog that settles the animation even if requestAnimationFrame never
    // runs. rAF is suspended while a window is occluded or minimised, and it
    // stalls behind a long main-thread task; without this, onDone would never
    // fire and whatever the animation was responsible for cleaning up -- a fly
    // item, a page's inline style, an overlay -- would stay in the document for
    // the life of the window. setTimeout still fires in those states, so the
    // final value always lands.
    const watchdog = setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      onUpdate(to, 1);
      if (onDone) onDone();
    }, duration + 120);

    const step = (now) => {
      if (cancelled) return;
      const progress = Math.min(1, (now - start) / duration);
      onUpdate(from + (to - from) * curve(progress), progress);
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        if (onDone) onDone();
      }
    };
    frame = requestAnimationFrame(step);

    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(watchdog);
        cancelAnimationFrame(frame);
      },
    };
  }

  // --- Ripple ---------------------------------------------------------------
  // An ink circle expanding from the press point, clipped to the host's own
  // rounded shape. This is Telegram's primary press affordance and the single
  // biggest change to how the interface feels.
  const RIPPLE_FLAG = 'data-motion-ripple';

  function attachRipple(el) {
    if (!el || el.getAttribute(RIPPLE_FLAG) === '1') return;
    el.setAttribute(RIPPLE_FLAG, '1');
    el.classList.add('ripple-host');
    // Only supply positioning for static hosts. Forcing `position: relative`
    // onto an element that is absolutely positioned elsewhere in the stylesheet
    // would pull it out of the place it was put.
    if (getComputedStyle(el).position === 'static') el.classList.add('ripple-host-position');

    el.addEventListener('pointerdown', (event) => {
      if (reduced()) return;
      if (typeof event.button === 'number' && event.button !== 0) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.hypot(
        Math.max(x, rect.width - x),
        Math.max(y, rect.height - y));

      // One ink per host: pressing again re-uses the existing one instead of
      // stacking a second circle on top of it.
      el.querySelectorAll('.ripple-ink').forEach((node) => node.remove());

      const ink = document.createElement('span');
      ink.className = 'ripple-ink';
      ink.style.width = radius * 2 + 'px';
      ink.style.height = radius * 2 + 'px';
      ink.style.left = x - radius + 'px';
      ink.style.top = y - radius + 'px';
      el.appendChild(ink);

      // The ink stays at full strength for as long as the press lasts, and only
      // fades once the press ends -- on release, on cancel, or when the pointer
      // is dragged off the control. That is what makes the highlight feel
      // attached to the press rather than to a fixed timer.
      let released = false;
      const release = () => {
        if (released || !ink.isConnected) return;
        released = true;
        el.removeEventListener('pointerup', release);
        el.removeEventListener('pointercancel', release);
        el.removeEventListener('pointerleave', release);
        ink.classList.add('releasing');
        ink.addEventListener('animationend', () => ink.remove(), { once: true });
        // Safety net: if the fade never fires, the ink must still go.
        setTimeout(() => ink.remove(), tokenMs('--motion-fast', 150) + 260);
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);

      // A press that never reports a release (the element was detached, the
      // window lost focus) still has to retire its ink.
      setTimeout(() => {
        if (!released) release();
      }, 2600);
    });
  }

  // Lists re-render constantly, so ripple attachment is idempotent and meant to
  // be re-run after each render rather than bound once at boot.
  const RIPPLE_SELECTOR = [
    '.primary-button', '.soft-button', '.text-button', '.link-button',
    '.cloud-action', '.icon-button', '.avatar-button', '.heart-button',
    '.control-button', '.round-play', '.filter-pill', '.choice', '.swatch',
    '.preset-card', '.nav-item', '.track-row', '.channel-card', '.chat-row',
    '.playlist-card', '.popover-item', '.modal-close',
    '.window-controls.integrated button',
  ].join(',');

  function refreshRipple(scope) {
    const root = scope || document;
    if (root.nodeType === 1 && root.matches && root.matches(RIPPLE_SELECTOR)) attachRipple(root);
    root.querySelectorAll(RIPPLE_SELECTOR).forEach(attachRipple);
  }

  // --- Stagger --------------------------------------------------------------
  // A list resolves as a wave instead of one block. Only the first render of a
  // container animates: re-running it on every filter keystroke would flicker.
  function stagger(container, selector, options) {
    if (!container) return;
    const opts = options || {};
    const items = container.querySelectorAll(selector || ':scope > *');
    // An empty container must not consume the one-shot flag, or the list would
    // never animate once the data finally arrives.
    if (!items.length) return;
    if (container.dataset.motionStaggered === '1' && !opts.force) return;
    container.dataset.motionStaggered = '1';

    const cap = opts.cap == null ? 8 : opts.cap;
    items.forEach((item, index) => {
      item.classList.add('motion-item');
      item.style.setProperty('--i', String(Math.min(index, cap)));
    });
  }

  // --- Shake ----------------------------------------------------------------
  // Ported from Telegram's DefaultShakeCallback: five damped segments that swing
  // right, left, right, left, and settle. Used for rejected input, where a
  // toast alone does not say *which* field is wrong.
  function shake(el, options) {
    if (!el) return;
    const opts = options || {};
    const amplitude = opts.amplitude == null ? 8 : opts.amplitude;
    const duration = opts.duration == null ? tokenMs('--motion-slow', 320) * 1.25 : opts.duration;
    const segments = 5;

    // Tracked so a second rejection cancels the first instead of two tweens
    // fighting over the same transform.
    const handle = tween({
      from: 0,
      to: 1,
      duration,
      ease: ease.linear,
      onUpdate: (value) => {
        const full = value * 6;
        const segment = Math.min(segments, Math.max(0, Math.floor(full)));
        const part = full - segment;
        const from = segment === 0
          ? 0
          : (segment === 1 || segment === 3 || segment === 5) ? 1 : -1;
        const to = (segment === 0 || segment === 2 || segment === 4)
          ? 1
          : (segment === 1 || segment === 3) ? -1 : 0;
        const shift = from * (1 - part) + to * part;
        el.style.transform = 'translateX(' + (shift * amplitude).toFixed(2) + 'px)';
      },
      onDone: () => { el.style.transform = ''; },
    });
    trackOn(el, handle);
  }

  // --- Text replacement -----------------------------------------------------
  // Telegram's cross-fade label: the old value lifts and fades, the new one
  // rises into place. Applied to the now-playing title and artist so a track
  // change reads as a change instead of a silent string swap.
  function crossFadeText(el, value, direction) {
    if (!el) return;
    const next = String(value == null ? '' : value);
    if (el.dataset.motionText === next) return;
    const first = el.dataset.motionText === undefined;
    el.dataset.motionText = next;

    // Every path leaves the element holding the new text. The animation is only
    // ever an overlay of the *old* text on top of it, so the element is correct
    // even if the animation never runs a frame -- which is what a stalled rAF
    // would otherwise turn into concatenated text.
    cancelFor(el);
    el.querySelectorAll('[data-motion-ghost]').forEach((node) => node.remove());

    if (first || reduced() || next.length > 60 || el.textContent === next) {
      el.textContent = next;
      return;
    }

    const previous = el.textContent;
    const shift = (direction === -1 ? -1 : 1) * Math.max(12, el.offsetHeight || 12);
    // The position check forces a style resolution, so it is done once per
    // element rather than on every text change.
    if (el.dataset.motionPositioned !== '1') {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.dataset.motionPositioned = '1';
    }

    el.textContent = next;
    const ghost = document.createElement('span');
    ghost.dataset.motionGhost = '1';
    ghost.textContent = previous;
    ghost.style.cssText = 'position:absolute;left:0;top:0;right:0;pointer-events:none;';
    el.appendChild(ghost);

    tween({
      from: 0,
      to: 1,
      duration: tokenMs('--motion-slow', 320),
      ease: ease.outCubic,
      onUpdate: (t) => {
        ghost.style.opacity = String(1 - t);
        ghost.style.transform = 'translateY(' + (-shift * t).toFixed(2) + 'px)';
      },
      onDone: () => { ghost.remove(); },
    });
  }

  // --- Numeric roll ---------------------------------------------------------
  // Counters (library size, favourites, cache size) roll to their new value.
  function count(el, to, options) {
    if (!el) return;
    const opts = options || {};
    const target = Number(to) || 0;
    const previous = Number(el.dataset.motionCount);
    const from = Number.isFinite(previous) ? previous : (opts.from == null ? 0 : Number(opts.from) || 0);
    el.dataset.motionCount = String(target);
    const format = opts.format || ((value) => String(Math.round(value)));

    if (reduced() || from === target) {
      el.textContent = format(target);
      return;
    }

    tween({
      from,
      to: target,
      duration: opts.duration == null ? tokenMs('--motion-slow', 320) : opts.duration,
      ease: ease.outQuint,
      onUpdate: (value) => { el.textContent = format(value); },
    });
  }

  // --- Parabolic flight -----------------------------------------------------
  // Ported from Telegram's reaction fly: the object travels a straight line in
  // x and a parabola in y, so any source-to-target pair arcs naturally instead
  // of crossing the screen in a straight diagonal.
  function parabolicTop(fromY, toY, lift, t) {
    const y1 = toY - fromY;
    if (!y1) {
      const y0 = -lift;
      return fromY - 4 * y0 * t * (1 - t);
    }
    const y0 = Math.min(0, y1) - lift;
    const ratio = y0 / y1;
    const disc = ratio * (ratio - 1);
    const root = disc > 0 ? Math.sqrt(disc) : 0;
    const t0 = y1 > 0 ? (ratio + root) : (ratio - root);
    const a = y1 / (1 - 2 * t0);
    const b = y1 - a;
    return a * t * t + b * t + fromY;
  }

  let flyLayer = null;
  function ensureFlyLayer() {
    if (flyLayer && flyLayer.isConnected) return flyLayer;
    flyLayer = document.createElement('div');
    flyLayer.className = 'motion-fly-layer';
    document.body.appendChild(flyLayer);
    return flyLayer;
  }

  // Concurrent flights are capped. Each one is short-lived and now has a watchdog,
  // so this is not the normal path -- it exists so that holding down an "add"
  // control, or a stuck frame, cannot pile up animated layers without bound.
  const kMaxConcurrentFlights = 6;

  function fly(options) {
    const opts = options || {};
    const from = opts.from;
    const to = opts.to;
    if (!from || !to || reduced()) {
      if (opts.onDone) opts.onDone();
      return { cancel() {} };
    }

    const layer = ensureFlyLayer();
    // Oldest first, so a burst degrades into fewer flights rather than a growing
    // layer. Cheap because the layer only ever holds a handful of items.
    const live = layer.children;
    while (live.length >= kMaxConcurrentFlights) live[0].remove();

    const width = opts.width == null ? from.width : opts.width;
    const height = opts.height == null ? from.height : opts.height;
    const item = document.createElement('div');
    item.className = 'motion-fly-item';
    item.style.width = width + 'px';
    item.style.height = height + 'px';
    item.style.borderRadius = (opts.radius == null ? 12 : opts.radius) + 'px';

    // Visual source: prefer a decoded cover, otherwise reuse whatever the
    // originating tile paints (gradient or flat tone), so a track with no
    // artwork still flies as its own colour rather than a generic block.
    const image = opts.image || (opts.source && opts.source.querySelector('img.ready'));
    if (image) {
      const img = document.createElement('img');
      img.src = image.currentSrc || image.src;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      item.appendChild(img);
    } else if (opts.source) {
      const cs = getComputedStyle(opts.source);
      item.style.background = cs.backgroundImage && cs.backgroundImage !== 'none'
        ? cs.backgroundImage
        : (cs.backgroundColor || 'var(--accent)');
    } else {
      item.style.background = opts.background || 'var(--accent)';
    }

    layer.appendChild(item);

    const fromCx = from.left + from.width / 2;
    const fromCy = from.top + from.height / 2;
    const toCx = to.left + to.width / 2;
    const toCy = to.top + to.height / 2;
    const endSize = opts.endSize == null ? Math.min(to.width, to.height) : opts.endSize;
    const targetScale = Math.max(0.14, Math.min(1, endSize / Math.max(width, height)));
    const lift = opts.lift == null ? 92 : opts.lift;

    const handle = tween({
      from: 0,
      to: 1,
      duration: opts.duration == null ? tokenMs('--motion-slow', 320) : opts.duration,
      // Telegram's fly is linear; the arc comes from the geometry, not the curve.
      ease: ease.linear,
      onUpdate: (t) => {
        const cx = fromCx + (toCx - fromCx) * t;
        const cy = parabolicTop(fromCy, toCy, lift, t);
        const scale = 1 + (targetScale - 1) * t;
        const opacity = t > 0.82 ? Math.max(0, 1 - (t - 0.82) / 0.18) : 1;
        item.style.transform = 'translate(' + (cx - width / 2).toFixed(2) + 'px,'
          + (cy - height / 2).toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')';
        item.style.opacity = String(opacity);
      },
      onDone: () => {
        item.remove();
        if (opts.onDone) opts.onDone();
      },
    });

    // The item is the animation's only cleanup responsibility, so a cancelled
    // flight must remove it too rather than leaving it parked on the layer.
    const cancelFlight = handle.cancel;
    handle.cancel = () => {
      cancelFlight();
      item.remove();
    };
    return handle;
  }

  // --- Page transition ------------------------------------------------------
  // Outgoing page fades up and leaves on the fast exit curve; incoming page
  // rises and fades in on the slower entrance curve. The outgoing page is
  // lifted out of flow so the two do not fight over the scroll container.
  function clearInline(el) {
    if (!el) return;
    el.style.position = '';
    el.style.inset = '';
    el.style.zIndex = '';
    el.style.pointerEvents = '';
    el.style.opacity = '';
    el.style.transform = '';
  }

  // A navigation can be triggered again before the previous one finishes. Only
  // one transition may own these elements at a time: a second one starting on
  // top would have the first one's completion wipe the new inline state, and a
  // page could be left marked active after it had already left.
  let pageState = null;

  function settlePageTransition() {
    const state = pageState;
    if (!state) return;
    pageState = null;
    if (state.outHandle) state.outHandle.cancel();
    if (state.inHandle) state.inHandle.cancel();
    if (state.shadow) state.shadow.remove();
    if (state.outEl) {
      state.outEl.classList.remove(state.activeClass);
      clearInline(state.outEl);
    }
    if (state.inEl) clearInline(state.inEl);
  }

  function pageTransition(outEl, inEl, options) {
    const opts = options || {};
    const activeClass = opts.activeClass || 'active';
    // Whatever the previous navigation was doing is finished immediately, so this
    // one starts from a consistent document either way.
    settlePageTransition();

    if (!inEl) {
      if (outEl) { outEl.classList.remove(activeClass); clearInline(outEl); }
      return;
    }
    if (reduced() || !outEl || outEl === inEl) {
      if (outEl && outEl !== inEl) { outEl.classList.remove(activeClass); clearInline(outEl); }
      inEl.classList.add(activeClass);
      clearInline(inEl);
      return;
    }

    // Defensive sweep within the container: any element still marked active that
    // this transition is not about to animate is settled, so no earlier
    // navigation can strand one.
    const container = inEl.parentElement;
    if (container && opts.uniqueActive !== false) {
      container.querySelectorAll('.' + activeClass).forEach((el) => {
        if (el !== inEl && el !== outEl) {
          el.classList.remove(activeClass);
          clearInline(el);
        }
      });
    }

    inEl.classList.add(activeClass);
    inEl.style.position = 'relative';
    inEl.style.zIndex = '1';

    outEl.classList.add(activeClass);
    outEl.style.position = 'absolute';
    outEl.style.inset = '0';
    outEl.style.zIndex = '0';
    outEl.style.pointerEvents = 'none';

    // Direction follows the document order of the pages, which is the same order
    // the navigation lists them in, so a forward move slides one way and going
    // back slides the other.
    const siblings = container ? [...container.querySelectorAll('.page')] : [];
    const outIndex = siblings.indexOf(outEl);
    const inIndex = siblings.indexOf(inEl);
    let direction = 1;
    if (outIndex >= 0 && inIndex >= 0) direction = inIndex >= outIndex ? 1 : -1;

    const width = Math.max(1, container ? container.clientWidth : inEl.clientWidth);
    // The outgoing page only shifts a little; the incoming one travels its whole
    // width. Sliding both by the full width reads as a carousel, and sliding both
    // by a little reads as a nudge. This asymmetric pair is what makes the new
    // page feel like it is arriving over the old one.
    const shift = Math.min(48, Math.round(width * 0.06));

    // A soft edge between the two pages, carried by the incoming one, so the
    // boundary has depth instead of being a hard seam.
    const shadow = document.createElement('div');
    shadow.style.cssText = 'position:absolute;top:0;bottom:0;width:26px;pointer-events:none;z-index:2;'
      + 'background:linear-gradient(90deg, rgba(15,30,45,.18), rgba(15,30,45,0));';
    if (direction > 0) shadow.style.left = '-26px';
    else {
      shadow.style.right = '-26px';
      shadow.style.background = 'linear-gradient(270deg, rgba(15,30,45,.18), rgba(15,30,45,0))';
    }
    inEl.appendChild(shadow);

    inEl.style.opacity = '0';
    inEl.style.transform = 'translateX(' + (direction * width) + 'px)';

    const outHandle = tween({
      from: 0,
      to: 1,
      duration: tokenMs('--motion-normal', 200),
      ease: ease.outCirc,
      onUpdate: (t) => {
        outEl.style.transform = 'translateX(' + (-direction * shift * t).toFixed(2) + 'px)';
        // The page being left recedes rather than vanishing at the first frame.
        outEl.style.opacity = String(1 - 0.55 * t);
      },
      onDone: () => {
        outEl.classList.remove(activeClass);
        clearInline(outEl);
      },
    });

    const inHandle = tween({
      from: 0,
      to: 1,
      duration: tokenMs('--motion-normal', 200),
      ease: ease.outCirc,
      onUpdate: (t) => {
        inEl.style.transform = 'translateX(' + (direction * width * (1 - t)).toFixed(2) + 'px)';
        inEl.style.opacity = String(t);
        shadow.style.opacity = String(Math.min(1, t * 2.2));
      },
      onDone: () => {
        clearInline(inEl);
        shadow.remove();
      },
    });

    pageState = { outEl, inEl, outHandle, inHandle, activeClass, shadow };
  }

  // --- Leaving --------------------------------------------------------------
  // Surfaces kept in the layout and faded rather than toggled with `display`
  // need the exit curve applied before they are hidden. Resolves once the
  // surface is actually gone, so callers can sequence work after it.
  function leave(el, options) {
    const opts = options || {};
    const openClass = opts.open || 'open';
    const leavingClass = opts.leaving || 'leaving';

    const finish = () => {
      el.classList.remove(openClass);
      el.classList.remove(leavingClass);
      if (opts.onHidden) opts.onHidden();
    };

    if (!el || reduced()) {
      finish();
      return Promise.resolve();
    }

    el.classList.add(leavingClass);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('transitionend', onEnd);
        finish();
        resolve();
      };
      const onEnd = (event) => {
        if (event.target === el && (event.propertyName === 'opacity' || event.propertyName === 'transform')) done();
      };
      el.addEventListener('transitionend', onEnd);
      setTimeout(done, tokenMs('--motion-fast', 150) + 120);
    });
  }

  window.TGMotion = {
    ease,
    reduced,
    tokenMs,
    invalidateTokens,
    tween,
    shake,
    stagger,
    count,
    fly,
    crossFadeText,
    pageTransition,
    leave,
    ripple: { attach: attachRipple, refresh: refreshRipple, selector: RIPPLE_SELECTOR },
  };
})();
