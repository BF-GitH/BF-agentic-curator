/**
 * pipeline.js — Core Orchestrator for bf-agentic-curator
 *
 * When the user sends a message:
 * 1. Arms the interceptor + pre-hides the AI message before streaming
 * 2. Writer 1 generates via ST's normal pipeline (already in-flight)
 * 3. Writers 2+3 fire direct API calls using the captured prompt (truly parallel)
 * 4. Once all 3 complete, fires the Judge call
 * 5. Replaces the message content with the Judge's output
 * 6. Reveals the message
 */

import { getSettings, setStatusIndicator, resolveApiKey as resolveApiKeyFromSettings, getWriterPresetName } from './settings.js';
import { setArmedCheck, getCapturedPrompt, clearCapturedPrompt } from './interceptor.js';
import { callLLM } from './api-adapters.js';
import { buildJudgeMessages, getDefaultJudgePrompt, JUDGE_PRESETS } from './judge.js';
import {
    showIndicator, hideIndicator, updateIndicator,
    showSkipButton, hideSkipButton, setSkipCallback,
    addDebugLog,
} from './ui-status.js';

const LOG = '[BFCurator]';

// ── Pipeline state ──────────────────────────────────────────────────────────

let pipelineActive = false;
let pendingMessageIndex = null;
let abortController = null;

// Promises for Writers 2 and 3, started at prompt-capture time
let writer2Promise = null;
let writer3Promise = null;

// MutationObserver for pre-hiding the AI message element
let messageObserver = null;
let observerTimeout = null;

// Safety timeout for the entire pipeline
let pipelineSafetyTimeout = null;

// Delayed cleanup timeout for GENERATION_STOPPED
// (ST fires GENERATION_STOPPED *before* MESSAGE_RECEIVED during normal completion)
let generationCleanupTimeout = null;

// Track whether we are making our own LLM calls (judge fallback)
let ownCallDepth = 0;

// Track whether the current generation is a swipe
let isSwipe = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getContext() {
    return SillyTavern.getContext();
}

function isOwnCall() {
    return ownCallDepth > 0;
}

/**
 * Resolve the API key for a writer or judge config.
 * Falls back to sharedApiKey. Returns empty string if none found
 * (callLLM will use ST proxy in that case).
 */
function resolveApiKey(writerOrJudgeConfig, settings) {
    return resolveApiKeyFromSettings(writerOrJudgeConfig);
}

/**
 * Resolve the provider for a writer or judge config.
 */
function resolveProvider(writerOrJudgeConfig, settings) {
    return writerOrJudgeConfig.provider || settings.sharedProvider || 'openrouter';
}

/**
 * Modify the captured messages array according to a writer's system prompt settings.
 * Supports preset-based system prompt replacement, custom replacement, and suffix appending.
 */
async function modifyPromptForWriter(messages, writerConfig) {
    const modified = structuredClone(messages);
    const systemMsg = modified.find(m => m.role === 'system');
    if (!systemMsg) return modified;

    // Handle preset-based system prompt replacement
    const preset = writerConfig.systemPromptPreset;
    if (preset && preset !== '__custom__') {
        // Named preset — prompt modification is handled at the API call level
        // (the preset name is stored on the config for callLLM to use)
    } else if (preset === '__custom__' && writerConfig.systemPrompt) {
        // Custom replacement
        systemMsg.content = writerConfig.systemPrompt;
    }
    // else: preset is '' → keep original (same as Writer 1)

    // Always append suffix if present
    if (writerConfig.systemPromptSuffix) {
        const content = typeof systemMsg.content === 'string' ? systemMsg.content : '';
        systemMsg.content = content + '\n\n' + writerConfig.systemPromptSuffix;
    }

    return modified;
}

/**
 * Build a full config object suitable for callLLM.
 */
function buildLLMConfig(writerOrJudgeConfig, settings) {
    return {
        provider: resolveProvider(writerOrJudgeConfig, settings),
        model: writerOrJudgeConfig.model,
        apiKey: resolveApiKey(writerOrJudgeConfig, settings),
        temperature: writerOrJudgeConfig.temperature,
        maxTokens: writerOrJudgeConfig.maxTokens,
        baseUrl: writerOrJudgeConfig.baseUrl,
        presetName: getWriterPresetName(writerOrJudgeConfig),
    };
}

