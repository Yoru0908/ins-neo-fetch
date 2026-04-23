"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstagramFetcher = void 0;
const neoClient_js_1 = require("./neoClient.js");
class InstagramFetcher {
    neo;
    constructor() {
        // Target domain for Neo to find the right tab
        this.neo = new neoClient_js_1.NeoClient('instagram.com');
    }
    /**
     * Fetches user info (including ID) by username.
     * Note: We use Instagram's native search/info endpoints.
     */
    async getUserId(username) {
        console.log(`[IG] Resolving user ID for @${username}...`);
        try {
            // Example endpoint. In reality, we'd use the GraphQL query hash or the ?__a=1 trick
            // e.g., https://www.instagram.com/api/v1/users/web_profile_info/?username={username}
            const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
            const response = await this.neo.execApi(url, 'GET');
            if (response && response.data && response.data.user) {
                return response.data.user.id;
            }
            console.error(`[IG] Could not find ID for ${username}`);
            return null;
        }
        catch (err) {
            console.error(`[IG] Failed to get user ID for ${username}`, err);
            return null;
        }
    }
    /**
     * Fetches active stories for a given user ID.
     */
    async getUserStories(userId) {
        console.log(`[IG] Fetching stories for user ID ${userId}...`);
        // This is the standard Instagram GraphQL query for stories.
        // We use neo exec to fire it from the browser.
        const variables = {
            "reel_ids": [userId],
            "location_ids": [],
            "precomposed_overlay": false
        };
        const encodedVariables = encodeURIComponent(JSON.stringify(variables));
        // Note: The query_hash might change over time, but usually the v1/feed/reels_media API is stable
        const url = `https://www.instagram.com/graphql/query/?query_hash=x&variables=${encodedVariables}`;
        // Better yet, use the REST-like endpoint which is often easier if GraphQL hashes rotate:
        // https://www.instagram.com/api/v1/feed/reels_media/?reel_ids={userId}
        const restUrl = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
        try {
            const response = await this.neo.execApi(restUrl, 'GET');
            if (response && response.reels && response.reels[userId]) {
                const items = response.reels[userId].items || [];
                console.log(`[IG] Found ${items.length} stories for user ${userId}`);
                return items;
            }
            console.log(`[IG] No active stories found for user ${userId}`);
            return [];
        }
        catch (err) {
            console.error(`[IG] Failed to fetch stories for ${userId}`, err);
            return [];
        }
    }
    /**
     * Extracts high-quality media URLs from a story item.
     */
    extractMediaUrls(storyItem) {
        const media = [];
        // Check for video versions first
        if (storyItem.video_versions && storyItem.video_versions.length > 0) {
            // Usually the first one is the highest quality
            media.push({ url: storyItem.video_versions[0].url, type: 'video' });
        }
        // Fallback to image versions
        else if (storyItem.image_versions2 && storyItem.image_versions2.candidates) {
            const candidates = storyItem.image_versions2.candidates;
            if (candidates.length > 0) {
                media.push({ url: candidates[0].url, type: 'image' });
            }
        }
        return media;
    }
}
exports.InstagramFetcher = InstagramFetcher;
//# sourceMappingURL=instagram.js.map