/**
 * Authoritative, in-memory room state.  It deliberately contains only shared
 * meeting state; MediaStreams remain peer-to-peer WebRTC resources.
 */
const rooms = new Map()
const DISCONNECT_GRACE_MS = 30_000
const REACTION_TTL_MS = 4_000

const bool = (value, fallback = false) => typeof value === 'boolean' ? value : fallback
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const reply = (ack, result) => { if (typeof ack === 'function') ack(result) }

function createRoom() {
  return {
    version: 0,
    participants: new Map(),
    activeScreenShareIds: [],
    hostParticipantId: null,
    reactions: new Map(),
    reactionClientIds: new Map(),
    reactionSequence: 0,
    messages: [],
    messageSequence: 0,
    disconnectTimers: new Map(),
  }
}

function pruneReactions(room, now = Date.now()) {
  for (const [id, reaction] of room.reactions) {
    if (reaction.expiresAt <= now) {
      room.reactions.delete(id)
      room.reactionClientIds.delete(`${reaction.participantId}:${reaction.clientReactionId}`)
    }
  }
}

function publicParticipant(participant, room) {
  return {
    participantId: participant.participantId,
    socketId: participant.socketId,
    userId: participant.userId,
    fullName: participant.fullName,
    username: participant.username,
    avatarUrl: participant.avatarUrl,
    isVideoMuted: participant.isVideoMuted,
    isAudioMuted: participant.isAudioMuted,
    isHandRaised: participant.isHandRaised,
    isEnhanced: participant.isEnhanced,
    isConnected: participant.isConnected,
    joinedAt: participant.joinedAt,
    isHost: room.hostParticipantId === participant.participantId,
    isScreenSharing: room.activeScreenShareIds.includes(participant.participantId),
  }
}

function snapshot(room) {
  pruneReactions(room)
  return {
    version: room.version,
    hostParticipantId: room.hostParticipantId,
    activeScreenShareIds: [...room.activeScreenShareIds],
    participants: [...room.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId))
      .map(participant => publicParticipant(participant, room)),
    reactions: [...room.reactions.values()].sort((a, b) => a.sequence - b.sequence),
    messages: [...room.messages],
  }
}

function publish(io, roomId, room) {
  io.to(roomId).emit('room-state', snapshot(room))
}

function nextVersion(room) {
  room.version += 1
}

function chooseNewHost(room) {
  const next = [...room.participants.values()]
    .sort((a, b) => Number(b.isConnected) - Number(a.isConnected) || a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId))[0]
  room.hostParticipantId = next?.participantId ?? null
}

function targetIsInSameRoom(io, socket, targetSocketId) {
  const target = io.sockets.sockets.get(targetSocketId)
  const room = rooms.get(socket.data.roomId)
  return Boolean(room && room.participants.get(socket.data.participantId)?.socketId === socket.id &&
    target && target.data.roomId === socket.data.roomId && target.id !== socket.id &&
    room.participants.get(target.data.participantId)?.socketId === target.id)
}

function removeParticipant(io, roomId, room, participantId) {
  const participant = room.participants.get(participantId)
  if (!participant) return

  const timer = room.disconnectTimers.get(participantId)
  if (timer) clearTimeout(timer)
  room.disconnectTimers.delete(participantId)
  room.participants.delete(participantId)
  room.activeScreenShareIds = room.activeScreenShareIds.filter(id => id !== participantId)
  if (room.hostParticipantId === participantId) chooseNewHost(room)
  nextVersion(room)

  if (room.participants.size === 0) {
    rooms.delete(roomId)
    return
  }

  io.to(roomId).emit('participant-left', { participantId, socketId: participant.socketId })
  publish(io, roomId, room)
}

