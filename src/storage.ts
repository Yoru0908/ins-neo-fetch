import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export class StorageManager {
    private readonly downloadDir: string;

    constructor(downloadDir: string = '/vol1/downloads/instagram/') {
        this.downloadDir = downloadDir;
        this.ensureDirExists(this.downloadDir);
    }

    private ensureDirExists(dirPath: string) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Downloads a media file to the local disk.
     * Supports subdirectory structure: username/contentType/filename
     */
    async downloadMedia(url: string, filename: string, subDir?: string): Promise<string> {
        const targetDir = subDir ? path.join(this.downloadDir, subDir) : this.downloadDir;
        this.ensureDirExists(targetDir);
        const filePath = path.join(targetDir, filename);

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(filePath);

            https.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
                    return;
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    console.log(`[Storage] Downloaded: ${filePath}`);
                    resolve(filePath);
                });
            }).on('error', (err) => {
                fs.unlink(filePath, () => { }); // Delete partial file
                reject(err);
            });
        });
    }

    /**
     * Checks if a file already exists (to avoid duplicate downloads).
     */
    fileExists(filename: string, subDir?: string): boolean {
        const targetDir = subDir ? path.join(this.downloadDir, subDir) : this.downloadDir;
        return fs.existsSync(path.join(targetDir, filename));
    }
}
