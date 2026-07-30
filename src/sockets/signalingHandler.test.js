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
    this.rooms = new Set()
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
