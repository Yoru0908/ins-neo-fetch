export declare class StorageManager {
    private readonly downloadDir;
    constructor(downloadDir?: string);
    private ensureDirExists;
    /**
     * Downloads a media file to the local disk.
     */
    downloadMedia(url: string, filename: string): Promise<string>;
    /**
     * Checks if a file already exists (to avoid duplicate downloads).
     */
    fileExists(filename: string): boolean;
}
//# sourceMappingURL=storage.d.ts.map