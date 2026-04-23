import { NeoClient } from './neoClient.js';
import * as fs from 'fs';
import * as path from 'path';

export class InstagramFetcher {
    private neo: NeoClient;
    private _rateLimited = false;

    /** True if the last request hit 429. Callers can check this to abort early. */
    get rateLimited() { return this._rateLimited; }

    constructor() {
        // Target domain for Neo to find the right tab
        this.neo = new NeoClient('instagram.com');
    }

    /** Switch to a different CDP session (for dual-account 429 fallback) */
    async switchSession(port: number): Promise<boolean> {
        const ok = await this.neo.switchSession(port);
        if (ok) this._rateLimited = false;
        return ok;
    }

    get currentPort() { return this.neo.port; }

    /**
     * Executes an API call directly in the page using `neo eval` to bypass CLI header parsing errors
     */
    private async executeInPage(url: string, method: string = 'GET', maxRetries: number = 3): Promise<any> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const script = `
            (async function() {
                try {
                    const res = await fetch("${url}", { 
                        method: "${method}",
                        headers: {
                            "accept": "*/*",
                            "x-ig-app-id": "936619743392459",
                            "x-asbd-id": "198387",
                            "x-csrftoken": (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || ''
                        }
                    });
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return JSON.stringify(await res.json());
                } catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            })()
            `;

