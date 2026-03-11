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

async function main() {
    console.log('🚀 Starting Neo-based Instagram Fetcher...');
    console.log(`📂 Download Directory: ${DOWNLOAD_DIR}`);

    const fetcher = new InstagramFetcher();
    const storage = new StorageManager(DOWNLOAD_DIR);
    const dedup = new DedupManager(DOWNLOAD_DIR);

    let totalNew = 0;
    let totalSkipped = 0;

    for (const username of TARGET_ACCOUNTS) {
        console.log(`\n----------------------------------------`);
        console.log(`🔍 Processing @${username}`);

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
                    console.log(`⊘ Dedup skip story: ${storyId}`);
                    totalSkipped++;
                    continue;
                }
                if (storage.fileExists(filename, subDir)) {
                    console.log(`⏭️  Skipping existing: ${subDir}/${filename}`);
                    totalSkipped++;
                    continue;
                }

                console.log(`📥 Downloading story: ${subDir}/${filename}`);
                const filePath = await storage.downloadMedia(media.url, filename, subDir);
                const fileSize = require('fs').statSync(filePath).size;
                dedup.addContent(username, storyId, 'story', media.type, filename, story.taken_at || 0, fileSize);
                totalNew++;
            }

            // 3. Fetch Posts
            const posts = await fetcher.getUserPosts(userId);

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
                        console.log(`⊘ Dedup skip post: ${pm.id}`);
                        totalSkipped++;
                        continue;
                    }
                    if (storage.fileExists(filename, subDir)) {
                        console.log(`⏭️  Skipping existing: ${subDir}/${filename}`);
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

        } catch (err: any) {
            console.error(`❌ Error processing @${username}:`, err.message);
            // Optionally: Implement UI fallback here if error indicates rate limit or auth loss
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
