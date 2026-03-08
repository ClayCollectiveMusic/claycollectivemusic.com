import * as fastGlob from 'fast-glob';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', 'src', 'media');

// Find all .wav files recursively
const wavFiles = fastGlob.sync('**/*.wav', {
    cwd: mediaDir,
    absolute: true,
});

console.log(`Found ${wavFiles.length} .wav files`);

for (const wavFile of wavFiles) {
    const mp3File = wavFile.replace(/\.wav$/, '.mp3');

    if (fs.existsSync(mp3File)) {
        console.log(`Skipping (mp3 exists): ${path.basename(wavFile)}`);
    } else {
        console.log(`Converting: ${path.basename(wavFile)}`);
        try {
            execSync(`ffmpeg -i "${wavFile}" -c:a libmp3lame -b:a 320k "${mp3File}"`, {
                stdio: 'inherit',
            });
        } catch (e) {
            console.error(`Failed to convert: ${wavFile}`);
            continue;
        }
    }

    // Delete the .wav only if the .mp3 now exists
    if (fs.existsSync(mp3File)) {
        fs.unlinkSync(wavFile);
        console.log(`Deleted: ${path.basename(wavFile)}`);
    }
}

console.log('Done!');
