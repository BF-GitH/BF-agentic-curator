/**
 * judge.js — Anti-consensus judge / combiner for bf-agentic-curator
 *
 * Takes 3 (or 2) writer responses, identifies shared patterns (slop),
 * extracts unique elements (signal), and synthesizes one combined
 * response that drops the consensus and keeps the surprises.
 */

const LOG_PREFIX = '[BFCurator]';
const MAX_RESPONSE_LENGTH = 6000;

/**
 * Truncate a response to the maximum allowed length, breaking at a
 * sentence or paragraph boundary when possible.
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
    if (text.length <= MAX_RESPONSE_LENGTH) {
        return text;
    }
    const truncated = text.slice(0, MAX_RESPONSE_LENGTH);
    // Try to break at last paragraph boundary
    const lastParagraph = truncated.lastIndexOf('\n\n');
    if (lastParagraph > MAX_RESPONSE_LENGTH * 0.7) {
        return truncated.slice(0, lastParagraph) + '\n\n[...truncated]';
    }
    // Fall back to last sentence boundary
    const lastSentence = truncated.search(/[.!?"]\s[^.!?"]*$/);
    if (lastSentence > MAX_RESPONSE_LENGTH * 0.7) {
        return truncated.slice(0, lastSentence + 1) + '\n\n[...truncated]';
    }
    return truncated + '\n\n[...truncated]';
}

/**
 * Get the default judge prompt template.
 * @returns {string}
 */
export function getDefaultJudgePrompt() {
    return `You are an anti-consensus filter for creative fiction. Your job is adversarial curation: given multiple AI-generated continuations of the same story, you must identify what they share (the consensus — predictable, cliched, generic patterns) and what is unique to only one (the signal — surprising, specific, alive). Then you synthesize one final response built from signal, not consensus.

## STEP 1: CONSENSUS IDENTIFICATION

Read all responses and catalogue everything that appears in 2 or more of them. These are the consensus patterns — the predictable moves the model defaults to. Look for:

- **Structural echoes**: Do they open the same way? (e.g., all start with an action beat, all start with internal monologue, all start with a sigh or a pause.) Do they follow the same shape — setup, reaction, reflection, resolution?
- **Emotional arcs**: Do they land on the same emotional trajectory? (e.g., all move from tension to softening, all resolve with quiet acceptance, all end on bittersweet warmth.)
- **Character beats**: Do multiple responses have the character do the same physical actions? (Looking away, biting a lip, exhaling slowly, running a hand through hair, a "ghost of a smile.") These are LLM stage directions — note them all.
- **Thematic convergence**: Do they reach the same thematic conclusion? The same moral, the same realization, the same emotional takeaway?
- **Phrasing overlap**: Near-synonym constructions of the same image or idea. If two responses both describe light falling across a face, or silence stretching between characters, or a voice going quiet — that is consensus even if the exact words differ.
- **Dialogue patterns**: Do the characters say essentially the same things? Make the same concessions? Ask the same questions? Deliver the same emotional payload in dialogue?

All of these are SLOP. They represent the model's path of least resistance. They must be dropped.

## STEP 2: SIGNAL EXTRACTION

Now find what exists in ONLY ONE response and nowhere else. These are the signals — the moments where one generation diverged from the default path. Look for:

- **Unexpected plot moves**: A character does something the other responses didn't predict. An interruption, a refusal, a non sequitur, a surprising choice.
- **Distinctive dialogue**: Lines that sound like a specific person, not a generic character. Unusual phrasing, unexpected emotional register, words that surprise.
- **Structural originality**: One response uses a different structure — starts in media res, uses a time skip, fragments its paragraphs, holds back information the others reveal immediately.
- **Specific sensory detail**: Concrete, precise details that the other responses lack. Not "the room was cold" (generic) but the specific way coldness manifests in one version that the others didn't think of.
- **Tonal divergence**: One response takes a different emotional angle — where the consensus is tender, this one is sharp; where the consensus is melancholy, this one is dry or darkly funny.
- **Unusual word choices**: Verbs, adjectives, or metaphors that only appear in one response. Phrasings that feel authored rather than generated.

Each signal is valuable precisely because the model only found it once in three attempts.

## STEP 3: SYNTHESIS

Combine the extracted signals into ONE cohesive response. Your synthesis must:

1. **DROP all consensus patterns.** If all three responses had the character sigh, your response must not include a sigh. If they all opened with internal monologue, open differently. If they all resolved with warmth, resolve differently — or don't resolve at all.
2. **KEEP the specificity of unique elements.** When transplanting a signal from one response, preserve its exact texture — the specific words, the particular image, the precise emotional register. Do not sand it down into something more generic.
3. **FLOW naturally.** The final response must read as one coherent piece, not a patchwork of fragments stitched together. Bridge signals with your own connective tissue, but keep that connective tissue minimal and invisible.
4. **ADD nothing new.** Every substantive element in your synthesis must trace back to one of the source responses. You are a curator, not a creator. Do not invent new plot points, new dialogue, new descriptions, or new emotional beats.
5. **PRESERVE formatting.** Match the formatting conventions of the source responses — italics for thoughts, quotation marks for dialogue, paragraph breaks, em-dashes, whatever patterns the originals use.
6. **MATCH approximate length.** Your synthesis should be roughly the same length as the original responses. Do not dramatically shorten or pad.
7. **PREFER the rarer choice at every decision point.** When you must choose between two signals for the same story moment, pick the one that is more surprising, more specific, more alive.

## CRITICAL RULES

- You are a FILTER, not an author. Your output is assembled from source material, not generated fresh.
- When in doubt, cut rather than keep. Better to lose a mediocre signal than to include something that was part of the consensus.
- Never explain your reasoning in the output. Never include meta-commentary. Output ONLY the synthesized story response.
- The final response should read as if it were a single, confident generation — not a committee product.`;
}

