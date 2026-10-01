import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const sharp = require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 30_000;

parentPort.on('message', async ({ bytes, expectedFormat }) => {
    try {
        const input = Buffer.from(bytes);
        const options = { animated: false, page: 0, pages: 1, failOn: 'error', limitInputPixels: MAX_PIXELS };
        const metadata = await sharp(input, options).metadata();
        if (metadata.format !== expectedFormat || !['png', 'jpeg', 'gif', 'webp'].includes(metadata.format)
            || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
            || metadata.width < 1 || metadata.height < 1) {
            parentPort.postMessage({ kind: 'image-type' });
            return;
        }
        if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION
            || metadata.width * metadata.height > MAX_PIXELS) {
            parentPort.postMessage({ kind: 'too-large' });
            return;
        }
        const output = await sharp(input, options).rotate().timeout({ seconds: 10 }).png().toBuffer();
        if (output.length > MAX_IMAGE_BYTES) {
            parentPort.postMessage({ kind: 'too-large' });
            return;
        }
        parentPort.postMessage({ bytes: output });
    }
    catch (error) {
        const reason = String(error?.message);
        parentPort.postMessage({ kind: /timed?\s*out|timeout/iu.test(reason) ? 'failed'
            : /pixel limit|too large|image too large/iu.test(reason) ? 'too-large' : 'image-type' });
    }
});
