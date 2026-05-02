/**
 * ui-status.js — Status indicator, reveal/skip button, and debug logging for bf-agentic-curator.
 */

const LOG_PREFIX = '[BFCurator]';
const MAX_DEBUG_ENTRIES = 200;
const INDICATOR_TIMEOUT_MS = 300_000; // 5 minutes

let skipCallback = null;
let indicatorTimeout = null;
const debugLog = [];

/**
 * Create DOM elements (indicator + skip button). Call once at extension init.
 */
export function initStatusUI() {
    _createIndicator();
    _initSkipButton();
}

// ---------------------------------------------------------------------------
// Status Indicator
// ---------------------------------------------------------------------------

function _createIndicator() {
    if (document.getElementById('bf_curator_indicator')) return;

    const indicator = document.createElement('div');
    indicator.id = 'bf_curator_indicator';
    indicator.style.display = 'none';

    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        sendForm.parentNode.insertBefore(indicator, sendForm);
    }
}

/**
 * Show the status banner with the given text and a spinner icon.
 */
export function showIndicator(text) {
    let indicator = document.getElementById('bf_curator_indicator');
    if (!indicator) {
        _createIndicator();
        indicator = document.getElementById('bf_curator_indicator');
    }
    if (!indicator) return;

    indicator.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${text}`;
    indicator.style.display = 'flex';

    _resetIndicatorTimeout();
    console.log(`${LOG_PREFIX} Status: ${text}`);
}

/**
 * Update the text of an already-visible banner.
 */
export function updateIndicator(text) {
    const indicator = document.getElementById('bf_curator_indicator');
    if (!indicator) return;

    indicator.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${text}`;

    _resetIndicatorTimeout();
    console.log(`${LOG_PREFIX} Status: ${text}`);
}

/**
 * Hide the status banner.
 */
export function hideIndicator() {
    const indicator = document.getElementById('bf_curator_indicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
    _clearIndicatorTimeout();
}

function _resetIndicatorTimeout() {
    _clearIndicatorTimeout();
    indicatorTimeout = setTimeout(() => {
        console.warn(`${LOG_PREFIX} Indicator safety timeout reached (${INDICATOR_TIMEOUT_MS / 1000}s). Auto-hiding.`);
        hideIndicator();
    }, INDICATOR_TIMEOUT_MS);
}

function _clearIndicatorTimeout() {
    if (indicatorTimeout) {
        clearTimeout(indicatorTimeout);
        indicatorTimeout = null;
    }
}

// ---------------------------------------------------------------------------
// Reveal / Skip Button
// ---------------------------------------------------------------------------

let skipButtonRetries = 0;
function _initSkipButton() {
    const menuList = document.querySelector('#chat_options .list-group');
    if (!menuList) {
        if (skipButtonRetries++ < 10) {
            setTimeout(_initSkipButton, 2000);
        } else {
            console.warn('[BFCurator] Could not find chat options menu after 10 retries, skip button unavailable');
        }
        return;
    }

    if (document.getElementById('bf_curator_skip_btn')) return;

    const menuItem = document.createElement('a');
    menuItem.id = 'bf_curator_skip_btn';
    menuItem.className = 'list-group-item';
    menuItem.innerHTML = '<i class="fa-solid fa-forward"></i> Skip Arena';
    menuItem.style.display = 'none';
    menuItem.style.cursor = 'pointer';

    menuItem.addEventListener('click', () => {
        console.log(`${LOG_PREFIX} Skip button clicked.`);
        if (typeof skipCallback === 'function') {
            skipCallback();
        }
    });

    menuList.appendChild(menuItem);
}

/**
 * Show the "Skip Arena" button in the burger menu.
 */
export function showSkipButton() {
    const btn = document.getElementById('bf_curator_skip_btn');
    if (btn) {
        btn.style.display = '';
    }
}

/**
 * Hide the "Skip Arena" button.
 */
export function hideSkipButton() {
    const btn = document.getElementById('bf_curator_skip_btn');
    if (btn) {
        btn.style.display = 'none';
    }
}

/**
 * Set the callback invoked when the Skip button is clicked.
 */
export function setSkipCallback(fn) {
    skipCallback = fn;
}

// ---------------------------------------------------------------------------
// Debug Log
// ---------------------------------------------------------------------------

/**
 * Truncate text to roughly N words, preserving word boundaries.
 * @param {string} text
 * @param {number} wordLimit
 * @returns {string}
 */
function truncateWords(text, wordLimit) {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= wordLimit) return text;
    return words.slice(0, wordLimit).join(' ') + ` [...${words.length - wordLimit} more words]`;
}

/**
 * Add an entry to the debug log.
 * @param {'info'|'pass'|'fail'} type
 * @param {string} message
 * @param {string} [detail] - Optional expandable detail (full text content)
 */
export function addDebugLog(type, message, detail) {
    if (debugLog.length >= MAX_DEBUG_ENTRIES) {
        debugLog.shift();
    }
    const timestamp = new Date();
    debugLog.push({ type, message, detail, timestamp });
    console.log(`${LOG_PREFIX} [${type.toUpperCase()}] ${message}`);
    if (detail) console.log(`${LOG_PREFIX} [DETAIL] ${detail.slice(0, 500)}${detail.length > 500 ? '...' : ''}`);

    // Render to settings debug panel if it exists
    const panel = document.getElementById('bf_curator_debug_log');
    if (panel) {
        // Remove "Waiting for activity..." placeholder
        const placeholder = panel.querySelector('.bf-curator-debug-entry.info');
        if (placeholder && placeholder.textContent.includes('Waiting for')) {
            placeholder.remove();
        }

        const entry = document.createElement('div');
        entry.className = `bf-curator-debug-entry ${type}`;
        const time = timestamp.toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;

        // Add collapsible detail block if provided
        if (detail) {
            const toggle = document.createElement('span');
            toggle.textContent = ' [+show]';
            toggle.style.cssText = 'cursor:pointer; opacity:0.7; font-size:0.9em;';
            const detailBlock = document.createElement('pre');
            detailBlock.textContent = detail;
            detailBlock.style.cssText = 'display:none; white-space:pre-wrap; word-break:break-word; margin:4px 0 8px 16px; padding:6px; background:rgba(0,0,0,0.3); border-radius:4px; font-size:0.85em; max-height:400px; overflow-y:auto; color:inherit;';
            toggle.addEventListener('click', () => {
                const visible = detailBlock.style.display !== 'none';
                detailBlock.style.display = visible ? 'none' : 'block';
                toggle.textContent = visible ? ' [+show]' : ' [-hide]';
            });
            entry.appendChild(toggle);
            entry.appendChild(detailBlock);
        }

        panel.appendChild(entry);

        // Trim DOM entries to match max
        while (panel.children.length > MAX_DEBUG_ENTRIES) {
            panel.removeChild(panel.firstChild);
        }

        // Auto-scroll to bottom
        panel.scrollTop = panel.scrollHeight;
    }
}

/**
 * Helper: truncate to first N words for summary logging.
 */
export { truncateWords };

/**
 * Return a copy of all debug log entries.
 */
export function getDebugLog() {
    return [...debugLog];
}

/**
 * Clear all debug log entries.
 */
export function clearDebugLog() {
    debugLog.length = 0;
}