// ── Pre-hide observer ───────────────────────────────────────────────────────

function startPreHideObserver() {
    stopPreHideObserver();

    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    messageObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.classList?.contains('mes') && node.getAttribute('is_user') !== 'true') {
                    node.style.display = 'none';
                    addDebugLog('info', 'Pre-hidden AI message before streaming');
                    stopPreHideObserver();
                    return;
                }
            }
        }
    });

    messageObserver.observe(chatEl, { childList: true });

    observerTimeout = setTimeout(() => {
        addDebugLog('fail', 'Pre-hide observer timed out after 60s');
        stopPreHideObserver();
    }, 60000);
}

function stopPreHideObserver() {
    if (messageObserver) {
        messageObserver.disconnect();
        messageObserver = null;
    }
    if (observerTimeout) {
        clearTimeout(observerTimeout);
        observerTimeout = null;
    }
}

// ── Message visibility ──────────────────────────────────────────────────────

function hideMessage(messageIndex) {
    const el = document.querySelector(`[mesid="${messageIndex}"]`);
    if (el) {
        el.style.display = 'none';
    }
}

function showMessage(messageIndex) {
    const el = document.querySelector(`[mesid="${messageIndex}"]`);
    if (el) {
        el.style.display = '';
    }
}

// ── Message replacement ─────────────────────────────────────────────────────

function replaceMessage(messageIndex, newContent) {
    const context = getContext();
    const msg = context.chat[messageIndex];
    if (!msg) {
        console.error(`${LOG} replaceMessage: no message at index ${messageIndex}`);
        return;
    }

    msg.mes = newContent;

    const mesBlock = document.querySelector(`[mesid="${messageIndex}"] .mes_text`);
    if (mesBlock) {
        mesBlock.innerHTML = context.messageFormatting(
            newContent,
            msg.name,
            msg.is_system,
            msg.is_user,
            messageIndex,
        );
    }

    context.saveChat();
}

// ── Fire parallel writers ───────────────────────────────────────────────────

/**
 * Log a summary of the captured prompt with FULL text in expandable detail.
 */
function logPromptSummary(messages, label) {
    if (!messages || messages.length === 0) return;

    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const assistantCount = messages.filter(m => m.role === 'assistant').length;

    const systemFull = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : '') : '(none)';
    const userFull = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '') : '(none)';

    const detail = `Total messages: ${messages.length} (${userMsgs.length} user, ${assistantCount} assistant, ${systemMsg ? 1 : 0} system)\n\n` +
        `── System Prompt (FULL) ──\n${systemFull}\n\n` +
        `── Last User Message (FULL) ──\n${userFull}`;

    addDebugLog('info', `${label}: ${messages.length} messages`, detail);
}

/**
 * Log writer config details.
 */
function logWriterConfig(label, config) {
    const keySource = config.apiKey ? 'custom key' : 'ST proxy (no key needed)';
    addDebugLog('info', `${label} config: ${config.provider}/${config.model} | temp=${config.temperature} | maxTokens=${config.maxTokens} | key=${keySource}`);
}

