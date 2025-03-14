declare module 'ws' {
  export default class WebSocket {
    constructor(address: string, options?: any);
    on(event: string, listener: (...args: any[]) => void): this;
    send(data: any, callback?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(data?: any, mask?: boolean, callback?: (err: Error) => void): void;
    pong(data?: any, mask?: boolean, callback?: (err: Error) => void): void;
    readyState: number;
  }
} 