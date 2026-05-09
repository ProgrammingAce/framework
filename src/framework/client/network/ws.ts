import type { ClientMessage, ServerMessage } from '../../shared/types';

type MessageHandler = (msg: ServerMessage) => void;

export class GameWebSocket {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private handlers: MessageHandler[] = [];
  private primaryUrl: string;
  private reconnectDelay = 1000;
  private fallbackUsed = false;

  constructor(url?: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (url) {
      this.primaryUrl = url;
    } else {
      const meta = document.querySelector('meta[name="cinematic-bazaar-ws"]');
      const metaUrl = meta?.getAttribute('content');
      this.primaryUrl = metaUrl ?? `${proto}://${location.host}/ws`;
    }
  }

  connect(): void {
    const urlToTry = this.fallbackUsed ? 'ws://localhost:3000/ws' : this.primaryUrl;
    console.log(`[WebSocket] Attempting to connect to ${urlToTry}...`);
    this.ws = new WebSocket(urlToTry);

    this.ws.onopen = () => {
      console.log(`[WebSocket] Connected to ${urlToTry}`);
      this.reconnectDelay = 1000;
      this.fallbackUsed = false;
      for (const msg of this.queue) this.rawSend(msg);
      this.queue = [];
    };

    this.ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data); } catch { return; }
      for (const h of this.handlers) h(msg);
    };

    this.ws.onerror = () => {
      console.error(`[WebSocket] Connection error on ${urlToTry}`);
    };

    this.ws.onclose = (event) => {
      console.warn(`[WebSocket] Connection closed. Code: ${event.code}, Reason: ${event.reason || 'None'}`);

      if (!this.fallbackUsed && urlToTry !== 'ws://localhost:3000/ws') {
        console.log(`[WebSocket] Primary connection failed. Attempting fallback to localhost:3000...`);
        this.fallbackUsed = true;
        this.connect();
      } else {
        console.log(`[WebSocket] Retrying in ${this.reconnectDelay}ms...`);
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
      }
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend(msg);
    } else {
      this.queue.push(msg);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter(h => h !== handler); };
  }

  private rawSend(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
