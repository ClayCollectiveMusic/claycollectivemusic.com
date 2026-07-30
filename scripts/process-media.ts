import * as fastGlob from 'fast-glob';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', 'src', 'media');

/**
 * Derives a stem's display label (shown on each track row in the player) from its
 * filename. Handles both naming conventions found in the media folder:
 *
 *   "Song Title - Electric Guitar 2.mp3"  -> "Electric Guitar 2"   (current)
 *   "GTTK_E GTR 2.mp3"                    -> "E GTR 2"             (legacy)
 *
 * The old implementation only handled the legacy underscore form and fell back to
 * the whole filename otherwise — which, after the files were renamed to the
 * "Song - Instrument" convention, produced labels like
 * "Pour out Your Spirit - Acoustic Guitar" instead of "Acoustic Guitar".
 */
function stemDisplayName(fileName: string, trackName: string): string {
    const base = fileName.replace(/\.mp3$/i, '');

    // Current convention: strip the leading "<track name> - " prefix.
    const prefix = `${trackName} - `;
    if (base.toLowerCase().startsWith(prefix.toLowerCase())) {
        return base.slice(prefix.length).trim();
    }

    // Generic "Anything - Instrument" fallback (handles abbreviated song prefixes).
    const dashed = base.match(/^.+?\s+-\s+(.+)$/);
    if (dashed) return dashed[1].trim();

    // Legacy convention: "PREFIX_INSTRUMENT".
    const underscored = base.match(/^[^_]+_(.+)$/);
    if (underscored) return underscored[1].trim();

    return base;
}

// Find all album directories
const albumDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^.+?\s*\(\d{4}\)$/.test(d.name));

console.log(`Found ${albumDirs.length} albums\n`);

let albumsCreated = 0;
let albumsUpdated = 0;
let wavConverted = 0;

// --- Step 1: convert .wav to .mp3 ---
//
// This MUST run before the album.json stem scan below. The scan globs for *.mp3,
// so if conversion ran afterwards, freshly converted stems would be invisible and
// their `stems` arrays would stay empty until a second run of this script.
//
// The .wav originals are KEPT. src/media/ is the permanent source of truth for
// masters — only the derived .mp3 files get uploaded to R2/Cloudflare. This script
// used to delete each .wav after a successful convert, which made the conversion
// lossy and irreversible; that is deliberately no longer the case. Do not
// reintroduce an unlink here.
const wavFiles = fastGlob.sync('**/*.wav', { cwd: mediaDir, absolute: true });

if (wavFiles.length > 0) {
    console.log(`Converting ${wavFiles.length} .wav files (originals are preserved)...`);
    for (const wavFile of wavFiles) {
        const mp3File = wavFile.replace(/\.wav$/i, '.mp3');

        if (fs.existsSync(mp3File)) {
            continue;
        }

        console.log(`  [converting] ${path.basename(wavFile)}`);
        try {
            execSync(`ffmpeg -i "${wavFile}" -c:a libmp3lame -b:a 320k "${mp3File}"`, {
                stdio: 'inherit',
            });
            wavConverted++;
        } catch (e) {
            console.error(`  [error] Failed to convert: ${wavFile}`);
            // Remove a partial/corrupt mp3 so the next run retries the convert
            // instead of treating the broken file as already done.
            if (fs.existsSync(mp3File)) fs.unlinkSync(mp3File);
        }
    }
    console.log(`  Converted ${wavConverted}, skipped ${wavFiles.length - wavConverted} (mp3 already existed)\n`);
}

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
            const fullPath = path.join(stemsBaseDir, stemFolder, sf);
            const fileSize = fs.statSync(fullPath).size;
            return {
                name: stemDisplayName(sf, track.name),
                file: sf,
                folder: stemFolder,
                fileSize,
            };
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

// Render waveform SVGs for every track and stem. Runs last, after wav->mp3
// conversion, so newly converted files get waveforms in the same pass.
// Skips files whose .svg is already newer than the mp3, so re-runs are cheap.
console.log(`\nGenerating waveform SVGs...`);
let waveformsRendered = 0;
try {
    execSync('node scripts/generate-waveforms.js', { stdio: 'inherit' });
    waveformsRendered = 1;
} catch (e) {
    console.error(`  [error] Waveform generation failed. Pages will fall back to`);
    console.error(`          decoding audio in the browser. Is ffmpeg on PATH?`);
}

console.log(`\nDone. Albums created: ${albumsCreated}, stems updated: ${albumsUpdated}, wavs converted: ${wavConverted}`);
if (!waveformsRendered) console.log(`Waveform generation did not complete — see the error above.`);
