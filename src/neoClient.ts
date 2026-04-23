import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class NeoClient {
    private readonly targetDomain: string;
    private currentPort: number = 9222;

    constructor(targetDomain: string) {
        this.targetDomain = targetDomain;
    }

    /** Switch Neo session to a different CDP port (for dual-account support) */
    async switchSession(port: number): Promise<boolean> {
        try {
            console.log(`[Neo] Switching to CDP port ${port}...`);
            const { stdout } = await execAsync(`neo connect ${port}`);
            this.currentPort = port;
            console.log(`[Neo] Connected to port ${port}: ${stdout.trim()}`);
            return true;
        } catch (e: any) {
            console.error(`[Neo] Failed to switch to port ${port}:`, e.message);
            return false;
        }
    }

    get port() { return this.currentPort; }

    /**
     * Executes a raw Neo command.
     */
    async executeCommand(command: string): Promise<string> {
        try {
            console.log(`[Neo] Executing: neo ${command}`);
            // Use --json output for programmatic consumption if supported, else parse stdout
            const { stdout, stderr } = await execAsync(`neo ${command}`);
            if (stderr && !stderr.includes('Debugger attached')) {
                // Some CDP logs go to stderr, we only warn on actual errors
                console.warn(`[Neo] Stderr:`, stderr);
            }
            return stdout.trim();
        } catch (error: any) {
            console.error(`[Neo] Command failed: neo ${command}`);
            console.error(error.message);
            throw error;
        }
    }

    /**
     * Executes an API call using `neo exec` within the browser context.
     * @param url The full URL to fetch
     * @param method HTTP Method
     * @param body Optional request body
     */
    async execApi(url: string, method: string = 'GET', body?: any): Promise<any> {
        let cmd = `exec "${url}" --method ${method} --tab ${this.targetDomain} --auto-headers`;

        if (body) {
            const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''"); // Escape single quotes for bash
            cmd += ` --body '${bodyStr}'`;
        }

        const output = await this.executeCommand(cmd);

        try {
            // Attempt to parse JSON response
            return JSON.parse(output);
        } catch (e) {
            // If it's not JSON, return the raw string
            return output;
        }
    }

    /**
     * Finds active tabs.
     */
    async getTabs(): Promise<string> {
        return this.executeCommand('tabs');
    }

    /**
     * UI Automation: Take a snapshot of the current page's a11y tree.
     */
    async snapshot(): Promise<string> {
        return this.executeCommand('snapshot');
    }

    /**
     * UI Automation: Click an element by its a11y ref.
     */
    async click(ref: string): Promise<void> {
        await this.executeCommand(`click ${ref}`);
    }
}
