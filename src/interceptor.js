/**
 * Prompt Interceptor for BF Agentic Curator
 *
 * Captures SillyTavern's fully-built messages array via the
 * CHAT_COMPLETION_PROMPT_READY event so Writers 2 and 3 can
 * reuse the same conversation context for their direct API calls.
 */

let capturedPrompt = null;
let isArmedCheck = () => false;

function getContext() {
    return SillyTavern.getContext();
}

/**
 * Sets up the event listener that captures the prompt.
 */
export function initInterceptor() {
    const { eventSource, eventTypes } = getContext();

    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (data?.dryRun) {
            console.log('[BFCurator] Skipping dry run prompt capture');
            return;
        }

        if (!isArmedCheck()) {
            return;
        }

        capturedPrompt = structuredClone(data.chat);
        console.log(`[BFCurator] Captured prompt with ${capturedPrompt.length} messages`);
    });

    console.log('[BFCurator] Interceptor initialized');
}

/**
 * Returns the captured messages array, or null if nothing has been captured.
 * @returns {Array|null}
 */
export function getCapturedPrompt() {
    return capturedPrompt;
}

/**
 * Resets the captured prompt to null.
 */
export function clearCapturedPrompt() {
    capturedPrompt = null;
}

/**
 * Registers the armed-check callback provided by the pipeline.
 * The interceptor only captures prompts when this returns true,
 * preventing capture of the extension's own internal LLM calls.
 * @param {() => boolean} fn
 */
export function setArmedCheck(fn) {
    isArmedCheck = fn;
}
