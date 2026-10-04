const domReadyHandlers = new Set();
let hasRunDomReadyHandlers = false;

function defer(callback) {
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(callback);
    } else {
        setTimeout(callback, 0);
    }
}

function invokeGuardedHandler(handler, failureLabel) {
    try {
        handler();
    } catch (error) {
        console.error(failureLabel, error);
    }
}

function invokeDomReadyHandler(handler) {
    invokeGuardedHandler(handler, 'Moonlit Echoes DOM ready handler failed');
}

/**
 * Register a handler to run once the DOM is ready.
 * If the DOM is already ready, the handler runs on the next tick so module
 * initialization can finish before any startup work executes.
 *
 * @param {Function} handler - Function to invoke when DOM is ready.
 */
export function registerDomReadyHandler(handler) {
    if (typeof handler !== 'function') {
        return;
    }

    if (document.readyState === 'loading') {
        domReadyHandlers.add(handler);
    } else {
        defer(() => invokeDomReadyHandler(handler));
    }
}

/**
 * Register a handler to run once every element listed in `ids` is present in
 * the document. Hosts such as TauriTavern detach closed settings drawers from
 * the document tree, so controls living inside those panels (for example
 * `#chat_display`) may only become reachable after the panel is opened. The
 * handler runs exactly once: on the next tick when all elements are already
 * present, or when a later DOM mutation makes them available.
 *
 * @param {string[]} ids - Element ids the handler depends on.
 * @param {Function} handler - Function to invoke once all ids resolve.
 * @returns {Function} Disposer that cancels the pending registration.
 */
export function whenElementsAvailable(ids, handler) {
    if (typeof handler !== 'function') {
        return () => {};
    }

    const run = () => invokeGuardedHandler(handler, 'Moonlit Echoes element availability handler failed');

    // Ids still missing. Resolved ones are dropped so each poll only looks for
    // what is actually outstanding.
    const pending = new Set(ids);
    const resolvePending = () => {
        for (const id of pending) {
            if (document.getElementById(id)) {
                pending.delete(id);
            }
        }
        return pending.size === 0;
    };

    if (resolvePending()) {
        defer(run);
        return () => {};
    }

    let observer = null;
    let checkScheduled = false;

    // Mutation batches arrive far faster than the DOM settles (once per streamed
    // token), so collapse them into a single check per frame instead of running
    // a lookup for every record.
    const scheduleCheck = () => {
        if (checkScheduled) return;
        checkScheduled = true;
        defer(() => {
            checkScheduled = false;
            if (resolvePending()) {
                observer?.disconnect();
                observer = null;
                run();
            }
        });
    };

    observer = new MutationObserver(scheduleCheck);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    return () => {
        observer?.disconnect();
        observer = null;
    };
}

function runDomReadyHandlers() {
    if (hasRunDomReadyHandlers) {
        return;
    }

    hasRunDomReadyHandlers = true;
    domReadyHandlers.forEach((handler) => {
        invokeDomReadyHandler(handler);
    });
    domReadyHandlers.clear();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runDomReadyHandlers, { once: true });
} else {
    defer(runDomReadyHandlers);
}
