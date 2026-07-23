/**
 * Handles WebRTC signaling and room management for Socket.io.
 * @param {import('socket.io').Server} io - The Socket.io server instance
 * @param {import('socket.io').Socket} socket - The connected client socket
 */
export const handleSignaling = (io, socket) => {
  
  // 1. User joins a specific room
  socket.on('join-room', ({ roomId, userId }) => {
    // Join the logical room provided by Socket.io
    socket.join(roomId);
    
    console.log(`[ROOM] User ${userId} (Socket: ${socket.id}) joined room: ${roomId}`);

    // Broadcast to everyone else IN THE ROOM that a new user connected
    // We send the socket.id so the existing peers know who to send the WebRTC Offer to
    socket.to(roomId).emit('user-connected', {
      userId,
      socketId: socket.id
    });

    // Store roomId in the socket instance for cleanup on disconnect
    socket.data.roomId = roomId;
    socket.data.userId = userId;
  });

  // 2. WebRTC Signaling: Relay the Offer
  socket.on('webrtc-offer', ({ offer, toSocketId }) => {
    // Forward the offer directly to the specific peer
    socket.to(toSocketId).emit('webrtc-offer', {
      offer,
      fromSocketId: socket.id
    });
  });

  // 3. WebRTC Signaling: Relay the Answer
  socket.on('webrtc-answer', ({ answer, toSocketId }) => {
    // Forward the answer directly back to the peer who made the offer
    socket.to(toSocketId).emit('webrtc-answer', {
      answer,
      fromSocketId: socket.id
    });
  });

  // 4. WebRTC Signaling: Relay ICE Candidates
  socket.on('ice-candidate', ({ candidate, toSocketId }) => {
    // ICE candidates are essential for bypassing NATs/Firewalls
    socket.to(toSocketId).emit('ice-candidate', {
      candidate,
      fromSocketId: socket.id
    });
  });

  // 5. Cleanup on disconnection
  socket.on('disconnect', () => {
    const { roomId, userId } = socket.data;
    
    if (roomId) {
      console.log(`[ROOM] User ${userId || socket.id} disconnected from room: ${roomId}`);
      // Notify the remaining peers in the room so they can close the UI/Video elements
      socket.to(roomId).emit('user-disconnected', {
        socketId: socket.id
      });
    }
  });
};