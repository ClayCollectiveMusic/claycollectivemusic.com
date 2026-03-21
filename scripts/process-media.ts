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

// Find all album directories and create album.json if missing
const albumDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^.+?\s*\(\d{4}\)$/.test(d.name));

for (const dir of albumDirs) {
    const albumPath = path.join(mediaDir, dir.name);
    const albumJsonPath = path.join(albumPath, 'album.json');

    if (fs.existsSync(albumJsonPath)) continue;

    const match = dir.name.match(/^(.+?)\s*\((\d{4})\)$/);
    if (!match) continue;

    const albumName = match[1].trim();
    const year = match[2];

    // Discover tracks to prefill track entries
    const tracksDir = path.join(albumPath, 'tracks');
    const trackSource = fs.existsSync(tracksDir) ? tracksDir : albumPath;
    const trackFiles = fastGlob.sync('*.{mp3,wav}', { cwd: trackSource }).sort();

    const tracks = trackFiles
        .map(f => {
            const m = f.match(/^\d+\s*-\s*(.+)\.(mp3|wav)$/);
            return m ? m[1].trim() : null;
        })
        .filter((name, i, arr) => name && arr.indexOf(name) === i)
        .map(name => ({
            name,
            stemsUrl: '',
            masterUrl: '',
            spotifyUrl: '',
        }));

    const albumJson = {
        releaseDate: `${year}-01-01`,
        tracks,
    };

    fs.writeFileSync(albumJsonPath, JSON.stringify(albumJson, null, 2) + '\n');
    console.log(`Created album.json for: ${dir.name}`);
}

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
