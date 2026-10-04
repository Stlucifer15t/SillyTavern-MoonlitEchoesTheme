import { getSettings as getExtensionSettings } from '../services/settings-service.js';

function stripOrigin(url) {
    if (!url) return '';
    if (url.startsWith(window.location.origin)) {
        return url.replace(window.location.origin, '');
    }
    return url;
}

function parseAvatarSource(rawSrc) {
    if (!rawSrc) return null;

    const normalized = stripOrigin(rawSrc);
    const trimmed = normalized.startsWith('/') ? normalized.slice(1) : normalized;

    try {
        const parsed = new URL(normalized, window.location.origin);
        if (parsed.pathname.endsWith('thumbnail')) {
            const type = parsed.searchParams.get('type');
            const file = parsed.searchParams.get('file');
            if (type && file) {
                return { type, file: decodeURIComponent(file) };
            }
        }
    } catch (err) {
        // Ignore URL parse errors and fall back to path inspection
    }

    if (trimmed.startsWith('characters/')) {
        return { type: 'avatar', file: trimmed.replace(/^characters\//, '') };
    }

    if (trimmed.startsWith('User Avatars/')) {
        return { type: 'persona', file: trimmed.replace(/^User Avatars\//, '') };
    }

    return { type: null, file: trimmed };
}

function getAvatarSources(rawSrc) {
    const info = parseAvatarSource(rawSrc);
    if (!info) {
        return { thumb: null, original: null };
    }

    const { type, file } = info;
    const ensureAbsolute = (path) => {
        if (!path) return '';
        return path.startsWith('/') ? path : `/${path}`;
    };

    const thumb =
        type === 'avatar' || type === 'persona'
            ? `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`
            : ensureAbsolute(info.file);

    const original =
        type === 'avatar'
            ? ensureAbsolute(`characters/${file}`)
            : type === 'persona'
                ? ensureAbsolute(`User Avatars/${file}`)
                : ensureAbsolute(info.file);

    return {
        thumb: stripOrigin(thumb),
        original: stripOrigin(original),
    };
}

function formatSrcsetUrl(url) {
    try {
        return encodeURI(url).replace(/,/g, '%2C');
    } catch (err) {
        return url.replace(/,/g, '%2C');
    }
}

/**
 * Remembers what has already been written to each message element so repeated
 * passes are no-ops. Keyed by message element, valued by the resolved avatar
 * signature. A WeakMap means unloaded chats are garbage collected normally.
 * @type {WeakMap<Element, string>}
 */
const appliedAvatarSignatures = new WeakMap();

function applyAvatarSources(mes, avatarImg, preferOriginal) {
    const srcCandidate = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src');
    if (!srcCandidate) return;

    const { thumb, original } = getAvatarSources(srcCandidate);
    if (!thumb && !original) return;

    const thumbUrl = thumb || original;
    const originalUrl = original || thumbUrl;
    const targetUrl = preferOriginal ? originalUrl : thumbUrl;

    // Signature is derived from the *computed* urls, so rewriting <img src> to
    // the thumbnail below cannot cause the next pass to see it as a change.
    const signature = `${preferOriginal ? 'o' : 't'}|${originalUrl}|${targetUrl}`;
    if (appliedAvatarSignatures.get(mes) === signature) return;

    // Only the two variables actually consumed by the stylesheets are written.
    mes.style.setProperty('--mes-avatar-original-url', `url('${originalUrl}')`);
    mes.style.setProperty('--mes-avatar-url', `url('${targetUrl}')`);

    const currentSrc = stripOrigin(avatarImg.getAttribute('src') || '');
    const desiredSrc = stripOrigin(thumbUrl);
    if (desiredSrc && currentSrc !== desiredSrc) {
        avatarImg.setAttribute('src', thumbUrl);
    }

    if (preferOriginal && originalUrl && originalUrl !== thumbUrl) {
        avatarImg.setAttribute('srcset', formatSrcsetUrl(originalUrl));
    } else {
        avatarImg.removeAttribute('srcset');
    }

    appliedAvatarSignatures.set(mes, signature);
}

function resolvePreferOriginal() {
    const context = SillyTavern.getContext();
    const settings = getExtensionSettings(context) || {};
    return (
        settings.useOriginalAvatarImages === true ||
        document.body.classList.contains('ripplestyle')
    );
}

/**
 * Initialize avatar injector observer.
 * Injects avatar URLs into message elements so they can be used in CSS.
 *
 * Only messages that actually changed are re-processed: during streaming
 * SillyTavern mutates the last message on every token, and rescanning the whole
 * chat each time cost hundreds of style writes per token on long chats.
 * @returns {function} Function to manually trigger a full avatar refresh.
 */
export function initAvatarInjector() {
    function updateAvatars() {
        const preferOriginal = resolvePreferOriginal();

        document.querySelectorAll('#chat .mes').forEach((mes) => {
            const avatarImg = mes.querySelector('.avatar img');
            if (!avatarImg) return;

            applyAvatarSources(mes, avatarImg, preferOriginal);
        });
    }

    /**
     * Collect the messages touched by a mutation batch. Text-only edits inside
     * a message body (the streaming case) resolve to nothing here, which is
     * what keeps the observer cheap.
     * @param {MutationRecord[]} mutations
     * @param {Set<Element>} out
     */
    function collectAffectedMessages(mutations, out) {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                if (target.nodeType !== 1) continue;
                const mes = target.closest?.('.mes');
                if (mes) out.add(mes);
                continue;
            }

            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList.contains('mes')) {
                    out.add(node);
                } else if (node.querySelector) {
                    node.querySelectorAll('.mes').forEach((mes) => out.add(mes));
                }
            }
        }
    }

    const pendingMessages = new Set();
    let flushScheduled = false;

    function flushPending() {
        flushScheduled = false;
        if (pendingMessages.size === 0) return;

        const preferOriginal = resolvePreferOriginal();
        const targets = [...pendingMessages];
        pendingMessages.clear();

        // Messages removed from the document no longer need styling.
        for (const mes of targets) {
            if (!mes.isConnected) continue;
            const avatarImg = mes.querySelector('.avatar img');
            if (!avatarImg) continue;
            applyAvatarSources(mes, avatarImg, preferOriginal);
        }
    }

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        setTimeout(flushPending, 100);
    }

    const observerCallback = (mutations) => {
        collectAffectedMessages(mutations, pendingMessages);
        // Nothing relevant changed (e.g. streamed text) — skip scheduling.
        if (pendingMessages.size === 0) return;
        scheduleFlush();
    };

    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        const observer = new MutationObserver(observerCallback);
        observer.observe(chatContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data-src'],
        });
    }

    updateAvatars();

    window.updateAvatars = updateAvatars;
    return updateAvatars;
}

