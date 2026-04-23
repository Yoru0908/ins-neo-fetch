export declare class InstagramFetcher {
    private neo;
    constructor();
    /**
     * Fetches user info (including ID) by username.
     * Note: We use Instagram's native search/info endpoints.
     */
    getUserId(username: string): Promise<string | null>;
    /**
     * Fetches active stories for a given user ID.
     */
    getUserStories(userId: string): Promise<any[]>;
    /**
     * Extracts high-quality media URLs from a story item.
     */
    extractMediaUrls(storyItem: any): {
        url: string;
        type: 'video' | 'image';
    }[];
}
//# sourceMappingURL=instagram.d.ts.map