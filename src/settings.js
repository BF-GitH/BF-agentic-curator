/**
 * BF Curator - Settings Module
 * Handles settings persistence, UI template loading, and event binding.
 * Design matches bf-agentic-validator pattern (external HTML template, tabs).
 */

import { getDefaultJudgePrompt, JUDGE_PRESETS } from './judge.js';

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
        judgePromptPreset: 'default',
    },

    sharedApiKey: '',
    sharedProvider: 'openrouter',
    minWriters: 2,
    timeoutMs: 120000,
    showToast: true,
    debugMode: false,

    // Extension presets
    presets: {},        // { "PresetName": { writer2: {...}, writer3: {...}, judge: {...}, sharedProvider: '...', minWriters: N } }
    currentPreset: '',  // Name of currently loaded preset
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

// ─── Extension presets ───

function getPresetData() {
    // Snapshot the saveable settings (not enabled, not presets themselves)
    return {
        writer2: structuredClone(extensionSettings.writer2),
        writer3: structuredClone(extensionSettings.writer3),
        judge: structuredClone(extensionSettings.judge),
        sharedApiKey: extensionSettings.sharedApiKey,
        sharedProvider: extensionSettings.sharedProvider,
        minWriters: extensionSettings.minWriters,
        timeoutMs: extensionSettings.timeoutMs,
    };
}

function savePreset(name) {
    if (!name) return;
    extensionSettings.presets[name] = getPresetData();
    extensionSettings.currentPreset = name;
    saveSettings();
    updatePresetDropdown();
    console.log(`${LOG_PREFIX} Preset saved: ${name}`);
    if (typeof toastr !== 'undefined') toastr.success(`Preset "${name}" saved`, 'BF Curator');
}

function loadPreset(name) {
    const preset = extensionSettings.presets[name];
    if (!preset) {
        if (typeof toastr !== 'undefined') toastr.error(`Preset "${name}" not found`, 'BF Curator');
        return;
    }

    // Apply preset values
    for (const key of Object.keys(preset)) {
        if (typeof preset[key] === 'object' && preset[key] !== null) {
            extensionSettings[key] = structuredClone(preset[key]);
        } else {
            extensionSettings[key] = preset[key];
        }
    }
    extensionSettings.currentPreset = name;
    saveSettings();

    // Reload UI to reflect new values
    if (typeof toastr !== 'undefined') toastr.success(`Preset "${name}" loaded`, 'BF Curator');
    console.log(`${LOG_PREFIX} Preset loaded: ${name}`);
    location.reload();
}

function deletePreset(name) {
    if (!name) return;
    if (!confirm(`Delete preset "${name}"?`)) return;
    delete extensionSettings.presets[name];
    if (extensionSettings.currentPreset === name) {
        extensionSettings.currentPreset = '';
    }
    saveSettings();
    updatePresetDropdown();
    if (typeof toastr !== 'undefined') toastr.info(`Preset "${name}" deleted`, 'BF Curator');
}

function updatePresetDropdown() {
    const select = document.getElementById('bf_curator_preset_select');
    if (!select) return;

    const currentValue = select.value || extensionSettings.currentPreset;
    select.innerHTML = '<option value="">-- Select Preset --</option>';

    const names = Object.keys(extensionSettings.presets || {}).sort();
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }

    if (currentValue && extensionSettings.presets[currentValue]) {
        select.value = currentValue;
    }
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

    // Read from ST's chat completion presets dropdown
    const stSelect = document.getElementById('settings_preset_openai');
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
 * Populate a model dropdown from ST's OpenRouter model list (#openrouter_models).
 * Falls back to a minimal hardcoded list if ST's dropdown isn't available.
 */
function populateModelDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const currentValue = select.value;

    // Clear all options except the placeholder
    while (select.options.length > 1) {
        select.remove(1);
    }

    // Try to clone from ST's OpenRouter model dropdown
    const stModels = document.getElementById('openrouter_models');
    if (stModels && stModels.options.length > 1) {
        // Clone all options and optgroups from ST's dropdown
        Array.from(stModels.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const group = document.createElement('optgroup');
                group.label = child.label;
                Array.from(child.options).forEach(opt => {
                    if (opt.value) {
                        const newOpt = document.createElement('option');
                        newOpt.value = opt.value;
                        newOpt.textContent = opt.textContent;
                        group.appendChild(newOpt);
                    }
                });
                select.appendChild(group);
            } else if (child.tagName === 'OPTION' && child.value) {
                const newOpt = document.createElement('option');
                newOpt.value = child.value;
                newOpt.textContent = child.textContent;
                select.appendChild(newOpt);
            }
        });
        console.log(`[BFCurator] Populated ${selectId} with ${select.options.length - 1} models from ST`);
    } else {
        console.warn('[BFCurator] ST OpenRouter model list not found, using empty dropdown. Type a model ID or refresh later.');
    }

    // Restore previous selection if it still exists, or add it as a custom option
    if (currentValue) {
        if (!Array.from(select.options).some(o => o.value === currentValue)) {
            const customOpt = document.createElement('option');
            customOpt.value = currentValue;
            customOpt.textContent = `${currentValue} (saved)`;
            select.insertBefore(customOpt, select.options[1]);
        }
        select.value = currentValue;
    }
}

