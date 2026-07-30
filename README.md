# MeetMesh — Signaling Server

WebRTC signaling server for the MeetMesh P2P video-calling platform. Relays offer/answer/ICE-candidate messages, maintains authoritative room state in memory, and manages participant lifecycle — without touching any media data.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| HTTP | Express 5 |
| WebSocket | Socket.IO 4 |
| CORS | `cors` middleware |
| Dev | nodemon (auto-restart) |
| Test | Node.js native test runner (`node:test`) |

## Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Peer A     │   │   Peer B     │   │   Peer C     │
│  (Browser)   │   │  (Browser)   │   │  (Browser)   │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │        Socket.IO (WebSocket)        │
       └──────────────────┼──────────────────┘
                          │
               ┌──────────▼──────────┐
               │   Signaling Server  │
               │   (this project)    │
               │                     │
               │   In-memory state   │
               │   Rooms, participants│
               │   Screen shares,    │
               │   reactions         │
               └─────────────────────┘

               Media flows P2P directly
               betweeen browsers via
               RTCPeerConnection
```

The server is stateless by design — all room state lives in JavaScript `Map` instances. A restart clears all active rooms.

## Events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join-room` | `{ roomId, participantId, fullName?, username?, avatarUrl?, isVideoMuted?, isAudioMuted?, isHandRaised?, isEnhanced? }` | Join or rejoin a meeting room. First joiner becomes host. |
| `update-room-state` | `{ patch: { isVideoMuted?, isAudioMuted?, isHandRaised?, isEnhanced?, isScreenSharing? }, mutationId? }` | Update participant media state or toggle screen share. |
| `send-reaction` | `{ emoji, clientReactionId? }` | Send an emoji reaction (4s TTL). Idempotent via `clientReactionId`. |
| `request-room-state` | — | Request a fresh room snapshot (ack callback). |
| `webrtc-offer` | `{ offer, toSocketId }` | Relay a WebRTC offer to a specific peer. |
| `webrtc-answer` | `{ answer, toSocketId }` | Relay a WebRTC answer to a specific peer. |
| `ice-candidate` | `{ candidate, toSocketId }` | Relay an ICE candidate to a specific peer. |
| `end-room` | — | Host-only. Ends the room and disconnects all peers. |
| `leave-room` | — | Gracefully leave the current room. |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `room-state` | `{ version, hostParticipantId, activeScreenShareIds, participants[], reactions[] }` | Full authoritative room snapshot (sent on join, state change, or reconnect). |
| `participant-joined` | `ParticipantInfo` | A new participant joined the room. |
| `participant-reconnected` | `ParticipantInfo` | A participant reconnected after a temporary disconnect. |
| `participant-left` | `{ participantId, socketId }` | A participant was fully removed. |
| `reaction` | `Reaction` | An emoji reaction was sent by someone in the room. |
| `room-ended` | — | The host ended the room. |
| `webrtc-offer` | `{ offer, fromSocketId }` | Incoming WebRTC offer from another peer. |
| `webrtc-answer` | `{ answer, fromSocketId }` | Incoming WebRTC answer from another peer. |
| `ice-candidate` | `{ candidate, fromSocketId }` | Incoming ICE candidate from another peer. |

## Room State

All state is held in memory:

| Field | Type | Description |
|---|---|---|
| `version` | `number` | Monotonically increasing version counter. Clients ignore stale snapshots. |
| `hostParticipantId` | `string \| null` | The participant ID of the current host (first joiner). |
| `activeScreenShareIds` | `string[]` | Participant IDs currently sharing their screen. |
| `participants` | `Participant[]` | Sorted by join time. |
| `reactions` | `Reaction[]` | Active reactions (expired ones are pruned). |

### Participant object

```json
{
  "participantId": "uuid",
  "socketId": "socket-id",
  "userId": "uuid",
  "fullName": "Alice",
  "username": "@alice",
  "avatarUrl": "https://...",
  "isVideoMuted": false,
  "isAudioMuted": false,
  "isHandRaised": false,
  "isEnhanced": false,
  "isConnected": true,
  "joinedAt": 1700000000000,
  "isHost": true,
  "isScreenSharing": true
}
```

## Disconnect & Reconnect

When a socket disconnects (network drop, tab close), the server:

1. Immediately marks `participant.isConnected = false` and publishes the updated state
2. Starts a **10-second grace timer**
3. If the participant rejoins within 10 seconds (same `participantId`), the timer is cleared and `isConnected` is set back to `true`
4. If the timer expires, the participant is fully removed, and `participant-left` is broadcast

This prevents brief network interruptions from removing participants from the room.

## Project Structure

```
meetmesh-signaling/
├── index.js                        # Entry point: Express + Socket.IO
├── package.json
├── .env                            # CLIENT_ORIGIN (allowed CORS origins)
├── .gitignore
└── src/
    └── sockets/
        ├── signalingHandler.js     # All socket event handlers (312 lines)
        └── signalingHandler.test.js# Unit tests (Node.js native)
```

## Getting Started

```bash
# Install
npm install

# Start development (with auto-reload)
npm run dev

# Start production
npm start

# Run tests
npm test
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP/WebSocket listen port |
| `CLIENT_ORIGIN` | `*` | Comma-separated allowed CORS origins (e.g. `http://localhost:3000,https://app.example.com`) |

## Frontend Integration

This server is consumed by [videocall-app](https://github.com/your-org/videocall-app). The client connects via `socket.io-client` and uses the events above to establish WebRTC peer connections and synchronize room state.

The client's `NEXT_PUBLIC_SIGNALING_SERVER_URL` must point to this server's URL.

## Deployment

The server is a plain Node.js process and can be deployed to any platform that supports Node.js (Render, Railway, Fly.io, DigitalOcean, etc.).

```bash
# Set environment variables
export PORT=3001
export CLIENT_ORIGIN=https://your-frontend.com

# Start
node index.js
```

No database, no build step — just install and run.
