import assert from 'node:assert/strict'
import test from 'node:test'
import { handleSignaling } from './signalingHandler.js'

class FakeIo {
  constructor() {
    this.sockets = { sockets: new Map(), adapter: { rooms: new Map() } }
  }

  to(roomId, excludedId) {
    return {
      emit: (event, payload) => {
        for (const socket of this.sockets.sockets.values()) {
          if (socket.rooms.has(roomId) && socket.id !== excludedId) socket.receive(event, payload)
        }
      },
    }
  }
}

class FakeSocket {
  constructor(id, io) {
    this.id = id
    this.io = io
    this.data = {}
    this.rooms = new Set([id])
    this.handlers = new Map()
    this.received = []
    io.sockets.sockets.set(id, this)
  }

  on(event, handler) { this.handlers.set(event, handler) }
  emit(event, payload) { this.receive(event, payload) }
  receive(event, payload) { this.received.push({ event, payload }) }
  trigger(event, payload, ack = () => {}) { this.handlers.get(event)?.(payload, ack) }
  join(roomId) { this.rooms.add(roomId) }
  leave(roomId) { this.rooms.delete(roomId) }
  to(roomId) { return this.io.to(roomId, this.id) }
  disconnect() { this.handlers.get('disconnect')?.() }
  last(event) { return [...this.received].reverse().find(item => item.event === event)?.payload }
}

test('authoritative snapshots converge media, hand state and reactions for every peer', () => {
  const io = new FakeIo()
  const alice = new FakeSocket('socket-a', io)
  const bob = new FakeSocket('socket-b', io)
  handleSignaling(io, alice)
  handleSignaling(io, bob)

  alice.trigger('join-room', { roomId: 'sync-test-room', participantId: 'alice', userId: 'alice', fullName: 'Alice' })
  bob.trigger('join-room', { roomId: 'sync-test-room', participantId: 'bob', userId: 'bob', fullName: 'Bob' })

  let aliceState
  alice.trigger('update-room-state', {
    patch: { isAudioMuted: true, isHandRaised: true, isEnhanced: true },
    mutationId: 'alice-1',
  }, result => { aliceState = result.state })

  const bobState = bob.last('room-state')
  assert.equal(aliceState.version, bobState.version)
  assert.deepEqual(aliceState.participants, bobState.participants)
  const aliceProjection = aliceState.participants.find(item => item.participantId === 'alice')
  assert.deepEqual(
    { muted: aliceProjection.isAudioMuted, hand: aliceProjection.isHandRaised, enhanced: aliceProjection.isEnhanced },
    { muted: true, hand: true, enhanced: true },
  )

  alice.trigger('send-reaction', { emoji: '👏', clientReactionId: 'reaction-1' })
  alice.trigger('send-reaction', { emoji: '👏', clientReactionId: 'reaction-1' })
  const fromAlice = alice.last('reaction')
  const fromBob = bob.last('reaction')
  assert.deepEqual(fromAlice, fromBob)
  assert.ok(fromAlice.expiresAt > fromAlice.createdAt)
  assert.equal(typeof fromAlice.sequence, 'number')
  assert.equal(alice.received.filter(item => item.event === 'reaction').length, 1)
  assert.equal(bob.received.filter(item => item.event === 'reaction').length, 1)
})

function pair(roomId) {
  const io = new FakeIo()
  const a = new FakeSocket(`${roomId}-a`, io)
  const b = new FakeSocket(`${roomId}-b`, io)
  for (const socket of [a, b]) handleSignaling(io, socket)
  a.trigger('join-room', {roomId, participantId: 'a', fullName: 'Alice'})
  b.trigger('join-room', {roomId, participantId: 'b', fullName: 'Bob'})
  return {io, a, b}
}

test('chat is ordered, bounded, idempotent and restored on rejoin', () => {
  const {io, a, b} = pair('chat-room')
  for (let i = 0; i < 105; i++) a.trigger('send-message', {body: `Message ${i}`, clientMessageId: `message-${i}`})
  a.trigger('send-message', {body: 'Duplicate', clientMessageId: 'message-104'})
  assert.equal(b.received.filter(item => item.event === 'chat-message').length, 105)
  assert.equal(a.last('chat-message').sequence, 105)
  const replacement = new FakeSocket('chat-room-b-new', io)
  handleSignaling(io, replacement)
  replacement.trigger('join-room', {roomId: 'chat-room', participantId: 'b'})
  const messages = replacement.last('room-state').messages
  assert.equal(messages.length, 100)
  assert.equal(messages[0].body, 'Message 5')
  assert.equal(messages.at(-1).body, 'Message 104')
  a.trigger('leave-room')
  replacement.trigger('leave-room')
})

test('replaced sockets cannot mutate, leave, send messages or end the room', () => {
  const {io, a, b} = pair('stale-room')
  const replacement = new FakeSocket('stale-room-new', io)
  handleSignaling(io, replacement)
  replacement.trigger('join-room', {roomId: 'stale-room', participantId: 'a', isAudioMuted: true})
  let result
  a.trigger('update-room-state', {patch: {isAudioMuted: false}}, value => {result = value})
  assert.equal(result.ok, false)
  a.trigger('send-message', {body: 'stale', clientMessageId: 'stale'}, value => {result = value})
  assert.equal(result.ok, false)
  a.trigger('end-room', value => {result = value})
  assert.equal(b.last('room-ended'), undefined)
  a.trigger('leave-room')
  replacement.trigger('request-room-state', value => {result = value})
  assert.equal(replacement.last('room-state').participants.length, 2)
  assert.equal(replacement.last('room-state').participants.find(p => p.participantId === 'a').isAudioMuted, true)
  replacement.trigger('leave-room')
  b.trigger('leave-room')
})

test('screen state reconciles across reconnect and host transfers on leave', () => {
  const {io, a, b} = pair('screen-room')
  a.trigger('update-room-state', {patch: {isScreenSharing: true}})
  b.trigger('update-room-state', {patch: {isScreenSharing: true}})
  assert.deepEqual(b.last('room-state').activeScreenShareIds, ['a', 'b'])
  const replacement = new FakeSocket('screen-room-a-new', io)
  handleSignaling(io, replacement)
  replacement.trigger('join-room', {roomId: 'screen-room', participantId: 'a', isScreenSharing: false})
  assert.deepEqual(b.last('room-state').activeScreenShareIds, ['b'])
  replacement.trigger('leave-room')
  assert.equal(b.last('room-state').hostParticipantId, 'b')
  b.trigger('leave-room')
})

test('signals cannot cross rooms, including unjoined sockets', () => {
  const {io, a, b} = pair('signal-room')
  const outsider = new FakeSocket('outsider', io)
  handleSignaling(io, outsider)
  outsider.trigger('webrtc-offer', {toSocketId: a.id, offer: {type: 'offer', sdp: 'forbidden'}})
  assert.equal(a.last('webrtc-offer'), undefined)
  a.trigger('webrtc-offer', {toSocketId: b.id, offer: {type: 'offer', sdp: 'allowed'}})
  assert.equal(b.last('webrtc-offer').offer.sdp, 'allowed')
  a.trigger('leave-room')
  b.trigger('leave-room')
})

test('malformed packets and callback arguments cannot crash signaling', () => {
  const {a, b} = pair('malformed-room')
  for (const event of ['join-room', 'update-room-state', 'send-message', 'send-reaction', 'webrtc-offer', 'webrtc-answer', 'ice-candidate']) {
    assert.doesNotThrow(() => a.trigger(event, null, 'invalid callback'))
  }
  a.trigger('leave-room')
  b.trigger('leave-room')
})