            // Escape script for CLI
            const escapedScript = script.replace(/"/g, '\\"').replace(/\n/g, ' ');
            const output = await this.neo.executeCommand(`eval "${escapedScript}" --tab instagram.com`);

            try {
                let parsed: any;
                try {
                    parsed = JSON.parse(output);
                } catch {
                    const lines = output.split('\n');
                    const resultStr = lines[lines.length - 1];
                    if (!resultStr) throw new Error("Eval returned empty or invalid string");
                    parsed = JSON.parse(resultStr);
                }
                if (parsed.error) {
                    // Detect 429 rate limit and retry with exponential backoff
                    if (parsed.error.includes('429')) {
                        this._rateLimited = true;
                        if (attempt < maxRetries) {
                            const waitSec = Math.pow(2, attempt + 1) * 15; // 30s, 60s, 120s
                            console.log(`[IG] Rate limited (429), waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`);
                            await new Promise(r => setTimeout(r, waitSec * 1000));
                            continue;
                        }
                    }
                    throw new Error(parsed.error);
                }
                this._rateLimited = false;
                return parsed;
            } catch (e) {
                if (attempt < maxRetries && (e as Error).message?.includes('429')) {
                    continue; // already handled above, but safety net
                }
                console.error('[IG] Failed to parse eval output:', output.substring(0, 200));
                throw e;
            }
        }
    }

    /**
     * Fetches user info (including ID) by username.
     * Note: We use Instagram's native search/info endpoints.
     */
    async getUserId(username: string): Promise<string | null> {
        console.log(`[IG] Resolving user ID for @${username}...`);
        try {
            // Example endpoint. In reality, we'd use the GraphQL query hash or the ?__a=1 trick
            // e.g., https://www.instagram.com/api/v1/users/web_profile_info/?username={username}
            const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
            const response = await this.executeInPage(url, 'GET');

            if (response && response.data && response.data.user) {
                return response.data.user.id;
            }

            console.error(`[IG] Could not find ID for ${username}`);
            return null;
        } catch (err) {
            console.error(`[IG] Failed to get user ID for ${username}`, err);
            return null;
        }
    }

    /**
     * Fetches active stories for a given user ID.
     */
    async getUserStories(userId: string): Promise<any[]> {
        console.log(`[IG] Fetching stories for user ID ${userId}...`);

        // This is the standard Instagram GraphQL query for stories.
        // We use neo exec to fire it from the browser.
        const variables = {
            "reel_ids": [userId],
            "location_ids": [],
            "precomposed_overlay": false
        };

        // Better yet, use the REST-like endpoint which is often easier if GraphQL hashes rotate:
        // https://www.instagram.com/api/v1/feed/reels_media/?reel_ids={userId}
        const restUrl = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;

        try {
            const response = await this.executeInPage(restUrl, 'GET');

            if (response && response.reels && response.reels[userId]) {
                const items = response.reels[userId].items || [];
                console.log(`[IG] Found ${items.length} stories for user ${userId}`);
                return items;
            }

            console.log(`[IG] No active stories found for user ${userId}`);
            return [];
        } catch (err) {
            console.error(`[IG] Failed to fetch stories for ${userId}`, err);
            return [];
        }
    }

    /**
     * Extracts high-quality media URLs from a story item.
     */
    extractMediaUrls(storyItem: any): { url: string, type: 'video' | 'image' }[] {
        const media: { url: string, type: 'video' | 'image' }[] = [];

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

    /**
     * Fetches recent posts for a given user ID.
     * Uses pagination to get up to maxPosts items.
     * If isKnown callback is provided, stops pagination early when
     * all posts in a page are already known (early termination optimization).
     */
    async getUserPosts(userId: string, maxPosts: number = 50, isKnown?: (postId: string) => boolean): Promise<any[]> {
        console.log(`[IG] Fetching posts for user ID ${userId} (max ${maxPosts})...`);
        const allItems: any[] = [];
        let maxId: string | null = null;
        let pagesLoaded = 0;

        try {
            while (allItems.length < maxPosts) {
                let url = `https://www.instagram.com/api/v1/feed/user/${userId}/?count=50`;
                if (maxId) url += `&max_id=${maxId}`;

                const response = await this.executeInPage(url, 'GET');

                if (!response || !response.items || response.items.length === 0) {
                    break;
                }

                pagesLoaded++;
                allItems.push(...response.items);

                // Early termination: if the first 5 posts are already known,
                // older posts will also be known (posts are in reverse chronological order)
                if (isKnown && response.items.length > 0) {
                    const checkCount = Math.min(5, response.items.length);
                    const firstNKnown = response.items.slice(0, checkCount).every((item: any) => {
                        const rawId = String(item.id || '');
                        const postId = rawId.includes('_') ? rawId.split('_')[0]! : rawId;
                        return isKnown(postId);
                    });
                    if (firstNKnown) {
                        console.log(`[IG] Early stop: first ${checkCount} posts all known, skipping remaining`);
                        break;
                    }
                }

                if (!response.more_available || !response.next_max_id) {
                    break;
                }
                maxId = response.next_max_id;

                // Small delay between pagination requests
                await new Promise(r => setTimeout(r, 500));
            }

            console.log(`[IG] Found ${allItems.length} posts for user ${userId} (${pagesLoaded} pages)`);
            return allItems.slice(0, maxPosts);
        } catch (err) {
            console.error(`[IG] Failed to fetch posts for ${userId}`, err);
            return allItems; // Return what we have so far
        }
    }

    /**
     * Extracts media items from a post (handles carousel/single posts).
     * Returns array of { id, url, type, taken_at } for each media item.
     */
    extractPostMedia(post: any): { id: string, url: string, type: 'video' | 'image', taken_at: number }[] {
        const results: { id: string, url: string, type: 'video' | 'image', taken_at: number }[] = [];
        const rawId = String(post.id || 'unknown');
        const postId = rawId.includes('_') ? rawId.split('_')[0]! : rawId;
        const takenAt = post.taken_at || 0;

        // Carousel post
        if (post.carousel_media && post.carousel_media.length > 0) {
            for (let i = 0; i < post.carousel_media.length; i++) {
                const item = post.carousel_media[i];
                const media = this._extractSingleMedia(item);
                if (media) {
                    results.push({ id: `${postId}_${i}`, url: media.url, type: media.type, taken_at: takenAt });
                }
            }
        } else {
            // Single media post
            const media = this._extractSingleMedia(post);
            if (media) {
                results.push({ id: postId, url: media.url, type: media.type, taken_at: takenAt });
            }
        }

        return results;
    }

    private _extractSingleMedia(item: any): { url: string, type: 'video' | 'image' } | null {
        if (item.video_versions && item.video_versions.length > 0) {
            return { url: item.video_versions[0].url, type: 'video' };
        } else if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length > 0) {
            return { url: item.image_versions2.candidates[0].url, type: 'image' };
        }
        return null;
    }
}
