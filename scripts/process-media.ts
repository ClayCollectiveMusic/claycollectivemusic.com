import * as fastGlob from 'fast-glob';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', 'src', 'media');

// Find all album directories
const albumDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^.+?\s*\(\d{4}\)$/.test(d.name));

console.log(`Found ${albumDirs.length} albums\n`);

let albumsCreated = 0;
let albumsUpdated = 0;
let wavConverted = 0;

for (const dir of albumDirs) {
    const albumPath = path.join(mediaDir, dir.name);
    const albumJsonPath = path.join(albumPath, 'album.json');
    const match = dir.name.match(/^(.+?)\s*\((\d{4})\)$/);
    if (!match) continue;
    const year = match[2];

    // Create album.json if missing
    if (!fs.existsSync(albumJsonPath)) {
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
                stems: [],
            }));

        const albumJson = { releaseDate: `${year}-01-01`, tracks };
        fs.writeFileSync(albumJsonPath, JSON.stringify(albumJson, null, 2) + '\n');
        console.log(`  [created] album.json for: ${dir.name}`);
        albumsCreated++;
    }

    // Update stems arrays in album.json from what's on disk
    const albumMeta = JSON.parse(fs.readFileSync(albumJsonPath, 'utf8'));
    const stemsBaseDir = path.join(albumPath, 'stems');
    let updated = false;

    for (let i = 0; i < (albumMeta.tracks || []).length; i++) {
        const track = albumMeta.tracks[i];
        const trackNum = track.trackNum ?? (i + 1);
        const trackNumStr = String(trackNum).padStart(2, '0');

        // Find the stem folder for this track
        let stemFolder: string | null = null;
        const exactMatch = `${trackNumStr} - ${track.name}`;
        if (fs.existsSync(path.join(stemsBaseDir, exactMatch))) {
            stemFolder = exactMatch;
        } else if (fs.existsSync(stemsBaseDir)) {
            const stemDirs = fs.readdirSync(stemsBaseDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            stemFolder = stemDirs.find(d => {
                const m = d.match(/^\d+\s*-\s*(.+)$/);
                return m && m[1].trim().toLowerCase() === track.name.toLowerCase();
            }) ?? null;
        }

        if (!stemFolder) continue;

        const stemFiles = fastGlob.sync('*.mp3', {
            cwd: path.join(stemsBaseDir, stemFolder)
        }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const stemNames = stemFiles.map(sf => {
            const m = sf.match(/^.+?_(.+)\.mp3$/);
            return { name: m ? m[1] : sf.replace('.mp3', ''), file: sf, folder: stemFolder };
        });

        const existing = JSON.stringify(track.stems ?? []);
        const incoming = JSON.stringify(stemNames);
        if (existing !== incoming) {
            albumMeta.tracks[i].stems = stemNames;
            updated = true;
        }
    }

    if (updated) {
        fs.writeFileSync(albumJsonPath, JSON.stringify(albumMeta, null, 2) + '\n');
        console.log(`  [updated] stems in album.json for: ${dir.name}`);
        albumsUpdated++;
    } else {
        console.log(`  [ok]      ${dir.name}`);
    }
}

// Convert .wav files to .mp3
const wavFiles = fastGlob.sync('**/*.wav', { cwd: mediaDir, absolute: true });

if (wavFiles.length > 0) {
    console.log(`\nConverting ${wavFiles.length} .wav files...`);
    for (const wavFile of wavFiles) {
        const mp3File = wavFile.replace(/\.wav$/, '.mp3');

        if (fs.existsSync(mp3File)) {
            console.log(`  [skip] mp3 already exists: ${path.basename(wavFile)}`);
        } else {
            console.log(`  [converting] ${path.basename(wavFile)}`);
            try {
                execSync(`ffmpeg -i "${wavFile}" -c:a libmp3lame -b:a 320k "${mp3File}"`, {
                    stdio: 'inherit',
                });
                wavConverted++;
            } catch (e) {
                console.error(`  [error] Failed to convert: ${wavFile}`);
                continue;
            }
        }

        if (fs.existsSync(mp3File)) {
            fs.unlinkSync(wavFile);
            console.log(`  [deleted] ${path.basename(wavFile)}`);
        }
    }
}

console.log(`\nDone. Albums created: ${albumsCreated}, stems updated: ${albumsUpdated}, wavs converted: ${wavConverted}`);
