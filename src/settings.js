/**
 * BF Curator - Settings Module
 * Handles settings persistence, UI template loading, and event binding.
 * Design matches bf-agentic-validator pattern (external HTML template, tabs).
 */

import { getDefaultJudgePrompt } from './judge.js';

const LOG_PREFIX = '[BFCurator]';

// Derive extension folder name from actual URL
const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch (e) { /* fallback */ }
    return 'bf-agentic-curator';
})();

const DEFAULT_SETTINGS = {
    enabled: false,

    writer2: {
        enabled: true,
        provider: 'openrouter',
        model: '',
        apiKey: '',
        temperature: 1.0,
        maxTokens: 4096,
        systemPromptMode: 'append',
        systemPrompt: '',
        systemPromptSuffix: '',
    },

    writer3: {
        enabled: true,
        provider: 'openrouter',
        model: '',
        apiKey: '',
        temperature: 1.2,
        maxTokens: 4096,
        systemPromptMode: 'append',
        systemPrompt: '',
        systemPromptSuffix: '',
    },

    judge: {
        provider: 'openrouter',
        model: '',
        apiKey: '',
        temperature: 0.3,
        maxTokens: 8192,
        prompt: '',
    },

    sharedApiKey: '',
    sharedProvider: 'openrouter',
    minWriters: 2,
    timeoutMs: 120000,
    showToast: true,
    debugMode: false,
};

let extensionSettings = null;

function getContext() {
    return SillyTavern.getContext();
}

// ─── Settings persistence ───

function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const saved = context.extensionSettings[EXTENSION_NAME];

    // Merge top-level defaults
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved[key] === undefined) {
            saved[key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }

    // Merge nested object defaults
    for (const section of ['writer2', 'writer3', 'judge']) {
        if (typeof saved[section] === 'object' && saved[section] !== null) {
            for (const key of Object.keys(DEFAULT_SETTINGS[section])) {
                if (saved[section][key] === undefined) {
                    saved[section][key] = structuredClone(DEFAULT_SETTINGS[section][key]);
                }
            }
        }
    }

    extensionSettings = saved;
    console.log(`${LOG_PREFIX} Settings loaded`);
    return saved;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

// ─── Status bar ───

function updateStatus(state) {
    const dot = document.getElementById('bf_curator_status_dot');
    const text = document.getElementById('bf_curator_status_text');
    if (!dot || !text) return;

    dot.classList.remove('active', 'running', 'error');

    if (!extensionSettings?.enabled) {
        text.textContent = 'Disabled';
        return;
    }

    switch (state) {
        case 'idle':
            dot.classList.add('active');
            text.textContent = 'Ready';
            break;
        case 'running':
            dot.classList.add('running');
            text.textContent = 'Running pipeline...';
            break;
        case 'error':
            dot.classList.add('error');
            text.textContent = 'Error';
            break;
        default:
            dot.classList.add('active');
            text.textContent = 'Ready';
    }
}

// ─── Test connection ───

async function testConnection(sectionKey) {
    const s = extensionSettings[sectionKey];
    const apiKey = resolveApiKey(s);
    const provider = s.provider || extensionSettings.sharedProvider;
    const model = s.model;

    if (!model) {
        if (typeof toastr !== 'undefined') toastr.error('Select a model first', 'BF Curator');
        return;
    }

    const btn = document.getElementById(`bf_curator_${sectionKey}_test`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing...';
    }

    try {
        const { callLLM } = await import('./api-adapters.js');
        const messages = [{ role: 'user', content: 'Say "connection successful" in exactly two words.' }];
        const config = {
            provider,
            model,
            apiKey,
            temperature: 0,
            maxTokens: 20,
        };
        const result = await callLLM(messages, config);
        if (typeof toastr !== 'undefined') {
            toastr.success(`${model} responded in ${(result.elapsed / 1000).toFixed(1)}s`, 'BF Curator');
        }
        console.log(`${LOG_PREFIX} Test connection OK: ${model} (${result.elapsed}ms)`);
    } catch (err) {
        if (typeof toastr !== 'undefined') {
            toastr.error(`${model}: ${err.message}`, 'BF Curator', { timeOut: 8000 });
        }
        console.error(`${LOG_PREFIX} Test connection failed:`, err);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-plug"></i> Test Connection';
        }
    }
}

// ─── Tab switching ───

