export declare class NeoClient {
    private readonly targetDomain;
    constructor(targetDomain: string);
    /**
     * Executes a raw Neo command.
     */
    executeCommand(command: string): Promise<string>;
    /**
     * Executes an API call using `neo exec` within the browser context.
     * @param url The full URL to fetch
     * @param method HTTP Method
     * @param body Optional request body
     */
    execApi(url: string, method?: string, body?: any): Promise<any>;
    /**
     * Finds active tabs.
     */
    getTabs(): Promise<string>;
    /**
     * UI Automation: Take a snapshot of the current page's a11y tree.
     */
    snapshot(): Promise<string>;
    /**
     * UI Automation: Click an element by its a11y ref.
     */
    click(ref: string): Promise<void>;
}
//# sourceMappingURL=neoClient.d.ts.map