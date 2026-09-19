/**
 * Production socket factory: a real WebSocket to the bridge container.
 *
 * Kept apart from client.ts so the transport can be swapped for the in-memory
 * mock bridge in tests without pulling `ws` into the test graph.
 */
import WebSocket from "ws";
import type { BridgeSocket, BridgeSocketFactory } from "./client.js";

export const createWebSocketBridgeSocket: BridgeSocketFactory = (url, handlers): BridgeSocket => {
  const socket = new WebSocket(url);
  socket.binaryType = "nodebuffer";

  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      // The bridge sends binary frames only; text is not part of the protocol.
      return;
    }
    handlers.onFrame(toBuffer(data));
  });
  socket.on("error", (error: Error) => handlers.onError(error));
  socket.on("close", (code: number, reason: Buffer) =>
    handlers.onClose(`${code}${reason.length > 0 ? `:${reason.toString("utf8")}` : ""}`),
  );

  return {
    send(data: Buffer) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    },
    close() {
      socket.close();
    },
  };
};

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