function initTabs() {
    const tabButtons = document.querySelectorAll('.bf-curator-tab-btn');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;

            // Deactivate all
            tabButtons.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
                b.setAttribute('tabindex', '-1');
            });

            document.querySelectorAll('.bf-curator-tab-panel').forEach(panel => {
                panel.style.display = 'none';
                panel.setAttribute('aria-hidden', 'true');
            });

            // Activate clicked
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');

            const panel = document.getElementById(`bf_curator_tab_${targetTab}`);
            if (panel) {
                panel.style.display = '';
                panel.removeAttribute('aria-hidden');
            }
        });
    });
}

// ─── Event binding ───

function bindWriterEvents(id, section) {
    const s = extensionSettings[section];

    $(`#bf_curator_${id}_enabled`).prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked;
        saveSettings();
    });

    $(`#bf_curator_${id}_provider`).val(s.provider).on('change', function () {
        s.provider = this.value;
        saveSettings();
    });

    $(`#bf_curator_${id}_model`).val(s.model).on('change', function () {
        s.model = this.value;
        saveSettings();
    });

    $(`#bf_curator_${id}_apiKey`).val(s.apiKey).on('input', function () {
        s.apiKey = this.value;
        saveSettings();
    });

    $(`#bf_curator_${id}_temperature`).val(s.temperature).on('change', function () {
        s.temperature = parseFloat(this.value) || 0;
        saveSettings();
    });

    $(`#bf_curator_${id}_maxTokens`).val(s.maxTokens).on('change', function () {
        s.maxTokens = parseInt(this.value, 10) || 4096;
        saveSettings();
    });

    $(`#bf_curator_${id}_systemPromptMode`).val(s.systemPromptMode).on('change', function () {
        s.systemPromptMode = this.value;
        if (this.value === 'append') {
            $(`#bf_curator_${id}_suffixWrap`).show();
            $(`#bf_curator_${id}_replaceWrap`).hide();
        } else {
            $(`#bf_curator_${id}_suffixWrap`).hide();
            $(`#bf_curator_${id}_replaceWrap`).show();
        }
        saveSettings();
    });

    // Set initial visibility
    if (s.systemPromptMode === 'replace') {
        $(`#bf_curator_${id}_suffixWrap`).hide();
        $(`#bf_curator_${id}_replaceWrap`).show();
    }

    $(`#bf_curator_${id}_systemPromptSuffix`).val(s.systemPromptSuffix).on('input', function () {
        s.systemPromptSuffix = this.value;
        saveSettings();
    });

    $(`#bf_curator_${id}_systemPrompt`).val(s.systemPrompt).on('input', function () {
        s.systemPrompt = this.value;
        saveSettings();
    });

    // Test connection
    $(`#bf_curator_${id}_test`).on('click', function () {
        testConnection(section);
    });
}

function bindJudgeEvents() {
    const s = extensionSettings.judge;

    $('#bf_curator_judge_provider').val(s.provider).on('change', function () {
        s.provider = this.value;
        saveSettings();
    });

    $('#bf_curator_judge_model').val(s.model).on('change', function () {
        s.model = this.value;
        saveSettings();
    });

    $('#bf_curator_judge_apiKey').val(s.apiKey).on('input', function () {
        s.apiKey = this.value;
        saveSettings();
    });

    $('#bf_curator_judge_temperature').val(s.temperature).on('change', function () {
        s.temperature = parseFloat(this.value) || 0;
        saveSettings();
    });

    $('#bf_curator_judge_maxTokens').val(s.maxTokens).on('change', function () {
        s.maxTokens = parseInt(this.value, 10) || 8192;
        saveSettings();
    });

    // Show saved prompt, or default if empty
    const defaultPrompt = getDefaultJudgePrompt();
    $('#bf_curator_judge_prompt').val(s.prompt || defaultPrompt).on('input', function () {
        const val = this.value.trim();
        // Save empty if it matches the default (so future default updates apply)
        s.prompt = (val === defaultPrompt.trim()) ? '' : this.value;
        saveSettings();
    });

    $('#bf_curator_judge_resetPrompt').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        s.prompt = '';
        $('#bf_curator_judge_prompt').val(getDefaultJudgePrompt());
        saveSettings();
        console.log(`${LOG_PREFIX} Judge prompt reset to default`);
        if (typeof toastr !== 'undefined') {
            toastr.info('Judge prompt reset to default', 'BF Curator');
        }
    });

    // Test connection
    $('#bf_curator_judge_test').on('click', function () {
        testConnection('judge');
    });
}