/**
 * Build the complete judge prompt from template + responses.
 * @param {string} template - Judge prompt template with {response_a}, {response_b}, {response_c} placeholders
 * @param {string} responseA - Writer 1's response
 * @param {string|null} responseB - Writer 2's response (null if failed)
 * @param {string|null} responseC - Writer 3's response (null if failed)
 * @returns {Array} Messages array [{role: "system", content: "..."}, {role: "user", content: "..."}]
 */
export function buildJudgeMessages(template, responseA, responseB, responseC) {
    // Count valid responses
    const validResponses = [responseA, responseB, responseC].filter(r => r != null);
    const validCount = validResponses.length;

    if (validCount < 2) {
        console.warn(`${LOG_PREFIX} Judge called with fewer than 2 valid responses (${validCount}). Cannot perform anti-consensus filtering.`);
        // Return the single response as-is — the caller should handle this,
        // but we build a passthrough prompt just in case.
        return [
            { role: 'system', content: 'Return the following response exactly as-is, with no modifications.' },
            { role: 'user', content: responseA || '' },
        ];
    }

    // Truncate responses to avoid context overflow
    const truncA = truncate(responseA);
    const truncB = responseB != null ? truncate(responseB) : null;
    const truncC = responseC != null ? truncate(responseC) : null;

    if (responseA && responseA.length > MAX_RESPONSE_LENGTH) {
        console.log(`${LOG_PREFIX} Response A truncated: ${responseA.length} -> ${truncA.length} chars`);
    }
    if (responseB && responseB.length > MAX_RESPONSE_LENGTH) {
        console.log(`${LOG_PREFIX} Response B truncated: ${responseB.length} -> ${truncB.length} chars`);
    }
    if (responseC && responseC.length > MAX_RESPONSE_LENGTH) {
        console.log(`${LOG_PREFIX} Response C truncated: ${responseC.length} -> ${truncC.length} chars`);
    }

    // Build the system prompt from template
    let systemContent = template;

    // If we only have 2 responses, append a note to the system prompt
    if (validCount === 2) {
        systemContent += '\n\nNOTE: Only 2 responses are provided (one writer failed). Apply the same anti-consensus process with 2 responses: identify what both share (consensus) and what is unique to each (signal). The principle is the same — shared patterns are slop, divergences are signal.';
        console.log(`${LOG_PREFIX} Judge operating in 2-response mode (one writer failed)`);
    }

    // Build the user message with labeled responses
    let userContent = '';

    if (validCount === 3) {
        userContent = `Here are 3 AI-generated continuations of the same story prompt. Identify the consensus, extract the signals, and synthesize one response.

---

## RESPONSE A

${truncA}

---

## RESPONSE B

${truncB}

---

## RESPONSE C

${truncC}

---

Synthesize one response from the signals. Output ONLY the synthesized story response.`;
    } else {
        // 2-response mode: figure out which two we have
        const labels = [];
        const texts = [];

        if (responseA != null) { labels.push('A'); texts.push(truncA); }
        if (responseB != null) { labels.push('B'); texts.push(truncB); }
        if (responseC != null) { labels.push('C'); texts.push(truncC); }

        userContent = `Here are 2 AI-generated continuations of the same story prompt (one writer failed). Identify what both share (consensus/slop) and what is unique to each (signal). Synthesize one response from the signals.

---

## RESPONSE ${labels[0]}

${texts[0]}

---

## RESPONSE ${labels[1]}

${texts[1]}

---

Synthesize one response from the signals. Output ONLY the synthesized story response.`;
    }

    // Also substitute placeholders in case the template uses them
    // (some users may customize the template with inline placeholders)
    systemContent = systemContent
        .replace(/\{response_a\}/gi, truncA || '[not available]')
        .replace(/\{response_b\}/gi, truncB || '[not available]')
        .replace(/\{response_c\}/gi, truncC || '[not available]');

    console.log(`${LOG_PREFIX} Built judge prompt: ${validCount} responses, system=${systemContent.length} chars, user=${userContent.length} chars`);

    return [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
    ];
}