/**
 * Initialize monitoring of #form_sheld height and expose helper controls.
 *
 * The previous implementation watched the whole document subtree for added
 * nodes and ran three forced layouts per keystroke. This version keeps a single
 * narrow observer on the form's parent and coalesces every measurement into one
 * animation frame.
 * @returns {{update: function, start: function, stop: function}} Control helpers.
 */
export function initFormSheldHeightMonitor() {
    let observedFormSheld = null;
    let updateScheduled = false;
    let restartScheduled = false;
    let lastHeight = -1;

    function writeHeight(height) {
        // A custom property on <html> invalidates style for the whole document,
        // so skip the write whenever the measured height has not changed.
        if (height <= 0 || height === lastHeight) return;
        lastHeight = height;
        document.documentElement.style.setProperty('--formSheldHeight', `${height}px`);
    }

    function updateFormSheldHeight() {
        const formSheld = document.getElementById('form_sheld');
        if (!formSheld) return;
        writeHeight(formSheld.getBoundingClientRect().height);
    }

    /** Coalesce all height refresh requests into a single pre-paint pass. */
    function scheduleUpdate() {
        if (updateScheduled) return;
        updateScheduled = true;

        const run = () => {
            updateScheduled = false;
            updateFormSheldHeight();
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    function scheduleRestart() {
        if (restartScheduled) return;
        restartScheduled = true;
        setTimeout(() => {
            restartScheduled = false;
            startObservers();
        }, 50);
    }

    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target === observedFormSheld) {
                writeHeight(entry.contentRect.height);
            }
        }
    });

    // Watches only the form's direct children, so the chat stream above it
    // never triggers this callback.
    const parentObserver = new MutationObserver(() => {
        const current = document.getElementById('form_sheld');
        if (current !== observedFormSheld) {
            scheduleRestart();
        }
    });

    function stopObservers() {
        resizeObserver.disconnect();
        parentObserver.disconnect();
        observedFormSheld = null;
    }

    function startObservers() {
        const formSheld = document.getElementById('form_sheld');
        if (!formSheld) return;
        if (formSheld === observedFormSheld) {
            updateFormSheldHeight();
            return;
        }

        stopObservers();
        observedFormSheld = formSheld;

        resizeObserver.observe(formSheld);

        const parent = formSheld.parentElement;
        if (parent) {
            parentObserver.observe(parent, { childList: true });
        }

        updateFormSheldHeight();
    }

    function setupListeners() {
        const textArea = document.getElementById('send_textarea');
        if (textArea) {
            textArea.removeEventListener('input', scheduleUpdate);
            textArea.addEventListener('input', scheduleUpdate);
        }

        document.querySelectorAll('#qr--bar .qr--option, #options_button').forEach((button) => {
            button.removeEventListener('click', scheduleUpdate);
            button.addEventListener('click', scheduleUpdate);
        });
    }

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', () => {
        scheduleUpdate();
        // The viewport can still be settling after the orientation swap.
        setTimeout(scheduleUpdate, 300);
    });

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            () => {
                startObservers();
                setupListeners();
                scheduleUpdate();
                setTimeout(scheduleUpdate, 500);
            },
            { once: true },
        );
    } else {
        startObservers();
        setupListeners();
        scheduleUpdate();
    }

    // Quick Reply bars can mount well after the initial pass.
    setTimeout(setupListeners, 1000);

    return {
        update: updateFormSheldHeight,
        start: startObservers,
        stop: stopObservers,
    };
}
