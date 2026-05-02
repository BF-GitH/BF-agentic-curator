/**
 * BF Curator - Settings Module
 * Handles settings persistence, UI template loading, and event binding.
 * Design matches bf-agentic-validator pattern (external HTML template, tabs).
 */

import { getDefaultJudgePrompt } from './judge.js';

const LOG_PREFIX = '[BFCurator]';

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
        systemPromptPreset: '',   // '' = same as W1, '__custom__' = manual, or preset name
        systemPrompt: '',         // custom replacement text
        systemPromptSuffix: '',   // always appended
    },

    writer3: {
        enabled: true,
        provider: 'openrouter',
        model: '',
        apiKey: '',
        temperature: 1.2,
        maxTokens: 4096,
        systemPromptPreset: '',
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

    // Connection profiles (like validator)
    useProfile: false,
    curatorProfile: '',
};

let extensionSettings = null;
let initialized = false;

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

    // Migrate old systemPromptMode → systemPromptPreset
    for (const section of ['writer2', 'writer3']) {
        const s = saved[section];
        if (s.systemPromptMode && s.systemPromptPreset === undefined) {
            if (s.systemPromptMode === 'replace' && s.systemPrompt) {
                s.systemPromptPreset = '__custom__';
            } else {
                s.systemPromptPreset = '';
            }
            delete s.systemPromptMode;
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

// ─── Connection profiles ───

function getConnectionProfiles() {
    try {
        const profiles = getContext().extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch (e) {
        return [];
    }
}

function getCurrentProfileId() {
    try {
        return getContext().extensionSettings?.connectionManager?.selectedProfile || null;
    } catch (e) {
        return null;
    }
}

function populateProfileDropdown() {
    const select = document.getElementById('bf_curator_curatorProfile');
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Select Profile --</option>';

    const profiles = getConnectionProfiles();
    const activeId = getCurrentProfileId();

    for (const profile of profiles) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name + (profile.id === activeId ? ' (current)' : '');
        select.appendChild(opt);
    }

    select.value = currentValue || extensionSettings.curatorProfile || '';
}

// ─── System prompt presets ───

function populateSystemPromptDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const currentValue = select.value;

    // Keep first two options (Same as W1, Custom)
    while (select.options.length > 2) {
        select.remove(2);
    }

    // Read from ST's sysprompt dropdown
    const stSelect = document.getElementById('sysprompt_select');
    if (stSelect) {
        Array.from(stSelect.options).forEach(opt => {
            if (opt.value) {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.textContent = opt.textContent;
                select.appendChild(newOpt);
            }
        });
    }

    select.value = currentValue;
}

/**
 * Try to fetch a system prompt's content by name.
 * Tries multiple methods with fallbacks.
 */
export async function getSystemPromptContent(presetName) {
    if (!presetName || presetName === '__custom__') return null;

    // Method 1: If currently selected in ST, read from textarea
    const stSelect = document.getElementById('sysprompt_select');
    if (stSelect && stSelect.value === presetName) {
        const textarea = document.getElementById('sysprompt_textarea');
        if (textarea && textarea.value) return textarea.value;
    }

    // Method 2: Try fetching from ST server
    try {
        const headers = getContext().getRequestHeaders?.();
        if (headers) {
            const response = await fetch('/api/presets/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ apiId: 'sysprompt', name: presetName }),
            });
            if (response.ok) {
                const data = await response.json();
                if (typeof data === 'string') return data;
                if (data?.content) return data.content;
            }
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} Could not fetch system prompt preset '${presetName}':`, e.message);
    }

    return null;
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
        const config = { provider, model, apiKey, temperature: 0, maxTokens: 20 };
        const result = await callLLM(messages, config);
        if (typeof toastr !== 'undefined') {
            toastr.success(`${model} responded in ${(result.elapsed / 1000).toFixed(1)}s`, 'BF Curator');
        }
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

            tabButtons.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
                b.setAttribute('tabindex', '-1');
            });

            document.querySelectorAll('.bf-curator-tab-panel').forEach(panel => {
                panel.style.display = 'none';
                panel.setAttribute('aria-hidden', 'true');
            });

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

// ─── Event binding (uses .off().on() to prevent accumulation) ───

function bindWriterEvents(id, section) {
    const s = extensionSettings[section];

    $(`#bf_curator_${id}_enabled`).prop('checked', s.enabled)
        .off('change').on('change', function () { s.enabled = this.checked; saveSettings(); });

    $(`#bf_curator_${id}_provider`).val(s.provider)
        .off('change').on('change', function () { s.provider = this.value; saveSettings(); });

    $(`#bf_curator_${id}_model`).val(s.model)
        .off('change').on('change', function () { s.model = this.value; saveSettings(); });

    $(`#bf_curator_${id}_apiKey`).val(s.apiKey)
        .off('input').on('input', function () { s.apiKey = this.value; saveSettings(); });

    // FIX: use 'input change' for number fields so they save on every interaction
    $(`#bf_curator_${id}_temperature`).val(s.temperature)
        .off('input change').on('input change', function () { s.temperature = parseFloat(this.value) || 0; saveSettings(); });

    $(`#bf_curator_${id}_maxTokens`).val(s.maxTokens)
        .off('input change').on('input change', function () { s.maxTokens = parseInt(this.value, 10) || 4096; saveSettings(); });

    // System prompt preset dropdown
    const presetSelect = $(`#bf_curator_${id}_syspromptPreset`);
    presetSelect.val(s.systemPromptPreset || '')
        .off('change').on('change', function () {
            s.systemPromptPreset = this.value;
            // Show/hide custom prompt area
            $(`#bf_curator_${id}_customPromptWrap`).toggle(this.value === '__custom__');
            saveSettings();
        });

    // Set initial visibility for custom prompt
    $(`#bf_curator_${id}_customPromptWrap`).toggle(s.systemPromptPreset === '__custom__');

    // Populate dropdown
    populateSystemPromptDropdown(`bf_curator_${id}_syspromptPreset`);

    // Refresh presets button
    $(`#bf_curator_${id}_refreshPresets`).off('click').on('click', function () {
        populateSystemPromptDropdown(`bf_curator_${id}_syspromptPreset`);
        if (typeof toastr !== 'undefined') toastr.info('Presets refreshed', 'BF Curator');
    });

    $(`#bf_curator_${id}_systemPrompt`).val(s.systemPrompt)
        .off('input').on('input', function () { s.systemPrompt = this.value; saveSettings(); });

    $(`#bf_curator_${id}_systemPromptSuffix`).val(s.systemPromptSuffix)
        .off('input').on('input', function () { s.systemPromptSuffix = this.value; saveSettings(); });

    // Test connection
    $(`#bf_curator_${id}_test`).off('click').on('click', function () { testConnection(section); });
}

function bindJudgeEvents() {
    const s = extensionSettings.judge;

    $('#bf_curator_judge_provider').val(s.provider)
        .off('change').on('change', function () { s.provider = this.value; saveSettings(); });

    $('#bf_curator_judge_model').val(s.model)
        .off('change').on('change', function () { s.model = this.value; saveSettings(); });

    $('#bf_curator_judge_apiKey').val(s.apiKey)
        .off('input').on('input', function () { s.apiKey = this.value; saveSettings(); });

    $('#bf_curator_judge_temperature').val(s.temperature)
        .off('input change').on('input change', function () { s.temperature = parseFloat(this.value) || 0; saveSettings(); });

    $('#bf_curator_judge_maxTokens').val(s.maxTokens)
        .off('input change').on('input change', function () { s.maxTokens = parseInt(this.value, 10) || 8192; saveSettings(); });

    const defaultPrompt = getDefaultJudgePrompt();
    $('#bf_curator_judge_prompt').val(s.prompt || defaultPrompt)
        .off('input').on('input', function () {
            const val = this.value.trim();
            s.prompt = (val === defaultPrompt.trim()) ? '' : this.value;
            saveSettings();
        });

    $('#bf_curator_judge_resetPrompt').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        s.prompt = '';
        $('#bf_curator_judge_prompt').val(getDefaultJudgePrompt());
        saveSettings();
        if (typeof toastr !== 'undefined') toastr.info('Judge prompt reset to default', 'BF Curator');
    });

    $('#bf_curator_judge_test').off('click').on('click', function () { testConnection('judge'); });
}