async function fireParallelWriters() {
    const settings = getSettings();
    const capturedMessages = getCapturedPrompt();

    if (!capturedMessages || capturedMessages.length === 0) {
        addDebugLog('fail', 'fireParallelWriters called but no captured prompt available');
        return;
    }

    // Log the captured prompt summary
    logPromptSummary(capturedMessages, 'Captured prompt');

    const signal = abortController ? abortController.signal : undefined;

    // Writer 2
    if (settings.writer2 && settings.writer2.enabled && settings.writer2.model) {
        try {
            const messages = await modifyPromptForWriter(capturedMessages, settings.writer2);
            const config = buildLLMConfig(settings.writer2, settings);
            logWriterConfig('Writer 2', config);

            // Log if system prompt was modified
            const preset2 = settings.writer2.systemPromptPreset;
            if (preset2 && preset2 !== '__custom__') {
                addDebugLog('info', 'Writer 2: system prompt from preset', preset2);
            } else if (preset2 === '__custom__' && settings.writer2.systemPrompt) {
                addDebugLog('info', 'Writer 2: system prompt REPLACED (custom)', settings.writer2.systemPrompt);
            }
            if (settings.writer2.systemPromptSuffix) {
                addDebugLog('info', 'Writer 2: system prompt suffix APPENDED', settings.writer2.systemPromptSuffix);
            }

            writer2Promise = callLLM(messages, config, signal);
            writer2Promise.catch(() => {});
        } catch (err) {
            addDebugLog('fail', `Writer 2 setup error: ${err.message}`);
            writer2Promise = Promise.reject(err);
            writer2Promise.catch(() => {});
        }
    } else {
        addDebugLog('info', `Writer 2: ${!settings.writer2?.enabled ? 'disabled' : 'no model selected'}`);
        writer2Promise = null;
    }

    // Writer 3
    if (settings.writer3 && settings.writer3.enabled && settings.writer3.model) {
        try {
            const messages = await modifyPromptForWriter(capturedMessages, settings.writer3);
            const config = buildLLMConfig(settings.writer3, settings);
            logWriterConfig('Writer 3', config);

            const preset3 = settings.writer3.systemPromptPreset;
            if (preset3 && preset3 !== '__custom__') {
                addDebugLog('info', 'Writer 3: system prompt from preset', preset3);
            } else if (preset3 === '__custom__' && settings.writer3.systemPrompt) {
                addDebugLog('info', 'Writer 3: system prompt REPLACED (custom)', settings.writer3.systemPrompt);
            }
            if (settings.writer3.systemPromptSuffix) {
                addDebugLog('info', 'Writer 3: system prompt suffix APPENDED', settings.writer3.systemPromptSuffix);
            }

            writer3Promise = callLLM(messages, config, signal);
            writer3Promise.catch(() => {});
        } catch (err) {
            addDebugLog('fail', `Writer 3 setup error: ${err.message}`);
            writer3Promise = Promise.reject(err);
            writer3Promise.catch(() => {});
        }
    } else {
        addDebugLog('info', `Writer 3: ${!settings.writer3?.enabled ? 'disabled' : 'no model selected'}`);
        writer3Promise = null;
    }
}

// ── Pipeline reset / abort ──────────────────────────────────────────────────

function resetPipeline() {
    if (abortController) {
        try { abortController.abort(); } catch (_) { /* ignore */ }
        abortController = null;
    }

    if (pipelineSafetyTimeout) {
        clearTimeout(pipelineSafetyTimeout);
        pipelineSafetyTimeout = null;
    }

    if (generationCleanupTimeout) {
        clearTimeout(generationCleanupTimeout);
        generationCleanupTimeout = null;
    }

    if (pendingMessageIndex !== null) {
        showMessage(pendingMessageIndex);
    }

    stopPreHideObserver();
    hideIndicator();
    hideSkipButton();
    setStatusIndicator('idle');

    pipelineActive = false;
    pendingMessageIndex = null;
    writer2Promise = null;
    writer3Promise = null;
    isSwipe = false;
    clearCapturedPrompt();

    addDebugLog('info', 'Pipeline reset');
}

// ── Core pipeline execution ─────────────────────────────────────────────────

