import { imageDiagnosticsEnabled } from './qqbot-image-diagnostics.mjs';

/** A loaded image and a completed visual answer are separate outcomes. */
export function readVisionResponse(assembler, imageRef) {
    const finish = assembler.finish;
    const text = assembler.blocks().filter(block => block.type === 'text')
        .map(block => block.text).join(' ').trim();
    if (imageDiagnosticsEnabled()) {
        const fields = { stage: 'model-response',
            finish: ['stop', 'max-tokens', 'error', 'aborted', 'tool-calls'].includes(finish?.kind) ? finish.kind : 'unknown',
            textChars: text.length };
        for (const key of ['bytes', 'width', 'height']) {
            if (Number.isSafeInteger(imageRef?.[key]) && imageRef[key] >= 0) fields[key] = imageRef[key];
        }
        for (const key of ['outputTokens', 'reasoningTokens']) {
            if (Number.isSafeInteger(assembler.usage?.[key]) && assembler.usage[key] >= 0) fields[key] = assembler.usage[key];
        }
        try { console.info('[qqbot-vision] ' + JSON.stringify(fields)); } catch { /* Diagnostics are optional. */ }
    }
    if (finish?.kind === 'max-tokens') {
        const error = new Error('qqbot_describe_image: image loaded successfully, but the vision model reached its output limit before completing the analysis. Do not infer a missing image or download failure, and do not automatically retry this image.');
        error.code = 'VISION_OUTPUT_LIMIT';
        throw error;
    }
    if (!text) {
        const error = new Error('qqbot_describe_image: image loaded successfully, but the vision model returned no visible text. Do not infer a missing image or download failure, and do not automatically retry this image.');
        error.code = 'VISION_EMPTY_RESPONSE';
        throw error;
    }
    return text;
}