function bindGlobalEvents() {
    $('#bf_curator_enabled').prop('checked', extensionSettings.enabled)
        .off('change').on('change', function () {
            extensionSettings.enabled = this.checked;
            $('#bf_curator_settings_content').toggle(extensionSettings.enabled);
            updateStatus('idle');
            saveSettings();
        });

    $('#bf_curator_settings_content').toggle(extensionSettings.enabled);

    $('#bf_curator_sharedProvider').val(extensionSettings.sharedProvider)
        .off('change').on('change', function () { extensionSettings.sharedProvider = this.value; saveSettings(); });

    $('#bf_curator_sharedApiKey').val(extensionSettings.sharedApiKey)
        .off('input').on('input', function () { extensionSettings.sharedApiKey = this.value; saveSettings(); });

    $('#bf_curator_minWriters').val(extensionSettings.minWriters)
        .off('input change').on('input change', function () { extensionSettings.minWriters = parseInt(this.value, 10) || 2; saveSettings(); });

    $('#bf_curator_timeoutMs').val(extensionSettings.timeoutMs)
        .off('input change').on('input change', function () { extensionSettings.timeoutMs = parseInt(this.value, 10) || 120000; saveSettings(); });

    $('#bf_curator_showToast').prop('checked', extensionSettings.showToast)
        .off('change').on('change', function () { extensionSettings.showToast = this.checked; saveSettings(); });

    // Connection profile
    $('#bf_curator_useProfile').prop('checked', extensionSettings.useProfile)
        .off('change').on('change', function () {
            extensionSettings.useProfile = this.checked;
            $('#bf_curator_profile_section').toggle(this.checked);
            saveSettings();
        });

    $('#bf_curator_profile_section').toggle(extensionSettings.useProfile);
    populateProfileDropdown();

    $('#bf_curator_curatorProfile').val(extensionSettings.curatorProfile)
        .off('change').on('change', function () { extensionSettings.curatorProfile = this.value; saveSettings(); });

    $('#bf_curator_refreshProfiles').off('click').on('click', function () {
        populateProfileDropdown();
        if (typeof toastr !== 'undefined') toastr.info('Profiles refreshed', 'BF Curator');
    });

    // Debug
    $('#bf_curator_debugMode').prop('checked', extensionSettings.debugMode)
        .off('change').on('change', function () {
            extensionSettings.debugMode = this.checked;
            $('#bf_curator_debug_panel').toggle(this.checked);
            saveSettings();
        });

    $('#bf_curator_debug_panel').toggle(extensionSettings.debugMode);

    $('#bf_curator_copy_debug').off('click').on('click', function () {
        const log = $('#bf_curator_debug_log').text();
        navigator.clipboard.writeText(log).then(() => {
            if (typeof toastr !== 'undefined') toastr.info('Debug log copied', 'BF Curator');
        });
    });

    $('#bf_curator_clear_debug').off('click').on('click', function () {
        $('#bf_curator_debug_log').html('<div class="bf-curator-debug-entry info">Log cleared.</div>');
    });

    $('#bf_curator_reset_all').off('click').on('click', function () {
        if (!confirm('Reset ALL BF Curator settings to defaults? This cannot be undone.')) return;
        const context = getContext();
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        extensionSettings = context.extensionSettings[EXTENSION_NAME];
        saveSettings();
        if (typeof toastr !== 'undefined') toastr.warning('All settings reset to defaults', 'BF Curator');
        location.reload();
    });
}

// ─── Load UI template ───

async function loadUI() {
    // Guard against double init
    if (document.getElementById('bf_curator_settings')) {
        console.warn(`${LOG_PREFIX} Settings UI already exists, skipping`);
        return;
    }

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

    initTabs();
    bindGlobalEvents();
    bindWriterEvents('writer2', 'writer2');
    bindWriterEvents('writer3', 'writer3');
    bindJudgeEvents();
    updateStatus('idle');

    console.log(`${LOG_PREFIX} Settings UI initialized`);
}

// ─── Public API ───

export function resolveApiKey(writerOrJudgeConfig) {
    if (writerOrJudgeConfig && writerOrJudgeConfig.apiKey) return writerOrJudgeConfig.apiKey;
    if (extensionSettings?.sharedApiKey) return extensionSettings.sharedApiKey;
    return '';
}

export function getSettings() {
    return extensionSettings;
}

export function setStatusIndicator(state) {
    updateStatus(state);
}

export async function initSettings() {
    if (initialized) {
        console.warn(`${LOG_PREFIX} initSettings already called, skipping`);
        return;
    }
    initialized = true;
    loadSettings();
    await loadUI();
}
