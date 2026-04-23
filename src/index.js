"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const instagram_js_1 = require("./instagram.js");
const storage_js_1 = require("./storage.js");
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
// Load environment variables
dotenv.config();
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../downloads');
const TARGET_ACCOUNTS = [
    // Add a few test accounts
    'nogizaka46_tv',
    'shiori_k_official',
    'sakurazaka46'
];
async function main() {
    console.log('🚀 Starting Neo-based Instagram Fetcher...');
    console.log(`📂 Download Directory: ${DOWNLOAD_DIR}`);
    const fetcher = new instagram_js_1.InstagramFetcher();
    const storage = new storage_js_1.StorageManager(DOWNLOAD_DIR);
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
            // 2. Fetch Stories (Neo API context)
            const stories = await fetcher.getUserStories(userId);
            if (stories.length === 0) {
                continue;
            }
            // 3. Download Media
            for (const story of stories) {
                const mediaUrls = fetcher.extractMediaUrls(story);
                if (mediaUrls.length === 0) {
                    console.log(`⚠️ No extractable media for story ${story.id}`);
                    continue;
                }
                // Usually take the first (best quality)
                const media = mediaUrls[0];
                if (!media || !media.url || !media.type) {
                    console.log(`⚠️ Skipping story ${story.id} due to undefined media...`);
                    continue;
                }
                const ext = media.type === 'video' ? 'mp4' : 'jpg';
                const filename = `${username}_${story.taken_at}_${story.id}.${ext}`;
                if (storage.fileExists(filename)) {
                    console.log(`⏭️  Skipping existing file: ${filename}`);
                    continue;
                }
                console.log(`📥 Downloading ${media.type}: ${filename}`);
                await storage.downloadMedia(media.url, filename);
            }
        }
        catch (err) {
            console.error(`❌ Error processing @${username}:`, err.message);
            // Optionally: Implement UI fallback here if error indicates rate limit or auth loss
        }
    }
    console.log(`\n✅ Fetch cycle complete!`);
}
// Support being called directly or imported
if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error in main loop:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map