/**
 * Get the name of a chat completion preset selected for a writer.
 * The pipeline will switch to this preset before making the ST proxy call.
 * Returns null if no preset selected or if it's custom.
 */
export function getWriterPresetName(writerConfig) {
    const preset = writerConfig?.systemPromptPreset;
    if (!preset || preset === '__custom__') return null;
    return preset;
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

    // Populate model dropdown from ST's OpenRouter list, then set saved value
    populateModelDropdown(`bf_curator_${id}_model`);
    $(`#bf_curator_${id}_model`).val(s.model)
        .off('change').on('change', function () { s.model = this.value; saveSettings(); });

    // Refresh models button
    $(`#bf_curator_${id}_refreshModels`).off('click').on('click', function () {
        populateModelDropdown(`bf_curator_${id}_model`);
        $(`#bf_curator_${id}_model`).val(s.model);
        if (typeof toastr !== 'undefined') toastr.info('Model list refreshed from ST', 'BF Curator');
    });

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

    // Populate model dropdown from ST's OpenRouter list, then set saved value
    populateModelDropdown('bf_curator_judge_model');
    $('#bf_curator_judge_model').val(s.model)
        .off('change').on('change', function () { s.model = this.value; saveSettings(); });

    // Refresh models button
    $('#bf_curator_judge_refreshModels').off('click').on('click', function () {
        populateModelDropdown('bf_curator_judge_model');
        $('#bf_curator_judge_model').val(s.model);
        if (typeof toastr !== 'undefined') toastr.info('Model list refreshed from ST', 'BF Curator');
    });

    $('#bf_curator_judge_apiKey').val(s.apiKey)
        .off('input').on('input', function () { s.apiKey = this.value; saveSettings(); });

    $('#bf_curator_judge_temperature').val(s.temperature)
        .off('input change').on('input change', function () { s.temperature = parseFloat(this.value) || 0; saveSettings(); });

    $('#bf_curator_judge_maxTokens').val(s.maxTokens)
        .off('input change').on('input change', function () { s.maxTokens = parseInt(this.value, 10) || 8192; saveSettings(); });

    // Judge prompt preset dropdown
    const presetSelect = $('#bf_curator_judge_promptPreset');
    presetSelect.empty();

    // Add "Custom" option first
    presetSelect.append('<option value="__custom__">Custom (edit below)</option>');

    // Add built-in presets
    for (const [key, preset] of Object.entries(JUDGE_PRESETS)) {
        presetSelect.append(`<option value="${key}">${preset.label}</option>`);
    }

    // Determine current preset: if saved prompt matches a preset, select it; otherwise "custom"
    const currentPresetKey = s.judgePromptPreset || 'default';
    presetSelect.val(currentPresetKey);

    // Set textarea content based on current selection
    const activePreset = JUDGE_PRESETS[currentPresetKey];
    if (currentPresetKey === '__custom__' || !activePreset) {
        $('#bf_curator_judge_prompt').val(s.prompt || getDefaultJudgePrompt()).prop('disabled', false);
    } else {
        $('#bf_curator_judge_prompt').val(activePreset.prompt).prop('disabled', true);
    }

    presetSelect.off('change').on('change', function () {
        const key = this.value;
        s.judgePromptPreset = key;
        if (key === '__custom__') {
            // Switch to editable custom prompt
            $('#bf_curator_judge_prompt').val(s.prompt || getDefaultJudgePrompt()).prop('disabled', false);
        } else {
            const preset = JUDGE_PRESETS[key];
            if (preset) {
                s.prompt = '';  // Clear custom prompt when using a preset
                $('#bf_curator_judge_prompt').val(preset.prompt).prop('disabled', true);
            }
        }
        saveSettings();
    });

    // Textarea for custom editing
    $('#bf_curator_judge_prompt').off('input').on('input', function () {
        if (s.judgePromptPreset === '__custom__') {
            s.prompt = this.value;
            saveSettings();
        }
    });

    // Reset button — resets to default preset
    $('#bf_curator_judge_resetPrompt').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        s.prompt = '';
        s.judgePromptPreset = 'default';
        presetSelect.val('default');
        $('#bf_curator_judge_prompt').val(getDefaultJudgePrompt()).prop('disabled', true);
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

    // Extension presets
    updatePresetDropdown();

    $('#bf_curator_preset_select').off('change').on('change', function () {
        extensionSettings.currentPreset = this.value;
        saveSettings();
    });

    $('#bf_curator_preset_save').off('click').on('click', function () {
        const select = document.getElementById('bf_curator_preset_select');
        let name = select?.value;
        if (!name) {
            name = prompt('Enter preset name:');
        }
        if (name) savePreset(name);
    });

    $('#bf_curator_preset_new').off('click').on('click', function () {
        const name = prompt('Enter new preset name:');
        if (name) savePreset(name);
    });

    $('#bf_curator_preset_load').off('click').on('click', function () {
        const select = document.getElementById('bf_curator_preset_select');
        if (select?.value) loadPreset(select.value);
    });

    $('#bf_curator_preset_delete').off('click').on('click', function () {
        const select = document.getElementById('bf_curator_preset_select');
        if (select?.value) deletePreset(select.value);
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
