"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeoClient = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class NeoClient {
    targetDomain;
    constructor(targetDomain) {
        this.targetDomain = targetDomain;
    }
    /**
     * Executes a raw Neo command.
     */
    async executeCommand(command) {
        try {
            console.log(`[Neo] Executing: neo ${command}`);
            // Use --json output for programmatic consumption if supported, else parse stdout
            const { stdout, stderr } = await execAsync(`neo ${command}`);
            if (stderr && !stderr.includes('Debugger attached')) {
                // Some CDP logs go to stderr, we only warn on actual errors
                console.warn(`[Neo] Stderr:`, stderr);
            }
            return stdout.trim();
        }
        catch (error) {
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
    async execApi(url, method = 'GET', body) {
        let cmd = `exec "${url}" --method ${method} --tab ${this.targetDomain} --auto-headers`;
        if (body) {
            const bodyStr = JSON.stringify(body).replace(/'/g, "'\\''"); // Escape single quotes for bash
            cmd += ` --body '${bodyStr}'`;
        }
        const output = await this.executeCommand(cmd);
        try {
            // Attempt to parse JSON response
            return JSON.parse(output);
        }
        catch (e) {
            // If it's not JSON, return the raw string
            return output;
        }
    }
    /**
     * Finds active tabs.
     */
    async getTabs() {
        return this.executeCommand('tabs');
    }
    /**
     * UI Automation: Take a snapshot of the current page's a11y tree.
     */
    async snapshot() {
        return this.executeCommand('snapshot');
    }
    /**
     * UI Automation: Click an element by its a11y ref.
     */
    async click(ref) {
        await this.executeCommand(`click ${ref}`);
    }
}
exports.NeoClient = NeoClient;
//# sourceMappingURL=neoClient.js.map