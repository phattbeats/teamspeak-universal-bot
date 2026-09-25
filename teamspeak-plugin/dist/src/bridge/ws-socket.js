import WebSocket from "ws";
const createWebSocketBridgeSocket = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = "nodebuffer";
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      return;
    }
    handlers.onFrame(toBuffer(data));
  });
  socket.on("error", (error) => handlers.onError(error));
  socket.on(
    "close",
    (code, reason) => handlers.onClose(`${code}${reason.length > 0 ? `:${reason.toString("utf8")}` : ""}`)
  );
  return {
    send(data) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    },
    close() {
      socket.close();
    }
  };
};
function toBuffer(data) {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
export {
  createWebSocketBridgeSocket
};