async function runJudgePipeline(messageIndex) {
    const settings = getSettings();
    const context = getContext();
    const signal = abortController ? abortController.signal : undefined;

    const pipelineStartTime = performance.now();

    try {
        // ── Gather Writer 1 output ──────────────────────────────────────
        const writer1Text = context.chat[messageIndex]?.mes;
        if (!writer1Text) {
            addDebugLog('fail', `Writer 1 produced no text at index ${messageIndex}`);
            showMessage(messageIndex);
            resetPipeline();
            return;
        }
        addDebugLog('pass', `Writer 1 done (${writer1Text.length} chars)`, writer1Text);

        // ── Await Writers 2+3 ───────────────────────────────────────────
        updateIndicator('Waiting for parallel writers...');

        const pendingPromises = [];
        const promiseLabels = [];
        if (writer2Promise) { pendingPromises.push(writer2Promise); promiseLabels.push('Writer 2'); }
        if (writer3Promise) { pendingPromises.push(writer3Promise); promiseLabels.push('Writer 3'); }

        const settled = await Promise.allSettled(pendingPromises);

        const writerResults = [{ label: 'Writer 1', content: writer1Text, ok: true }];

        settled.forEach((result, idx) => {
            const label = promiseLabels[idx];
            if (result.status === 'fulfilled' && result.value?.content) {
                const elapsed = (result.value.elapsed / 1000).toFixed(2);
                addDebugLog('pass', `${label} done (${result.value.content.length} chars, ${elapsed}s)`, result.value.content);
                writerResults.push({ label, content: result.value.content, ok: true, elapsed: result.value.elapsed });
            } else {
                const reason = result.status === 'rejected'
                    ? result.reason?.message || String(result.reason)
                    : 'Empty response';
                addDebugLog('fail', `${label} failed: ${reason}`);
                writerResults.push({ label, content: null, ok: false, error: reason });
            }
        });

        // Check abort after awaiting
        if (!pipelineActive) {
            addDebugLog('info', 'Pipeline was aborted while waiting for writers');
            return;
        }

        // ── Validate minimum writers ────────────────────────────────────
        const successfulWriters = writerResults.filter(w => w.ok);
        const minWriters = settings.minWriters || 2;

        if (successfulWriters.length < minWriters) {
            addDebugLog('fail', `Only ${successfulWriters.length}/${minWriters} writers succeeded. Showing Writer 1 output.`);
            if (settings.showToast) {
                toastr.warning(
                    `Only ${successfulWriters.length} writer(s) succeeded (need ${minWriters}). Showing raw Writer 1 output.`,
                    'BF Curator',
                    { timeOut: 6000 },
                );
            }
            showMessage(messageIndex);
            resetPipeline();
            return;
        }

        // ── Run the Judge ───────────────────────────────────────────────
        updateIndicator('Judge is evaluating...');

        const responseA = successfulWriters[0]?.content || null;
        const responseB = successfulWriters[1]?.content || null;
        const responseC = successfulWriters[2]?.content || null;

        // Resolve judge prompt: preset > custom > default
        const presetKey = settings.judge.judgePromptPreset || 'default';
        const presetLabel = (presetKey !== '__custom__' && JUDGE_PRESETS[presetKey])
            ? JUDGE_PRESETS[presetKey].label : 'Custom';
        const judgePrompt = (presetKey !== '__custom__' && JUDGE_PRESETS[presetKey])
            ? JUDGE_PRESETS[presetKey].prompt
            : (settings.judge.prompt || getDefaultJudgePrompt());
        addDebugLog('info', `Judge prompt preset: ${presetLabel} (${judgePrompt.length} chars)`);
        const judgeMessages = buildJudgeMessages(judgePrompt, responseA, responseB, responseC);
        const judgeConfig = buildLLMConfig(settings.judge, settings);

        // Log judge config
        const judgeKeySource = judgeConfig.apiKey ? 'custom key' : 'ST proxy';
        addDebugLog('info', `Judge config: ${judgeConfig.provider}/${judgeConfig.model} | temp=${judgeConfig.temperature} | maxTokens=${judgeConfig.maxTokens} | key=${judgeKeySource}`);

        // Log judge prompt (FULL text in expandable detail)
        const judgeSysContent = judgeMessages.find(m => m.role === 'system')?.content || '';
        const judgeUserContent = judgeMessages.find(m => m.role === 'user')?.content || '';
        addDebugLog('info', `Judge prompt: system=${judgeSysContent.length} chars, user=${judgeUserContent.length} chars (${successfulWriters.length} responses)`,
            `── Judge System Prompt (FULL) ──\n${judgeSysContent}\n\n── Judge User Prompt (FULL) ──\n${judgeUserContent}`);

        let judgeContent;
        try {
            const judgeResult = await callLLM(judgeMessages, judgeConfig, signal);
            judgeContent = judgeResult.content;
            addDebugLog('pass', `Judge done (${judgeContent.length} chars, ${(judgeResult.elapsed / 1000).toFixed(2)}s)`, judgeContent);
        } catch (judgeDirectErr) {
            // Fallback: try generateQuietPrompt if the direct call fails
            addDebugLog('info', `Judge direct API failed, trying generateQuietPrompt fallback: ${judgeDirectErr.message}`);

            ownCallDepth++;
            try {
                const fallbackPrompt = judgeMessages.map(m => `${m.role}: ${m.content}`).join('\n\n');
                judgeContent = await context.generateQuietPrompt({ quietPrompt: fallbackPrompt, skipWIAN: true });
                if (!judgeContent || typeof judgeContent !== 'string' || !judgeContent.trim()) {
                    throw new Error('generateQuietPrompt returned empty');
                }
                addDebugLog('pass', `Judge fallback done (${judgeContent.length} chars)`, judgeContent);
            } catch (fallbackErr) {
                addDebugLog('fail', `Judge fallback also failed: ${fallbackErr.message}`);
                if (settings.showToast) {
                    toastr.error('Judge failed. Showing raw Writer 1 output.', 'BF Curator', { timeOut: 6000 });
                }
                showMessage(messageIndex);
                resetPipeline();
                return;
            } finally {
                ownCallDepth--;
            }
        }

        // Check abort after judge
        if (!pipelineActive) {
            addDebugLog('info', 'Pipeline was aborted during Judge call');
            return;
        }

        // ── Replace message + reveal ────────────────────────────────────
        replaceMessage(messageIndex, judgeContent);
        showMessage(messageIndex);

        if (settings.showToast) {
            toastr.success(
                `Arena complete: ${successfulWriters.length} writers judged`,
                'BF Curator',
                { timeOut: 4000 },
            );
        }

        // ── Final summary ───────────────────────────────────────────────
        const totalTime = ((performance.now() - pipelineStartTime) / 1000).toFixed(1);
        const writerSummary = writerResults.map(w => {
            if (w.ok) return `${w.label}: ✓ ${w.content.length} chars`;
            return `${w.label}: ✗ ${w.error}`;
        }).join('\n');
        addDebugLog('pass', `Pipeline complete (${totalTime}s total, ${successfulWriters.length} writers, msg #${messageIndex})`,
            `── Pipeline Summary ──\nTotal time: ${totalTime}s\nWriters:\n${writerSummary}\nJudge model: ${judgeConfig.provider}/${judgeConfig.model}\nJudge output: ${judgeContent.length} chars\nFinal message index: ${messageIndex}`);

        // Store arena metadata on the message
        const msg = context.chat[messageIndex];
        if (msg) {
            msg.extra = msg.extra || {};
            msg.extra.bf_curator = {
                writers: writerResults.map(w => ({
                    label: w.label,
                    ok: w.ok,
                    content: w.ok ? w.content : null,
                    contentLength: w.ok ? w.content.length : 0,
                    error: w.error || null,
                })),
                judgeModel: judgeConfig.model,
                timestamp: Date.now(),
            };
            context.saveChat();
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            addDebugLog('info', 'Pipeline aborted');
            return;
        }
        addDebugLog('fail', `Pipeline error: ${err.message}`);
        if (getSettings().showToast) {
            toastr.error(`Arena error: ${err.message}`, 'BF Curator', { timeOut: 8000 });
        }
        showMessage(messageIndex);
    } finally {
        if (pipelineActive) {
            pipelineActive = false;
            pendingMessageIndex = null;
            writer2Promise = null;
            writer3Promise = null;
            isSwipe = false;
            abortController = null;
            clearCapturedPrompt();
            hideIndicator();
            hideSkipButton();
            if (pipelineSafetyTimeout) {
                clearTimeout(pipelineSafetyTimeout);
                pipelineSafetyTimeout = null;
            }
        }
    }
}

