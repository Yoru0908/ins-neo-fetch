/**
 * Targeted carousel repair script.
 * Finds posts with only _0 file (missing _1, _2, ...) and re-fetches
 * full carousel data via /media/{id}/info/ API.
 */
import { InstagramFetcher } from './instagram.js';
import { StorageManager } from './storage.js';
import { DedupManager } from './dedup.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../downloads');

function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Scan download dir for carousel posts that only have _0 (missing _1+).
 * Returns array of { username, subDir, filenamePrefix, mediaId, filePath }
 */
function findIncompleteCarousels(baseDir: string): {
    username: string;
    dateStr: string;
    code: string;
    mediaId: string;
    filePath: string;
}[] {
    const results: any[] = [];

    function scanDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(full);
                continue;
            }
            if (!entry.name.startsWith('posts_')) continue;

            // Check if filename ends with _0.jpg or _0.mp4
            const match = entry.name.match(/^(posts_.+)_0\.(jpg|mp4)$/);
            if (!match) continue;

            const prefix = match[1]; // e.g., posts_DWBMCIWgDcx_3855415678970378033
            const ext = match[2];

            // Check if _1 exists (either .jpg or .mp4)
            const has1 = fs.existsSync(path.join(dir, `${prefix}_1.jpg`)) ||
                         fs.existsSync(path.join(dir, `${prefix}_1.mp4`));
            if (has1) continue; // Already complete

            // Extract info from path: baseDir/username/posts/dateStr/filename
            const rel = path.relative(baseDir, dir);
            const parts = rel.split(path.sep);
            if (parts.length < 3) continue;
            const username = parts[0]!;
            const dateStr = parts[2]!;

            // Extract code and mediaId from prefix: posts_{code}_{mediaId}
            const prefixParts = prefix!.replace('posts_', '').split('_');
            const mediaId = prefixParts[prefixParts.length - 1]!;
            const code = prefixParts.slice(0, -1).join('_');

            results.push({ username, dateStr, code, mediaId, filePath: full });
        }
    }

    scanDir(baseDir);
    return results;
}

async function main() {
    console.log('🔧 Carousel Repair Script');
    console.log(`📂 Scanning: ${DOWNLOAD_DIR}\n`);

    const fetcher = new InstagramFetcher();
    const storage = new StorageManager(DOWNLOAD_DIR);
    const dedup = new DedupManager(DOWNLOAD_DIR);

    const incomplete = findIncompleteCarousels(DOWNLOAD_DIR);
    console.log(`Found ${incomplete.length} incomplete carousel posts\n`);

    if (incomplete.length === 0) {
        console.log('✅ No incomplete carousels found!');
        return;
    }

    let totalDownloaded = 0;
    let totalFailed = 0;

    for (let i = 0; i < incomplete.length; i++) {
        const item = incomplete[i]!;
        console.log(`\n[${i + 1}/${incomplete.length}] @${item.username} / ${item.code} (${item.mediaId})`);

        try {
            // Query full media info
            const mediaInfo = await (fetcher as any).executeInPage(
                `https://www.instagram.com/api/v1/media/${item.mediaId}/info/`, 'GET'
            );

            if (!mediaInfo || !mediaInfo.items || mediaInfo.items.length === 0) {
                console.log(`  ⚠️ No media info returned, skipping`);
                totalFailed++;
                continue;
            }

            const post = mediaInfo.items[0];
            const postMedia = fetcher.extractPostMedia(post);

            if (postMedia.length <= 1) {
                console.log(`  ℹ️ Single image post (not a carousel), skipping`);
                continue;
            }

            console.log(`  📦 Carousel has ${postMedia.length} items`);

            let downloaded = 0;
            for (const pm of postMedia) {
                const ext = pm.type === 'video' ? 'mp4' : 'jpg';
                const filename = `posts_${item.code}_${pm.id}.${ext}`;
                const subDir = `${item.username}/posts/${item.dateStr}`;

                // Skip if already exists
                if (dedup.contentExists(item.username, pm.id, 'post')) {
                    continue;
                }

                if (storage.fileExists(filename, subDir)) {
                    // Backfill dedup record
                    const existPath = path.join(DOWNLOAD_DIR, subDir, filename);
                    const existSize = fs.statSync(existPath).size;
                    dedup.addContent(item.username, pm.id, 'post', pm.type, filename, pm.taken_at, existSize);
                    console.log(`  📝 Backfill: ${pm.id}`);
                    continue;
                }

                console.log(`  📥 Downloading: ${filename}`);
                try {
                    const filePath = await storage.downloadMedia(pm.url, filename, subDir);
                    const fileSize = fs.statSync(filePath).size;
                    dedup.addContent(item.username, pm.id, 'post', pm.type, filename, pm.taken_at, fileSize);
                    downloaded++;
                } catch (dlErr: any) {
                    console.error(`  ❌ Download failed: ${dlErr.message}`);
                }
            }

            totalDownloaded += downloaded;
            console.log(`  ✅ Downloaded ${downloaded} new items`);

        } catch (err: any) {
            console.error(`  ❌ Error: ${err.message}`);
            totalFailed++;
        }

        // Random delay between API calls (2-3s, individual lookups are lightweight)
        if (i < incomplete.length - 1) {
            const delay = randomDelay(2000, 3000);
            console.log(`  ⏳ Waiting ${Math.round(delay / 1000)}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    console.log(`\n🏁 Repair complete!`);
    console.log(`📊 Downloaded: ${totalDownloaded} new items`);
    console.log(`⚠️ Failed: ${totalFailed} posts`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
