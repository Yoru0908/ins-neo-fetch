/**
 * Repair carousel posts from a list file (generated on Homeserver).
 * Downloads missing carousel items to a temp directory for scp back.
 * 
 * Usage: node dist/repair-from-list.js <list-file> <output-dir>
 * List format: username|code|mediaId|dateStr (one per line)
 */
import { InstagramFetcher } from './instagram.js';
import { StorageManager } from './storage.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function main() {
    const listFile = process.argv[2];
    const outputDir = process.argv[3] || '/tmp/carousel-repair-output';

    if (!listFile) {
        console.error('Usage: node dist/repair-from-list.js <list-file> [output-dir]');
        process.exit(1);
    }

    const lines = fs.readFileSync(listFile, 'utf8').trim().split('\n').filter(l => l.length > 0);
    console.log(`🔧 Carousel Repair from List`);
    console.log(`📋 Input: ${lines.length} posts from ${listFile}`);
    console.log(`📂 Output: ${outputDir}\n`);

    fs.mkdirSync(outputDir, { recursive: true });

    const fetcher = new InstagramFetcher();
    const storage = new StorageManager(outputDir);

    let totalDownloaded = 0;
    let totalFailed = 0;
    let totalSingleImage = 0;

    for (let i = 0; i < lines.length; i++) {
        const [username, code, mediaId, dateStr] = lines[i]!.split('|');
        if (!username || !code || !mediaId || !dateStr) {
            console.log(`  ⚠️ Skipping malformed line: ${lines[i]}`);
            continue;
        }

        // Progress every 100
        if (i > 0 && i % 100 === 0) {
            console.log(`\n📊 Progress: ${i}/${lines.length} | Downloaded: ${totalDownloaded} | Failed: ${totalFailed} | Single: ${totalSingleImage}\n`);
        }

        process.stdout.write(`[${i + 1}/${lines.length}] @${username}/${code} `);

        try {
            const mediaInfo = await (fetcher as any).executeInPage(
                `https://www.instagram.com/api/v1/media/${mediaId}/info/`, 'GET'
            );

            if (!mediaInfo || !mediaInfo.items || mediaInfo.items.length === 0) {
                console.log(`⚠️ no data`);
                totalFailed++;
                continue;
            }

            const post = mediaInfo.items[0];
            const postMedia = fetcher.extractPostMedia(post);

            if (postMedia.length <= 1) {
                console.log(`ℹ️ single (${postMedia.length})`);
                totalSingleImage++;
                continue;
            }

            let downloaded = 0;
            for (const pm of postMedia) {
                // Skip _0 (already exists on server)
                if (pm.id.endsWith('_0')) continue;

                const ext = pm.type === 'video' ? 'mp4' : 'jpg';
                const filename = `posts_${code}_${pm.id}.${ext}`;
                const subDir = `${username}/posts/${dateStr}`;

                // Skip if already downloaded in this session
                const outPath = path.join(outputDir, subDir, filename);
                if (fs.existsSync(outPath)) continue;

                try {
                    await storage.downloadMedia(pm.url, filename, subDir);
                    downloaded++;
                } catch (dlErr: any) {
                    console.error(`❌ dl fail: ${pm.id}`);
                }
            }

            totalDownloaded += downloaded;
            console.log(`✅ +${downloaded} (total ${postMedia.length})`);

        } catch (err: any) {
            console.log(`❌ ${err.message.substring(0, 60)}`);
            totalFailed++;
        }

        // Delay 2-3s between API calls
        if (i < lines.length - 1) {
            await new Promise(r => setTimeout(r, randomDelay(2000, 3000)));
        }
    }

    console.log(`\n🏁 Repair complete!`);
    console.log(`📊 Downloaded: ${totalDownloaded} new carousel items`);
    console.log(`ℹ️ Single-image posts: ${totalSingleImage}`);
    console.log(`⚠️ Failed: ${totalFailed}`);
    console.log(`📂 Output dir: ${outputDir}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