// ── Initialization ──────────────────────────────────────────────────────────

export function initPipeline() {
    const context = getContext();
    const { eventSource, eventTypes } = context;

    // Register the armed-check with the interceptor
    setArmedCheck(() => pipelineActive && !isOwnCall());

    // Set up skip button callback
    setSkipCallback(() => {
        addDebugLog('info', 'User clicked Skip Arena');
        resetPipeline();
    });

    // Listen to CHAT_COMPLETION_PROMPT_READY to fire parallel writers
    // immediately after the interceptor captures the prompt.
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (data?.dryRun) return;
        if (!pipelineActive) return;
        if (isOwnCall()) return;

        const captured = getCapturedPrompt();
        if (!captured) return;

        addDebugLog('info', `Prompt captured (${captured.length} messages), firing parallel writers`);
        fireParallelWriters();
    });

    // ── GENERATION_STARTED ──────────────────────────────────────────
    eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        const settings = getSettings();
        if (!settings || !settings.enabled) return;

        // Only arm for supported generation types
        const supportedTypes = ['normal', 'regenerate', 'swipe', 'continue'];
        if (type && !supportedTypes.includes(type)) return;

        // Skip dry runs
        if (dryRun) return;

        // Ignore if pipeline is already active (re-entrancy guard)
        if (pipelineActive) return;

        addDebugLog('info', `GENERATION_STARTED (type=${type}) — arming pipeline`);

        pipelineActive = true;
        pendingMessageIndex = null;
        writer2Promise = null;
        writer3Promise = null;
        isSwipe = (type === 'swipe');
        clearCapturedPrompt();

        abortController = new AbortController();

        // For swipes, the message element already exists — hide it directly
        if (isSwipe) {
            const lastAiMsg = document.querySelector('#chat .mes:last-child');
            if (lastAiMsg) lastAiMsg.style.display = 'none';
            addDebugLog('info', 'Swipe detected — directly hid last AI message');
        } else {
            startPreHideObserver();
        }

        showIndicator('Writer 1 generating...');
        showSkipButton();
        setStatusIndicator('running');

        // Safety timeout
        const timeout = settings.timeoutMs || 120000;
        pipelineSafetyTimeout = setTimeout(() => {
            if (pipelineActive) {
                addDebugLog('fail', `Pipeline safety timeout (${timeout / 1000}s) — forcing reset`);
                if (settings.showToast) {
                    toastr.error(`Arena timed out after ${timeout / 1000}s`, 'BF Curator', { timeOut: 6000 });
                }
                resetPipeline();
            }
        }, timeout);
    });

    // ── MESSAGE_RECEIVED ────────────────────────────────────────────
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageIndex) => {
        if (!pipelineActive) return;

        // Cancel any pending generation-stopped cleanup since we got a real message
        if (generationCleanupTimeout) {
            clearTimeout(generationCleanupTimeout);
            generationCleanupTimeout = null;
        }

        addDebugLog('info', `MESSAGE_RECEIVED (index ${messageIndex}) — Writer 1 complete`);

        pendingMessageIndex = messageIndex;
        hideMessage(messageIndex);

        await runJudgePipeline(messageIndex);
    });

    // ── GENERATION_STOPPED ──────────────────────────────────────────
    // FIX: ST fires GENERATION_STOPPED *before* MESSAGE_RECEIVED during
    // normal completion. Delay cleanup by 3s so MESSAGE_RECEIVED has time
    // to fire first. If MESSAGE_RECEIVED fires, it cancels this timeout.
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (!pipelineActive) return;

        addDebugLog('info', 'GENERATION_STOPPED — scheduling cleanup in 3s');
        if (generationCleanupTimeout) clearTimeout(generationCleanupTimeout);
        generationCleanupTimeout = setTimeout(() => {
            generationCleanupTimeout = null;
            if (pipelineActive) {
                addDebugLog('info', 'Generation cleanup timeout fired — no MESSAGE_RECEIVED, aborting');
                resetPipeline();
            }
        }, 3000);
    });

    // ── CHAT_CHANGED ────────────────────────────────────────────────
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (pipelineActive) {
            addDebugLog('info', 'CHAT_CHANGED — aborting pipeline');
            resetPipeline();
        }
    });

    console.log(`${LOG} Pipeline initialized`);
}
