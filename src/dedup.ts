import * as fs from 'fs';
import * as path from 'path';

interface ContentRecord {
    id: string;
    username: string;
    content_type: 'story' | 'post';
    media_type: 'video' | 'image';
    filename: string;
    date: string;
    downloaded_at: string;
    file_size: number;
}

interface DedupDatabase {
    version: string;
    created_at: string;
    updated_at: string;
    content: { [username: string]: ContentRecord[] };
    statistics: {
        total_content: number;
        stories_count: number;
        posts_count: number;
    };
}

export class DedupManager {
    private readonly dbPath: string;
    private db: DedupDatabase;

    constructor(dbDir: string) {
        this.dbPath = path.join(dbDir, 'dedup_database.json');
        this.db = this.loadDatabase();
    }

    private loadDatabase(): DedupDatabase {
        try {
            if (fs.existsSync(this.dbPath)) {
                const data = fs.readFileSync(this.dbPath, 'utf-8');
                const parsed = JSON.parse(data);
                console.log(`[Dedup] Database loaded: ${parsed.statistics.total_content} records`);
                return parsed;
            }
        } catch (err: any) {
            console.error(`[Dedup] Failed to load database: ${err.message}`);
        }
        return this.createNewDatabase();
    }

    private createNewDatabase(): DedupDatabase {
        console.log('[Dedup] Creating new database');
        return {
            version: '1.0',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            content: {},
            statistics: {
                total_content: 0,
                stories_count: 0,
                posts_count: 0
            }
        };
    }

    private saveDatabase(): void {
        try {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), 'utf-8');
        } catch (err: any) {
            console.error(`[Dedup] Failed to save database: ${err.message}`);
        }
    }

    /**
     * Check if content already exists (dedup check).
     * Uses content_id + username + content_type as unique key.
     */
    contentExists(username: string, contentId: string, contentType: string): boolean {
        if (!this.db.content[username]) {
            return false;
        }
        // Normalize ID: strip user ID suffix (e.g., "3849799_10860886596" → "3849799")
        const normalizedId = contentId.includes('_') ? contentId.split('_')[0] : contentId;

        return this.db.content[username].some(
            record => record.id === normalizedId && record.content_type === contentType
        );
    }

    /**
     * Add a content record after successful download.
     */
    addContent(
        username: string,
        contentId: string,
        contentType: 'story' | 'post',
        mediaType: 'video' | 'image',
        filename: string,
        takenAt: number,
        fileSize: number
    ): void {
        if (!this.db.content[username]) {
            this.db.content[username] = [];
        }

        const normalizedId: string = contentId.includes('_') ? contentId.split('_')[0]! : contentId;

        const record: ContentRecord = {
            id: normalizedId,
            username,
            content_type: contentType,
            media_type: mediaType,
            filename,
            date: new Date(takenAt * 1000).toISOString(),
            downloaded_at: new Date().toISOString(),
            file_size: fileSize
        };

        this.db.content[username].push(record);
        this.db.statistics.total_content++;
        if (contentType === 'story') {
            this.db.statistics.stories_count++;
        } else {
            this.db.statistics.posts_count++;
        }
        this.db.updated_at = new Date().toISOString();

        this.saveDatabase();
    }

    /**
     * Get statistics summary.
     */
    getStats(): { total: number; stories: number; posts: number; accounts: number } {
        return {
            total: this.db.statistics.total_content,
            stories: this.db.statistics.stories_count,
            posts: this.db.statistics.posts_count,
            accounts: Object.keys(this.db.content).length
        };
    }
}
