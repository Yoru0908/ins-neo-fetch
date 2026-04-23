import { InstagramFetcher } from './instagram.js';
import { StorageManager } from './storage.js';
import { DedupManager } from './dedup.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../downloads');
const TARGET_ACCOUNTS = (process.env.TARGET_ACCOUNTS || 'hinatazaka46,nogizaka46,sakurazaka46')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
const BACKFILL_MODE = process.argv.includes('--backfill');
const FAST_MODE = process.argv.includes('--fast');
const CDP_PORTS = (process.env.CDP_PORTS || '9222')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(p => !isNaN(p));

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
}

function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function main() {
    console.log('🚀 Starting Neo-based Instagram Fetcher...');
    console.log(`📂 Download Directory: ${DOWNLOAD_DIR}`);

    const fetcher = new InstagramFetcher();
    const storage = new StorageManager(DOWNLOAD_DIR);
    const dedup = new DedupManager(DOWNLOAD_DIR);

    // --fast: local runs use short fixed delay, no shuffle
    // default (cron): shuffle + random long delay to avoid detection
    const accounts = FAST_MODE ? TARGET_ACCOUNTS : shuffle(TARGET_ACCOUNTS);
    if (!FAST_MODE) console.log(`🔀 Shuffled ${accounts.length} accounts`);
    else console.log(`⚡ Fast mode: ${accounts.length} accounts, 20-35s random delay`);

    let totalNew = 0;
    let totalSkipped = 0;
    let consecutive429 = 0;
    const DELAY_MIN = FAST_MODE ? 20_000 : 60_000;
    const DELAY_MAX = FAST_MODE ? 35_000 : 150_000;
    const MAX_CONSECUTIVE_429 = 3;    // abort after 3 consecutive 429s

    for (let i = 0; i < accounts.length; i++) {
        const username = accounts[i]!;

        // On persistent 429, try switching to backup account
        if (consecutive429 >= MAX_CONSECUTIVE_429) {
            const currentIdx = CDP_PORTS.indexOf(fetcher.currentPort);
            const nextIdx = (currentIdx + 1) % CDP_PORTS.length;
            if (nextIdx !== currentIdx && CDP_PORTS[nextIdx]) {
                console.log(`\n🔄 Switching to backup session (CDP port ${CDP_PORTS[nextIdx]})...`);
                const switched = await fetcher.switchSession(CDP_PORTS[nextIdx]!);
                if (switched) {
                    console.log(`✅ Switched to port ${CDP_PORTS[nextIdx]}. Resetting 429 counter.`);
                    consecutive429 = 0;
                    // Re-process the current account with the new session
                    i--;
                    continue;
                } else {
                    console.log(`❌ Failed to switch session. Aborting.`);
                    break;
                }
            } else {
                console.log(`\n⛔ Aborting: ${consecutive429} consecutive 429 errors on all sessions.`);
                break;
            }
        }

        // Random delay between accounts (skip for the first one)
        if (i > 0) {
            const delay = fetcher.rateLimited ? (FAST_MODE ? 30_000 : randomDelay(120_000, 300_000)) : randomDelay(DELAY_MIN, DELAY_MAX);
            console.log(`⏳ Waiting ${Math.round(delay / 1000)}s before next account...`);
            await new Promise(r => setTimeout(r, delay));
        }

        console.log(`\n----------------------------------------`);
        console.log(`🔍 Processing @${username} (${i + 1}/${accounts.length})`);

        try {
            // 1. Get User ID (Neo API context)
            const userId = await fetcher.getUserId(username);
            if (!userId) {
                console.log(`⚠️ Skipping @${username} (Cannot resolve ID)`);
                continue;
            }

            // 2. Fetch Stories
            const stories = await fetcher.getUserStories(userId);

            for (const story of stories) {
                const mediaUrls = fetcher.extractMediaUrls(story);
                if (mediaUrls.length === 0) continue;

                const media = mediaUrls[0];
                if (!media || !media.url || !media.type) continue;

                const ext = media.type === 'video' ? 'mp4' : 'jpg';
                const filename = `story_${story.id}.${ext}`;
                const takenDate = new Date((story.taken_at || 0) * 1000);
                const dateStr = takenDate.toISOString().slice(0, 10).replace(/-/g, '');
                const subDir = `${username}/stories/${dateStr}`;

                const storyId = String(story.id);
                if (dedup.contentExists(username, storyId, 'story')) {
                    totalSkipped++;
                    continue;
                }
                if (storage.fileExists(filename, subDir)) {
                    // Backfill: file exists but no dedup record - add publish time
                    const existPath = path.join(DOWNLOAD_DIR, subDir, filename);
                    const existSize = require('fs').statSync(existPath).size;
                    dedup.addContent(username, storyId, 'story', media.type, filename, story.taken_at || 0, existSize);
                    console.log(`📝 Backfill story: ${storyId}`);
                    totalSkipped++;
                    continue;
                }

                console.log(`📥 Downloading story: ${subDir}/${filename}`);
                const filePath = await storage.downloadMedia(media.url, filename, subDir);
                const fileSize = require('fs').statSync(filePath).size;
                dedup.addContent(username, storyId, 'story', media.type, filename, story.taken_at || 0, fileSize);
                totalNew++;
            }

            // 3. Fetch Posts (force max50 for all accounts with dedup check)
            const isKnown = (postId: string) => dedup.contentExists(username, postId, 'post');
            const maxPosts = BACKFILL_MODE ? 9999 : 50;
            if (BACKFILL_MODE) {
                console.log(`🔄 Backfill mode: full fetch (max ${maxPosts})`);
            }
            const posts = await fetcher.getUserPosts(userId, maxPosts, BACKFILL_MODE ? undefined : isKnown);

            for (const post of posts) {
                const postMedia = fetcher.extractPostMedia(post);
                const postCode = post.code || '';

                for (const pm of postMedia) {
                    const ext = pm.type === 'video' ? 'mp4' : 'jpg';
                    const filename = `posts_${postCode}_${pm.id}.${ext}`;
                    const takenDate = new Date(pm.taken_at * 1000);
                    const dateStr = takenDate.toISOString().slice(0, 10).replace(/-/g, '');
                    const subDir = `${username}/posts/${dateStr}`;

                    if (dedup.contentExists(username, pm.id, 'post')) {
                        totalSkipped++;
                        continue;
                    }
                    if (storage.fileExists(filename, subDir)) {
                        // Backfill: file exists but no dedup record - add publish time
                        const existPath = path.join(DOWNLOAD_DIR, subDir, filename);
                        const existSize = require('fs').statSync(existPath).size;
                        dedup.addContent(username, pm.id, 'post', pm.type, filename, pm.taken_at, existSize);
                        console.log(`📝 Backfill post: ${pm.id}`);
                        totalSkipped++;
                        continue;
                    }

                    console.log(`📥 Downloading post: ${subDir}/${filename}`);
                    try {
                        const filePath = await storage.downloadMedia(pm.url, filename, subDir);
                        const fileSize = require('fs').statSync(filePath).size;
                        dedup.addContent(username, pm.id, 'post', pm.type, filename, pm.taken_at, fileSize);
                        totalNew++;
                    } catch (dlErr: any) {
                        console.error(`⚠️ Failed to download post ${pm.id}: ${dlErr.message}`);
                    }
                }
            }

            // Reset 429 counter on success
            consecutive429 = 0;

        } catch (err: any) {
            console.error(`❌ Error processing @${username}:`, err.message);
            if (err.message?.includes('429')) {
                consecutive429++;
                console.log(`⚠️ 429 count: ${consecutive429}/${MAX_CONSECUTIVE_429}`);
            }
        }
    }

    const stats = dedup.getStats();
    console.log(`\n✅ Fetch cycle complete!`);
    console.log(`📊 This run: ${totalNew} new, ${totalSkipped} skipped`);
    console.log(`📊 Total in DB: ${stats.total} records across ${stats.accounts} accounts`);
}

// Support being called directly or imported
if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error in main loop:', err);
        process.exit(1);
    });
}