export const handleSignaling = (io, socket) => {
  socket.on('join-room', (payload = {}, ack) => {
    payload ||= {}
    const roomId = text(payload.roomId, 160)
    const participantId = text(payload.participantId || payload.userId, 160)
    if (!roomId || !participantId) {
      reply(ack, { ok: false, error: 'roomId and participantId are required' })
      return
    }

    // A socket can belong to one meeting only.  Cleanly remove a previous one.
    if (socket.data.roomId && (socket.data.roomId !== roomId || socket.data.participantId !== participantId)) {
      const oldRoom = rooms.get(socket.data.roomId)
      if (oldRoom) removeParticipant(io, socket.data.roomId, oldRoom, socket.data.participantId)
      socket.leave(socket.data.roomId)
    }

    const room = rooms.get(roomId) || createRoom()
    rooms.set(roomId, room)
    const existing = room.participants.get(participantId)
    const reconnecting = Boolean(existing)
    if (existing?.socketId && existing.socketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(existing.socketId)
      previousSocket?.disconnect(true)
    }
    const timer = room.disconnectTimers.get(participantId)
    if (timer) clearTimeout(timer)
    room.disconnectTimers.delete(participantId)

    const participant = {
      participantId,
      socketId: socket.id,
      userId: text(payload.userId, 160) || participantId,
      fullName: text(payload.fullName, 120),
      username: text(payload.username, 80),
      avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl.slice(0, 2_048) : null,
      isVideoMuted: bool(payload.isVideoMuted),
      isAudioMuted: bool(payload.isAudioMuted),
      isHandRaised: bool(payload.isHandRaised),
      isEnhanced: bool(payload.isEnhanced),
      isConnected: true,
      joinedAt: existing?.joinedAt ?? Date.now(),
    }
    room.participants.set(participantId, participant)
    // Rejoining supplies the device's current state, including a presentation
    // that was stopped while signaling was unavailable.
    room.activeScreenShareIds = room.activeScreenShareIds.filter(id => id !== participantId)
    if (payload.isScreenSharing === true) room.activeScreenShareIds.push(participantId)
    if (!room.hostParticipantId) room.hostParticipantId = participantId

    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.participantId = participantId
    socket.data.userId = participant.userId
    nextVersion(room)

    // The joiner always gets a complete snapshot before any incremental signal.
    socket.emit('room-state', snapshot(room))
    socket.to(roomId).emit(reconnecting ? 'participant-reconnected' : 'participant-joined', publicParticipant(participant, room))
    publish(io, roomId, room)
    reply(ack, { ok: true, state: snapshot(room) })
  })

  socket.on('request-room-state', (ack) => {
    const room = rooms.get(socket.data.roomId)
    if (!room || !socket.data.participantId) return reply(ack, { ok: false })
    const state = snapshot(room)
    socket.emit('room-state', state)
    reply(ack, { ok: true, state })
  })

  socket.on('update-room-state', (payload = {}, ack) => {
    payload ||= {}
    const roomId = socket.data.roomId
    const participantId = socket.data.participantId
    const room = rooms.get(roomId)
    const participant = room?.participants.get(participantId)
    if (!room || !participant || participant.socketId !== socket.id) {
      reply(ack, { ok: false, error: 'not joined' })
      return
    }

    const patch = payload.patch || {}
    let changed = false
    for (const key of ['isVideoMuted', 'isAudioMuted', 'isHandRaised', 'isEnhanced']) {
      if (typeof patch[key] === 'boolean' && participant[key] !== patch[key]) {
        participant[key] = patch[key]
        changed = true
      }
    }

    if (typeof patch.isScreenSharing === 'boolean') {
      const currentlySharing = room.activeScreenShareIds.includes(participantId)
      if (patch.isScreenSharing && !currentlySharing) {
        room.activeScreenShareIds.push(participantId)
        changed = true
      } else if (!patch.isScreenSharing && currentlySharing) {
        room.activeScreenShareIds = room.activeScreenShareIds.filter(id => id !== participantId)
        changed = true
      }
    }

    if (changed) {
      nextVersion(room)
      publish(io, roomId, room)
    }
    reply(ack, { ok: true, mutationId: text(payload.mutationId, 120), state: snapshot(room) })
  })

  socket.on('send-reaction', (payload = {}, ack) => {
    payload ||= {}
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    const participant = room?.participants.get(socket.data.participantId)
    const emoji = text(payload.emoji, 16)
    if (!room || !participant || participant.socketId !== socket.id || !emoji) return reply(ack, { ok: false })

    pruneReactions(room)
    const clientReactionId = text(payload.clientReactionId, 120)
    const idempotencyKey = `${participant.participantId}:${clientReactionId}`
    const knownReactionId = clientReactionId && room.reactionClientIds.get(idempotencyKey)
    if (knownReactionId) {
      reply(ack, { ok: true, reaction: room.reactions.get(knownReactionId), duplicate: true })
      return
    }
    const sequence = ++room.reactionSequence
    const createdAt = Date.now()
    const reaction = {
      id: `${room.version + 1}-${sequence}-${participant.participantId}`,
      sequence,
      participantId: participant.participantId,
      socketId: socket.id,
      emoji,
      x: ((sequence * 73) % 241) - 120,
      y: (sequence % 6) * 30,
      size: sequence % 5 === 0 ? 40 : 44,
      createdAt,
      expiresAt: createdAt + REACTION_TTL_MS,
      clientReactionId,
    }
    room.reactions.set(reaction.id, reaction)
    if (clientReactionId) room.reactionClientIds.set(idempotencyKey, reaction.id)
    io.to(roomId).emit('reaction', reaction)
    reply(ack, { ok: true, reaction })
  })

  socket.on('send-message', (payload = {}, ack) => {
    payload ||= {}
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    const participant = room?.participants.get(socket.data.participantId)
    const body = text(payload.body, 4000)
    const clientMessageId = text(payload.clientMessageId, 120)
    if (!room || !participant || participant.socketId !== socket.id || !body || !clientMessageId) {
      return reply(ack, { ok: false, error: 'A joined participant, message and clientMessageId are required' })
    }
    const existing = room.messages.find(item => item.participantId === participant.participantId && item.clientMessageId === clientMessageId)
    if (existing) return reply(ack, { ok: true, message: existing })
    const message = {
      id: `${++room.messageSequence}-${participant.participantId}`,
      sequence: room.messageSequence,
      participantId: participant.participantId,
      fullName: participant.fullName || participant.username,
      body,
      clientMessageId,
      createdAt: Date.now(),
    }
    room.messages.push(message)
    if (room.messages.length > 100) room.messages.shift()
    io.to(roomId).emit('chat-message', message)
    reply(ack, { ok: true, message })
  })

  socket.on('leave-room', () => {
    const { roomId, participantId } = socket.data
    const room = rooms.get(roomId)
    if (room?.participants.get(participantId)?.socketId === socket.id) removeParticipant(io, roomId, room, participantId)
    socket.leave(roomId)
    socket.data.roomId = null
    socket.data.participantId = null
  })

  socket.on('webrtc-offer', (payload) => {
    const {offer, toSocketId} = payload || {}
    if (targetIsInSameRoom(io, socket, toSocketId) && offer?.type === 'offer' && typeof offer.sdp === 'string' && offer.sdp.length <= 60000) {
      io.to(toSocketId).emit('webrtc-offer', { offer, fromSocketId: socket.id })
    }
  })

  socket.on('webrtc-answer', (payload) => {
    const {answer, toSocketId} = payload || {}
    if (targetIsInSameRoom(io, socket, toSocketId) && answer?.type === 'answer' && typeof answer.sdp === 'string' && answer.sdp.length <= 60000) {
      io.to(toSocketId).emit('webrtc-answer', { answer, fromSocketId: socket.id })
    }
  })

  socket.on('ice-candidate', (payload) => {
    const {candidate, toSocketId} = payload || {}
    if (targetIsInSameRoom(io, socket, toSocketId) && typeof candidate?.candidate === 'string' && candidate.candidate.length <= 4096) {
      io.to(toSocketId).emit('ice-candidate', { candidate, fromSocketId: socket.id })
    }
  })

  socket.on('end-room', (ack) => {
    const roomId = socket.data.roomId
    const room = rooms.get(roomId)
    if (!room || room.hostParticipantId !== socket.data.participantId ||
      room.participants.get(socket.data.participantId)?.socketId !== socket.id) {
      reply(ack, { ok: false, error: 'only the host can end the room' })
      return
    }
    // Resolve the host's request before clients close their sockets on room-ended.
    reply(ack, { ok: true })
    io.to(roomId).emit('room-ended')
    const socketIds = io.sockets.adapter.rooms.get(roomId)
    for (const timer of room.disconnectTimers.values()) clearTimeout(timer)
    rooms.delete(roomId)
    for (const socketId of socketIds || []) {
      const peer = io.sockets.sockets.get(socketId)
      if (peer) {
        peer.data.roomId = null
        peer.data.participantId = null
        peer.disconnect(true)
      }
    }
  })

  socket.on('disconnect', () => {
    const { roomId, participantId } = socket.data
    const room = rooms.get(roomId)
    const participant = room?.participants.get(participantId)
    if (!room || !participant || participant.socketId !== socket.id) return

    participant.isConnected = false
    nextVersion(room)
    publish(io, roomId, room)
    const timer = setTimeout(() => {
      const activeRoom = rooms.get(roomId)
      const current = activeRoom?.participants.get(participantId)
      if (activeRoom && current && !current.isConnected && current.socketId === socket.id) {
        removeParticipant(io, roomId, activeRoom, participantId)
      }
    }, DISCONNECT_GRACE_MS)
    room.disconnectTimers.set(participantId, timer)
  })
}