function bindGlobalEvents() {
    $('#bf_curator_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        extensionSettings.enabled = this.checked;
        $('#bf_curator_settings_content').toggle(extensionSettings.enabled);
        updateStatus('idle');
        saveSettings();
        console.log(`${LOG_PREFIX} Arena ${this.checked ? 'enabled' : 'disabled'}`);
    });

    // Show/hide settings content based on initial state
    $('#bf_curator_settings_content').toggle(extensionSettings.enabled);

    $('#bf_curator_sharedProvider').val(extensionSettings.sharedProvider).on('change', function () {
        extensionSettings.sharedProvider = this.value;
        saveSettings();
    });

    $('#bf_curator_sharedApiKey').val(extensionSettings.sharedApiKey).on('input', function () {
        extensionSettings.sharedApiKey = this.value;
        saveSettings();
    });

    $('#bf_curator_minWriters').val(extensionSettings.minWriters).on('change', function () {
        extensionSettings.minWriters = parseInt(this.value, 10) || 2;
        saveSettings();
    });

    $('#bf_curator_timeoutMs').val(extensionSettings.timeoutMs).on('change', function () {
        extensionSettings.timeoutMs = parseInt(this.value, 10) || 120000;
        saveSettings();
    });

    $('#bf_curator_showToast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = this.checked;
        saveSettings();
    });

    $('#bf_curator_debugMode').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = this.checked;
        $('#bf_curator_debug_panel').toggle(this.checked);
        saveSettings();
        console.log(`${LOG_PREFIX} Debug mode ${this.checked ? 'enabled' : 'disabled'}`);
    });

    // Show/hide debug panel based on initial state
    $('#bf_curator_debug_panel').toggle(extensionSettings.debugMode);

    // Debug tools
    $('#bf_curator_copy_debug').on('click', function () {
        const log = $('#bf_curator_debug_log').text();
        navigator.clipboard.writeText(log).then(() => {
            if (typeof toastr !== 'undefined') toastr.info('Debug log copied', 'BF Curator');
        });
    });

    $('#bf_curator_clear_debug').on('click', function () {
        $('#bf_curator_debug_log').html('<div class="bf-curator-debug-entry info">Log cleared.</div>');
    });

    // Reset all
    $('#bf_curator_reset_all').on('click', function () {
        if (!confirm('Reset ALL BF Curator settings to defaults? This cannot be undone.')) return;
        const context = getContext();
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        extensionSettings = context.extensionSettings[EXTENSION_NAME];
        saveSettings();
        if (typeof toastr !== 'undefined') toastr.warning('All settings reset to defaults', 'BF Curator');
        console.log(`${LOG_PREFIX} All settings reset to defaults`);
        // Reload the page to re-render UI with defaults
        location.reload();
    });
}

// ─── Load UI template ───

async function loadUI() {
    let path = `scripts/extensions/third-party/${EXTENSION_NAME}`;
    let html = null;

    try {
        html = await $.get(`${path}/templates/settings.html`);
    } catch (e) {
        path = `scripts/extensions/${EXTENSION_NAME}`;
        try {
            html = await $.get(`${path}/templates/settings.html`);
        } catch (e2) {
            console.error(`${LOG_PREFIX} Failed to load UI template from both paths`);
            return;
        }
    }

    $('#extensions_settings').append(html);

    // Init tabs
    initTabs();

    // Bind all events
    bindGlobalEvents();
    bindWriterEvents('writer2', 'writer2');
    bindWriterEvents('writer3', 'writer3');
    bindJudgeEvents();

    // Set initial status
    updateStatus('idle');

    console.log(`${LOG_PREFIX} Settings UI initialized`);
}

// ─── Public API ───

export function resolveApiKey(writerOrJudgeConfig) {
    // 1. Per-writer/judge key
    if (writerOrJudgeConfig && writerOrJudgeConfig.apiKey) {
        return writerOrJudgeConfig.apiKey;
    }
    // 2. Shared key from extension settings
    if (extensionSettings?.sharedApiKey) {
        return extensionSettings.sharedApiKey;
    }
    // 3. No key — callLLM will proxy through ST's backend automatically
    return '';
}

export function getSettings() {
    return extensionSettings;
}

export function setStatusIndicator(state) {
    updateStatus(state);
}

export async function initSettings() {
    loadSettings();
    await loadUI();
}
