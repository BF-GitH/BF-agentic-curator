/**
 * api-adapters.js — Direct LLM provider API calls for bf-agentic-curator
 *
 * Bypasses SillyTavern's pipeline to call providers directly via fetch().
 * Supports OpenRouter, Anthropic, and OpenAI-compatible endpoints.
 */

const LOG_PREFIX = '[BFCurator]';

/**
 * Extract plain text from a message's content field.
 * Handles both string content and multimodal content arrays.
 * @param {string|Array} content
 * @returns {string}
 */
function extractTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n');
    }
    return String(content ?? '');
}

/**
 * Prepare messages for the Anthropic API format.
 * - Extracts system messages into a separate system string.
 * - Ensures the messages array only contains user/assistant roles.
 * @param {Array} messages
 * @returns {{ system: string, messages: Array }}
 */
function prepareAnthropicMessages(messages) {
    const cloned = structuredClone(messages);
    const systemParts = [];
    const filtered = [];

    for (const msg of cloned) {
        if (msg.role === 'system') {
            systemParts.push(extractTextContent(msg.content));
        } else {
            filtered.push(msg);
        }
    }

    return {
        system: systemParts.join('\n\n'),
        messages: filtered,
    };
}

/**
 * Call an OpenRouter or OpenAI-compatible endpoint.
 * @param {Array} messages
 * @param {object} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function callOpenAICompatible(messages, config, signal) {
    const { model, apiKey, temperature, maxTokens, baseUrl } = config;

    const url = baseUrl
        ? `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
        : 'https://openrouter.ai/api/v1/chat/completions';

    const body = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
    };

    console.log(`${LOG_PREFIX} Calling ${url} with model ${model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '(unable to read error body)');
        throw new Error(
            `${LOG_PREFIX} ${response.status} ${response.statusText} from ${url}: ${errorBody}`
        );
    }

    const data = await response.json();

    const content = data?.choices?.[0]?.message?.content;
    if (content == null) {
        throw new Error(`${LOG_PREFIX} Unexpected response structure from ${url}: ${JSON.stringify(data)}`);
    }

    return content;
}

/**
 * Call the Anthropic Messages API directly.
 * @param {Array} messages
 * @param {object} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function callAnthropic(messages, config, signal) {
    const { model, apiKey, temperature, maxTokens } = config;
    const url = 'https://api.anthropic.com/v1/messages';

    const { system, messages: filteredMessages } = prepareAnthropicMessages(messages);

    const body = {
        model,
        messages: filteredMessages,
        max_tokens: maxTokens,
        temperature,
    };

    if (system) {
        body.system = system;
    }

    console.log(`${LOG_PREFIX} Calling Anthropic API with model ${model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '(unable to read error body)');
        throw new Error(
            `${LOG_PREFIX} ${response.status} ${response.statusText} from Anthropic: ${errorBody}`
        );
    }

    const data = await response.json();

    const content = data?.content?.[0]?.text;
    if (content == null) {
        throw new Error(`${LOG_PREFIX} Unexpected response structure from Anthropic: ${JSON.stringify(data)}`);
    }

    return content;
}

/**
 * Map extension provider names to ST's chat_completion_source values.
 */
const ST_SOURCE_MAP = {
    'openrouter': 'openrouter',
    'anthropic': 'claude',
    'custom': 'custom',
};

/**
 * Call an LLM via SillyTavern's backend proxy.
 * ST attaches the API key server-side — no key needed in the browser.
 * @param {Array} messages
 * @param {object} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function callSTProxy(messages, config, signal) {
    const { model, temperature, maxTokens, provider, presetName } = config;
    const chatCompletionSource = ST_SOURCE_MAP[provider] || provider;

    const headers = SillyTavern.getContext().getRequestHeaders?.();
    if (!headers) {
        throw new Error(`${LOG_PREFIX} Cannot get ST request headers for proxy call`);
    }

    const body = {
        chat_completion_source: chatCompletionSource,
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
    };

    // If a chat completion preset name is specified, include it
    if (presetName) {
        body.preset = presetName;
        console.log(`${LOG_PREFIX} Using chat completion preset: ${presetName}`);
    }

    console.log(`${LOG_PREFIX} Calling ST proxy for ${chatCompletionSource}/${model}`);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '(unable to read error body)');
        throw new Error(
            `${LOG_PREFIX} ST proxy ${response.status} ${response.statusText}: ${errorBody}`
        );
    }

    const data = await response.json();

    // ST proxy returns OpenAI-compatible format
    const content = data?.choices?.[0]?.message?.content;
    if (content == null) {
        throw new Error(`${LOG_PREFIX} Unexpected response from ST proxy: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return content;
}

/**
 * Call an LLM provider. Uses direct API calls when an API key is available,
 * otherwise proxies through SillyTavern's backend (which uses ST's stored key).
 * @param {Array} messages - Chat messages array [{role, content}, ...]
 * @param {object} config - { provider, model, apiKey, temperature, maxTokens, baseUrl }
 * @param {AbortSignal} [signal] - Optional AbortController signal for cancellation
 * @returns {Promise<{content: string, elapsed: number}>}
 */
export async function callLLM(messages, config, signal) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        throw new Error(`${LOG_PREFIX} callLLM requires a non-empty messages array`);
    }
    if (!config || !config.provider || !config.model) {
        throw new Error(`${LOG_PREFIX} callLLM requires config with provider and model`);
    }

    const startTime = performance.now();

    let content;
    const hasApiKey = !!config.apiKey;

    if (!hasApiKey) {
        // No API key available — proxy through ST's backend
        console.log(`${LOG_PREFIX} No API key for ${config.provider}, using ST proxy`);
        content = await callSTProxy(messages, config, signal);
    } else {
        switch (config.provider) {
            case 'openrouter':
                content = await callOpenAICompatible(messages, config, signal);
                break;

            case 'anthropic':
                content = await callAnthropic(messages, config, signal);
                break;

            case 'custom':
                if (!config.baseUrl) {
                    throw new Error(`${LOG_PREFIX} Custom provider requires a baseUrl in config`);
                }
                content = await callOpenAICompatible(messages, config, signal);
                break;

            default:
                throw new Error(`${LOG_PREFIX} Unknown provider: ${config.provider}`);
        }
    }

    const elapsed = performance.now() - startTime;

    console.log(`${LOG_PREFIX} Response from ${config.provider}/${config.model} in ${(elapsed / 1000).toFixed(2)}s`);

    return { content, elapsed };
}
